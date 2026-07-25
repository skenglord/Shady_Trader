#!/usr/bin/env python3
"""Create a new OKF concept document with correct frontmatter (SPEC.md §4).

Usage:
    python3 new_concept.py <bundle_root> <concept/path/without-md> \
        --type "Module" \
        [--title "Auth Service"] \
        [--description "Handles OAuth2 token lifecycle."] \
        [--resource https://github.com/org/repo/blob/main/src/auth] \
        [--tags auth,security] \
        [--timestamp 2026-07-06T12:00:00Z] [--no-timestamp] \
        [--no-sections] [--force]
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _okf_common import dump_frontmatter, is_reserved, now_iso8601, eprint  # noqa: E402


TEMPLATE_SECTIONS = """
# Overview

<!-- Describe what this concept represents and why it matters. -->

# Files

<!-- List the key files and line ranges for this concept.
     Example:
     - src/auth/handler.py (lines 1-80): OAuth2 flow entry point
     - src/auth/models.py (lines 10-45): Token schema -->

# Risks

<!-- Link to any Risk concepts triggered by this module.
     Example: [SQL injection in user query](/risks/sql-injection.md) -->

# Notes

<!-- Any additional context, edge cases, or references. -->
"""


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("bundle_root")
    p.add_argument("concept_path",
                    help="Path of the concept relative to the bundle root, "
                         "WITHOUT the .md suffix, e.g. modules/auth")
    p.add_argument("--type", required=True, dest="type_")
    p.add_argument("--title")
    p.add_argument("--description")
    p.add_argument("--resource")
    p.add_argument("--tags", help="comma-separated, e.g. auth,security")
    p.add_argument("--timestamp", help="ISO 8601 datetime; default: now (UTC)")
    p.add_argument("--no-timestamp", action="store_true")
    p.add_argument("--no-sections", action="store_true",
                    help="skip the placeholder body sections")
    p.add_argument("--force", action="store_true")
    args = p.parse_args()

    concept_path = args.concept_path
    if concept_path.endswith(".md"):
        concept_path = concept_path[:-3]
    basename = os.path.basename(concept_path) + ".md"
    if is_reserved(basename):
        eprint(f"'{basename}' is a reserved OKF filename (index.md/log.md) and "
               "cannot be used for a concept. Choose a different name.")
        sys.exit(1)

    target = os.path.join(args.bundle_root, concept_path + ".md")
    if os.path.exists(target) and not args.force:
        eprint(f"refusing to overwrite existing {target} (pass --force)")
        sys.exit(1)

    os.makedirs(os.path.dirname(target), exist_ok=True)

    if args.no_timestamp:
        timestamp = None
    else:
        timestamp = args.timestamp or now_iso8601()

    tags = [t.strip() for t in args.tags.split(",")] if args.tags else None

    fm_fields = [
        ("type", args.type_),
        ("title", args.title),
        ("description", args.description),
        ("resource", args.resource),
        ("tags", tags),
        ("timestamp", timestamp),
    ]
    frontmatter = dump_frontmatter(fm_fields)

    body = TEMPLATE_SECTIONS if not args.no_sections else "\n"

    with open(target, "w", encoding="utf-8") as f:
        f.write(frontmatter + "\n" + body)

    print(f"Created concept: {target}")
    print(f"  concept ID: {concept_path}")
    if not args.title:
        print("  note: no --title given; consumers may derive one from the filename.")
    if not args.description:
        print("  note: no --description given; add one before running gen_index.py "
              "for a useful index entry.")


if __name__ == "__main__":
    main()
