#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { stdin, stdout, stderr, argv, exit, cwd } from "node:process";
import {
  getHomeAssistantBaseUrl,
  getHomeAssistantWebSocketUrl,
  loadHomeAssistantToken,
} from "./homeassistant-common.mjs";

const helpText = `Usage: ha-dev <command> [args]

Commands:
  backup
      Create a Home Assistant backup before applying changes. Tries backup.create_automatic first,
      then falls back to backup.create if needed.

  check-config
      Run Home Assistant core configuration validation via REST.

  get-config
      Fetch Home Assistant runtime config via the WebSocket API.

  get-states [entity_id]
      List all current entity states or a single entity by id.

  entity-source [entity_id]
      Show entity source metadata from the WebSocket API.

  render-template <template | @file | ->
      Render a Jinja template via the REST API. Use @file to load from a file or - to read stdin.

  validate-config <json | @file | ->
      Validate a structured trigger/condition/action config via the WebSocket API.
      Input must be JSON.

  call-service <domain> <service> [json | @file | ->]
      Call any Home Assistant service/action via the REST API. Optional JSON payload.

  reload <scope>
      Reload a common configuration scope. Supported scopes:
      automation, script, scene, group, template, lovelace_resources, all

  detect-config-dir
      Best-effort detection of a local Home Assistant config directory.
`;

function printHelp(code = 0) {
  stdout.write(`${helpText}\n`);
  exit(code);
}

function fail(message, code = 1) {
  stderr.write(`${message}\n`);
  exit(code);
}

function printJson(value) {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function readAllStdin() {
  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readArgText(spec, missingMessage) {
  if (!spec) {
    fail(missingMessage);
  }
  if (spec === "-") {
    return (await readAllStdin()).trim();
  }
  if (spec.startsWith("@")) {
    return (await readFile(spec.slice(1), "utf8")).trim();
  }
  return spec;
}

async function readOptionalJson(spec) {
  if (!spec) {
    return {};
  }
  const text = await readArgText(spec, "Missing JSON input.");
  if (!text) {
    return {};
  }
  return JSON.parse(text);
}

function restUrl(path) {
  return `${getHomeAssistantBaseUrl()}${path}`;
}

function websocketUrl() {
  return getHomeAssistantWebSocketUrl();
}

async function restRequest(path, { method = "GET", body, expectText = false } = {}) {
  const token = await loadHomeAssistantToken();
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
  };

  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  const response = await fetch(restUrl(path), {
    method,
    headers,
    body: payload,
  });

  const text = await response.text();
  if (!response.ok) {
    fail(`${method} ${path} failed with ${response.status} ${response.statusText}: ${text}`);
  }

  if (expectText) {
    stdout.write(text);
    if (!text.endsWith("\n")) {
      stdout.write("\n");
    }
    return text;
  }

  if (!text) {
    printJson({ success: true });
    return null;
  }

  const data = JSON.parse(text);
  printJson(data);
  return data;
}

async function wsCommand(type, payload = {}) {
  const token = await loadHomeAssistantToken();
  const url = websocketUrl();
  const ws = new WebSocket(url);
  const commandId = 1;

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {}
      reject(new Error(`WebSocket command timed out: ${type}`));
    }, 30000);

    function cleanup() {
      clearTimeout(timer);
    }

    ws.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }

      if (message.type === "auth_required") {
        ws.send(JSON.stringify({ type: "auth", access_token: token }));
        return;
      }

      if (message.type === "auth_ok") {
        ws.send(JSON.stringify({ id: commandId, type, ...payload }));
        return;
      }

      if (message.type === "auth_invalid") {
        cleanup();
        reject(new Error(`Home Assistant WebSocket auth failed: ${message.message || "invalid token"}`));
        return;
      }

      if (message.id !== commandId) {
        return;
      }

      cleanup();
      if (message.success === false) {
        reject(new Error(`Home Assistant WebSocket error for ${type}: ${JSON.stringify(message.error)}`));
        return;
      }
      resolve(message.result);
      try {
        ws.close();
      } catch {}
    });

    ws.addEventListener("error", (event) => {
      cleanup();
      reject(new Error(`Home Assistant WebSocket connection failed: ${event.message || "unknown error"}`));
    });

    ws.addEventListener("close", () => {
      // If we have not resolved yet, the timeout or error handler will surface a useful failure.
    });
  });
}

