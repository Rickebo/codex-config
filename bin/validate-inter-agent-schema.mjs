#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const CAPS = {
  lane: 120,
  status: 80,
  worktree: 200,
  commit_or_pr: 80,
  changed_files: { items: 20, chars: 240 },
  validation: { items: 8, command: 240, evidence: 280 },
  epistemic_claims: { items: 6, statement: 240 },
  blockers: { items: 3, resource: 240, error: 280 },
  next_action: 200,
};

function usage() {
  console.error([
    "Usage:",
    "  validate-inter-agent-schema.mjs <report.json>",
    "  cat report.json | validate-inter-agent-schema.mjs -",
    "  validate-inter-agent-schema.mjs --schema",
  ].join("\n"));
}

function fail(message) {
  console.error(`VALIDATION FAILED:\n- ${message}`);
  process.exit(1);
}

function extractJson(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("```json")) {
    const match = trimmed.match(/```json\s*([\s\S]*?)\s*```/);
    if (match) return JSON.parse(match[1]);
  } else if (trimmed.startsWith("```")) {
    const match = trimmed.match(/```\s*([\s\S]*?)\s*```/);
    if (match) return JSON.parse(match[1]);
  }
  return JSON.parse(trimmed);
}

function validate(report) {
  const errors = [];
  if (!report || typeof report !== "object") {
    return ["Report must be a valid JSON object"];
  }

  const allowedFields = new Set([
    "lane",
    "status",
    "worktree",
    "commit_or_pr",
    "changed_files",
    "validation",
    "epistemic_claims",
    "blockers",
    "next_action",
  ]);

  for (const key of Object.keys(report)) {
    if (!allowedFields.has(key)) errors.push(`Disallowed field detected: "${key}" (context hygiene violation)`);
  }

  const requiredFields = ["lane", "status", "worktree", "changed_files", "validation", "epistemic_claims", "blockers", "next_action"];
  for (const field of requiredFields) {
    if (!(field in report)) errors.push(`Missing required field: "${field}"`);
  }

  if (typeof report.lane === "string") {
    if (report.lane.length > CAPS.lane) errors.push(`lane exceeds ${CAPS.lane} characters`);
  }
  if (!["completed", "failed", "blocked", "ready_for_review"].includes(report.status)) {
    errors.push(`status must be one of: "completed", "failed", "blocked", "ready_for_review"`);
  }

  if (typeof report.worktree === "string") {
    if (report.worktree.length > CAPS.worktree) errors.push(`worktree exceeds ${CAPS.worktree} characters`);
  }

  if (Array.isArray(report.changed_files)) {
    if (report.changed_files.length > CAPS.changed_files.items) {
      errors.push(`changed_files exceeds ${CAPS.changed_files.items} items`);
    }
    for (const f of report.changed_files) {
      if (typeof f !== "string" || f.length > CAPS.changed_files.chars) {
        errors.push(`changed_file item exceeds ${CAPS.changed_files.chars} characters`);
      }
    }
  } else {
    errors.push(`changed_files must be an array`);
  }

  if (Array.isArray(report.validation)) {
    if (report.validation.length > CAPS.validation.items) {
      errors.push(`validation exceeds ${CAPS.validation.items} items`);
    }
    for (const [idx, v] of report.validation.entries()) {
      if (!v || typeof v !== "object") {
        errors.push(`validation[${idx}] must be an object`);
        continue;
      }
      if (v.epistemic_tag !== "FACT") {
        errors.push(`validation[${idx}].epistemic_tag MUST be "FACT" (found "${v.epistemic_tag}")`);
      }
      if (typeof v.command !== "string" || v.command.length > CAPS.validation.command) {
        errors.push(`validation[${idx}].command must be string under ${CAPS.validation.command} chars`);
      }
      if (typeof v.exit_code !== "number") {
        errors.push(`validation[${idx}].exit_code must be integer`);
      }
      if (typeof v.evidence !== "string" || v.evidence.length > CAPS.validation.evidence) {
        errors.push(`validation[${idx}].evidence must be string under ${CAPS.validation.evidence} chars`);
      }
    }
  } else {
    errors.push(`validation must be an array`);
  }

  if (Array.isArray(report.epistemic_claims)) {
    if (report.epistemic_claims.length > CAPS.epistemic_claims.items) {
      errors.push(`epistemic_claims exceeds ${CAPS.epistemic_claims.items} items`);
    }
    for (const [idx, c] of report.epistemic_claims.entries()) {
      if (!c || typeof c !== "object") {
        errors.push(`epistemic_claims[${idx}] must be an object`);
        continue;
      }
      if (!["FACT", "INFERENCE", "HYPOTHESIS", "UNKNOWN"].includes(c.tag)) {
        errors.push(`epistemic_claims[${idx}].tag must be one of: FACT, INFERENCE, HYPOTHESIS, UNKNOWN`);
      }
      if (typeof c.statement !== "string" || c.statement.length > CAPS.epistemic_claims.statement) {
        errors.push(`epistemic_claims[${idx}].statement must be non-empty string under ${CAPS.epistemic_claims.statement} chars`);
      }
    }
  } else {
    errors.push(`epistemic_claims must be an array`);
  }

  if (Array.isArray(report.blockers)) {
    if (report.status === "blocked" && report.blockers.length === 0) {
      errors.push(`status is "blocked" but blockers array is empty`);
    }
    if (report.status !== "blocked" && report.blockers.length > 0) {
      errors.push(`status is "${report.status}" but blockers array contains items (blockers must only exist when status is "blocked")`);
    }
    if (report.blockers.length > CAPS.blockers.items) {
      errors.push(`blockers exceeds ${CAPS.blockers.items} items`);
    }
    for (const [idx, b] of report.blockers.entries()) {
      if (!b || typeof b !== "object") {
        errors.push(`blockers[${idx}] must be an object`);
        continue;
      }
      if (b.epistemic_tag !== "FACT") {
        errors.push(`blockers[${idx}].epistemic_tag MUST be "FACT". Blockers cannot be based on INFERENCE, HYPOTHESIS, or UNKNOWN.`);
      }
      if (typeof b.command_or_resource !== "string" || b.command_or_resource.trim().length === 0) {
        errors.push(`blockers[${idx}].command_or_resource must be non-empty`);
      }
      if (typeof b.error_snippet !== "string" || b.error_snippet.trim().length === 0) {
        errors.push(`blockers[${idx}].error_snippet must contain factual error output`);
      }
    }
  } else {
    errors.push(`blockers must be an array`);
  }

  if (typeof report.next_action !== "string" || report.next_action.length > CAPS.next_action) {
    errors.push(`next_action must be a string under ${CAPS.next_action} chars`);
  }

  return errors;
}

function main() {
  const arg = process.argv[2];
  if (!arg || arg === "-h" || arg === "--help") {
    usage();
    process.exit(arg ? 0 : 1);
  }

  if (arg === "--schema") {
    const schemaPath = path.join(process.env.HOME || "", ".codex", "pipeline", "inter-agent-report.schema.json");
    process.stdout.write(fs.readFileSync(schemaPath, "utf8"));
    return;
  }

  let raw;
  if (arg === "-") {
    raw = fs.readFileSync(0, "utf8");
  } else {
    raw = fs.readFileSync(path.resolve(process.cwd(), arg), "utf8");
  }

  let report;
  try {
    report = extractJson(raw);
  } catch (err) {
    fail(`Invalid JSON input: ${err.message}`);
  }

  const errors = validate(report);
  if (errors.length > 0) {
    fail(errors.join("\n- "));
  }

  console.log("INTER-AGENT-REPORT-OK: Valid schema with verified epistemic tags");
}

main();
