#!/usr/bin/env node

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function getGitHubToken(hostname) {
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token", "--hostname", hostname], {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    const token = stdout.trim();
    if (!token) {
      throw new Error("empty token");
    }
    return token;
  } catch (error) {
    const detail = error.stderr?.trim() || error.message || String(error);
    throw new Error(`Failed to get GitHub token from gh for ${hostname}: ${detail}`);
  }
}

async function getGitHubScopes(hostname) {
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "status", "--hostname", hostname], {
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    const match = stdout.match(/Token scopes:\s+(.+)/);
    if (!match) {
      return [];
    }
    return match[1]
      .replace(/'/g, "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function hasProjectScope(scopes) {
  return scopes.includes("project") || scopes.includes("read:project");
}

async function main() {
  const hostname = process.env.GITHUB_HOSTNAME || "github.com";
  const image = process.env.GITHUB_MCP_IMAGE || "ghcr.io/github/github-mcp-server";
  const toolsets = process.env.GITHUB_TOOLSETS || "default,actions,projects";
  const token = await getGitHubToken(hostname);
  const scopes = await getGitHubScopes(hostname);

  if (!hasProjectScope(scopes) && toolsets.split(",").map((s) => s.trim()).includes("projects")) {
    process.stderr.write(
      `Warning: gh token for ${hostname} does not currently include project scope. ` +
        `GitHub Projects tools may fail until you run: gh auth refresh --hostname ${hostname} --scopes project\n`,
    );
  }

  const child = spawn(
    "docker",
    [
      "run",
      "-i",
      "--rm",
      "-e",
      "GITHUB_PERSONAL_ACCESS_TOKEN",
      "-e",
      "GITHUB_TOOLSETS",
      image,
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        GITHUB_PERSONAL_ACCESS_TOKEN: token,
        GITHUB_TOOLSETS: toolsets,
      },
    },
  );

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });

  child.on("error", (error) => {
    process.stderr.write(`Failed to start GitHub MCP server: ${error.message}\n`);
    process.exit(1);
  });
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
