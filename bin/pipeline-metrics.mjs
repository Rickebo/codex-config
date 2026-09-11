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

function runDirs(runsDir) {
  if (!fs.existsSync(runsDir)) return [];
  return fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runsDir, entry.name))
    .sort();
}

function safeDiv(num, den) {
  if (!den) return 0;
  return num / den;
}

function topEntries(mapObj, limit = 10) {
  return Object.entries(mapObj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function renderMarkdown(summary) {
  const lines = [];
  lines.push("# Pipeline Metrics");
  lines.push("");
  lines.push(`- Generated at: ${summary.generated_at}`);
  lines.push(`- Runs scanned: ${summary.runs.total}`);
  lines.push(`- Completed: ${summary.runs.done}`);
  lines.push(`- Awaiting approval: ${summary.runs.awaiting_approval}`);
  lines.push(`- Loop-limit exceeded: ${summary.runs.loop_limit_exceeded}`);
  lines.push(`- Average loops per run: ${summary.runs.avg_loops.toFixed(2)}`);
  lines.push("");
  lines.push("## Stage Failure Rates");
  for (const stage of ["spec", "review", "test", "validation"]) {
    const stat = summary.stage_stats[stage];
    lines.push(
      `- ${stage}: attempts=${stat.attempts}, fails=${stat.fails}, fail_rate=${(stat.fail_rate * 100).toFixed(1)}%`,
    );
  }
  lines.push("");
  lines.push("## Top Blockers");
  for (const item of summary.top_blockers) {
    lines.push(`- ${item.key}: ${item.count}`);
  }
  lines.push("");
  lines.push("## Top Issue Titles");
  for (const item of summary.top_issue_titles) {
    lines.push(`- ${item.key}: ${item.count}`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runsDir = ensureAbsolute(`${args["runs-dir"] || defaultRunsDir()}`);
  const format = `${args.format || "json"}`.toLowerCase();
  const outPath = args.out ? ensureAbsolute(`${args.out}`) : null;
  const dirs = runDirs(runsDir);

  const stageStats = {
    spec: { attempts: 0, fails: 0, passes: 0 },
    code: { attempts: 0, fails: 0, passes: 0 },
    review: { attempts: 0, fails: 0, passes: 0 },
    test: { attempts: 0, fails: 0, passes: 0 },
    validation: { attempts: 0, fails: 0, passes: 0 },
  };
  const blockerCounts = {};
  const issueTitleCounts = {};

  let done = 0;
  let awaitingApproval = 0;
  let loopLimitExceeded = 0;
  let totalLoops = 0;
  let approvalEvents = 0;
  let transitions = 0;

  for (const runDir of dirs) {
    const statePath = path.join(runDir, "state.json");
    if (!fs.existsSync(statePath)) continue;
    let state;
    try {
      state = readJson(statePath);
    } catch {
      continue;
    }

    totalLoops += Number(state.loop_count || 0);
    if (state.done) done += 1;
    if (state.awaiting_approval) awaitingApproval += 1;

    const history = Array.isArray(state.history) ? state.history : [];
    if (history.some((event) => `${event.event || ""}` === "loop_limit_exceeded")) {
      loopLimitExceeded += 1;
    }
    approvalEvents += history.filter((event) => `${event.event || ""}` === "approval_required").length;

    for (const event of history) {
      const eventType = `${event.event || "transition"}`;
      if (eventType !== "transition" && eventType !== "approval_required") continue;
      transitions += 1;

      const stage = `${event.stage || ""}`;
      const status = `${event.status || ""}`;
      if (!stageStats[stage]) continue;
      stageStats[stage].attempts += 1;
      if (status === "fail" || status === "blocked") stageStats[stage].fails += 1;
      if (status === "pass" || status === "ready_for_review") stageStats[stage].passes += 1;

      const reportFile = `${event.report_file || ""}`.trim();
      if (!reportFile || !fs.existsSync(reportFile)) continue;
      let report;
      try {
        report = readJson(reportFile);
      } catch {
        continue;
      }
      const blockers = Array.isArray(report.blockers) ? report.blockers : [];
      for (const blocker of blockers) {
        const key = `${blocker || ""}`.trim();
        if (!key) continue;
        blockerCounts[key] = Number(blockerCounts[key] || 0) + 1;
      }

      const issues = Array.isArray(report.issues) ? report.issues : [];
      for (const issue of issues) {
        const title = `${issue?.title || ""}`.trim();
        if (!title) continue;
        issueTitleCounts[title] = Number(issueTitleCounts[title] || 0) + 1;
      }
    }
  }

  for (const stage of Object.keys(stageStats)) {
    const attempts = stageStats[stage].attempts;
    const fails = stageStats[stage].fails;
    stageStats[stage].fail_rate = safeDiv(fails, attempts);
  }

  const summary = {
    generated_at: new Date().toISOString(),
    runs_dir: runsDir,
    runs: {
      total: dirs.length,
      done,
      awaiting_approval: awaitingApproval,
      loop_limit_exceeded: loopLimitExceeded,
      avg_loops: safeDiv(totalLoops, dirs.length),
    },
    transitions,
    approval_events: approvalEvents,
    stage_stats: stageStats,
    top_blockers: topEntries(blockerCounts, Number(args["top-blockers"] || 10)),
    top_issue_titles: topEntries(issueTitleCounts, Number(args["top-issues"] || 10)),
  };

  let output = "";
  if (format === "md" || format === "markdown") {
    output = renderMarkdown(summary);
  } else {
    output = `${JSON.stringify(summary, null, 2)}\n`;
  }

  if (outPath) {
    fs.writeFileSync(outPath, output, "utf8");
  } else {
    process.stdout.write(output);
  }
}

main();
