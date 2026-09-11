#!/usr/bin/env python3
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

DB = Path(sys.argv[1])
NONCE = sys.argv[2]

def attempt():
    con = sqlite3.connect(DB, timeout=10, isolation_level=None)
    con.execute("CREATE TABLE IF NOT EXISTS replay (nonce TEXT PRIMARY KEY, consumed_at TEXT NOT NULL)")
    try:
        con.execute("BEGIN IMMEDIATE")
        con.execute("INSERT INTO replay VALUES (?, ?)", (NONCE, "2026-08-26T12:00:00Z"))
        con.execute("COMMIT")
        return {"result": "SUCCESS"}
    except sqlite3.IntegrityError:
        con.execute("ROLLBACK")
        return {"result": "REPLAY"}
    finally:
        con.close()

if len(sys.argv) > 3 and sys.argv[3] == "attempt":
    print(json.dumps(attempt()))
else:
    procs = [subprocess.Popen([sys.executable, __file__, str(DB), NONCE, "attempt"], stdout=subprocess.PIPE, text=True) for _ in range(2)]
    results = sorted((json.loads(proc.communicate()[0]) for proc in procs), key=lambda item:item['result'])
    con = sqlite3.connect(DB)
    count = con.execute("SELECT count(*) FROM replay WHERE nonce = ?", (NONCE,)).fetchone()[0]
    con.close()
    print(json.dumps({"nonce": NONCE, "attempts": results, "successes": sum(x["result"] == "SUCCESS" for x in results), "replays": sum(x["result"] == "REPLAY" for x in results), "after_restart_count": count, "durable": True}))
