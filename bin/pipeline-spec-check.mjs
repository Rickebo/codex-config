#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

function usage() {
  console.error(
    [
      "Usage:",
      "  pipeline-spec-check.mjs --spec /abs/path/feature-spec.json [--out /abs/path/spec-check.json] [--strict]",
      "  pipeline-spec-check.mjs --spec /abs/path/feature-spec.json --format md [--out /abs/path/spec-check.md]",
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

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasGivenWhenThen(text) {
  if (!isNonEmptyString(text)) return false;
  const low = text.toLowerCase();
  return low.includes("given") && low.includes("when") && low.includes("then");
}

function renderMarkdown(result) {
  const lines = [];
  lines.push("# Spec Check Result");
  lines.push("");
  lines.push(`- Spec file: ${result.spec_file}`);
  lines.push(`- Checked at: ${result.checked_at}`);
  lines.push(`- OK: ${result.ok}`);
  lines.push("");
  lines.push("## Quality Gates");
  for (const [name, status] of Object.entries(result.quality_gates)) {
    lines.push(`- ${name}: ${status ? "PASS" : "FAIL"}`);
  }
  lines.push("");
  lines.push("## Summary");
  lines.push(`- requirements_total: ${result.summary.requirements_total}`);
  lines.push(`- must_total: ${result.summary.must_total}`);
  lines.push(`- acceptance_total: ${result.summary.acceptance_total}`);
  lines.push(`- tests_total: ${result.summary.tests_total}`);
  lines.push(`- trace_rows_total: ${result.summary.trace_rows_total}`);
  lines.push("");
  lines.push("## Errors");
  if (result.errors.length === 0) lines.push("- none");
  for (const err of result.errors) lines.push(`- ${err}`);
  lines.push("");
  lines.push("## Warnings");
  if (result.warnings.length === 0) lines.push("- none");
  for (const warn of result.warnings) lines.push(`- ${warn}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    usage();
    process.exit(0);
  }

  const specArg = `${args.spec || ""}`.trim();
  if (!specArg) {
    usage();
    process.exit(2);
  }
  const specPath = ensureAbsolute(specArg);
  if (!fs.existsSync(specPath)) {
    console.error(`spec file not found: ${specPath}`);
    process.exit(2);
  }

  let spec;
  try {
    spec = readJson(specPath);
  } catch (error) {
    console.error(`failed to parse spec json: ${error.message}`);
    process.exit(2);
  }

  const errors = [];
  const warnings = [];

  const requirements = Array.isArray(spec.requirements) ? spec.requirements : [];
  const acceptance = Array.isArray(spec.acceptance_criteria) ? spec.acceptance_criteria : [];
  const tests = Array.isArray(spec.test_plan) ? spec.test_plan : [];
  const traceRows = Array.isArray(spec.traceability) ? spec.traceability : [];
  const perspectives = Array.isArray(spec?.council?.perspectives) ? spec.council.perspectives : [];

  if (!isNonEmptyString(spec?.meta?.id)) errors.push("meta.id is required");
  if (!isNonEmptyString(spec?.meta?.title)) errors.push("meta.title is required");
  if (!isNonEmptyString(spec?.feature?.problem_statement)) {
    errors.push("feature.problem_statement is required");
  }

  if (requirements.length === 0) errors.push("requirements must contain at least one item");
  if (acceptance.length === 0) errors.push("acceptance_criteria must contain at least one item");
  if (tests.length === 0) errors.push("test_plan must contain at least one item");
  if (traceRows.length === 0) errors.push("traceability must contain at least one item");

  const reqIds = requirements.map((row) => row?.id).filter(Boolean);
  const acIds = acceptance.map((row) => row?.id).filter(Boolean);
  const testIds = tests.map((row) => row?.id).filter(Boolean);
  const reqSet = new Set(reqIds);
  const acSet = new Set(acIds);
  const testSet = new Set(testIds);

  if (reqSet.size !== reqIds.length) errors.push("requirement IDs must be unique");
  if (acSet.size !== acIds.length) errors.push("acceptance criteria IDs must be unique");
  if (testSet.size !== testIds.length) errors.push("test IDs must be unique");

  const mustReqs = requirements.filter((row) => row?.priority === "MUST");
  if (mustReqs.length === 0) errors.push("at least one MUST requirement is required");

  for (const row of acceptance) {
    if (!hasGivenWhenThen(row?.scenario)) {
      errors.push(`acceptance criterion ${row?.id || "<missing-id>"} must include Given/When/Then`);
    }
    const linked = Array.isArray(row?.requirement_ids) ? row.requirement_ids : [];
    if (linked.length === 0) {
      errors.push(`acceptance criterion ${row?.id || "<missing-id>"} must reference requirement_ids`);
    }
    for (const reqId of linked) {
      if (!reqSet.has(reqId)) {
        errors.push(`acceptance criterion ${row?.id || "<missing-id>"} references unknown requirement ${reqId}`);
      }
    }
  }

  for (const row of tests) {
    const linked = Array.isArray(row?.requirement_ids) ? row.requirement_ids : [];
    if (linked.length === 0) {
      errors.push(`test ${row?.id || "<missing-id>"} must reference requirement_ids`);
    }
    for (const reqId of linked) {
      if (!reqSet.has(reqId)) {
        errors.push(`test ${row?.id || "<missing-id>"} references unknown requirement ${reqId}`);
      }
    }
  }

  const traceByReq = new Map();
  for (const row of traceRows) {
    const reqId = row?.requirement_id;
    if (!reqId || !reqSet.has(reqId)) {
      errors.push(`trace row has unknown requirement_id: ${reqId || "<missing>"}`);
      continue;
    }
    if (traceByReq.has(reqId)) {
      warnings.push(`duplicate trace rows for ${reqId}; consolidating is recommended`);
    }
    traceByReq.set(reqId, row);
    for (const acId of row?.acceptance_ids || []) {
      if (!acSet.has(acId)) errors.push(`trace row ${reqId} references unknown acceptance ${acId}`);
    }
    for (const tstId of row?.test_ids || []) {
      if (!testSet.has(tstId)) errors.push(`trace row ${reqId} references unknown test ${tstId}`);
    }
    if (!Array.isArray(row?.review_checks) || row.review_checks.length === 0) {
      errors.push(`trace row ${reqId} must include review_checks`);
    }
    if (!Array.isArray(row?.validation_checks) || row.validation_checks.length === 0) {
      errors.push(`trace row ${reqId} must include validation_checks`);
    }
  }

  for (const req of requirements) {
    if (!traceByReq.has(req.id)) {
      errors.push(`requirement ${req.id} is missing traceability row`);
    }
  }

  for (const req of mustReqs) {
    const trace = traceByReq.get(req.id);
    if (!trace) continue;
    if (!Array.isArray(trace.acceptance_ids) || trace.acceptance_ids.length === 0) {
      errors.push(`MUST requirement ${req.id} needs at least one acceptance criterion`);
    }
    if (!Array.isArray(trace.test_ids) || trace.test_ids.length === 0) {
      errors.push(`MUST requirement ${req.id} needs at least one test`);
    }
  }

  if (perspectives.length < 3) {
    warnings.push("council.perspectives has fewer than 3 perspectives; coverage may be weak");
  }

  const qualityGates = {
    requirements_present: requirements.length > 0,
    acceptance_gherkin_present: acceptance.length > 0 && acceptance.every((row) => hasGivenWhenThen(row?.scenario)),
    traceability_complete: requirements.length > 0 && requirements.every((row) => traceByReq.has(row.id)),
    must_requirements_testable: mustReqs.every((req) => {
      const row = traceByReq.get(req.id);
      return row && Array.isArray(row.test_ids) && row.test_ids.length > 0;
    }),
    council_coverage_min_3: perspectives.length >= 3
  };

  const result = {
    ok: errors.length === 0,
    checked_at: new Date().toISOString(),
    spec_file: specPath,
    quality_gates: qualityGates,
    summary: {
      requirements_total: requirements.length,
      must_total: mustReqs.length,
      acceptance_total: acceptance.length,
      tests_total: tests.length,
      trace_rows_total: traceRows.length
    },
    errors,
    warnings
  };

  const format = `${args.format || "json"}`.toLowerCase();
  const outPath = args.out ? ensureAbsolute(`${args.out}`) : null;
  const strict = Boolean(args.strict);
  let payload = "";
  if (format === "md" || format === "markdown") {
    payload = renderMarkdown(result);
  } else {
    payload = `${JSON.stringify(result, null, 2)}\n`;
  }

  if (outPath) fs.writeFileSync(outPath, payload, "utf8");
  else process.stdout.write(payload);

  if (!result.ok || (strict && result.warnings.length > 0)) {
    process.exit(1);
  }
}

main();
