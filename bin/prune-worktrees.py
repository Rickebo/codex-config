#!/usr/bin/env python3
"""
prune-worktrees.py: Safe automated git worktree housekeeping for Codicarium & Codex.

Identifies and cleans up:
1. Merged worktrees: branches/commits merged to origin/main or default branch.
2. Stale review worktrees: reviewer worktrees for closed/merged PRs or past commits.
3. Orphaned worktrees: directories missing on disk but registered in git (prunable records).
4. Dangling untracked directories: abandoned worktree folders in .worktrees not tracked by any git repo.

Safety guarantees:
- NEVER touches the main checkout worktree.
- NEVER touches worktrees containing an active process CWD (/proc/*/cwd).
- NEVER touches worktrees modified within --min-age-hours (default: 24h).
- NEVER touches worktrees with open GitHub PRs.
- Protects uncommitted dirty changes (unless only harmless build/test caches like __pycache__, .pytest_cache).
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

# Harmless untracked files/patterns that can be safely discarded if branch is merged
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
    resolved = path.resolve()
    for acwd in active_cwds:
        if resolved == acwd or resolved in acwd.parents:
            return True
    return False

def get_git_repos(base_dir: Path):
    repos = []
    if (base_dir / ".git").is_dir():
        repos.append(base_dir)
        return repos
    for p in base_dir.iterdir():
        if p.is_dir() and (p / ".git").is_dir():
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

def is_status_clean_or_harmless(wt_path: Path) -> tuple[bool, list[str]]:
    r = subprocess.run(
        ["git", "-C", str(wt_path), "status", "--porcelain"],
        capture_output=True,
        text=True
    )
    if r.returncode != 0:
        return False, ["git status failed"]
    
    lines = [l.strip() for l in r.stdout.splitlines() if l.strip()]
    if not lines:
        return True, []
    
    harmful = []
    for line in lines:
        code = line[:2]
        filename = line[3:].strip()
        # If file is tracked and modified (e.g. M , A , D ), it's not harmless
        if any(c in "MADRCU" for c in code):
            harmful.append(line)
            continue
        # If file is untracked (??), check if harmless pattern
        is_harmless = False
        for pat in HARMLESS_UNTRACKED_PATTERNS:
            if re.search(pat, filename):
                is_harmless = True
                break
        if not is_harmless:
            harmful.append(line)
            
    return (len(harmful) == 0), harmful

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
    parser.add_argument("--base-dir", default="/mnt/rickebo-p/codicarium-platform", help="Base directory containing repositories or repo itself")
    parser.add_argument("--repo", help="Filter to a specific repository name")
    parser.add_argument("--min-age-hours", type=float, default=24.0, help="Minimum age in hours before worktree is eligible for deletion (default: 24.0)")
    parser.add_argument("--dry-run", action="store_true", default=False, help="Perform dry run without deleting files or running git remove")
    parser.add_argument("--prune-merged", action="store_true", help="Remove worktrees merged to default branch")
    parser.add_argument("--prune-reviews", action="store_true", help="Remove stale reviewer worktrees")
    parser.add_argument("--prune-orphans", action="store_true", help="Prune missing git worktree records and untracked dirs")
    parser.add_argument("--prune-all-safe", action="store_true", help="Safely prune all eligible merged, reviews, and orphans")
    parser.add_argument("--json", action="store_true", help="Output report in JSON format")

    args = parser.parse_args()

    # Default to dry-run if no prune action is specified
    if not (args.prune_merged or args.prune_reviews or args.prune_orphans or args.prune_all_safe):
        args.dry_run = True

    if args.prune_all_safe:
        args.prune_merged = True
        args.prune_reviews = True
        args.prune_orphans = True

    base = Path(args.base_dir)
    if not base.exists():
        print(f"Error: Base directory {base} does not exist", file=sys.stderr)
        sys.exit(1)

    all_repos = get_git_repos(base)
    
    # First, collect ALL registered worktrees across ALL repositories in base
    # This prevents false orphan identification when filtering by --repo
    all_registered_wt_paths = set()
    for repo in all_repos:
        wts = parse_worktrees(repo)
        for idx, wt in enumerate(wts):
            if idx == 0 and Path(wt["worktree"]).resolve() == repo.resolve():
                continue
            all_registered_wt_paths.add(Path(wt["worktree"]).resolve())

    # Target repositories for this run
    target_repos = all_repos
    if args.repo:
        target_repos = [r for r in all_repos if r.name == args.repo]
        if not target_repos:
            print(f"Error: Repository {args.repo} not found under {base}", file=sys.stderr)
            sys.exit(1)

    active_cwds = get_active_cwds()
    now = time.time()
    min_age_seconds = args.min_age_hours * 3600.0

    actions_plan = {
        "git_worktree_prune_repos": [],
        "worktrees_to_remove": [],
        "branches_to_delete": [],
        "untracked_dirs_to_delete": [],
        "skipped_active_process": [],
        "skipped_too_young": [],
        "skipped_open_pr": [],
        "skipped_dirty": [],
        "skipped_unmerged": []
    }

    for repo in target_repos:
        # Determine default upstream branch
        r_def = subprocess.run(["git", "-C", str(repo), "symbolic-ref", "--short", "HEAD"], capture_output=True, text=True)
        default_branch = r_def.stdout.strip() if r_def.returncode == 0 else "main"
        r_om = subprocess.run(["git", "-C", str(repo), "rev-parse", "--verify", "origin/main"], capture_output=True)
        target_upstream = "origin/main" if r_om.returncode == 0 else default_branch

        open_pr_branches = get_open_pr_branches(repo.name)
        wts = parse_worktrees(repo)
        has_prunable_records = False

        for idx, wt in enumerate(wts):
            wt_path_str = wt["worktree"]
            wt_path = Path(wt_path_str).resolve()

            # Index 0 is the main worktree (the repository itself)
            if idx == 0 and wt_path == repo.resolve():
                continue

            # Check if prunable by git (missing directory)
            if not wt_path.exists() or wt.get("prunable"):
                has_prunable_records = True
                continue

            # Safety check 1: Active process
            if is_path_active(wt_path, active_cwds):
                actions_plan["skipped_active_process"].append({
                    "repo": repo.name,
                    "path": str(wt_path),
                    "reason": "Locked by active running process CWD"
                })
                continue

            # Safety check 2: Minimum age
            try:
                mtime = wt_path.stat().st_mtime
                age_seconds = now - mtime
                age_hours = age_seconds / 3600.0
            except OSError:
                age_seconds = 0
                age_hours = 0

            if age_seconds < min_age_seconds:
                actions_plan["skipped_too_young"].append({
                    "repo": repo.name,
                    "path": str(wt_path),
                    "age_hours": round(age_hours, 1),
                    "min_age_hours": args.min_age_hours
                })
                continue

            raw_branch = wt.get("branch", "")
            short_branch = raw_branch.replace("refs/heads/", "") if raw_branch else ""

            # Safety check 3: Open PR
            if short_branch and short_branch in open_pr_branches:
                actions_plan["skipped_open_pr"].append({
                    "repo": repo.name,
                    "path": str(wt_path),
                    "branch": short_branch,
                    "reason": f"Active open PR for branch {short_branch}"
                })
                continue

            # Safety check 4: Status / uncommitted edits
            is_clean, harmful_diffs = is_status_clean_or_harmless(wt_path)
            if not is_clean:
                actions_plan["skipped_dirty"].append({
                    "repo": repo.name,
                    "path": str(wt_path),
                    "harmful_diffs": harmful_diffs[:5]
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

            is_review = "review" in wt_path.name.lower()

            eligible_for_removal = False
            reason = ""

            if is_merged and args.prune_merged:
                eligible_for_removal = True
                reason = f"Merged into {target_upstream}"
            elif is_review and args.prune_reviews:
                eligible_for_removal = True
                reason = f"Stale review worktree (age {round(age_hours, 1)}h)"
            
            if eligible_for_removal:
                actions_plan["worktrees_to_remove"].append({
                    "repo": repo.name,
                    "repo_path": str(repo),
                    "path": str(wt_path),
                    "branch": short_branch,
                    "reason": reason,
                    "head": head[:10]
                })
                if short_branch and is_merged:
                    actions_plan["branches_to_delete"].append({
                        "repo": repo.name,
                        "repo_path": str(repo),
                        "branch": short_branch
                    })
            else:
                actions_plan["skipped_unmerged"].append({
                    "repo": repo.name,
                    "path": str(wt_path),
                    "branch": short_branch,
                    "head": head[:10],
                    "age_hours": round(age_hours, 1)
                })

        if has_prunable_records:
            actions_plan["git_worktree_prune_repos"].append(str(repo))

    # Check for orphaned directories in .worktrees
    wt_dir = base / ".worktrees"
    if args.prune_orphans and wt_dir.is_dir():
        for item in wt_dir.iterdir():
            if not item.is_dir():
                continue
            
            # If repo is specified, only check orphans belonging to this repo
            if args.repo and not (item.name.startswith(f"{args.repo}-") or item.name.startswith(f"{args.repo}_")):
                continue

            resolved_item = item.resolve()
            if resolved_item in all_registered_wt_paths:
                continue
            if is_path_active(resolved_item, active_cwds):
                continue
            try:
                mtime = item.stat().st_mtime
                if (now - mtime) < min_age_seconds:
                    continue
            except OSError:
                pass
            actions_plan["untracked_dirs_to_delete"].append(str(resolved_item))

    # Output or execute
    if args.json:
        print(json.dumps(actions_plan, indent=2))
        return

    print("=" * 70)
    print(f" WORKTREE PRUNING AUDIT & PLAN ({'DRY RUN' if args.dry_run else 'EXECUTING'})")
    print("=" * 70)
    print(f"Repositories scanned: {len(target_repos)}")
    print(f"Min age threshold: {args.min_age_hours} hours")
    print(f"Worktrees scheduled for removal: {len(actions_plan['worktrees_to_remove'])}")
    print(f"Merged local branches scheduled for deletion: {len(actions_plan['branches_to_delete'])}")
    print(f"Untracked orphaned directories to delete: {len(actions_plan['untracked_dirs_to_delete'])}")
    print(f"Repos requiring 'git worktree prune': {len(actions_plan['git_worktree_prune_repos'])}")
    print("-" * 70)
    print(f"Skipped - locked by active process: {len(actions_plan['skipped_active_process'])}")
    print(f"Skipped - younger than {args.min_age_hours}h: {len(actions_plan['skipped_too_young'])}")
    print(f"Skipped - open GitHub PR active: {len(actions_plan['skipped_open_pr'])}")
    print(f"Skipped - uncommitted non-cache modifications: {len(actions_plan['skipped_dirty'])}")
    print(f"Skipped - unmerged non-review: {len(actions_plan['skipped_unmerged'])}")
    print("=" * 70)

    if args.dry_run:
        print("\n[DRY RUN] No files or git records were modified.")
        print("To execute these actions, run with --prune-all-safe (or specific flags) without --dry-run.")
        return

    # EXECUTION PHASE
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
            print(f"    Warning: git worktree remove failed: {r.stderr.strip()}", file=sys.stderr)
            failed_count += 1

    print(f"Removed {removed_count} worktrees ({failed_count} errors).")

    # Prune git records for all repos
    print("\nRunning 'git worktree prune' across repositories...")
    pruned_repos = 0
    all_repos_to_prune = set(actions_plan["git_worktree_prune_repos"])
    for item in actions_plan["worktrees_to_remove"]:
        all_repos_to_prune.add(item["repo_path"])

    for rp in all_repos_to_prune:
        subprocess.run(["git", "-C", rp, "worktree", "prune"], capture_output=True)
        pruned_repos += 1
    print(f"Pruned metadata for {pruned_repos} repositories.")

    # Delete merged local branches
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

    # Delete untracked orphaned directories in .worktrees
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
