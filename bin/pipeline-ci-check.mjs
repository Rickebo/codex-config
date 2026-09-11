#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function usage() {
  console.error(
    [
      "Usage:",
      "  pipeline-ci-check.mjs [--runs-dir /abs/path] [--policy /abs/path/transitions.json]",
      "  pipeline-ci-check.mjs --run-dir /abs/path [--policy /abs/path/transitions.json]",
      "  pipeline-ci-check.mjs --runs-dir /abs/path --strict",
    ].join("\n"),
  );
}

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

function defaultPolicyPath() {
  const home = process.env.HOME || "";
  return path.join(home, ".codex", "pipeline", "transitions.json");
}

function defaultRunsDir() {
  const home = process.env.HOME || "";
  return path.join(home, ".codex", "pipeline", "runs");
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validateReportShape(report) {
  const required = [
    "stage",
    "status",
    "summary",
    "changed_files",
    "validation",
    "blockers",
    "next_action",
  ];
  for (const key of required) {
    if (!(key in report)) return `missing required field: ${key}`;
  }

  const stage = `${report.stage || ""}`.trim();
  const status = `${report.status || ""}`.trim();
  const validStages = new Set(["spec", "code", "review", "test", "validation"]);
  if (!validStages.has(stage)) return `invalid stage: ${stage}`;

  if (!isNonEmptyString(report.summary)) return "summary must be a non-empty string";
  if (!isStringArray(report.changed_files)) return "changed_files must be a string array";
  if (!isStringArray(report.validation)) return "validation must be a string array";
  if (!isStringArray(report.blockers)) return "blockers must be a string array";
  if (!isNonEmptyString(report.next_action)) return "next_action must be a non-empty string";

  if (stage === "spec") {
    if (!new Set(["pass", "fail"]).has(status)) {
      return "spec stage status must be pass or fail";
    }
  } else if (stage === "code") {
    if (!new Set(["ready_for_review", "blocked"]).has(status)) {
      return "code stage status must be ready_for_review or blocked";
    }
  } else if (!new Set(["pass", "fail"]).has(status)) {
    return `${stage} stage status must be pass or fail`;
  }

  if (stage === "spec" && status === "pass") {
    const routeTo = `${report.route_to || ""}`.trim();
    if (routeTo !== "code") return "spec pass route_to must be code";
    if (!isNonEmptyString(report.spec_file)) return "spec pass requires spec_file";
    if (!isNonEmptyString(report.spec_check_file)) return "spec pass requires spec_check_file";
  }
  if (stage === "spec" && status === "fail") {
    const routeTo = `${report.route_to || ""}`.trim();
    if (routeTo !== "spec") return "spec fail route_to must be spec";
  }

  if (status === "fail") {
    const routeTo = `${report.route_to || ""}`.trim();
    if (!routeTo) return "route_to is required when status is fail";
    if (stage === "review" && routeTo !== "code") return "review fail route_to must be code";
    if (stage === "test" && routeTo !== "code") return "test fail route_to must be code";
    if (stage === "validation" && !new Set(["code", "review", "test"]).has(routeTo)) {
      return "validation fail route_to must be one of code/review/test";
    }
  }

  return null;
}

function policyDecision(policy, stage, status) {
  const transitions = policy?.transitions?.[stage];
  if (!transitions) return [];
  const allowed = transitions[status];
  return Array.isArray(allowed) ? allowed : [];
}

function runDirectoriesFromArgs(args) {
  if (args["run-dir"]) {
    return [ensureAbsolute(`${args["run-dir"]}`)];
  }
  const runsDir = ensureAbsolute(`${args["runs-dir"] || defaultRunsDir()}`);
  if (!fs.existsSync(runsDir)) return [];
  return fs
    .readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(runsDir, entry.name))
    .sort();
}