async function backup() {
  const candidates = [
    ["backup", "create_automatic"],
    ["backup", "create"],
  ];

  const failures = [];
  for (const [domain, service] of candidates) {
    try {
      const result = await callService(domain, service, {});
      printJson({ backup_service: `${domain}.${service}`, result });
      return;
    } catch (error) {
      failures.push(`${domain}.${service}: ${error.message}`);
    }
  }

  fail(`Backup failed:\n${failures.join("\n")}`);
}

async function callService(domain, service, data) {
  const token = await loadHomeAssistantToken();
  const response = await fetch(restUrl(`/api/services/${domain}/${service}`), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data || {}),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST /api/services/${domain}/${service} failed with ${response.status} ${response.statusText}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

async function handleReload(scope) {
  const scopes = {
    automation: ["automation", "reload"],
    script: ["script", "reload"],
    scene: ["scene", "reload"],
    group: ["group", "reload"],
    template: ["homeassistant", "reload_custom_templates"],
    lovelace_resources: ["lovelace", "reload_resources"],
    all: ["homeassistant", "reload_all"],
  };

  const service = scopes[scope];
  if (!service) {
    fail(`Unsupported reload scope: ${scope}`);
  }

  const result = await callService(service[0], service[1], {});
  printJson({ reload_scope: scope, service: `${service[0]}.${service[1]}`, result });
}

async function handleCheckConfig() {
  const result = await restRequest("/api/config/core/check_config", { method: "POST" });
  if (result && result.result && result.result !== "valid") {
    exit(1);
  }
}

async function handleGetConfig() {
  printJson(await wsCommand("get_config"));
}

async function handleGetStates(entityId) {
  const states = await wsCommand("get_states");
  if (!entityId) {
    printJson(states);
    return;
  }
  const match = states.find((item) => item.entity_id === entityId);
  if (!match) {
    fail(`Entity not found: ${entityId}`);
  }
  printJson(match);
}

async function handleEntitySource(entityId) {
  const result = await wsCommand("entity/source");
  if (!entityId) {
    printJson(result);
    return;
  }
  const match = result[entityId];
  if (!match) {
    fail(`Entity source not found: ${entityId}`);
  }
  printJson({ [entityId]: match });
}

async function handleRenderTemplate(spec) {
  const template = await readArgText(spec, "Missing template input.");
  await restRequest("/api/template", {
    method: "POST",
    body: { template },
    expectText: true,
  });
}

async function handleValidateConfig(spec) {
  const payload = await readOptionalJson(spec);
  const result = await wsCommand("validate_config", payload);
  printJson(result);

  const invalid = Object.values(result || {}).some(
    (entry) => entry && typeof entry === "object" && entry.valid === false,
  );
  if (invalid) {
    exit(1);
  }
}

async function detectConfigDir() {
  const candidates = [
    process.env.HOMEASSISTANT_CONFIG_DIR,
    cwd(),
    "/config",
    `${process.env.HOME || ""}/.homeassistant`,
    `${process.env.HOME || ""}/homeassistant`,
    `${process.env.HOME || ""}/HomeAssistant`,
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      await readFile(`${dir}/configuration.yaml`, "utf8");
      stdout.write(`${dir}\n`);
      return;
    } catch {}
  }

  fail("Could not detect a Home Assistant config directory. Set HOMEASSISTANT_CONFIG_DIR or run from the config root.");
}

const command = argv[2];

if (!command || command === "help" || command === "--help" || command === "-h") {
  printHelp(0);
}

try {
  switch (command) {
    case "backup":
      await backup();
      break;
    case "check-config":
      await handleCheckConfig();
      break;
    case "get-config":
      await handleGetConfig();
      break;
    case "get-states":
      await handleGetStates(argv[3]);
      break;
    case "entity-source":
      await handleEntitySource(argv[3]);
      break;
    case "render-template":
      await handleRenderTemplate(argv[3]);
      break;
    case "validate-config":
      await handleValidateConfig(argv[3]);
      break;
    case "call-service": {
      const domain = argv[3];
      const service = argv[4];
      if (!domain || !service) {
        fail("Usage: ha-dev call-service <domain> <service> [json | @file | ->]");
      }
      const data = await readOptionalJson(argv[5]);
      printJson(await callService(domain, service, data));
      break;
    }
    case "reload":
      if (!argv[3]) {
        fail("Usage: ha-dev reload <scope>");
      }
      await handleReload(argv[3]);
      break;
    case "detect-config-dir":
      await detectConfigDir();
      break;
    default:
      printHelp(1);
  }
} catch (error) {
  fail(String(error.message || error));
}
