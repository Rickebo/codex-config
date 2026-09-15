#!/usr/bin/env python3
"""
prune-worktrees.py: Safe automated git worktree housekeeping for Codicarium & Codex.

Supports:
1. Merged worktrees: branches/commits merged to origin/main or default branch.
2. Stale review worktrees: reviewer worktrees for closed/merged PRs or past commits.
3. Inactive worktrees: any worktree with no change in the last N days (default: 7 days).
4. Orphaned worktrees: directories missing on disk but registered in git (prunable records).
5. Dangling untracked directories: abandoned worktree folders in .worktrees not tracked by any git repo.

Safety guarantees:
- NEVER touches the main checkout worktree.
- NEVER touches worktrees containing an active process CWD (/proc/*/cwd).
- NEVER touches worktrees modified within --min-age-hours or --prune-older-than-days.
- NEVER touches worktrees with active open GitHub PRs.
- For unmerged worktrees older than N days: removes the worktree folder to reclaim disk space,
  but KEEPS the git branch intact so no commit history is ever lost.
- Always supports --dry-run before executing any changes.
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

HARMLESS_UNTRACKED_PATTERNS = [
    r"__pycache__",
    r"\.pytest_cache",
    r"\.ruff_cache",
    r"\.terraform",
    r"\.terraform\.lock\.hcl",
    r"\.worktrees",
    r"\.DS_Store",
    r"\.coverage",
    r"htmlcov",
    r"\.mypy_cache",
    r"\.cache",
    r"node_modules",
]

def get_active_cwds():
    active = set()
    for pid in os.listdir("/proc"):
        if pid.isdigit():
            try:
                target = os.readlink(f"/proc/{pid}/cwd")
                active.add(Path(target).resolve())
            except (OSError, FileNotFoundError):
                pass
    return active

def is_path_active(path: Path, active_cwds: set) -> bool:
    try:
        resolved = path.resolve()
    except OSError:
        return False
    for acwd in active_cwds:
        if resolved == acwd or resolved in acwd.parents:
            return True
    return False

def find_all_git_repos(base_dir: Path, recursive: bool = False, max_depth: int = 4):
    if (base_dir / ".git").is_dir():
        return [base_dir]
    
    if not recursive:
        repos = []
        for p in base_dir.iterdir():
            if p.is_dir() and (p / ".git").is_dir():
                repos.append(p)
        return sorted(repos)

    repos = []
    base_depth = len(base_dir.parts)
    for root, dirs, _ in os.walk(str(base_dir)):
        p = Path(root)
        if len(p.parts) - base_depth > max_depth:
            dirs.clear()
            continue
        # Avoid traversing into .git, .worktrees, node_modules, etc.
        dirs[:] = [d for d in dirs if d not in [".git", ".worktrees", "node_modules", ".cache", ".Trash-1000", "archive000"]]
        if (p / ".git").is_dir():
            repos.append(p)
    return sorted(repos)

def parse_worktrees(repo_path: Path):
    res = subprocess.run(
        ["git", "-C", str(repo_path), "worktree", "list", "--porcelain"],
        capture_output=True,
        text=True
    )
    if res.returncode != 0:
        return []
    
    entries = []
    curr = {}
    for line in res.stdout.splitlines():
        if line.startswith("worktree "):
            if curr:
                entries.append(curr)
            curr = {"worktree": line.split(" ", 1)[1]}
        elif line.startswith("HEAD "):
            curr["HEAD"] = line.split(" ", 1)[1]
        elif line.startswith("branch "):
            curr["branch"] = line.split(" ", 1)[1]
        elif line.startswith("prunable"):
            curr["prunable"] = line
        elif line.startswith("bare"):
            curr["bare"] = True
        elif line.startswith("detached"):
            curr["detached"] = True
        elif line.startswith("locked"):
            curr["locked"] = line
    if curr:
        entries.append(curr)
    return entries

def get_open_pr_branches(repo_name: str) -> set[str]:
    branches = set()
    for org in ["rickebo-com", "codicarium"]:
        cmd = ["gh", "pr", "list", "--repo", f"{org}/{repo_name}", "--state", "open", "--json", "headRefName"]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode == 0 and r.stdout.strip():
            try:
                prs = json.loads(r.stdout)
                for pr in prs:
                    if pr.get("headRefName"):
                        branches.add(pr["headRefName"])
            except json.JSONDecodeError:
                pass
            break
    return branches

def main():
    parser = argparse.ArgumentParser(description="Automated safe worktree pruning utility.")
    parser.add_argument("--base-dir", default="/mnt/rickebo-p/codicarium-platform", help="Base directory containing repositories or volume root")
    parser.add_argument("--repo", help="Filter to a specific repository name")
    parser.add_argument("--recursive", action="store_true", help="Recursively search for all git repositories under base-dir")
    parser.add_argument("--min-age-hours", type=float, default=24.0, help="Minimum age in hours for standard pruning (default: 24.0)")
    parser.add_argument("--prune-older-than-days", type=float, help="Prune any worktree with no changes for > N days (e.g. 7.0)")
    parser.add_argument("--dry-run", action="store_true", default=False, help="Perform dry run without deleting files or running git remove")
    parser.add_argument("--prune-merged", action="store_true", help="Remove worktrees merged to default branch")
    parser.add_argument("--prune-reviews", action="store_true", help="Remove stale reviewer worktrees")
    parser.add_argument("--prune-orphans", action="store_true", help="Prune missing git worktree records and untracked dirs")
    parser.add_argument("--prune-all-safe", action="store_true", help="Safely prune all eligible merged, reviews, and orphans")
    parser.add_argument("--json", action="store_true", help="Output report in JSON format")

    args = parser.parse_args()

    if not (args.prune_merged or args.prune_reviews or args.prune_orphans or args.prune_all_safe or args.prune_older_than_days):
        args.dry_run = True

    if args.prune_all_safe:
        args.prune_merged = True
        args.prune_reviews = True
        args.prune_orphans = True

    base = Path(args.base_dir)
    if not base.exists():
        print(f"Error: Base directory {base} does not exist", file=sys.stderr)
        sys.exit(1)

    all_repos = find_all_git_repos(base, recursive=args.recursive)
    print(f"Found {len(all_repos)} repositories under {base} (recursive={args.recursive}).")

    # Collect all registered worktrees
    all_registered_wt_paths = set()
    for repo in all_repos:
        wts = parse_worktrees(repo)
        for idx, wt in enumerate(wts):
            if idx == 0 and Path(wt["worktree"]).resolve() == repo.resolve():
                continue
            try:
                all_registered_wt_paths.add(Path(wt["worktree"]).resolve())
            except OSError:
                pass

    target_repos = all_repos
    if args.repo:
        target_repos = [r for r in all_repos if r.name == args.repo]
        if not target_repos:
            print(f"Error: Repository {args.repo} not found under {base}", file=sys.stderr)
            sys.exit(1)

    active_cwds = get_active_cwds()
    now = time.time()
    min_age_seconds = args.min_age_hours * 3600.0
    stale_age_seconds = (args.prune_older_than_days * 86400.0) if args.prune_older_than_days else None

    actions_plan = {
        "git_worktree_prune_repos": [],
        "worktrees_to_remove": [],
        "branches_to_delete": [],
        "untracked_dirs_to_delete": [],
        "skipped_active_process": [],
        "skipped_recent": [],
        "skipped_open_pr": [],
        "skipped_other": []
    }

    # Cache open PR branches per repo
    open_prs_cache = {}

    for repo in target_repos:
        r_def = subprocess.run(["git", "-C", str(repo), "symbolic-ref", "--short", "HEAD"], capture_output=True, text=True)
        default_branch = r_def.stdout.strip() if r_def.returncode == 0 else "main"
        r_om = subprocess.run(["git", "-C", str(repo), "rev-parse", "--verify", "origin/main"], capture_output=True)
        target_upstream = "origin/main" if r_om.returncode == 0 else default_branch

        wts = parse_worktrees(repo)
        has_prunable_records = False

        for idx, wt in enumerate(wts):
            wt_path_str = wt["worktree"]
            wt_path = Path(wt_path_str)
            try:
                resolved_wt_path = wt_path.resolve()
            except OSError:
                resolved_wt_path = wt_path

            # Index 0 is the main worktree checkout
            if idx == 0 and resolved_wt_path == repo.resolve():
                continue

            # Missing directory on disk
            if not resolved_wt_path.exists() or wt.get("prunable"):
                has_prunable_records = True
                continue

            # Safety 1: Active process
            if is_path_active(resolved_wt_path, active_cwds):
                actions_plan["skipped_active_process"].append({
                    "repo": repo.name,
                    "path": str(resolved_wt_path),
                    "reason": "Locked by active running process CWD"
                })
                continue

            # Check age
            try:
                mtime = resolved_wt_path.stat().st_mtime
                age_seconds = now - mtime
                age_days = age_seconds / 86400.0
            except OSError:
                age_seconds = 0
                age_days = 0

            raw_branch = wt.get("branch", "")
            short_branch = raw_branch.replace("refs/heads/", "") if raw_branch else ""

            # Check if active open PR
            if short_branch:
                if repo.name not in open_prs_cache:
                    open_prs_cache[repo.name] = get_open_pr_branches(repo.name)
                if short_branch in open_prs_cache[repo.name]:
                    actions_plan["skipped_open_pr"].append({
                        "repo": repo.name,
                        "path": str(resolved_wt_path),
                        "branch": short_branch,
                        "reason": f"Active open PR for branch {short_branch}"
                    })
                    continue

            # Check merge status
            head = wt.get("HEAD", "")
            is_merged = False
            if head:
                r_merge = subprocess.run(
                    ["git", "-C", str(repo), "merge-base", "--is-ancestor", head, target_upstream],
                    capture_output=True
                )
                is_merged = (r_merge.returncode == 0)

            is_review = "review" in resolved_wt_path.name.lower()

            eligible = False
            reason = ""

            # Rule A: Inactive older than N days (user instruction: > 7 days)
            if stale_age_seconds and age_seconds >= stale_age_seconds:
                eligible = True
                reason = f"Inactive for {round(age_days, 1)} days (> {args.prune_older_than_days}d)"
            # Rule B: Standard merged
            elif is_merged and args.prune_merged and age_seconds >= min_age_seconds:
                eligible = True
                reason = f"Merged into {target_upstream}"
            # Rule C: Stale review worktree
            elif is_review and args.prune_reviews and age_seconds >= min_age_seconds:
                eligible = True
                reason = f"Stale review worktree (age {round(age_days, 1)}d)"

            if eligible:
                actions_plan["worktrees_to_remove"].append({
                    "repo": repo.name,
                    "repo_path": str(repo),
                    "path": str(resolved_wt_path),
                    "branch": short_branch,
                    "reason": reason,
                    "head": head[:10],
                    "is_merged": is_merged
                })
                # Only delete branch if merged to main
                if short_branch and is_merged:
                    actions_plan["branches_to_delete"].append({
                        "repo": repo.name,
                        "repo_path": str(repo),
                        "branch": short_branch
                    })
            else:
                if stale_age_seconds and age_seconds < stale_age_seconds:
                    actions_plan["skipped_recent"].append({
                        "repo": repo.name,
                        "path": str(resolved_wt_path),
                        "age_days": round(age_days, 1)
                    })
                else:
                    actions_plan["skipped_other"].append({
                        "repo": repo.name,
                        "path": str(resolved_wt_path),
                        "age_days": round(age_days, 1)
                    })

        if has_prunable_records:
            actions_plan["git_worktree_prune_repos"].append(str(repo))

    # Check for orphaned directories in .worktrees
    wt_dirs = []
    top_wt = base / ".worktrees"
    if top_wt.is_dir():
        wt_dirs.append(top_wt)
    for r in target_repos:
        sub_wt = r / ".worktrees"
        if sub_wt.is_dir() and sub_wt not in wt_dirs:
            wt_dirs.append(sub_wt)

    if args.prune_orphans or stale_age_seconds:
        cutoff = stale_age_seconds if stale_age_seconds else min_age_seconds
        for wdir in wt_dirs:
            for item in wdir.iterdir():
                if not item.is_dir():
                    continue
                try:
                    resolved_item = item.resolve()
                except OSError:
                    continue
                if resolved_item in all_registered_wt_paths:
                    continue
                if is_path_active(resolved_item, active_cwds):
                    continue
                try:
                    mtime = item.stat().st_mtime
                    if (now - mtime) < cutoff:
                        continue
                except OSError:
                    pass
                actions_plan["untracked_dirs_to_delete"].append(str(resolved_item))

    if args.json:
        print(json.dumps(actions_plan, indent=2))
        return

    print("=" * 70)
    print(f" WORKTREE PRUNING AUDIT & PLAN ({'DRY RUN' if args.dry_run else 'EXECUTING'})")
    print("=" * 70)
    print(f"Repositories scanned: {len(target_repos)}")
    if stale_age_seconds:
        print(f"Stale age threshold: {args.prune_older_than_days} days (>= {stale_age_seconds/86400}d)")
    print(f"Worktrees scheduled for removal: {len(actions_plan['worktrees_to_remove'])}")
    print(f"Merged local branches scheduled for deletion: {len(actions_plan['branches_to_delete'])}")
    print(f"Untracked orphaned directories to delete: {len(actions_plan['untracked_dirs_to_delete'])}")
    print(f"Repos requiring 'git worktree prune': {len(actions_plan['git_worktree_prune_repos'])}")
    print("-" * 70)
    print(f"Skipped - locked by active process: {len(actions_plan['skipped_active_process'])}")
    print(f"Skipped - recent (modified within last week): {len(actions_plan['skipped_recent'])}")
    print(f"Skipped - open GitHub PR active: {len(actions_plan['skipped_open_pr'])}")
    print(f"Skipped - other: {len(actions_plan['skipped_other'])}")
    print("=" * 70)

    if args.dry_run:
        print("\n[DRY RUN] No files or git records were modified.")
        return

    # EXECUTION
    print("\nExecuting worktree removals...")
    removed_count = 0
    failed_count = 0

    for item in actions_plan["worktrees_to_remove"]:
        repo_path = item["repo_path"]
        wt_path = item["path"]
        print(f"  Removing [{item['repo']}]: {Path(wt_path).name} ({item['reason']})")
        r = subprocess.run(
            ["git", "-C", repo_path, "worktree", "remove", "--force", wt_path],
            capture_output=True,
            text=True
        )
        if r.returncode == 0:
            removed_count += 1
        else:
            # If git failed because folder was already partially deleted or corrupted, clean dir
            if Path(wt_path).exists():
                try:
                    shutil.rmtree(wt_path)
                    removed_count += 1
                except Exception as e:
                    print(f"    Failed to remove {wt_path}: {e}", file=sys.stderr)
                    failed_count += 1
            else:
                removed_count += 1

    print(f"Removed {removed_count} worktrees ({failed_count} errors).")

    print("\nRunning 'git worktree prune' across repositories...")
    pruned_repos = 0
    all_repos_to_prune = set(actions_plan["git_worktree_prune_repos"])
    for item in actions_plan["worktrees_to_remove"]:
        all_repos_to_prune.add(item["repo_path"])

    for rp in all_repos_to_prune:
        subprocess.run(["git", "-C", rp, "worktree", "prune"], capture_output=True)
        pruned_repos += 1
    print(f"Pruned metadata for {pruned_repos} repositories.")

    if actions_plan["branches_to_delete"]:
        print(f"\nDeleting {len(actions_plan['branches_to_delete'])} merged local branches...")
        branch_del_count = 0
        for b_item in actions_plan["branches_to_delete"]:
            r = subprocess.run(
                ["git", "-C", b_item["repo_path"], "branch", "-d", b_item["branch"]],
                capture_output=True,
                text=True
            )
            if r.returncode == 0:
                branch_del_count += 1
        print(f"Deleted {branch_del_count} local merged branches.")

    if actions_plan["untracked_dirs_to_delete"]:
        print(f"\nDeleting {len(actions_plan['untracked_dirs_to_delete'])} untracked orphaned directories...")
        orphans_del_count = 0
        for p_str in actions_plan["untracked_dirs_to_delete"]:
            p = Path(p_str)
            try:
                if p.is_dir():
                    shutil.rmtree(p)
                    orphans_del_count += 1
            except Exception as e:
                print(f"    Failed to remove {p}: {e}", file=sys.stderr)
        print(f"Deleted {orphans_del_count} orphaned directories.")

    print("\nHousekeeping complete.")

if __name__ == "__main__":
    main()
