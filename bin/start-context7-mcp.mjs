#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const defaultKeyPath = join(homedir(), ".codex", "api-keys", "context7");

async function loadApiKey() {
  const envKey = process.env.CONTEXT7_API_KEY?.trim();
  if (envKey) {
    return envKey;
  }

  const keyFile = process.env.CONTEXT7_API_KEY_FILE || defaultKeyPath;

  try {
    const fileKey = (await readFile(keyFile, "utf8")).trim();
    if (fileKey) {
      return fileKey;
    }
    console.error(`Context7 API key file exists but is empty: ${keyFile}`);
    process.exit(2);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error(`Failed to read Context7 API key file: ${keyFile}`);
      console.error(String(error));
      process.exit(2);
    }
  }

  return "";
}

const apiKey = await loadApiKey();
const child = spawn("npx", ["-y", "@upstash/context7-mcp"], {
  stdio: "inherit",
  env: apiKey ? { ...process.env, CONTEXT7_API_KEY: apiKey } : process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
