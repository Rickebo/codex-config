#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const CAPS = {
  lane: 120,
  status: 80,
  worktree: 200,
  commit_or_pr: 200,
  changed_files: { items: 20, chars: 240 },
  validation: { items: 12, command: 240, evidence: 300 },
  epistemic_claims: { items: 12, statement: 280 },
  blockers: { items: 5, resource: 240, error: 280 },
  next_action: 280,
  issues: { items: 15, issue: 360, fix_direction: 240, file_or_symbol: 180 },
};

const VALID_STATUSES = new Set([
  "completed",
  "complete",
  "failed",
  "blocked",
  "ready_for_review",
  "go",
  "no-go",
  "in_progress",
  "incomplete",
  "partial",
]);

const VALID_EPISTEMIC_TAGS = new Set(["FACT", "INFERENCE", "HYPOTHESIS", "UNKNOWN"]);

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

function cleanStatus(status) {
  if (typeof status !== "string") return "";
  let s = status.trim();
  s = s.replace(/^\[(FACT|INFERENCE|HYPOTHESIS|UNKNOWN)\]\s*/i, "").trim().toLowerCase();
  return s;
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
    "verdict",
    "issues",
    // Architectural mapping fields
    "entry_point",
    "key_paths",
    "caveats",
    "suggested_edit",
  ]);

  for (const key of Object.keys(report)) {
    if (!allowedFields.has(key)) errors.push(`Disallowed field detected: "${key}" (context hygiene violation)`);
  }

  const requiredFields = ["lane", "status", "changed_files", "validation", "epistemic_claims", "blockers"];
  for (const field of requiredFields) {
    if (!(field in report)) errors.push(`Missing required field: "${field}"`);
  }

  if (typeof report.lane === "string") {
    if (report.lane.length > CAPS.lane) errors.push(`lane exceeds ${CAPS.lane} characters`);
  }

  const normStatus = cleanStatus(report.status);
  if (!VALID_STATUSES.has(normStatus)) {
    errors.push(`status must be one of: "completed", "complete", "failed", "blocked", "ready_for_review", "go", "no-go" (found "${report.status}")`);
  }

  if (report.worktree !== undefined && report.worktree !== null) {
    if (typeof report.worktree !== "string") {
      errors.push(`worktree must be a string`);
    } else if (report.worktree.length > CAPS.worktree) {
      errors.push(`worktree exceeds ${CAPS.worktree} characters`);
    }
  }

  if (report.commit_or_pr !== undefined && report.commit_or_pr !== null) {
    if (typeof report.commit_or_pr !== "string") {
      errors.push(`commit_or_pr must be a string (or null)`);
    } else if (report.commit_or_pr.length > CAPS.commit_or_pr) {
      errors.push(`commit_or_pr exceeds ${CAPS.commit_or_pr} characters`);
    }
  }

  // Changed files
  if (Array.isArray(report.changed_files)) {
    if (report.changed_files.length > CAPS.changed_files.items) {
      errors.push(`changed_files exceeds ${CAPS.changed_files.items} items`);
    }
    for (const f of report.changed_files) {
      if (typeof f !== "string" || f.length > CAPS.changed_files.chars) {
        errors.push(`changed_file item exceeds ${CAPS.changed_files.chars} characters`);
      }
    }
  } else if (typeof report.changed_files === "string") {
    const s = report.changed_files.toLowerCase();
    if (!s.includes("none") && !s.includes("no files") && !s.includes("empty") && s.trim() !== "[]" && !s.includes("tombstone")) {
      errors.push(`changed_files as string must indicate no files changed (e.g. "none" or "[FACT] None.")`);
    }
  } else {
    errors.push(`changed_files must be an array of filenames (or "none")`);
  }

  // Validation
  if (Array.isArray(report.validation)) {
    if (report.validation.length > CAPS.validation.items) {
      errors.push(`validation exceeds ${CAPS.validation.items} items`);
    }
    for (const [idx, v] of report.validation.entries()) {
      if (typeof v === "string") {
        if (!v.includes("[FACT]") && !v.includes("FACT")) {
          errors.push(`validation[${idx}] string must include [FACT] evidence`);
        }
        if (v.length > CAPS.validation.evidence) {
          errors.push(`validation[${idx}] string exceeds ${CAPS.validation.evidence} characters`);
        }
      } else if (v && typeof v === "object") {
        const evidenceStr = typeof v.evidence === "string" ? v.evidence : "";
        const tag = v.epistemic_tag || (evidenceStr.includes("[FACT]") || evidenceStr.length > 0 ? "FACT" : undefined);
        if (tag !== "FACT") {
          errors.push(`validation[${idx}].epistemic_tag MUST be "FACT" or evidence must include [FACT]`);
        }
        if (typeof v.command !== "string" || v.command.length > CAPS.validation.command) {
          errors.push(`validation[${idx}].command must be string under ${CAPS.validation.command} chars`);
        }
        if (v.exit_code !== undefined && typeof v.exit_code !== "number") {
          errors.push(`validation[${idx}].exit_code must be integer`);
        }
        if (typeof v.evidence !== "string" || v.evidence.length > CAPS.validation.evidence) {
          errors.push(`validation[${idx}].evidence must be string under ${CAPS.validation.evidence} chars`);
        }
      } else {
        errors.push(`validation[${idx}] must be an object or string`);
      }
    }
  } else if (typeof report.validation === "string") {
    if (!report.validation.includes("[FACT]") && !report.validation.includes("FACT")) {
      errors.push(`validation string must include [FACT] evidence`);
    }
  } else {
    errors.push(`validation must be an array`);
  }

  // Epistemic Claims
  if (Array.isArray(report.epistemic_claims)) {
    if (report.epistemic_claims.length > CAPS.epistemic_claims.items) {
      errors.push(`epistemic_claims exceeds ${CAPS.epistemic_claims.items} items`);
    }
    for (const [idx, c] of report.epistemic_claims.entries()) {
      if (typeof c === "string") {
        const match = c.match(/^\[(FACT|INFERENCE|HYPOTHESIS|UNKNOWN)\]/i);
        if (!match && !c.includes("FACT") && !c.includes("INFERENCE")) {
          errors.push(`epistemic_claims[${idx}] string must start with [FACT], [INFERENCE], [HYPOTHESIS], or [UNKNOWN]`);
        }
        if (c.length > CAPS.epistemic_claims.statement) {
          errors.push(`epistemic_claims[${idx}] string exceeds ${CAPS.epistemic_claims.statement} chars`);
        }
      } else if (c && typeof c === "object") {
        let tag = c.tag;
        if (!tag && typeof c.statement === "string") {
          const m = c.statement.match(/^\[(FACT|INFERENCE|HYPOTHESIS|UNKNOWN)\]/i);
          if (m) tag = m[1].toUpperCase();
          else if (c.statement.length > 0) tag = "FACT";
        }
        if (!tag || !VALID_EPISTEMIC_TAGS.has(tag.toUpperCase())) {
          errors.push(`epistemic_claims[${idx}].tag must be one of: FACT, INFERENCE, HYPOTHESIS, UNKNOWN`);
        }
        if (typeof c.statement !== "string" || c.statement.length > CAPS.epistemic_claims.statement) {
          errors.push(`epistemic_claims[${idx}].statement must be non-empty string under ${CAPS.epistemic_claims.statement} chars`);
        }
      } else {
        errors.push(`epistemic_claims[${idx}] must be an object or string`);
      }
    }
  } else if (typeof report.epistemic_claims === "string") {
    if (!report.epistemic_claims.includes("[FACT]") && !report.epistemic_claims.includes("[INFERENCE]")) {
      errors.push(`epistemic_claims string must include epistemic tags`);
    }
  } else {
    errors.push(`epistemic_claims must be an array`);
  }

  // Blockers
  const isBlocked = normStatus === "blocked" || normStatus === "no-go";
  if (Array.isArray(report.blockers)) {
    if (isBlocked && report.blockers.length === 0) {
      errors.push(`status is "${report.status}" but blockers array is empty`);
    }
    if (!isBlocked && report.blockers.length > 0) {
      errors.push(`status is "${report.status}" but blockers array contains items (blockers must only exist when status is "blocked")`);
    }
    if (report.blockers.length > CAPS.blockers.items) {
      errors.push(`blockers exceeds ${CAPS.blockers.items} items`);
    }
    for (const [idx, b] of report.blockers.entries()) {
      if (typeof b === "string") {
        if (!b.includes("[FACT]") && !b.includes("FACT")) {
          errors.push(`blockers[${idx}] string must include [FACT] tag. Blockers cannot be based on INFERENCE or HYPOTHESIS.`);
        }
      } else if (b && typeof b === "object") {
        const tag = b.epistemic_tag || (typeof b.error_snippet === "string" && b.error_snippet.includes("[FACT]") ? "FACT" : undefined);
        if (tag !== "FACT") {
          errors.push(`blockers[${idx}].epistemic_tag MUST be "FACT". Blockers cannot be based on INFERENCE, HYPOTHESIS, or UNKNOWN.`);
        }
        const resource = b.command_or_resource || b.resource || "";
        if (typeof resource !== "string" || resource.trim().length === 0) {
          errors.push(`blockers[${idx}].command_or_resource must be non-empty`);
        }
        const err = b.error_snippet || b.error || "";
        if (typeof err !== "string" || err.trim().length === 0) {
          errors.push(`blockers[${idx}].error_snippet must contain factual error output`);
        }
      } else {
        errors.push(`blockers[${idx}] must be an object or string`);
      }
    }
  } else if (typeof report.blockers === "string") {
    const s = report.blockers.toLowerCase();
    const hasNone = s.includes("none") || s.includes("no blockers") || s.trim() === "[]";
    if (isBlocked && hasNone) {
      errors.push(`status is "${report.status}" but blockers indicates none`);
    }
    if (!isBlocked && !hasNone) {
      errors.push(`status is "${report.status}" but blockers contains: "${report.blockers}"`);
    }
    if (isBlocked && !hasNone && !report.blockers.includes("[FACT]") && !report.blockers.includes("FACT")) {
      errors.push(`blockers string must include [FACT] tag`);
    }
  } else {
    errors.push(`blockers must be an array or string`);
  }

  // Next action
  if (report.next_action !== undefined && report.next_action !== null) {
    if (typeof report.next_action !== "string" || report.next_action.length > CAPS.next_action) {
      errors.push(`next_action must be a string under ${CAPS.next_action} chars`);
    }
  }

  // Reviewer fields (optional)
  if (report.verdict !== undefined && report.verdict !== null) {
    if (!["pass", "fail"].includes(String(report.verdict).toLowerCase())) {
      errors.push(`verdict must be "pass" or "fail"`);
    }
  }

  if (report.issues !== undefined && report.issues !== null) {
    if (Array.isArray(report.issues)) {
      if (report.issues.length > CAPS.issues.items) {
        errors.push(`issues exceeds ${CAPS.issues.items} items`);
      }
      for (const [idx, issue] of report.issues.entries()) {
        if (!issue || typeof issue !== "object") {
          errors.push(`issues[${idx}] must be an object`);
          continue;
        }
        if (!["critical", "high", "medium", "low"].includes(issue.severity?.toLowerCase())) {
          errors.push(`issues[${idx}].severity must be critical, high, medium, or low`);
        }
        if (typeof issue.issue !== "string" || issue.issue.length > CAPS.issues.issue) {
          errors.push(`issues[${idx}].issue exceeds ${CAPS.issues.issue} characters`);
        }
      }
    } else {
      errors.push(`issues must be an array`);
    }
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
