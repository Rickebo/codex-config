#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const defaultTokenPaths = [
  join(homedir(), ".homelab-mcp-api-key"),
];

const defaultMcpUrl = "https://mcp.rickebo.com/metamcp/observability/mcp";

async function loadToken() {
  const envToken = process.env.HOMELAB_OBSERVABILITY_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }

  const tokenPaths = process.env.HOMELAB_OBSERVABILITY_TOKEN_FILE
    ? [process.env.HOMELAB_OBSERVABILITY_TOKEN_FILE]
    : defaultTokenPaths;

  for (const tokenFile of tokenPaths) {
    try {
      const fileToken = (await readFile(tokenFile, "utf8")).trim();
      if (fileToken) {
        return fileToken;
      }
      throw new Error(`Homelab observability token file exists but is empty: ${tokenFile}`);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  throw new Error(
    `No homelab observability token configured. Set HOMELAB_OBSERVABILITY_TOKEN or place a bearer token in one of: ${defaultTokenPaths.join(", ")}`,
  );
}

const url = process.env.HOMELAB_OBSERVABILITY_MCP_URL?.trim() || defaultMcpUrl;

let token;
try {
  token = await loadToken();
} catch (error) {
  console.error(String(error.message || error));
  process.exit(2);
}

const child = spawn(
  "npx",
  ["-y", "mcp-remote", url, "--header", `Authorization: Bearer ${token}`],
  {
    stdio: ["inherit", "inherit", "pipe"],
    env: process.env,
  },
);

let stderrBuffer = "";
const flushStderr = (force = false) => {
  const keepLength = force ? 0 : Math.max(0, token.length - 1);
  if (!force && stderrBuffer.length <= keepLength) {
    return;
  }
  const safeLength = stderrBuffer.length - keepLength;
  const safeChunk = stderrBuffer.slice(0, safeLength).split(token).join("[REDACTED]");
  stderrBuffer = stderrBuffer.slice(safeLength);
  if (safeChunk) {
    process.stderr.write(safeChunk);
  }
};

child.stderr.on("data", (chunk) => {
  stderrBuffer += chunk.toString();
  flushStderr();
});

child.on("exit", (code, signal) => {
  flushStderr(true);
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
