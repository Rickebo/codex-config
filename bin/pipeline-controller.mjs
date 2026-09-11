#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function usage() {
  console.error(
    [
      "Usage:",
      "  pipeline-controller.mjs init --task \"...\" [--run-dir /abs/path] [--policy /abs/path/transitions.json] [--approval-rules /abs/path/approval-rules.json] [--profile lite|full|emergency] [--max-loops N]",
      "  pipeline-controller.mjs advance --run-dir /abs/path --report /abs/path/report.json [--policy /abs/path/transitions.json] [--approval-rules /abs/path/approval-rules.json]",
      "  pipeline-controller.mjs approve --run-dir /abs/path --approver \"name\" [--note \"...\"]",
      "  pipeline-controller.mjs status --run-dir /abs/path",
    ].join("\n"),
  );
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
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

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function defaultPolicyPath() {
  const home = process.env.HOME || "";
  return path.join(home, ".codex", "pipeline", "transitions.json");
}

function defaultApprovalRulesPath() {
  const home = process.env.HOME || "";
  return path.join(home, ".codex", "pipeline", "approval-rules.json");
}

function ensureAbsolute(p) {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

function nowIso() {
  return new Date().toISOString();
}

function safeRunId() {
  return nowIso().replace(/[:.]/g, "-");
}

function policyDecision(policy, stage, status) {
  const transitions = policy?.transitions?.[stage];
  if (!transitions) return [];
  const allowed = transitions[status];
  return Array.isArray(allowed) ? allowed : [];
}

function pipelineProfile(policy, requestedProfile) {
  const profiles = policy?.profiles && typeof policy.profiles === "object" ? policy.profiles : {};
  const defaultProfile = `${policy?.defaults?.profile || "full"}`.trim();
  const name = `${requestedProfile || defaultProfile || "full"}`.trim();
  if (requestedProfile && !profiles[name]) {
    fail(`unknown pipeline profile: ${name}`);
  }
  const profile = profiles[name] || {};
  return {
    name,
    max_loops: Number(profile.max_loops || policy?.defaults?.max_loops || 6),
    council: profile.council || { required: "risk_or_multilane", risk_threshold: "medium" },
  };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function safeSlug(value) {
  return `${value || ""}`.replace(/[^A-Za-z0-9._-]/g, "_");
}

function stripTrailingSlash(value) {
  return `${value || ""}`.replace(/[\\/]+$/, "");
}

function escapeRegexChar(ch) {
  return ch.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
}

function wildcardToRegex(pattern) {
  const src = `${pattern || ""}`;
  let out = "^";
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "*") {
      const next = src[i + 1];
      if (next === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/\\\\]*";
      }
      continue;
    }
    out += escapeRegexChar(ch);
  }
  out += "$";
  return new RegExp(out);
}

function matchesAnyGlob(filePath, globs) {
  if (!Array.isArray(globs) || globs.length === 0) return false;
  const normalized = stripTrailingSlash(filePath);
  return globs.some((glob) => {
    if (typeof glob !== "string" || glob.trim().length === 0) return false;
    return wildcardToRegex(glob).test(normalized);
  });
}

