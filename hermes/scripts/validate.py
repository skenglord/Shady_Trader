#!/usr/bin/env python3
"""Validate an OKF bundle's conformance (SPEC.md §9) plus optional soft-guidance
warnings and link checking.

Hard conformance rules (never optional, always checked):
  1. Every non-reserved .md file has a parseable YAML frontmatter block.
  2. Every such frontmatter block has a non-empty `type` field.
  3. Every index.md / log.md follows the §6 / §7 shape where present
     (no frontmatter, except a bundle-root index.md's `okf_version`; log.md
     date headings are ISO 8601 `## YYYY-MM-DD`, newest first).

Everything else (missing recommended fields, unknown `type` values, unknown
extra keys, broken links, missing index.md) is soft guidance per §9 and is
reported as a warning, never a failure -- unless --strict is passed, which
additionally fails on missing `title`/`description` for teams that want a
stricter house style than the spec mandates.

Usage:
    python3 validate.py <bundle_root> [--strict] [--check-links] [--quiet]

Exit code: 0 if conformant (given the flags used), 1 otherwise.
"""
import argparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _okf_common import (  # noqa: E402
    iter_markdown_files, iter_concept_files, is_reserved, split_frontmatter,
    parse_frontmatter, FrontmatterError, extract_links, resolve_link, concept_id,
)

DATE_HEADING_RE = re.compile(r"^##\s+(.*)$")
ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ISO_DATETIME_RE = re.compile(
    r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$"
)


def rel(bundle_root, path):
    return os.path.relpath(path, bundle_root)


def check_concepts(bundle_root, strict):
    rule1_failures = []
    rule2_failures = []
    strict_failures = []
    warnings = []
    checked = 0
    frontmatters = {}

    for path in iter_concept_files(bundle_root):
        checked += 1
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
        try:
            fm_text, body = split_frontmatter(text)
        except FrontmatterError as e:
            rule1_failures.append((rel(bundle_root, path), str(e)))
            continue
        if fm_text is None:
            rule1_failures.append((rel(bundle_root, path), "no frontmatter block found"))
            continue
        try:
            fm = parse_frontmatter(fm_text)
        except FrontmatterError as e:
            rule1_failures.append((rel(bundle_root, path), str(e)))
            continue

        frontmatters[path] = (fm, body)

        type_val = fm.get("type")
        if not type_val or not str(type_val).strip():
            rule2_failures.append(rel(bundle_root, path))
            continue

        r = rel(bundle_root, path)
        if not fm.get("title"):
            msg = f"{r}: missing recommended field `title`"
            (strict_failures if strict else warnings).append(msg)
        if not fm.get("description"):
            msg = f"{r}: missing recommended field `description`"
            (strict_failures if strict else warnings).append(msg)
        ts = fm.get("timestamp")
        if ts and not ISO_DATETIME_RE.match(str(ts)):
            warnings.append(f"{r}: `timestamp` value {ts!r} does not look like ISO 8601")
        tags = fm.get("tags")
        if tags is not None and not isinstance(tags, list):
            warnings.append(f"{r}: `tags` should be a YAML list")

    return {
        "checked": checked,
        "rule1_failures": rule1_failures,
        "rule2_failures": rule2_failures,
        "strict_failures": strict_failures,
        "warnings": warnings,
        "frontmatters": frontmatters,
    }


def check_index_files(bundle_root):
    rule3_failures = []
    warnings = []
    for path in iter_markdown_files(bundle_root):
        if os.path.basename(path) != "index.md":
            continue
        is_root = os.path.dirname(os.path.abspath(path)) == os.path.abspath(bundle_root)
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
        try:
            fm_text, body = split_frontmatter(text)
        except FrontmatterError as e:
            rule3_failures.append(f"{rel(bundle_root, path)}: {e}")
            continue
        r = rel(bundle_root, path)
        if fm_text is not None:
            if not is_root:
                rule3_failures.append(
                    f"{r}: non-root index.md must not have frontmatter (§6)"
                )
            else:
                try:
                    fm = parse_frontmatter(fm_text)
                    extra_keys = [k for k in fm if k != "okf_version"]
                    if extra_keys:
                        warnings.append(
                            f"{r}: root index.md frontmatter has keys other than "
                            f"`okf_version` ({extra_keys}); spec only defines "
                            f"`okf_version` here (§11)"
                        )
                except FrontmatterError as e:
                    rule3_failures.append(f"{r}: unparseable frontmatter: {e}")
        if not body.strip():
            warnings.append(f"{r}: index.md body is empty")
    return rule3_failures, warnings


