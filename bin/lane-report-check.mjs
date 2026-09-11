#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const CAPS = {
  lane: 120,
  status: 80,
  summary: 600,
  changed_files: { items: 20, chars: 240 },
  validation: { items: 12, chars: 280 },
  blockers: { items: 8, chars: 280 },
  next_action: 300,
  issues: { items: 15, issue: 360, fix_direction: 240, file_or_symbol: 180 },
};

function usage() {
  console.error(
    [
      "Usage:",
      "  lane-report-check.mjs check <report.json>",
      "  lane-report-check.mjs compact <report.json> [--out <report.json>]",
      "  lane-report-check.mjs schema",
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

function trunc(value, max) {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (text.length <= max) return text;
  if (max <= 3) return text.slice(0, max);
  return `${text.slice(0, max - 3)}...`;
}

function stringArray(value, cap) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, cap.items).map((item) => trunc(item, cap.chars));
}

function compact(report) {
  const out = {
    lane: trunc(report?.lane, CAPS.lane),
    status: trunc(report?.status, CAPS.status),
    changed_files: stringArray(report?.changed_files, CAPS.changed_files),
    validation: stringArray(report?.validation, CAPS.validation),
    blockers: stringArray(report?.blockers, CAPS.blockers),
    next_action: trunc(report?.next_action, CAPS.next_action),
  };
  if ("summary" in (report || {})) out.summary = trunc(report.summary, CAPS.summary);
  if (Array.isArray(report?.issues)) {
    out.issues = report.issues.slice(0, CAPS.issues.items).map((issue) => ({
      severity: ["low", "medium", "high", "critical"].includes(issue?.severity)
        ? issue.severity
        : "low",
      file_or_symbol: trunc(issue?.file_or_symbol, CAPS.issues.file_or_symbol),
      issue: trunc(issue?.issue, CAPS.issues.issue),
      fix_direction: trunc(issue?.fix_direction, CAPS.issues.fix_direction),
    }));
  }
  return out;
}

function validate(report) {
  const errors = [];
  const allowed = new Set([
    "lane",
    "status",
    "summary",
    "changed_files",
    "validation",
    "blockers",
    "next_action",
    "issues",
  ]);
  for (const key of Object.keys(report || {})) {
    if (!allowed.has(key)) errors.push(`unsupported field: ${key}`);
  }
  for (const key of ["lane", "status", "next_action"]) {
    if (typeof report?.[key] !== "string" || report[key].trim().length === 0) {
      errors.push(`${key} must be a non-empty string`);
    }
  }
  if (typeof report?.lane === "string" && report.lane.length > CAPS.lane) {
    errors.push("lane exceeds 120 characters");
  }
  if (typeof report?.status === "string" && report.status.length > CAPS.status) {
    errors.push("status exceeds 80 characters");
  }
  if (typeof report?.summary === "string" && report.summary.length > CAPS.summary) {
    errors.push("summary exceeds 600 characters");
  }
  if (typeof report?.next_action === "string" && report.next_action.length > CAPS.next_action) {
    errors.push("next_action exceeds 300 characters");
  }
  for (const key of ["changed_files", "validation", "blockers"]) {
    if (!Array.isArray(report?.[key]) || !report[key].every((item) => typeof item === "string")) {
      errors.push(`${key} must be an array of strings`);
      continue;
    }
    const cap = CAPS[key];
    if (report[key].length > cap.items) errors.push(`${key} exceeds ${cap.items} items`);
    if (report[key].some((item) => item.length > cap.chars)) {
      errors.push(`${key} item exceeds ${cap.chars} characters`);
    }
  }
  if (Array.isArray(report?.issues)) {
    if (report.issues.length > CAPS.issues.items) errors.push("issues exceeds 15 items");
    for (const [idx, issue] of report.issues.entries()) {
      if (!["low", "medium", "high", "critical"].includes(issue?.severity)) {
        errors.push(`issues[${idx}].severity must be low/medium/high/critical`);
      }
      for (const key of ["file_or_symbol", "issue", "fix_direction"]) {
        if (typeof issue?.[key] !== "string" || issue[key].trim().length === 0) {
          errors.push(`issues[${idx}].${key} must be a non-empty string`);
        }
      }
      if (typeof issue?.file_or_symbol === "string" && issue.file_or_symbol.length > CAPS.issues.file_or_symbol) {
        errors.push(`issues[${idx}].file_or_symbol exceeds ${CAPS.issues.file_or_symbol} characters`);
      }
      if (typeof issue?.issue === "string" && issue.issue.length > CAPS.issues.issue) {
        errors.push(`issues[${idx}].issue exceeds ${CAPS.issues.issue} characters`);
      }
      if (typeof issue?.fix_direction === "string" && issue.fix_direction.length > CAPS.issues.fix_direction) {
        errors.push(`issues[${idx}].fix_direction exceeds ${CAPS.issues.fix_direction} characters`);
      }
    }
  } else if ("issues" in (report || {})) {
    errors.push("issues must be an array");
  }
  return errors;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    usage();
    process.exit(cmd ? 0 : 1);
  }

  if (cmd === "schema") {
    const schemaPath = path.join(process.env.HOME || "", ".codex", "pipeline", "lane-report.schema.json");
    process.stdout.write(fs.readFileSync(schemaPath, "utf8"));
    return;
  }

  const file = args._[1];
  if (!file) fail(`${cmd} requires <report.json>`);
  const report = readJson(path.resolve(process.cwd(), file));

  if (cmd === "check") {
    const errors = validate(report);
    if (errors.length > 0) fail(`invalid lane report:\n- ${errors.join("\n- ")}`);
    process.stdout.write("lane-report-ok\n");
    return;
  }

  if (cmd === "compact") {
    const out = compact(report);
    const text = `${JSON.stringify(out, null, 2)}\n`;
    if (args.out) {
      fs.writeFileSync(path.resolve(process.cwd(), args.out), text, "utf8");
    } else {
      process.stdout.write(text);
    }
    return;
  }

  usage();
  fail(`unknown command: ${cmd}`);
}

main();
