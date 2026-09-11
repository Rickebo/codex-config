#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = "/home/rickebo/.codex";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codex-launchers-"));
const stub = path.join(tmp, "codex");

fs.writeFileSync(
  stub,
  [
    "#!/usr/bin/env node",
    "process.stdout.write(JSON.stringify(process.argv.slice(2)))",
    "",
  ].join("\n"),
  "utf8",
);
fs.chmodSync(stub, 0o755);

const env = { ...process.env, PATH: `${tmp}:${process.env.PATH || ""}` };

function run(script, args) {
  const result = spawnSync(path.join(root, "bin", script), args, {
    cwd: root,
    env,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`${script} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout || "[]");
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function includesPair(args, key, value) {
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] === key && args[i + 1] === value) return true;
  }
  return false;
}

function finalPrompt(args) {
  return args[args.length - 1] || "";
}

const fastHelp = run("codex-fast", ["--help"]);
assert(JSON.stringify(fastHelp) === JSON.stringify(["--help"]), "codex-fast --help must forward unchanged");

const fast = run("codex-fast", ["-C", "/tmp", "fix the thing"]);
assert(includesPair(fast, "-p", "fast"), "codex-fast must force fast profile");
assert(includesPair(fast, "-c", "features.multi_agent=false"), "codex-fast must disable multi-agent");
assert(includesPair(fast, "-c", "tool_output_token_limit=900"), "codex-fast must cap tool output");
assert(finalPrompt(fast).includes("Operating mode: fast."), "codex-fast must prepend fast seed");
assert(finalPrompt(fast).includes("fix the thing"), "codex-fast must preserve prompt");

const fastExecHelp = run("codex-fast", ["exec", "--help"]);
assert(
  JSON.stringify(fastExecHelp) === JSON.stringify(["exec", "--help"]),
  "codex-fast exec --help must forward unchanged",
);

const managerLiteHelp = run("codex-manager-lite", ["--help"]);
assert(
  JSON.stringify(managerLiteHelp) === JSON.stringify(["--help"]),
  "codex-manager-lite --help must forward unchanged",
);

const managerLite = run("codex-manager-lite", ["exec", "-C", "/tmp", "ship small patch"]);
assert(managerLite.includes("exec"), "codex-manager-lite exec must call codex exec");
assert(includesPair(managerLite, "-p", "manager"), "codex-manager-lite must use manager profile");
assert(includesPair(managerLite, "-s", "read-only"), "codex-manager-lite must default read-only");
assert(includesPair(managerLite, "-c", "agents.max_depth=1"), "codex-manager-lite must force depth 1");
assert(includesPair(managerLite, "-c", "agents.max_threads=4"), "codex-manager-lite must force threads 4");
assert(finalPrompt(managerLite).includes("Operating mode: manager-lite."), "manager-lite seed missing");

const pipelineLiteHelp = run("codex-pipeline-lite", ["exec", "--help"]);
assert(
  JSON.stringify(pipelineLiteHelp) === JSON.stringify(["exec", "--help"]),
  "codex-pipeline-lite exec --help must forward unchanged",
);

const pipelineLite = run("codex-pipeline-lite", ["run compact pipeline"]);
assert(includesPair(pipelineLite, "-p", "manager"), "codex-pipeline-lite must use manager profile");
assert(includesPair(pipelineLite, "-c", "agents.max_depth=1"), "codex-pipeline-lite must force depth 1");
assert(finalPrompt(pipelineLite).includes("pipeline-controller.mjs init --profile lite"), "pipeline-lite seed must mention lite profile");

process.stdout.write("launcher-contracts-ok\n");
