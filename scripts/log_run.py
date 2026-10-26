"""
log_run.py - append one line to data/run_log.csv for every scheduled pipeline run.

    python scripts/log_run.py <outcome>      outcome = updated | no-change | failed

The App performance page reads this file to show when the UN was last checked.
"""
import csv
import datetime
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
LOG = ROOT / "data" / "run_log.csv"

outcome = sys.argv[1] if len(sys.argv) > 1 else "unknown"
release = ""
try:
    release = json.loads((ROOT / "data" / "sdg7.json").read_text(encoding="utf-8")).get("release", "")
except (OSError, ValueError):
    pass

new = not LOG.exists()
with open(LOG, "a", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    if new:
        w.writerow(["checked_utc", "outcome", "release"])
    w.writerow([datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"), outcome, release])
print(f"logged {outcome} ({release})")
