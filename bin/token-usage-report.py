#!/usr/bin/env python3
"""Report Codex token usage from session JSONL files."""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any
from urllib.error import URLError
from urllib.request import urlopen


USAGE_FIELDS = (
    "input_tokens",
    "cached_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
)
LABEL_WIDTH = 24
VALUE_WIDTH = 16
RULE_WIDTH = LABEL_WIDTH + (VALUE_WIDTH * 6)
OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models"
COST_FIELDS = (
    "uncached_input_cost",
    "cached_input_cost",
    "output_cost",
    "reasoning_cost",
    "request_cost",
    "total_cost",
)


@dataclass
class SessionUsage:
    path: Path
    date: str
    model: str
    token_count_events: int
    usage: dict[str, int]


@dataclass(frozen=True)
class OpenRouterPricing:
    model_id: str
    prompt: Decimal | None
    completion: Decimal | None
    input_cache_read: Decimal | None
    input_cache_write: Decimal | None
    internal_reasoning: Decimal | None
    request: Decimal | None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate a monthly token usage report from Codex session JSONL files."
    )
    parser.add_argument(
        "--sessions-dir",
        type=Path,
        default=Path.home() / ".codex" / "sessions",
        help="Root sessions directory. Defaults to ~/.codex/sessions.",
    )
    parser.add_argument(
        "--month",
        default=datetime.now().strftime("%Y-%m"),
        help="Month to report as YYYY-MM. Defaults to the current month. Ignored with --all-months.",
    )
    parser.add_argument(
        "--all-months",
        action="store_true",
        help="Report every month found under the sessions directory, plus an all-time total.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit machine-readable JSON instead of a text report.",
    )
    progress_group = parser.add_mutually_exclusive_group()
    progress_group.add_argument(
        "--progress",
        dest="progress",
        action="store_true",
        default=None,
        help="Show a progress bar on stderr. This is automatic in interactive terminals.",
    )
    progress_group.add_argument(
        "--no-progress",
        dest="progress",
        action="store_false",
        help="Disable the progress bar.",
    )
    parser.add_argument(
        "--top",
        type=int,
        default=10,
        help="Number of largest sessions to show in the text report. Defaults to 10.",
    )
    parser.add_argument(
        "--threads",
        type=int,
        default=8,
        help="Number of worker threads used to scan session files. Defaults to 8.",
    )
    parser.add_argument(
        "--openrouter-pricing",
        action="store_true",
        help="Fetch OpenRouter model pricing and include hypothetical OpenRouter costs.",
    )
    parser.add_argument(
        "--openrouter-model-map",
        action="append",
        default=[],
        metavar="LOCAL=OPENROUTER_ID",
        help="Map a local model name to an OpenRouter model id. Can be repeated.",
    )
    return parser.parse_args()


def month_dir(sessions_dir: Path, month: str) -> Path:
    try:
        year, month_num = month.split("-", 1)
        if len(year) != 4 or len(month_num) != 2:
            raise ValueError
        int(year)
        int(month_num)
    except ValueError as exc:
        raise SystemExit("--month must use YYYY-MM format") from exc

    return sessions_dir / year / month_num


def month_name_from_dir(path: Path) -> str:
    return f"{path.parent.name}-{path.name}"


def discover_month_dirs(sessions_dir: Path) -> list[Path]:
    if not sessions_dir.exists():
        raise SystemExit(f"No sessions directory found: {sessions_dir}")

    months: list[Path] = []
    for year_dir in sorted(sessions_dir.iterdir()):
        if not year_dir.is_dir() or not year_dir.name.isdigit() or len(year_dir.name) != 4:
            continue
        for month_path in sorted(year_dir.iterdir()):
            if not month_path.is_dir() or not month_path.name.isdigit() or len(month_path.name) != 2:
                continue
            months.append(month_path)
    return months


def empty_usage() -> dict[str, int]:
    return {field: 0 for field in USAGE_FIELDS}


