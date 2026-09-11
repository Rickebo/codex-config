#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const defaultTokenPaths = [
  join(homedir(), ".codex", "api-keys", "homeassistant"),
  join(homedir(), ".codex", "api-keys", "home-assistant"),
];

export const defaultSshHost = "has";
export const defaultSshLocalPort = 18123;
export const defaultMcpUrl = `http://127.0.0.1:${defaultSshLocalPort}/api/mcp`;

export async function loadHomeAssistantToken() {
  const envToken = process.env.HOMEASSISTANT_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }

  const tokenPaths = process.env.HOMEASSISTANT_TOKEN_FILE
    ? [process.env.HOMEASSISTANT_TOKEN_FILE]
    : defaultTokenPaths;

  for (const tokenFile of tokenPaths) {
    try {
      const fileToken = (await readFile(tokenFile, "utf8")).trim();
      if (fileToken) {
        return fileToken;
      }
      throw new Error(`Home Assistant token file exists but is empty: ${tokenFile}`);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  throw new Error(
    `No Home Assistant token configured. Set HOMEASSISTANT_TOKEN or place a long-lived token in one of: ${defaultTokenPaths.join(", ")}`,
  );
}

export function getHomeAssistantMcpUrl() {
  return process.env.HOMEASSISTANT_MCP_URL?.trim() || defaultMcpUrl;
}

export function getHomeAssistantBaseUrl() {
  const explicitBaseUrl = process.env.HOMEASSISTANT_URL?.trim();
  if (explicitBaseUrl) {
    return stripTrailingSlash(explicitBaseUrl);
  }

  return stripMcpSuffix(getHomeAssistantMcpUrl());
}

export function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function stripMcpSuffix(value) {
  return stripTrailingSlash(value).replace(/\/api\/mcp$/, "");
}

export function getHomeAssistantWebSocketUrl() {
  const url = new URL(getHomeAssistantBaseUrl());
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${stripTrailingSlash(url.pathname)}/api/websocket`;
  return url.toString();
}
