#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const configPath = "/home/rickebo/.codex/github-task-memory.json";

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function loadConfig() {
  try {
    const raw = await readFile(configPath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { defaults: {}, repos: {} };
    }
    throw error;
  }
}

async function git(args, cwd) {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
}

function parseGitHubRemote(remoteUrl) {
  const patterns = [
    /^(?:ssh:\/\/)?git@(?<host>[^:/]+)[:/](?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/,
    /^https?:\/\/(?<host>[^/]+)\/(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/,
  ];

  for (const pattern of patterns) {
    const match = remoteUrl.match(pattern);
    if (match?.groups?.owner && match?.groups?.repo) {
      return {
        host: match.groups.host,
        owner: match.groups.owner,
        repo: match.groups.repo,
      };
    }
  }

  return null;
}

async function current(targetPath) {
  const requestedPath = resolve(targetPath || process.cwd());
  let repoRoot;
  try {
    repoRoot = await git(["rev-parse", "--show-toplevel"], requestedPath);
  } catch {
    fail(`Not inside a git repository: ${requestedPath}`);
  }

  let remoteUrl;
  try {
    remoteUrl = await git(["remote", "get-url", "origin"], repoRoot);
  } catch {
    fail(`Git repository has no origin remote: ${repoRoot}`);
  }

  const parsed = parseGitHubRemote(remoteUrl);
  if (!parsed) {
    fail(`Could not parse a GitHub owner/repo from origin URL: ${remoteUrl}`);
  }

  const repoKey = `${parsed.owner}/${parsed.repo}`;
  const config = await loadConfig();
  const defaults = config.defaults || {};
  const repoConfig = (config.repos && config.repos[repoKey]) || {};

  const result = {
    config_file: configPath,
    repo_root: repoRoot,
    repo_host: parsed.host,
    repo_owner: parsed.owner,
    repo_name: parsed.repo,
    repo_key: repoKey,
    issue_labels: repoConfig.issue_labels || defaults.issue_labels || [],
    priority_labels: repoConfig.priority_labels || defaults.priority_labels || [],
    default_priority_label:
      repoConfig.default_priority_label ||
      defaults.default_priority_label ||
      null,
    project_status_field: repoConfig.project_status_field || defaults.project_status_field || "Status",
    project_fields: {
      ...(defaults.project_fields || {}),
      ...(repoConfig.project_fields || {}),
    },
    statuses: {
      ...(defaults.statuses || {}),
      ...(repoConfig.statuses || {}),
    },
    project: repoConfig.project
      ? {
          owner: repoConfig.project.owner,
          owner_type: repoConfig.project.owner_type || "org",
          number: repoConfig.project.number,
        }
      : null,
  };

  printJson(result);
}

const command = process.argv[2] || "help";

if (command === "help" || command === "--help" || command === "-h") {
  process.stdout.write(`Usage: github-task-memory <command> [path]

Commands:
  current [path]   Resolve the current git repo and merge task-memory defaults/config.
  help             Show this help text.
`);
  process.exit(0);
}

if (command === "current") {
  current(process.argv[3]).catch((error) => fail(error.message));
} else {
  fail(`Unknown command: ${command}`);
}
