#!/usr/bin/env node

import { spawn } from "node:child_process";
import net from "node:net";
import {
  defaultSshHost,
  defaultSshLocalPort,
  getHomeAssistantMcpUrl,
  loadHomeAssistantToken,
} from "./homeassistant-common.mjs";

const explicitMcpUrl = process.env.HOMEASSISTANT_MCP_URL?.trim();
const sshHost = process.env.HOMEASSISTANT_SSH_HOST?.trim() || defaultSshHost;
const sshLocalPort = Number.parseInt(
  process.env.HOMEASSISTANT_SSH_LOCAL_PORT || String(defaultSshLocalPort),
  10,
);
const useSshTunnel =
  !explicitMcpUrl && process.env.HOMEASSISTANT_SSH_TUNNEL?.trim().toLowerCase() !== "false";

if (!Number.isInteger(sshLocalPort) || sshLocalPort < 1024 || sshLocalPort > 65535) {
  console.error(`Invalid HOMEASSISTANT_SSH_LOCAL_PORT: ${sshLocalPort}`);
  process.exit(2);
}

let sshChild;
let mcpChild;
let shuttingDown = false;

function stopChild(child) {
  if (child && child.exitCode === null && !child.killed) {
    child.kill("SIGTERM");
  }
}

function waitForPort(child, port, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let retryTimer;
    const deadline = Date.now() + timeoutMs;
    let sshStderr = "";

    child.stderr?.on("data", (chunk) => {
      sshStderr = `${sshStderr}${chunk.toString()}`.slice(-2000);
    });

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(retryTimer);
      child.off("exit", onExit);
      callback();
    };

    const onExit = (code, signal) => {
      finish(() => {
        const detail = sshStderr.trim() ? `: ${sshStderr.trim()}` : "";
        reject(new Error(`SSH tunnel exited before opening local port (${code ?? signal})${detail}`));
      });
    };

    const check = () => {
      if (settled) return;
      if (Date.now() >= deadline) {
        finish(() => reject(new Error(`SSH tunnel did not open 127.0.0.1:${port} within ${timeoutMs}ms`)));
        return;
      }

      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        finish(resolve);
      });
      socket.once("error", () => {
        socket.destroy();
        retryTimer = setTimeout(check, 100);
      });
    };

    child.once("exit", onExit);
    check();
  });
}

function attachRedactedStderr(child, secret) {
  let stderrBuffer = "";

  const flush = (force = false) => {
    const keepLength = force ? 0 : Math.max(0, secret.length - 1);
    if (!force && stderrBuffer.length <= keepLength) return;
    const safeLength = stderrBuffer.length - keepLength;
    const safeChunk = stderrBuffer.slice(0, safeLength).split(secret).join("[REDACTED]");
    stderrBuffer = stderrBuffer.slice(safeLength);
    if (safeChunk) process.stderr.write(safeChunk);
  };

  child.stderr.on("data", (chunk) => {
    stderrBuffer += chunk.toString();
    flush();
  });

  return () => flush(true);
}

function handleSignal(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  stopChild(mcpChild);
  stopChild(sshChild);
  process.exit(0);
}

process.on("SIGINT", () => handleSignal("SIGINT"));
process.on("SIGTERM", () => handleSignal("SIGTERM"));

let token;
try {
  token = await loadHomeAssistantToken();

  if (useSshTunnel) {
    sshChild = spawn(
      "ssh",
      [
        "-N",
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
        "-L",
        `${sshLocalPort}:127.0.0.1:8123`,
        sshHost,
      ],
      { stdio: ["ignore", "ignore", "pipe"], env: process.env },
    );
    await waitForPort(sshChild, sshLocalPort);
  }

  const mcpUrl = getHomeAssistantMcpUrl();
  mcpChild = spawn(
    "npx",
    ["--yes", "--loglevel=error", "mcp-remote", mcpUrl, "--header", `Authorization: Bearer ${token}`],
    {
      stdio: ["inherit", "inherit", "pipe"],
      env: {
        ...process.env,
        NPM_CONFIG_LOGLEVEL: "error",
        npm_config_loglevel: "error",
      },
    },
  );
  const flushMcpStderr = attachRedactedStderr(mcpChild, token);

  mcpChild.on("exit", (code, signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    flushMcpStderr();
    stopChild(sshChild);
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
} catch (error) {
  stopChild(mcpChild);
  stopChild(sshChild);
  console.error(String(error.message || error));
  process.exit(1);
}
