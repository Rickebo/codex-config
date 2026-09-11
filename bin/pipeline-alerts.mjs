#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok.startsWith("--")) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i += 1;
      }
    } else {
      out._.push(tok);
    }
  }
  return out;
}

function ensureAbsolute(p) {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function defaultRunsDir() {
  const home = process.env.HOME || "";
  return path.join(home, ".codex", "pipeline", "runs");
}

function dirs(runsDir) {
  if (!fs.existsSync(runsDir)) return [];
  return fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runsDir, entry.name))
    .sort();
}

function minutesSince(isoTime) {
  const t = Date.parse(isoTime);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return (Date.now() - t) / 60000;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runsDir = ensureAbsolute(`${args["runs-dir"] || defaultRunsDir()}`);
  const staleMinutes = Number(args["stale-minutes"] || 120);
  const approvalMinutes = Number(args["approval-minutes"] || 60);
  const loopRatio = Number(args["loop-ratio"] || 0.8);
  const failOnAlert = Boolean(args["fail-on-alert"]);

  const alerts = [];
  for (const runDir of dirs(runsDir)) {
    const statePath = path.join(runDir, "state.json");
    if (!fs.existsSync(statePath)) continue;

    let state;
    try {
      state = readJson(statePath);
    } catch {
      alerts.push({
        level: "error",
        type: "state_parse_failed",
        run_dir: runDir,
        message: "state.json is unreadable",
      });
      continue;
    }

    if (!state.done) {
      const idle = minutesSince(state.updated_at);
      if (idle >= staleMinutes) {
        alerts.push({
          level: "warning",
          type: "stale_run",
          run_dir: runDir,
          current_stage: state.current_stage,
          idle_minutes: Number(idle.toFixed(1)),
          message: `Run idle for ${Number(idle.toFixed(1))} minutes`,
        });
      }
    }

    if (state.awaiting_approval) {
      const wait = minutesSince(state.awaiting_approval.created_at);
      if (wait >= approvalMinutes) {
        alerts.push({
          level: "warning",
          type: "approval_waiting",
          run_dir: runDir,
          current_stage: state.current_stage,
          wait_minutes: Number(wait.toFixed(1)),
          gate: state.awaiting_approval.gate || null,
          reason: state.awaiting_approval.reason || null,
          message: `Approval pending for ${Number(wait.toFixed(1))} minutes`,
        });
      }
    }

    const maxLoops = Number(state.max_loops || 0);
    const loops = Number(state.loop_count || 0);
    if (maxLoops > 0 && loops / maxLoops >= loopRatio) {
      alerts.push({
        level: loops > maxLoops ? "error" : "warning",
        type: "loop_budget_risk",
        run_dir: runDir,
        loop_count: loops,
        max_loops: maxLoops,
        ratio: Number((loops / maxLoops).toFixed(3)),
        message: `Loop budget at ${(100 * loops / maxLoops).toFixed(1)}%`,
      });
    }
  }

  const payload = {
    generated_at: new Date().toISOString(),
    runs_dir: runsDir,
    alert_count: alerts.length,
    alerts,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);

  if (failOnAlert && alerts.length > 0) process.exit(1);
}

main();
