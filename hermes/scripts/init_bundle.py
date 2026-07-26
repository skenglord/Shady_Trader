#!/usr/bin/env python3
"""Scaffold a brand-new OKF bundle: root index.md (+ optional okf_version) and
an empty log.md. See SPEC.md §3, §6, §7, §11.

Usage:
    python3 init_bundle.py <path/to/bundle> [--okf-version 0.1] [--force]
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _okf_common import dump_frontmatter, eprint  # noqa: E402


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("bundle_root", help="Directory to create as the bundle root")
    p.add_argument("--okf-version", default="0.1",
                    help='Value for okf_version in the root index.md frontmatter '
                         '(default: 0.1). Pass --okf-version "" to omit it.')
    p.add_argument("--force", action="store_true",
                    help="Overwrite index.md/log.md if they already exist")
    args = p.parse_args()

    root = args.bundle_root
    os.makedirs(root, exist_ok=True)

    index_path = os.path.join(root, "index.md")
    log_path = os.path.join(root, "log.md")

    if os.path.exists(index_path) and not args.force:
        eprint(f"refusing to overwrite existing {index_path} (pass --force)")
        sys.exit(1)
    if os.path.exists(log_path) and not args.force:
        eprint(f"refusing to overwrite existing {log_path} (pass --force)")
        sys.exit(1)

    index_body = "# Concepts\n\n<!-- run gen_index.py to populate this automatically -->\n"
    if args.okf_version:
        fm = dump_frontmatter([("okf_version", args.okf_version)])
        index_content = fm + "\n\n" + index_body
    else:
        index_content = index_body

    with open(index_path, "w", encoding="utf-8") as f:
        f.write(index_content)

    log_content = "# Bundle Change Log\n"
    with open(log_path, "w", encoding="utf-8") as f:
        f.write(log_content)

    print(f"Created bundle root at {root}")
    print(f"  {index_path}")
    print(f"  {log_path}")
    print("Next: add concepts with new_concept.py, then gen_index.py / add_log_entry.py.")


if __name__ == "__main__":
    main()
