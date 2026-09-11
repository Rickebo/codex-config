#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const defaultTokenPath = join(homedir(), ".codicarium-mcp-api-key");
const url = process.argv[2]?.trim();

if (!url) {
  console.error("Usage: start-codicarium-mcp.mjs <mcp-url>");
  process.exit(2);
}

async function loadToken() {
  const envToken = process.env.CODICARIUM_MCP_API_KEY?.trim();
  if (envToken) {
    return envToken;
  }

  const tokenPath = process.env.CODICARIUM_MCP_API_KEY_FILE?.trim() || defaultTokenPath;
  try {
    const fileToken = (await readFile(tokenPath, "utf8")).trim();
    if (fileToken) {
      return fileToken;
    }
    throw new Error(`Codicarium MCP API-key file exists but is empty: ${tokenPath}`);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  throw new Error(
    `No Codicarium MCP API key configured. Set CODICARIUM_MCP_API_KEY or place the key in ${defaultTokenPath}`,
  );
}

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