def check_log_files(bundle_root):
    rule3_failures = []
    warnings = []
    for path in iter_markdown_files(bundle_root):
        if os.path.basename(path) != "log.md":
            continue
        r = rel(bundle_root, path)
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()
        try:
            fm_text, body = split_frontmatter(text)
        except FrontmatterError as e:
            rule3_failures.append(f"{r}: {e}")
            continue
        if fm_text is not None:
            rule3_failures.append(f"{r}: log.md must not have frontmatter (§7)")
            body = text

        dates_seen = []
        for line in body.split("\n"):
            m = DATE_HEADING_RE.match(line.strip())
            if not m:
                continue
            candidate = m.group(1).strip()
            if ISO_DATE_RE.match(candidate):
                dates_seen.append(candidate)
            else:
                rule3_failures.append(
                    f"{r}: '## {candidate}' is not an ISO 8601 YYYY-MM-DD date heading (§7)"
                )
        if dates_seen != sorted(dates_seen, reverse=True):
            warnings.append(f"{r}: date sections are not newest-first ({dates_seen})")
    return rule3_failures, warnings


def check_links(bundle_root, frontmatters):
    checked = 0
    broken = []
    for path, (fm, body) in frontmatters.items():
        for _text, url in extract_links(body):
            target = resolve_link(bundle_root, path, url)
            if target is None:
                continue
            checked += 1
            if not os.path.isfile(target):
                broken.append((concept_id(bundle_root, path), url))
    return checked, broken


def fmt_list(items, indent="    "):
    return "\n".join(f"{indent}- {i}" for i in items)


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("bundle_root")
    p.add_argument("--strict", action="store_true",
                    help="Also fail on missing recommended `title`/`description` fields.")
    p.add_argument("--check-links", action="store_true",
                    help="Resolve internal markdown links and report unresolved ones "
                         "(informational only -- never affects conformance, per §9/§5.3).")
    p.add_argument("--quiet", action="store_true", help="Only print the final verdict line.")
    args = p.parse_args()

    root = os.path.abspath(args.bundle_root)
    if not os.path.isdir(root):
        print(f"not a directory: {root}", file=sys.stderr)
        sys.exit(2)

    concept_report = check_concepts(root, args.strict)
    index_failures, index_warnings = check_index_files(root)
    log_failures, log_warnings = check_log_files(root)
    rule3_failures = index_failures + log_failures
    all_warnings = concept_report["warnings"] + index_warnings + log_warnings

    hard_fail = bool(
        concept_report["rule1_failures"]
        or concept_report["rule2_failures"]
        or rule3_failures
    )
    strict_fail = args.strict and bool(concept_report["strict_failures"])
    conformant = not hard_fail and not strict_fail

    if not args.quiet:
        print(f"OKF Conformance Report: {root}")
        print(f"  concepts checked: {concept_report['checked']}")
        print()

        r1 = concept_report["rule1_failures"]
        print(f"Rule 1 (parseable frontmatter on every non-reserved .md): "
              f"{'PASS' if not r1 else 'FAIL'}")
        if r1:
            print(fmt_list([f"{p_} ({why})" for p_, why in r1]))

        r2 = concept_report["rule2_failures"]
        print(f"Rule 2 (non-empty `type` field): {'PASS' if not r2 else 'FAIL'}")
        if r2:
            print(fmt_list(r2))

        print(f"Rule 3 (index.md/log.md shape, §6/§7): "
              f"{'PASS' if not rule3_failures else 'FAIL'}")
        if rule3_failures:
            print(fmt_list(rule3_failures))
        print()

        if args.strict and concept_report["strict_failures"]:
            print("Strict-mode failures (missing title/description -- not spec-required):")
            print(fmt_list(concept_report["strict_failures"]))
            print()

        if all_warnings:
            print("Warnings (soft guidance, never blocking per §9):")
            print(fmt_list(all_warnings))
        else:
            print("Warnings: none")
        print()

        if args.check_links:
            checked, broken = check_links(root, concept_report["frontmatters"])
            print(f"Link check: {checked} internal link(s) checked, "
                  f"{len(broken)} unresolved (informational only, never a conformance failure)")
            if broken:
                print(fmt_list([f"{cid}: -> {url}" for cid, url in broken]))
            print()

    verdict = "CONFORMANT" if conformant else "NOT CONFORMANT"
    print(f"Overall: {verdict}" + (" (strict mode)" if args.strict else ""))
    sys.exit(0 if conformant else 1)


if __name__ == "__main__":
    main()
