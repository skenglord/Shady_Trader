#!/usr/bin/env python3
"""Append an entry to a bundle's log.md (SPEC.md §7): flat, date-grouped,
newest-first. Creates log.md if it doesn't exist yet.

Usage:
    python3 add_log_entry.py <bundle_root> [--dir <subdir>] \
        --kind Update --text "Added freshness SLA to [orders](/tables/orders.md)."
    python3 add_log_entry.py <bundle_root> --kind Creation \
        --text "Established the [orders table](/tables/orders.md)." --date 2026-05-22
"""
import argparse
import os
import re
import sys
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _okf_common import eprint  # noqa: E402

DATE_HEADING_RE = re.compile(r"^##\s+(\d{4}-\d{2}-\d{2})\s*$")
ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("bundle_root")
    p.add_argument("--dir", default=None,
                    help="Directory (relative to bundle_root) whose log.md to "
                         "update. Default: bundle root.")
    p.add_argument("--kind", default="Update",
                    help="Leading bold word, e.g. Update/Creation/Deprecation "
                         "(convention, not required by spec). Default: Update.")
    p.add_argument("--text", required=True, help="The log entry prose.")
    p.add_argument("--date", default=None,
                    help="ISO 8601 YYYY-MM-DD. Default: today (local date).")
    args = p.parse_args()

    if args.date and not ISO_DATE_RE.match(args.date):
        eprint(f"--date must be ISO 8601 YYYY-MM-DD, got: {args.date!r}")
        sys.exit(1)
    entry_date = args.date or date.today().isoformat()

    target_dir = os.path.join(args.bundle_root, args.dir) if args.dir else args.bundle_root
    if not os.path.isdir(target_dir):
        eprint(f"not a directory: {target_dir}")
        sys.exit(1)

    log_path = os.path.join(target_dir, "log.md")
    entry_line = f"* **{args.kind}**: {args.text}"

    if not os.path.exists(log_path):
        content = f"# Bundle Change Log\n\n## {entry_date}\n{entry_line}\n"
        with open(log_path, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"Created {log_path} with first entry.")
        return

    with open(log_path, "r", encoding="utf-8") as f:
        text = f.read()

    lines = text.split("\n")

    first_date_idx = None
    for i, line in enumerate(lines):
        if DATE_HEADING_RE.match(line.strip()):
            first_date_idx = i
            break

    if first_date_idx is None:
        if lines and lines[-1].strip() != "":
            lines.append("")
        lines.append(f"## {entry_date}")
        lines.append(entry_line)
        new_text = "\n".join(lines) + "\n"
    else:
        existing_date = DATE_HEADING_RE.match(lines[first_date_idx].strip()).group(1)
        if existing_date == entry_date:
            insert_at = first_date_idx + 1
            lines.insert(insert_at, entry_line)
            new_text = "\n".join(lines) + ("\n" if not lines[-1] == "" else "")
        else:
            new_section = [f"## {entry_date}", entry_line, ""]
            lines[first_date_idx:first_date_idx] = new_section
            new_text = "\n".join(lines)
            if not new_text.endswith("\n"):
                new_text += "\n"

    with open(log_path, "w", encoding="utf-8") as f:
        f.write(new_text)
    print(f"Appended to {log_path}: [{entry_date}] {entry_line}")


if __name__ == "__main__":
    main()
