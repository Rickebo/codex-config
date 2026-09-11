#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const defaultKeyPath = join(homedir(), ".codex", "api-keys", "perplexity");

async function loadApiKey() {
  const envKey = process.env.PERPLEXITY_API_KEY?.trim();
  if (envKey) {
    return envKey;
  }

  const keyFile = process.env.PERPLEXITY_API_KEY_FILE || defaultKeyPath;

  try {
    const fileKey = (await readFile(keyFile, "utf8")).trim();
    if (fileKey) {
      return fileKey;
    }
    console.error(`Perplexity API key file exists but is empty: ${keyFile}`);
    process.exit(2);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      console.error(`Failed to read Perplexity API key file: ${keyFile}`);
      console.error(String(error));
      process.exit(2);
    }
  }

  console.error("No Perplexity API key configured for the Perplexity MCP server.");
  console.error(`Set PERPLEXITY_API_KEY or place the key in ${defaultKeyPath}.`);
  process.exit(2);
}

const apiKey = await loadApiKey();
const child = spawn("npx", ["-yq", "@perplexity-ai/mcp-server"], {
  stdio: "inherit",
  env: { ...process.env, PERPLEXITY_API_KEY: apiKey },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