def empty_cost() -> dict[str, Decimal]:
    return {field: Decimal("0") for field in COST_FIELDS}


class ProgressBar:
    def __init__(self, total: int, enabled: bool, label: str = "Scanning sessions") -> None:
        self.total = total
        self.enabled = enabled
        self.label = label
        self.current = 0
        self.last_render = 0.0
        self.last_rendered_current = -1

    def advance(self) -> None:
        self.current += 1
        self.render()

    def render(self, force: bool = False) -> None:
        if not self.enabled:
            return
        now = time.monotonic()
        if not force and now - self.last_render < 0.1 and self.current < self.total:
            return
        self.last_render = now

        width = 30
        if self.total <= 0:
            filled = 0
            percent = 100
        else:
            filled = min(width, round(width * self.current / self.total))
            percent = min(100, round(100 * self.current / self.total))
        bar = "#" * filled + "-" * (width - filled)
        message = f"\r{self.label} [{bar}] {self.current}/{self.total} {percent:3d}%"
        sys.stderr.write(message)
        sys.stderr.flush()
        self.last_rendered_current = self.current

    def finish(self) -> None:
        if not self.enabled:
            return
        self.current = max(self.current, self.total)
        if self.last_rendered_current != self.current:
            self.render(force=True)
        sys.stderr.write("\n")
        sys.stderr.flush()


def normalize_usage(raw: dict[str, Any]) -> dict[str, int]:
    usage = empty_usage()
    for field in USAGE_FIELDS:
        value = raw.get(field, 0)
        if isinstance(value, bool):
            continue
        if isinstance(value, int):
            usage[field] = value
    return usage


def session_date_from_path(path: Path) -> str:
    parent = path.parent.name
    if parent.isdigit() and len(parent) == 2:
        try:
            year = path.parent.parent.parent.name
            month = path.parent.parent.name
            return f"{year}-{month}-{parent}"
        except IndexError:
            pass
    return "unknown"