function ensureRunDirs(runDir) {
  const reportsDir = path.join(runDir, "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  return { reportsDir };
}

function copyReportIntoRun(runDir, reportPath, stage, status) {
  const { reportsDir } = ensureRunDirs(runDir);
  const stamp = nowIso().replace(/[:.]/g, "-");
  const fileName = `${stamp}_${safeSlug(stage)}_${safeSlug(status)}.json`;
  const target = path.join(reportsDir, fileName);
  fs.copyFileSync(reportPath, target);
  return target;
}

function severityRank(level) {
  const order = ["low", "medium", "high", "critical"];
  const idx = order.indexOf(`${level || ""}`.toLowerCase());
  return idx >= 0 ? idx : 0;
}

function maxIssueSeverity(report) {
  const issues = Array.isArray(report?.issues) ? report.issues : [];
  let max = "low";
  for (const issue of issues) {
    const level = `${issue?.severity || ""}`.toLowerCase();
    if (severityRank(level) > severityRank(max)) max = level;
  }
  return max;
}

function requireCouncilForReport(report, councilPolicy) {
  const required = `${councilPolicy?.required || "risk_or_multilane"}`.toLowerCase();
  if (required === "never" || required === "optional") return false;
  if (required === "always") return true;

  const minRisk = `${councilPolicy?.risk_threshold || "medium"}`.toLowerCase();
  const lanes = Array.isArray(report?.independent_lanes) ? report.independent_lanes : [];
  return (
    report?.requires_council === true ||
    lanes.length >= 2 ||
    severityRank(reportRiskLevel(report)) >= severityRank(minRisk)
  );
}

function reportRiskLevel(report) {
  const explicit = `${report?.risk_level || ""}`.toLowerCase().trim();
  if (["low", "medium", "high", "critical"].includes(explicit)) return explicit;
  return maxIssueSeverity(report);
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
  if (report.summary.length > 600) return "summary exceeds 600 characters";
  if (!isStringArray(report.changed_files)) return "changed_files must be a string array";
  if (report.changed_files.length > 20) return "changed_files exceeds 20 items";
  if (report.changed_files.some((item) => item.length > 240)) {
    return "changed_files item exceeds 240 characters";
  }
  if (!isStringArray(report.validation)) return "validation must be a string array";
  if (report.validation.length > 12) return "validation exceeds 12 items";
  if (report.validation.some((item) => item.length > 280)) {
    return "validation item exceeds 280 characters";
  }
  if (!isStringArray(report.blockers)) return "blockers must be a string array";
  if (report.blockers.length > 8) return "blockers exceeds 8 items";
  if (report.blockers.some((item) => item.length > 280)) {
    return "blockers item exceeds 280 characters";
  }
  if (!isNonEmptyString(report.next_action)) return "next_action must be a non-empty string";
  if (report.next_action.length > 300) return "next_action exceeds 300 characters";

  if ("independent_lanes" in report) {
    if (!isStringArray(report.independent_lanes)) {
      return "independent_lanes must be a string array";
    }
    if (report.independent_lanes.length > 12) return "independent_lanes exceeds 12 items";
    if (report.independent_lanes.some((item) => item.length > 160)) {
      return "independent_lanes item exceeds 160 characters";
    }
  }

  if ("requires_council" in report && typeof report.requires_council !== "boolean") {
    return "requires_council must be boolean";
  }

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

  if ("risk_level" in report) {
    const risk = `${report.risk_level || ""}`.toLowerCase().trim();
    if (!["low", "medium", "high", "critical"].includes(risk)) {
      return "risk_level must be low/medium/high/critical";
    }
  }

  if ("issues" in report) {
    if (!Array.isArray(report.issues)) return "issues must be an array";
    if (report.issues.length > 15) return "issues exceeds 15 items";
    for (const [idx, issue] of report.issues.entries()) {
      if (!issue || typeof issue !== "object") return `issues[${idx}] must be an object`;
      if (!isNonEmptyString(issue.id)) return `issues[${idx}].id must be a non-empty string`;
      if (issue.id.length > 80) return `issues[${idx}].id exceeds 80 characters`;
      if (!isNonEmptyString(issue.title)) return `issues[${idx}].title must be a non-empty string`;
      if (issue.title.length > 180) return `issues[${idx}].title exceeds 180 characters`;
      const sev = `${issue.severity || ""}`.toLowerCase().trim();
      if (!["low", "medium", "high", "critical"].includes(sev)) {
        return `issues[${idx}].severity must be low/medium/high/critical`;
      }
      if ("details" in issue && `${issue.details || ""}`.length > 800) {
        return `issues[${idx}].details exceeds 800 characters`;
      }
    }
  }

  return null;
}

function loadApprovalRules(rulesPath) {
  if (!rulesPath) return null;
  if (!fs.existsSync(rulesPath)) return null;
  return readJson(rulesPath);
}

function parseSpecCheck(checkPath) {
  if (!checkPath) return { ok: false, error: "spec_check_file is required" };
  if (!fs.existsSync(checkPath)) return { ok: false, error: `spec_check_file not found: ${checkPath}` };
  let parsed;
  try {
    parsed = readJson(checkPath);
  } catch (error) {
    return { ok: false, error: `spec_check_file parse failed: ${error.message}` };
  }
  if (parsed?.ok !== true) {
    const detail = Array.isArray(parsed?.errors) ? parsed.errors.join("; ") : "unknown spec check errors";
    return { ok: false, error: `spec check failed: ${detail}` };
  }
  return { ok: true, parsed };
}

function evaluateApprovalGate({ report, stage, status, nextStage, approvalRules }) {
  if (!approvalRules || approvalRules.enabled === false) return null;

  const changed = Array.isArray(report.changed_files) ? report.changed_files : [];
  const risk = reportRiskLevel(report);

  if (
    approvalRules.require_on_spec_to_code &&
    stage === "spec" &&
    status === "pass" &&
    nextStage === "code"
  ) {
    return {
      gate: "spec_to_code",
      reason: "Spec pass requires explicit approval before implementation starts.",
      risk_level: risk,
    };
  }

  if (
    approvalRules.require_on_validation_to_done &&
    stage === "validation" &&
    status === "pass" &&
    nextStage === "done"
  ) {
    return {
      gate: "validation_to_done",
      reason: "Validation pass requires explicit approval before done.",
      risk_level: risk,
    };
  }

  const minRisk = `${approvalRules.risk_threshold || "critical"}`.toLowerCase();
  if (severityRank(risk) >= severityRank(minRisk)) {
    return {
      gate: "risk_threshold",
      reason: `Risk level ${risk} meets or exceeds threshold ${minRisk}.`,
      risk_level: risk,
    };
  }

  const pathGlobs = Array.isArray(approvalRules.path_globs) ? approvalRules.path_globs : [];
  if (changed.some((filePath) => matchesAnyGlob(filePath, pathGlobs))) {
    return {
      gate: "path_glob",
      reason: "Changed files match approval-gated path globs.",
      risk_level: risk,
    };
  }

  return null;
}

function loadRunState(runDir) {
  const statePath = path.join(runDir, "state.json");
  if (!fs.existsSync(statePath)) fail(`state not found: ${statePath}`);
  return { statePath, state: readJson(statePath) };
}

function saveRunState(statePath, state) {
  state.updated_at = nowIso();
  writeJson(statePath, state);
}

function initRun(args) {
  const task = `${args.task || ""}`.trim();
  if (!task) fail("init requires --task");

  const policyPath = ensureAbsolute(`${args.policy || defaultPolicyPath()}`);
  if (!fs.existsSync(policyPath)) {
    fail(`policy not found: ${policyPath}`);
  }
  const policy = readJson(policyPath);
  const profile = pipelineProfile(policy, args.profile);
  const approvalRulesPath = ensureAbsolute(
    `${args["approval-rules"] || defaultApprovalRulesPath()}`,
  );
  const approvalRules = loadApprovalRules(approvalRulesPath);

  const runDir = ensureAbsolute(
    `${args["run-dir"] || path.join(process.env.HOME || "", ".codex", "pipeline", "runs", safeRunId())}`,
  );
  fs.mkdirSync(runDir, { recursive: true });
  ensureRunDirs(runDir);

  const maxLoopsRaw = args["max-loops"];
  const maxLoops = Number.isFinite(Number(maxLoopsRaw))
    ? Number(maxLoopsRaw)
    : Number(profile.max_loops || 6);
  if (!(maxLoops > 0)) fail("--max-loops must be a positive integer");

  const state = {
    version: 1,
    created_at: nowIso(),
    updated_at: nowIso(),
    task,
    policy_path: policyPath,
    approval_rules_path: approvalRules ? approvalRulesPath : null,
    initial_stage: "spec",
    current_stage: "spec",
    pipeline_profile: profile.name,
    done: false,
    max_loops: maxLoops,
    loop_count: 0,
    approval_required_count: 0,
    approvals: [],
    awaiting_approval: null,
    spec_gate: {
      passed: false,
      passed_at: null,
      spec_file: null,
      spec_check_file: null,
      council_file: null
    },
    council_policy: profile.council,
    history: [],
  };

  writeJson(path.join(runDir, "state.json"), state);
  fs.writeFileSync(path.join(runDir, "task.txt"), `${task}\n`, "utf8");

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        run_dir: runDir,
        state_file: path.join(runDir, "state.json"),
        current_stage: state.current_stage,
        pipeline_profile: state.pipeline_profile,
        max_loops: state.max_loops,
        council_policy: state.council_policy,
        approval_rules_enabled: Boolean(approvalRules),
        approval_rules_path: approvalRules ? approvalRulesPath : null,
      },
      null,
      2,
    )}\n`,
  );
}

function statusRun(args) {
  const runDir = `${args["run-dir"] || ""}`.trim();
  if (!runDir) fail("status requires --run-dir");

  const { state } = loadRunState(ensureAbsolute(runDir));

  process.stdout.write(`${JSON.stringify({ ok: true, state }, null, 2)}\n`);
}

function advanceRun(args) {
  const runDirArg = `${args["run-dir"] || ""}`.trim();
  const reportArg = `${args.report || ""}`.trim();
  if (!runDirArg) fail("advance requires --run-dir");
  if (!reportArg) fail("advance requires --report");

  const runDir = ensureAbsolute(runDirArg);
  const { statePath, state } = loadRunState(runDir);
  if (state.done) fail("run is already complete");
  if (state.awaiting_approval) {
    fail("run is awaiting approval; use approve command before advancing");
  }

  const reportPath = ensureAbsolute(reportArg);
  if (!fs.existsSync(reportPath)) fail(`report not found: ${reportPath}`);
  const report = readJson(reportPath);
  const reportError = validateReportShape(report);
  if (reportError) fail(`invalid report: ${reportError}`);

  const policyPath = ensureAbsolute(`${args.policy || state.policy_path || defaultPolicyPath()}`);
  if (!fs.existsSync(policyPath)) fail(`policy not found: ${policyPath}`);
  const policy = readJson(policyPath);
  const approvalRulesPath = ensureAbsolute(
    `${args["approval-rules"] || state.approval_rules_path || defaultApprovalRulesPath()}`,
  );
  const approvalRules = loadApprovalRules(approvalRulesPath);

  const stage = `${report.stage || ""}`.trim();
  const status = `${report.status || ""}`.trim();
  if (!stage || !status) fail("report must include stage and status");
  if (stage !== state.current_stage) {
    fail(`stage mismatch: expected ${state.current_stage}, got ${stage}`);
  }
  if (stage !== "spec" && state.initial_stage === "spec" && state.spec_gate?.passed !== true) {
    fail("spec gate is not passed; cannot advance non-spec stages");
  }

  const allowedNext = policyDecision(policy, stage, status);
  if (allowedNext.length === 0) {
    fail(`no transition configured for stage=${stage} status=${status}`);
  }

  let nextStage = allowedNext[0];
  const requestedRoute = `${report.route_to || ""}`.trim();
  if (requestedRoute) {
    if (!allowedNext.includes(requestedRoute)) {
      fail(
        `invalid route_to=${requestedRoute}; allowed values: ${allowedNext.join(", ")}`,
      );
    }
    nextStage = requestedRoute;
  }

  const reportCopyPath = copyReportIntoRun(runDir, reportPath, stage, status);

  let specGateCandidate = null;
  if (stage === "spec" && status === "pass") {
    const councilRequired = requireCouncilForReport(report, state.council_policy);
    if (councilRequired && !isNonEmptyString(report.council_file)) {
      fail("council_file is required by pipeline profile for this spec report");
    }

    const specFile = ensureAbsolute(`${report.spec_file || ""}`);
    if (!fs.existsSync(specFile)) {
      fail(`spec_file not found: ${specFile}`);
    }

    const specCheckFile = ensureAbsolute(`${report.spec_check_file || ""}`);
    const specCheck = parseSpecCheck(specCheckFile);
    if (!specCheck.ok) fail(specCheck.error);

    let councilFile = null;
    if (report.council_file) {
      councilFile = ensureAbsolute(`${report.council_file}`);
      if (!fs.existsSync(councilFile)) {
        fail(`council_file not found: ${councilFile}`);
      }
    }

    specGateCandidate = {
      spec_file: specFile,
      spec_check_file: specCheckFile,
      council_file: councilFile,
      checked_at: specCheck.parsed?.checked_at || nowIso(),
    };
  }

  const approvalGate = evaluateApprovalGate({
    report,
    stage,
    status,
    nextStage,
    approvalRules,
  });
  if (approvalGate) {
    state.awaiting_approval = {
      created_at: nowIso(),
      stage,
      status,
      requested_next_stage: nextStage,
      report_file: reportCopyPath,
      reason: approvalGate.reason,
      gate: approvalGate.gate,
      risk_level: approvalGate.risk_level,
      spec_gate: specGateCandidate,
    };
    state.approval_required_count = Number(state.approval_required_count || 0) + 1;
    state.history.push({
      at: nowIso(),
      event: "approval_required",
      stage,
      status,
      report_file: reportCopyPath,
      requested_next_stage: nextStage,
      gate: approvalGate.gate,
      reason: approvalGate.reason,
      risk_level: approvalGate.risk_level,
      spec_gate: specGateCandidate,
    });
    saveRunState(statePath, state);
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          approval_required: true,
          current_stage: state.current_stage,
          requested_next_stage: nextStage,
          gate: approvalGate.gate,
          reason: approvalGate.reason,
          risk_level: approvalGate.risk_level,
          loop_count: state.loop_count,
          max_loops: state.max_loops,
          state_file: statePath,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (nextStage === "code" && new Set(["review", "test", "validation"]).has(stage)) {
    state.loop_count += 1;
  }
  if (state.loop_count > state.max_loops) {
    state.history.push({
      at: nowIso(),
      event: "loop_limit_exceeded",
      stage,
      status,
      report_file: reportCopyPath,
      attempted_next_stage: nextStage,
      loop_count: state.loop_count,
      max_loops: state.max_loops,
    });
    saveRunState(statePath, state);
    fail(
      `loop limit exceeded (${state.loop_count} > ${state.max_loops}); escalate to human`,
    );
  }

  state.history.push({
    at: nowIso(),
    event: "transition",
    stage,
    status,
    report_file: reportCopyPath,
    next_stage: nextStage,
  });

  if (stage === "spec" && status === "pass" && nextStage === "code" && specGateCandidate) {
    state.spec_gate = {
      passed: true,
      passed_at: nowIso(),
      spec_file: specGateCandidate.spec_file,
      spec_check_file: specGateCandidate.spec_check_file,
      council_file: specGateCandidate.council_file,
    };
  }
  state.current_stage = nextStage;
  state.done = nextStage === "done";

  saveRunState(statePath, state);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        current_stage: state.current_stage,
        next_stage: nextStage,
        done: state.done,
        loop_count: state.loop_count,
        max_loops: state.max_loops,
        allowed_next: allowedNext,
        state_file: statePath,
      },
      null,
      2,
    )}\n`,
  );
}

