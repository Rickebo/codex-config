#!/usr/bin/env python3
"""Utility script to inspect and unblock stalled thread goals in ~/.codex/goals_1.sqlite."""

import argparse
import datetime
import sqlite3
import sys
import time

DB_PATH = "/home/rickebo/.codex/goals_1.sqlite"


def get_conn():
    return sqlite3.connect(DB_PATH)


def list_blocked(conn, hours=None):
    c = conn.cursor()
    query = 'SELECT thread_id, status, objective, updated_at_ms FROM thread_goals WHERE status = "blocked"'
    params = []
    if hours is not None:
        since_ms = int((time.time() - hours * 3600) * 1000)
        query += " AND updated_at_ms >= ?"
        params.append(since_ms)
    query += " ORDER BY updated_at_ms DESC"

    rows = c.execute(query, params).fetchall()
    print(f"Found {len(rows)} blocked goals" + (f" in the last {hours} hours:" if hours else ":"))
    for tid, status, obj, upd in rows:
        dt = datetime.datetime.fromtimestamp(upd / 1000).strftime("%Y-%m-%d %H:%M:%S")
        first_line = obj.strip().split("\n")[0][:100]
        print(f"[{dt}] {tid} -> {first_line}...")
    return rows


def unblock(conn, thread_ids):
    if not thread_ids:
        print("No thread IDs provided to unblock.")
        return 0
    c = conn.cursor()
    now_ms = int(time.time() * 1000)
    placeholders = ",".join("?" for _ in thread_ids)
    query = f'UPDATE thread_goals SET status = "active", updated_at_ms = ? WHERE thread_id IN ({placeholders}) AND status = "blocked"'
    c.execute(query, [now_ms] + list(thread_ids))
    conn.commit()
    print(f"Unblocked {c.rowcount} goals (reset to 'active').")
    return c.rowcount


def main():
    parser = argparse.ArgumentParser(description="Codex Goals Unblocker")
    parser.add_argument("--list", action="store_true", help="List all blocked goals")
    parser.add_argument("--hours", type=float, help="Filter by last N hours")
    parser.add_argument("--unblock", type=str, help="Thread ID to unblock")
    parser.add_argument("--unblock-recent", type=float, help="Unblock all goals blocked in the last N hours")
    parser.add_argument("--unblock-all", action="store_true", help="Unblock all blocked goals")

    args = parser.parse_args()
    conn = get_conn()

    if args.unblock:
        unblock(conn, [args.unblock])
    elif args.unblock_recent:
        rows = list_blocked(conn, hours=args.unblock_recent)
        if rows:
            tids = [r[0] for r in rows]
            unblock(conn, tids)
    elif args.unblock_all:
        rows = list_blocked(conn)
        if rows:
            tids = [r[0] for r in rows]
            unblock(conn, tids)
    else:
        list_blocked(conn, hours=args.hours)


if __name__ == "__main__":
    main()