function checkRun(runDir, policy, strict) {
  const errors = [];
  const warnings = [];
  const statePath = path.join(runDir, "state.json");
  if (!fs.existsSync(statePath)) {
    return {
      run_dir: runDir,
      ok: false,
      errors: ["missing state.json"],
      warnings,
      summary: null,
    };
  }

  let state;
  try {
    state = readJson(statePath);
  } catch (error) {
    return {
      run_dir: runDir,
      ok: false,
      errors: [`invalid JSON in state.json: ${error.message}`],
      warnings,
      summary: null,
    };
  }

  if (!Array.isArray(state.history)) errors.push("state.history must be an array");
  if (!isNonEmptyString(state.current_stage)) errors.push("state.current_stage must be a string");
  if (!Number.isFinite(Number(state.loop_count))) errors.push("state.loop_count must be numeric");
  if (!Number.isFinite(Number(state.max_loops))) errors.push("state.max_loops must be numeric");

  const history = Array.isArray(state.history) ? state.history : [];
  const initialStage = `${state.initial_stage || "code"}`.trim();
  let replayStage = initialStage;
  let replayLoops = 0;
  let pendingApproval = null;
  let transitionsCount = 0;
  let approvalEvents = 0;

  for (const [idx, event] of history.entries()) {
    const eventType = `${event.event || "transition"}`.trim();
    const stage = `${event.stage || ""}`.trim();
    const status = `${event.status || ""}`.trim();
    const reportFile = event.report_file ? ensureAbsolute(`${event.report_file}`) : null;

    if (eventType === "approval_required") {
      if (pendingApproval) {
        errors.push(`history[${idx}] approval_required while another approval is pending`);
      }
      if (stage !== replayStage) {
        errors.push(`history[${idx}] stage mismatch: expected ${replayStage}, got ${stage}`);
      }
      const requested = `${event.requested_next_stage || ""}`.trim();
      const allowed = policyDecision(policy, stage, status);
      if (!allowed.includes(requested)) {
        errors.push(
          `history[${idx}] requested_next_stage=${requested} not allowed for ${stage}/${status}`,
        );
      }
      if (reportFile && !fs.existsSync(reportFile)) {
        errors.push(`history[${idx}] missing report file: ${reportFile}`);
      }
      if (reportFile && fs.existsSync(reportFile)) {
        try {
          const report = readJson(reportFile);
          const reportError = validateReportShape(report);
          if (reportError) errors.push(`history[${idx}] invalid report: ${reportError}`);
          if (report.stage === "spec" && report.status === "pass") {
            const specFile = ensureAbsolute(`${report.spec_file || ""}`);
            const specCheckFile = ensureAbsolute(`${report.spec_check_file || ""}`);
            if (!fs.existsSync(specFile)) {
              errors.push(`history[${idx}] spec_file missing: ${specFile}`);
            }
            if (!fs.existsSync(specCheckFile)) {
              errors.push(`history[${idx}] spec_check_file missing: ${specCheckFile}`);
            } else {
              const check = readJson(specCheckFile);
              if (check?.ok !== true) {
                errors.push(`history[${idx}] spec_check_file reports ok=false`);
              }
            }
          }
        } catch (error) {
          errors.push(`history[${idx}] report parse error: ${error.message}`);
        }
      }
      pendingApproval = {
        stage,
        status,
        requested_next_stage: requested,
      };
      approvalEvents += 1;
      continue;
    }

    if (eventType === "approved_transition") {
      if (!pendingApproval) {
        errors.push(`history[${idx}] approved_transition without pending approval`);
      } else {
        const nextStage = `${event.next_stage || ""}`.trim();
        if (nextStage !== pendingApproval.requested_next_stage) {
          errors.push(
            `history[${idx}] approved next_stage ${nextStage} does not match pending ${pendingApproval.requested_next_stage}`,
          );
        }
        if (nextStage === "code" && new Set(["review", "test", "validation"]).has(replayStage)) {
          replayLoops += 1;
        }
        replayStage = nextStage;
        pendingApproval = null;
      }
      transitionsCount += 1;
      continue;
    }

    if (eventType === "loop_limit_exceeded") {
      continue;
    }

    if (stage !== replayStage) {
      errors.push(`history[${idx}] stage mismatch: expected ${replayStage}, got ${stage}`);
    }
    const nextStage = `${event.next_stage || ""}`.trim();
    const allowed = policyDecision(policy, stage, status);
    if (!allowed.includes(nextStage)) {
      errors.push(`history[${idx}] next_stage=${nextStage} not allowed for ${stage}/${status}`);
    }

    if (reportFile && !fs.existsSync(reportFile)) {
      errors.push(`history[${idx}] missing report file: ${reportFile}`);
    }
    if (reportFile && fs.existsSync(reportFile)) {
      try {
        const report = readJson(reportFile);
        const reportError = validateReportShape(report);
        if (reportError) errors.push(`history[${idx}] invalid report: ${reportError}`);
        if (report.stage === "spec" && report.status === "pass") {
          const specFile = ensureAbsolute(`${report.spec_file || ""}`);
          const specCheckFile = ensureAbsolute(`${report.spec_check_file || ""}`);
          if (!fs.existsSync(specFile)) {
            errors.push(`history[${idx}] spec_file missing: ${specFile}`);
          }
          if (!fs.existsSync(specCheckFile)) {
            errors.push(`history[${idx}] spec_check_file missing: ${specCheckFile}`);
          } else {
            const check = readJson(specCheckFile);
            if (check?.ok !== true) {
              errors.push(`history[${idx}] spec_check_file reports ok=false`);
            }
          }
        }
      } catch (error) {
        errors.push(`history[${idx}] report parse error: ${error.message}`);
      }
    }

    if (nextStage === "code" && new Set(["review", "test", "validation"]).has(stage)) {
      replayLoops += 1;
    }
    replayStage = nextStage;
    transitionsCount += 1;
  }

  if (pendingApproval) {
    if (!state.awaiting_approval) {
      errors.push("pending approval in history but state.awaiting_approval is null");
    }
  } else if (state.awaiting_approval) {
    errors.push("state.awaiting_approval set but no pending approval event in history");
  }

  if (state.current_stage !== replayStage) {
    errors.push(
      `state.current_stage mismatch: expected ${replayStage} from history replay, got ${state.current_stage}`,
    );
  }
  if (Number(state.loop_count) !== replayLoops) {
    errors.push(
      `state.loop_count mismatch: expected ${replayLoops} from history replay, got ${state.loop_count}`,
    );
  }
  const expectedDone = state.current_stage === "done";
  if (Boolean(state.done) !== expectedDone) {
    errors.push(`state.done mismatch: expected ${expectedDone}, got ${state.done}`);
  }

  if (Number(state.loop_count) > Number(state.max_loops)) {
    const hasLoopExceeded = history.some((e) => `${e.event || ""}` === "loop_limit_exceeded");
    if (!hasLoopExceeded) {
      errors.push("loop_count exceeds max_loops but no loop_limit_exceeded event exists");
    }
  }

  if (state.initial_stage === "spec") {
    if (state.spec_gate?.passed !== true && ["code", "review", "test", "validation", "done"].includes(state.current_stage)) {
      errors.push("spec gate not marked as passed but run progressed beyond spec");
    }
    if (state.spec_gate?.passed === true) {
      if (!isNonEmptyString(state.spec_gate.spec_file)) {
        errors.push("spec_gate.passed=true but spec_gate.spec_file is missing");
      }
      if (!isNonEmptyString(state.spec_gate.spec_check_file)) {
        errors.push("spec_gate.passed=true but spec_gate.spec_check_file is missing");
      }
    }
  }

  const reportDir = path.join(runDir, "reports");
  if (!fs.existsSync(reportDir)) {
    warnings.push("missing reports/ directory");
  }

  if (strict) {
    const transitionCountFromHistory = history.filter(
      (e) => `${e.event || "transition"}` === "transition",
    ).length;
    if (transitionCountFromHistory === 0) {
      errors.push("strict mode: no transition events present");
    }
  }

  return {
    run_dir: runDir,
    ok: errors.length === 0,
    errors,
    warnings,
    summary: {
      current_stage: state.current_stage,
      done: Boolean(state.done),
      loop_count: Number(state.loop_count),
      max_loops: Number(state.max_loops),
      transitions_count: transitionsCount,
      approval_events: approvalEvents,
    },
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    usage();
    process.exit(0);
  }

  const policyPath = ensureAbsolute(`${args.policy || defaultPolicyPath()}`);
  if (!fs.existsSync(policyPath)) {
    console.error(`policy not found: ${policyPath}`);
    process.exit(2);
  }
  const policy = readJson(policyPath);
  const strict = Boolean(args.strict);
  const runDirs = runDirectoriesFromArgs(args);

  if (runDirs.length === 0) {
    console.error("no pipeline runs found");
    process.exit(2);
  }

  const results = runDirs.map((runDir) => checkRun(runDir, policy, strict));
  const failed = results.filter((result) => !result.ok);
  const warnings = results.reduce((acc, result) => acc + result.warnings.length, 0);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: failed.length === 0,
        checked_runs: results.length,
        failed_runs: failed.length,
        warning_count: warnings,
        results,
      },
      null,
      2,
    )}\n`,
  );

  if (failed.length > 0) process.exit(1);
}

main();