function approveRun(args) {
  const runDirArg = `${args["run-dir"] || ""}`.trim();
  const approver = `${args.approver || ""}`.trim();
  const note = `${args.note || ""}`.trim();
  if (!runDirArg) fail("approve requires --run-dir");
  if (!approver) fail("approve requires --approver");

  const runDir = ensureAbsolute(runDirArg);
  const { statePath, state } = loadRunState(runDir);
  if (state.done) fail("run is already complete");
  if (!state.awaiting_approval) fail("run is not awaiting approval");

  const pending = state.awaiting_approval;
  const fromStage = `${pending.stage || state.current_stage}`.trim();
  const nextStage = `${pending.requested_next_stage || ""}`.trim();
  if (!nextStage) fail("awaiting approval is missing requested_next_stage");

  if (nextStage === "code" && new Set(["review", "test", "validation"]).has(fromStage)) {
    state.loop_count += 1;
  }
  if (state.loop_count > state.max_loops) {
    state.history.push({
      at: nowIso(),
      event: "loop_limit_exceeded",
      stage: fromStage,
      status: pending.status || "unknown",
      report_file: pending.report_file || null,
      attempted_next_stage: nextStage,
      loop_count: state.loop_count,
      max_loops: state.max_loops,
    });
    saveRunState(statePath, state);
    fail(
      `loop limit exceeded (${state.loop_count} > ${state.max_loops}); escalate to human`,
    );
  }

  const approvalEvent = {
    at: nowIso(),
    approver,
    note: note || null,
    gate: pending.gate || null,
    reason: pending.reason || null,
    risk_level: pending.risk_level || null,
    from_stage: fromStage,
    next_stage: nextStage,
    report_file: pending.report_file || null,
  };
  if (!Array.isArray(state.approvals)) state.approvals = [];
  state.approvals.push(approvalEvent);

  state.history.push({
    at: nowIso(),
    event: "approved_transition",
    stage: fromStage,
    status: pending.status || "unknown",
    report_file: pending.report_file || null,
    approver,
    note: note || null,
    next_stage: nextStage,
  });

  if (
    fromStage === "spec" &&
    pending.status === "pass" &&
    nextStage === "code" &&
    pending.spec_gate
  ) {
    state.spec_gate = {
      passed: true,
      passed_at: nowIso(),
      spec_file: pending.spec_gate.spec_file || null,
      spec_check_file: pending.spec_gate.spec_check_file || null,
      council_file: pending.spec_gate.council_file || null,
    };
  }

  state.awaiting_approval = null;
  state.current_stage = nextStage;
  state.done = nextStage === "done";
  saveRunState(statePath, state);

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        approved: true,
        approver,
        current_stage: state.current_stage,
        next_stage: nextStage,
        done: state.done,
        loop_count: state.loop_count,
        max_loops: state.max_loops,
        state_file: statePath,
      },
      null,
      2,
    )}\n`,
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    usage();
    process.exit(cmd ? 0 : 1);
  }

  if (cmd === "init") {
    initRun(args);
    return;
  }
  if (cmd === "advance") {
    advanceRun(args);
    return;
  }
  if (cmd === "approve") {
    approveRun(args);
    return;
  }
  if (cmd === "status") {
    statusRun(args);
    return;
  }

  usage();
  fail(`unknown command: ${cmd}`);
}

main();
