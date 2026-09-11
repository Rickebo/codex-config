#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";

const [targetContextOrServer, baseUrl] = process.argv.slice(2);

if (!targetContextOrServer || !baseUrl) {
  console.error("usage: start-argocd-mcp.mjs <context-or-server> <base-url>");
  process.exit(2);
}

const configPath = process.env.ARGOCD_CONFIG_PATH || `${homedir()}/.config/argocd/config`;
const normalizedTarget = normalize(targetContextOrServer);

let configText;
try {
  configText = readFileSync(configPath, "utf8");
} catch (error) {
  console.error(`Unable to read Argo CD CLI config at ${configPath}.`);
  console.error("Log in with argocd first so the MCP launcher can reuse your OIDC token.");
  process.exit(2);
}

const { contexts, users } = parseArgoCdConfig(configText);
const context = contexts.find((item) =>
  [item.name, item.server, item.user].some((value) => normalize(value) === normalizedTarget),
);

const userNameCandidates = [
  context?.user,
  context?.name,
  context?.server,
  targetContextOrServer,
];

const user = users.find((item) =>
  userNameCandidates.some((candidate) => normalize(item.name) === normalize(candidate)),
);

const token = user?.["auth-token"];
if (!token) {
  console.error(`No Argo CD auth token found for "${targetContextOrServer}" in ${configPath}.`);
  console.error(`Run: argocd login ${targetContextOrServer} --sso --grpc-web --name ${targetContextOrServer}`);
  process.exit(2);
}

const tokenInfo = parseJwt(token);
if (tokenInfo?.payload?.exp) {
  const expiresAt = tokenInfo.payload.exp * 1000;
  if (Number.isFinite(expiresAt) && Date.now() >= expiresAt) {
    const issuer = tokenInfo.payload.iss ? ` (issuer: ${tokenInfo.payload.iss})` : "";
    console.error(
      `Argo CD auth token for "${targetContextOrServer}" expired at ${new Date(expiresAt).toISOString()}${issuer}.`,
    );
    console.error(`Run: argocd login ${targetContextOrServer} --sso --grpc-web --name ${targetContextOrServer}`);
    process.exit(2);
  }
}

const child = spawn("npx", ["-y", "argocd-mcp@latest", "stdio"], {
  stdio: "inherit",
  env: {
    ...process.env,
    ARGOCD_BASE_URL: baseUrl,
    ARGOCD_API_TOKEN: token,
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

function normalize(value) {
  return String(value || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
}

function parseArgoCdConfig(text) {
  const result = {
    contexts: [],
    users: [],
  };

  let section = "";
  let current = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const topLevel = /^([A-Za-z0-9_-]+):\s*$/.exec(trimmed);
    if (topLevel) {
      section = topLevel[1];
      current = null;
      continue;
    }

    if (!["contexts", "users"].includes(section)) {
      continue;
    }

    if (trimmed.startsWith("- ")) {
      current = {};
      result[section].push(current);
      assign(current, trimmed.slice(2));
      continue;
    }

    if (current) {
      assign(current, trimmed);
    }
  }

  return result;
}

function assign(target, line) {
  const separatorIndex = line.indexOf(":");
  if (separatorIndex < 0) {
    return;
  }

  const key = line.slice(0, separatorIndex).trim();
  let value = line.slice(separatorIndex + 1).trim();

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  target[key] = value;
}

function parseJwt(token) {
  const parts = String(token || "").split(".");
  if (parts.length < 2) {
    return null;
  }

  try {
    return {
      payload: JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")),
    };
  } catch {
    return null;
  }
}