def read_session_usage(path: Path) -> SessionUsage | None:
    final_usage: dict[str, int] | None = None
    token_count_events = 0
    model = "unknown"
    date = session_date_from_path(path)

    with path.open("r", encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{line_number}: invalid JSON: {exc}") from exc

            payload = record.get("payload")
            if not isinstance(payload, dict):
                continue

            if record.get("type") == "turn_context" and isinstance(payload.get("model"), str):
                model = payload["model"]

            if record.get("type") == "session_meta" and date == "unknown":
                timestamp = payload.get("timestamp")
                if isinstance(timestamp, str) and len(timestamp) >= 10:
                    date = timestamp[:10]

            if payload.get("type") != "token_count":
                continue

            info = payload.get("info")
            if not isinstance(info, dict):
                continue
            total_usage = info.get("total_token_usage")
            if not isinstance(total_usage, dict):
                continue

            token_count_events += 1
            final_usage = normalize_usage(total_usage)

    if final_usage is None:
        return None

    return SessionUsage(
        path=path,
        date=date,
        model=model,
        token_count_events=token_count_events,
        usage=final_usage,
    )


def add_usage(target: dict[str, int], usage: dict[str, int]) -> None:
    for field in USAGE_FIELDS:
        target[field] += usage.get(field, 0)


def format_int(value: int) -> str:
    return f"{value:,}"


def format_usd(value: Decimal) -> str:
    return f"${value.quantize(Decimal('0.0001')):,.4f}"


def decimal_from_pricing(value: Any) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def parse_model_map(values: list[str]) -> dict[str, str]:
    model_map: dict[str, str] = {}
    for value in values:
        local, separator, openrouter_id = value.partition("=")
        if not separator or not local or not openrouter_id:
            raise SystemExit("--openrouter-model-map values must use LOCAL=OPENROUTER_ID")
        model_map[local] = openrouter_id
    return model_map


def default_openrouter_model_id(model: str, model_map: dict[str, str]) -> str:
    if model in model_map:
        return model_map[model]
    if "/" in model:
        return model
    return f"openai/{model}"


def fetch_openrouter_pricing(model_map: dict[str, str]) -> dict[str, OpenRouterPricing]:
    try:
        with urlopen(OPENROUTER_MODELS_URL, timeout=30) as response:
            payload = json.load(response)
    except (OSError, URLError, json.JSONDecodeError) as exc:
        raise SystemExit(f"Failed to fetch OpenRouter pricing: {exc}") from exc

    pricing_by_id: dict[str, OpenRouterPricing] = {}
    for model in payload.get("data", []):
        if not isinstance(model, dict):
            continue
        model_id = model.get("id")
        raw_pricing = model.get("pricing")
        if not isinstance(model_id, str) or not isinstance(raw_pricing, dict):
            continue
        pricing_by_id[model_id] = OpenRouterPricing(
            model_id=model_id,
            prompt=decimal_from_pricing(raw_pricing.get("prompt")),
            completion=decimal_from_pricing(raw_pricing.get("completion")),
            input_cache_read=decimal_from_pricing(raw_pricing.get("input_cache_read")),
            input_cache_write=decimal_from_pricing(raw_pricing.get("input_cache_write")),
            internal_reasoning=decimal_from_pricing(raw_pricing.get("internal_reasoning")),
            request=decimal_from_pricing(raw_pricing.get("request")),
        )

    for local_model, openrouter_id in model_map.items():
        if openrouter_id not in pricing_by_id:
            raise SystemExit(
                f"OpenRouter model map for {local_model!r} points to unknown model {openrouter_id!r}"
            )

    return pricing_by_id


def add_cost(target: dict[str, Decimal], cost: dict[str, Decimal]) -> None:
    for field in COST_FIELDS:
        target[field] += cost.get(field, Decimal("0"))


def calculate_cost(
    usage: dict[str, int],
    request_count: int,
    pricing: OpenRouterPricing,
) -> tuple[dict[str, Decimal], list[str]]:
    notes: list[str] = []
    cost = empty_cost()
    cached_input = usage["cached_input_tokens"]
    uncached_input = max(usage["input_tokens"] - cached_input, 0)
    reasoning_output = usage["reasoning_output_tokens"]
    output_tokens = usage["output_tokens"]

    if pricing.prompt is None:
        notes.append("missing_prompt_price")
    else:
        cost["uncached_input_cost"] = Decimal(uncached_input) * pricing.prompt

    if cached_input:
        if pricing.input_cache_read is not None:
            cost["cached_input_cost"] = Decimal(cached_input) * pricing.input_cache_read
        elif pricing.prompt is not None:
            cost["cached_input_cost"] = Decimal(cached_input) * pricing.prompt
            notes.append("cache_read_priced_as_prompt")
        else:
            notes.append("missing_cache_read_price")

    if pricing.internal_reasoning is not None and reasoning_output:
        visible_output = max(output_tokens - reasoning_output, 0)
        cost["reasoning_cost"] = Decimal(reasoning_output) * pricing.internal_reasoning
    else:
        visible_output = output_tokens
        if reasoning_output and pricing.internal_reasoning is None:
            notes.append("reasoning_priced_as_completion")

    if pricing.completion is None:
        if visible_output:
            notes.append("missing_completion_price")
    else:
        cost["output_cost"] = Decimal(visible_output) * pricing.completion

    if pricing.request is not None:
        cost["request_cost"] = Decimal(request_count) * pricing.request

    cost["total_cost"] = sum(cost[field] for field in COST_FIELDS if field != "total_cost")
    if pricing.input_cache_write is not None:
        notes.append("cache_write_not_counted_no_session_metric")
    return cost, notes


def thread_count(value: int) -> int:
    return max(1, value)


def build_report(
    root: Path,
    progress: ProgressBar | None = None,
    threads: int = 1,
) -> dict[str, Any]:
    if not root.exists():
        raise SystemExit(f"No session directory found: {root}")

    files = sorted(root.glob("*/*.jsonl"))
    sessions: list[SessionUsage] = []
    errors: list[str] = []

    if threads <= 1:
        for path in files:
            try:
                usage = read_session_usage(path)
            except ValueError as exc:
                errors.append(str(exc))
                continue
            finally:
                if progress is not None:
                    progress.advance()
            if usage is not None:
                sessions.append(usage)
    else:
        with ThreadPoolExecutor(max_workers=threads) as executor:
            future_to_path = {
                executor.submit(read_session_usage, path): path
                for path in files
            }
            for future in as_completed(future_to_path):
                usage = None
                try:
                    usage = future.result()
                except ValueError as exc:
                    errors.append(str(exc))
                finally:
                    if progress is not None:
                        progress.advance()
                if usage is not None:
                    sessions.append(usage)

    sessions.sort(key=lambda session: str(session.path))

    totals = empty_usage()
    by_day: dict[str, dict[str, int]] = defaultdict(empty_usage)
    by_model: dict[str, dict[str, int]] = defaultdict(empty_usage)

    for session in sessions:
        add_usage(totals, session.usage)
        add_usage(by_day[session.date], session.usage)
        add_usage(by_model[session.model], session.usage)

    return {
        "month": month_name_from_dir(root),
        "session_dir": str(root),
        "files_scanned": len(files),
        "sessions_with_usage": len(sessions),
        "sessions_without_usage": len(files) - len(sessions),
        "errors": errors,
        "totals": totals,
        "by_day": dict(sorted(by_day.items())),
        "by_model": dict(sorted(by_model.items())),
        "largest_sessions": [
            {
                "date": session.date,
                "model": session.model,
                "token_count_events": session.token_count_events,
                "usage": session.usage,
                "path": str(session.path),
            }
            for session in sorted(
                sessions,
                key=lambda item: item.usage.get("total_tokens", 0),
                reverse=True,
            )
        ],
    }


def pricing_cost_payload(cost: dict[str, Decimal]) -> dict[str, Decimal]:
    return {field: cost[field] for field in COST_FIELDS}


def apply_openrouter_pricing_to_month_report(
    report: dict[str, Any],
    pricing_by_id: dict[str, OpenRouterPricing],
    model_map: dict[str, str],
) -> None:
    by_model: dict[str, dict[str, Any]] = {}
    totals = empty_cost()
    missing_models: dict[str, int] = defaultdict(int)
    note_counts: dict[str, int] = defaultdict(int)

    for session in report["largest_sessions"]:
        local_model = session["model"]
        openrouter_id = default_openrouter_model_id(local_model, model_map)
        session["openrouter_model_id"] = openrouter_id
        pricing = pricing_by_id.get(openrouter_id)
        if pricing is None:
            missing_models[local_model] += 1
            session["openrouter_pricing_missing"] = True
            continue

        cost, notes = calculate_cost(
            usage=session["usage"],
            request_count=session["token_count_events"],
            pricing=pricing,
        )
        session["openrouter_cost"] = pricing_cost_payload(cost)
        if notes:
            session["openrouter_cost_notes"] = notes
            for note in notes:
                note_counts[note] += 1
        add_cost(totals, cost)

        model_entry = by_model.setdefault(
            local_model,
            {
                "openrouter_model_id": openrouter_id,
                "sessions": 0,
                "requests": 0,
                "cost": empty_cost(),
                "notes": defaultdict(int),
            },
        )
        model_entry["sessions"] += 1
        model_entry["requests"] += session["token_count_events"]
        add_cost(model_entry["cost"], cost)
        for note in notes:
            model_entry["notes"][note] += 1

    normalized_by_model = {}
    for model, entry in sorted(by_model.items()):
        normalized_by_model[model] = {
            "openrouter_model_id": entry["openrouter_model_id"],
            "sessions": entry["sessions"],
            "requests": entry["requests"],
            "cost": entry["cost"],
            "notes": dict(sorted(entry["notes"].items())),
        }

    report["openrouter_pricing"] = {
        "source": OPENROUTER_MODELS_URL,
        "cost_formula": (
            "uncached_input*prompt + cached_input*input_cache_read + "
            "output*completion + reasoning*internal_reasoning_when_available + request*request"
        ),
        "cache_write_tokens": "not_counted_no_session_metric",
        "total_cost": totals,
        "by_model": normalized_by_model,
        "missing_models": dict(sorted(missing_models.items())),
        "notes": dict(sorted(note_counts.items())),
    }


def apply_openrouter_pricing_to_all_months_report(
    report: dict[str, Any],
    pricing_by_id: dict[str, OpenRouterPricing],
    model_map: dict[str, str],
) -> None:
    totals = empty_cost()
    by_month: dict[str, dict[str, Decimal]] = {}
    by_model: dict[str, dict[str, Any]] = {}
    missing_models: dict[str, int] = defaultdict(int)
    note_counts: dict[str, int] = defaultdict(int)

    for month_report in report["months"]:
        apply_openrouter_pricing_to_month_report(month_report, pricing_by_id, model_map)
        month_pricing = month_report["openrouter_pricing"]
        add_cost(totals, month_pricing["total_cost"])
        by_month[month_report["month"]] = month_pricing["total_cost"]
        for model, count in month_pricing["missing_models"].items():
            missing_models[model] += count
        for note, count in month_pricing["notes"].items():
            note_counts[note] += count
        for model, entry in month_pricing["by_model"].items():
            aggregate = by_model.setdefault(
                model,
                {
                    "openrouter_model_id": entry["openrouter_model_id"],
                    "sessions": 0,
                    "requests": 0,
                    "cost": empty_cost(),
                    "notes": defaultdict(int),
                },
            )
            aggregate["sessions"] += entry["sessions"]
            aggregate["requests"] += entry["requests"]
            add_cost(aggregate["cost"], entry["cost"])
            for note, count in entry["notes"].items():
                aggregate["notes"][note] += count

    normalized_by_model = {}
    for model, entry in sorted(by_model.items()):
        normalized_by_model[model] = {
            "openrouter_model_id": entry["openrouter_model_id"],
            "sessions": entry["sessions"],
            "requests": entry["requests"],
            "cost": entry["cost"],
            "notes": dict(sorted(entry["notes"].items())),
        }

    report["openrouter_pricing"] = {
        "source": OPENROUTER_MODELS_URL,
        "cost_formula": (
            "uncached_input*prompt + cached_input*input_cache_read + "
            "output*completion + reasoning*internal_reasoning_when_available + request*request"
        ),
        "cache_write_tokens": "not_counted_no_session_metric",
        "total_cost": totals,
        "by_month": dict(sorted(by_month.items())),
        "by_model": normalized_by_model,
        "missing_models": dict(sorted(missing_models.items())),
        "notes": dict(sorted(note_counts.items())),
    }


def count_session_files(root: Path) -> int:
    return sum(1 for _ in root.glob("*/*.jsonl"))


def build_all_months_report(
    sessions_dir: Path,
    progress: ProgressBar | None = None,
    threads: int = 1,
) -> dict[str, Any]:
    month_reports = [
        build_report(path, progress=progress, threads=threads)
        for path in discover_month_dirs(sessions_dir)
    ]
    totals = empty_usage()
    by_model: dict[str, dict[str, int]] = defaultdict(empty_usage)
    files_scanned = 0
    sessions_with_usage = 0
    sessions_without_usage = 0
    errors: list[str] = []

    for report in month_reports:
        add_usage(totals, report["totals"])
        files_scanned += report["files_scanned"]
        sessions_with_usage += report["sessions_with_usage"]
        sessions_without_usage += report["sessions_without_usage"]
        errors.extend(report["errors"])
        for model, usage in report["by_model"].items():
            add_usage(by_model[model], usage)

    return {
        "session_dir": str(sessions_dir),
        "months_scanned": len(month_reports),
        "files_scanned": files_scanned,
        "sessions_with_usage": sessions_with_usage,
        "sessions_without_usage": sessions_without_usage,
        "errors": errors,
        "totals": totals,
        "by_month": {
            report["month"]: report["totals"]
            for report in month_reports
        },
        "by_model": dict(sorted(by_model.items())),
        "months": month_reports,
    }


def print_usage_row(label: str, usage: dict[str, int]) -> None:
    uncached_input = usage["input_tokens"] - usage["cached_input_tokens"]
    print(
        f"{label:<{LABEL_WIDTH}}"
        f"{format_int(usage['total_tokens']):>{VALUE_WIDTH}}"
        f"{format_int(usage['input_tokens']):>{VALUE_WIDTH}}"
        f"{format_int(usage['cached_input_tokens']):>{VALUE_WIDTH}}"
        f"{format_int(uncached_input):>{VALUE_WIDTH}}"
        f"{format_int(usage['output_tokens']):>{VALUE_WIDTH}}"
        f"{format_int(usage['reasoning_output_tokens']):>{VALUE_WIDTH}}"
    )


def print_cost_row(label: str, cost: dict[str, Decimal]) -> None:
    print(
        f"{label:<{LABEL_WIDTH}}"
        f"{format_usd(cost['total_cost']):>16}"
        f"{format_usd(cost['uncached_input_cost']):>16}"
        f"{format_usd(cost['cached_input_cost']):>16}"
        f"{format_usd(cost['output_cost']):>16}"
        f"{format_usd(cost['reasoning_cost']):>16}"
        f"{format_usd(cost['request_cost']):>16}"
    )


def print_openrouter_pricing_report(pricing_report: dict[str, Any]) -> None:
    print()
    print("Hypothetical OpenRouter cost")
    print(f"Pricing source: {pricing_report['source']}")
    print("Cache writes: not counted because session files do not include cache-write token counts")
    print()
    print_cost_row("TOTAL", pricing_report["total_cost"])
    print()
    print(
        f"{'Cost breakdown':<{LABEL_WIDTH}}"
        f"{'total':>16}"
        f"{'uncached in':>16}"
        f"{'cached in':>16}"
        f"{'output':>16}"
        f"{'reasoning':>16}"
        f"{'request':>16}"
    )
    print("-" * (LABEL_WIDTH + (16 * 6)))
    for model, entry in pricing_report["by_model"].items():
        label = model[:LABEL_WIDTH]
        print_cost_row(label, entry["cost"])

    if "by_month" in pricing_report:
        print()
        print("Cost by month")
        print("-" * (LABEL_WIDTH + (16 * 6)))
        for month, cost in pricing_report["by_month"].items():
            print_cost_row(month, cost)

    if pricing_report["missing_models"]:
        print()
        print("Missing OpenRouter pricing")
        for model, count in pricing_report["missing_models"].items():
            print(f"- {model}: {count} sessions")

    if pricing_report["notes"]:
        print()
        print("Pricing notes")
        for note, count in pricing_report["notes"].items():
            print(f"- {note}: {count} sessions")


def print_text_report(month: str, report: dict[str, Any], top: int) -> None:
    print(f"Codex token usage report for {month}")
    print(f"Session dir: {report['session_dir']}")
    print(
        "Files scanned: "
        f"{report['files_scanned']} "
        f"({report['sessions_with_usage']} with usage, "
        f"{report['sessions_without_usage']} without usage)"
    )
    if report["errors"]:
        print(f"Parse errors: {len(report['errors'])}")
    print()

    print_usage_row("TOTAL", report["totals"])
    print()

    print(
        f"{'Breakdown':<{LABEL_WIDTH}}"
        f"{'total':>{VALUE_WIDTH}}"
        f"{'input':>{VALUE_WIDTH}}"
        f"{'cached':>{VALUE_WIDTH}}"
        f"{'uncached in':>{VALUE_WIDTH}}"
        f"{'output':>{VALUE_WIDTH}}"
        f"{'reasoning':>{VALUE_WIDTH}}"
    )
    print("-" * RULE_WIDTH)
    for day, usage in report["by_day"].items():
        print_usage_row(day, usage)

    print()
    print("By model")
    print("-" * RULE_WIDTH)
    for model, usage in report["by_model"].items():
        print_usage_row(model[:24], usage)

    largest = report["largest_sessions"][: max(top, 0)]
    if largest:
        print()
        print(f"Largest {len(largest)} sessions")
        print("-" * RULE_WIDTH)
        for item in largest:
            label = f"{item['date']} {Path(item['path']).name[:40]}"
            print_usage_row(label[:24], item["usage"])

    if report["errors"]:
        print()
        print("Errors")
        for error in report["errors"]:
            print(f"- {error}")

    if "openrouter_pricing" in report:
        print_openrouter_pricing_report(report["openrouter_pricing"])


def print_all_months_text_report(report: dict[str, Any], top: int) -> None:
    print("Codex token usage report for all months")
    print(f"Session dir: {report['session_dir']}")
    print(
        "Months scanned: "
        f"{report['months_scanned']} | "
        "Files scanned: "
        f"{report['files_scanned']} "
        f"({report['sessions_with_usage']} with usage, "
        f"{report['sessions_without_usage']} without usage)"
    )
    if report["errors"]:
        print(f"Parse errors: {len(report['errors'])}")
    print()

    print_usage_row("ALL MONTHS", report["totals"])
    print()

    print(
        f"{'Month':<{LABEL_WIDTH}}"
        f"{'total':>{VALUE_WIDTH}}"
        f"{'input':>{VALUE_WIDTH}}"
        f"{'cached':>{VALUE_WIDTH}}"
        f"{'uncached in':>{VALUE_WIDTH}}"
        f"{'output':>{VALUE_WIDTH}}"
        f"{'reasoning':>{VALUE_WIDTH}}"
    )
    print("-" * RULE_WIDTH)
    for month, usage in report["by_month"].items():
        print_usage_row(month, usage)

    print()
    print("By model")
    print("-" * RULE_WIDTH)
    for model, usage in report["by_model"].items():
        print_usage_row(model[:24], usage)

    if "openrouter_pricing" in report:
        print_openrouter_pricing_report(report["openrouter_pricing"])

    for month_report in report["months"]:
        print()
        print("=" * RULE_WIDTH)
        print_text_report(month_report["month"], month_report, top)


def main() -> None:
    args = parse_args()
    sessions_dir = args.sessions_dir.expanduser()
    progress_enabled = args.progress if args.progress is not None else sys.stderr.isatty()
    threads = thread_count(args.threads)
    model_map = parse_model_map(args.openrouter_model_map)
    pricing_by_id = fetch_openrouter_pricing(model_map) if args.openrouter_pricing else None

    if args.all_months:
        month_paths = discover_month_dirs(sessions_dir)
        progress = ProgressBar(
            total=sum(count_session_files(path) for path in month_paths),
            enabled=progress_enabled,
        )
        report = build_all_months_report(sessions_dir, progress=progress, threads=threads)
        progress.finish()
        if pricing_by_id is not None:
            apply_openrouter_pricing_to_all_months_report(report, pricing_by_id, model_map)
        if args.json:
            print(json.dumps(report, indent=2, sort_keys=True, default=str))
        else:
            print_all_months_text_report(report, args.top)
        return

    root = month_dir(sessions_dir, args.month)
    progress = ProgressBar(
        total=count_session_files(root) if root.exists() else 0,
        enabled=progress_enabled,
    )
    report = build_report(root, progress=progress, threads=threads)
    progress.finish()
    if pricing_by_id is not None:
        apply_openrouter_pricing_to_month_report(report, pricing_by_id, model_map)

    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True, default=str))
    else:
        print_text_report(args.month, report, args.top)


if __name__ == "__main__":
    main()
