#!/usr/bin/env python3
"""Regenerate index.md file(s) for an OKF bundle from concept frontmatter
(SPEC.md §6). index.md carries no frontmatter, EXCEPT the bundle root's,
which may declare `okf_version` (§11) -- that line is detected and preserved.

A directory's own one-line description (used only when its *parent's*
index.md lists it as a subdirectory) is supported via an optional HTML comment
`<!-- description: ... -->` as the first line of an index.md body. If present
it is preserved across regeneration.

Usage:
    python3 gen_index.py <bundle_root> [--dir <subdir-relative-to-root>] [--dry-run]
    python3 gen_index.py <bundle_root> --dir modules --describe "Core source modules"
"""
import argparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _okf_common import (  # noqa: E402
    is_reserved, split_frontmatter, parse_frontmatter, FrontmatterError, eprint,
)

DESC_MARKER_RE = re.compile(r"^<!--\s*description:\s*(.*?)\s*-->\s*$")


def dir_has_markdown(path):
    for root, dirs, files in os.walk(path):
        dirs[:] = [d for d in dirs if d not in (".git", "node_modules", ".venv")]
        if any(f.endswith(".md") for f in files):
            return True
    return False


def read_existing_description_marker(index_path):
    if not os.path.exists(index_path):
        return None
    with open(index_path, "r", encoding="utf-8") as f:
        text = f.read()
    try:
        fm_text, body = split_frontmatter(text)
    except FrontmatterError:
        body = text
    for line in body.split("\n"):
        if not line.strip():
            continue
        m = DESC_MARKER_RE.match(line.strip())
        return m.group(1) if m else None
    return None


def read_root_okf_version(index_path):
    if not os.path.exists(index_path):
        return None
    with open(index_path, "r", encoding="utf-8") as f:
        text = f.read()
    try:
        fm_text, _ = split_frontmatter(text)
    except FrontmatterError:
        return None
    if fm_text is None:
        return None
    try:
        fm = parse_frontmatter(fm_text)
    except FrontmatterError:
        return None
    return fm.get("okf_version")


def concept_title_desc(path):
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    try:
        fm_text, _ = split_frontmatter(text)
    except FrontmatterError:
        return None, None
    if fm_text is None:
        return None, None
    try:
        fm = parse_frontmatter(fm_text)
    except FrontmatterError:
        return None, None
    title = fm.get("title") or os.path.splitext(os.path.basename(path))[0]
    description = fm.get("description") or ""
    return title, description


def build_index_body(dir_path, is_root, describe_override=None):
    entries_concepts = []
    entries_subdirs = []
    for name in sorted(os.listdir(dir_path)):
        full = os.path.join(dir_path, name)
        if name.startswith("."):
            continue
        if os.path.isdir(full):
            if name in ("node_modules", ".venv"):
                continue
            if not dir_has_markdown(full):
                continue
            sub_index = os.path.join(full, "index.md")
            desc = read_existing_description_marker(sub_index) or ""
            entries_subdirs.append((name, desc, name + "/"))
        elif name.endswith(".md") and not is_reserved(name):
            title, desc = concept_title_desc(full)
            if title is None:
                continue
            entries_concepts.append((title, desc, name))

    lines = []
    if is_root and describe_override:
        lines.append(f"<!-- description: {describe_override} -->")
    elif not is_root:
        existing = read_existing_description_marker(os.path.join(dir_path, "index.md"))
        marker = describe_override or existing
        if marker:
            lines.append(f"<!-- description: {marker} -->")
    if lines:
        lines.append("")

    lines.append("# Concepts")
    lines.append("")
    if entries_concepts:
        for title, desc, relpath in entries_concepts:
            suffix = f" - {desc}" if desc else ""
            lines.append(f"* [{title}]({relpath}){suffix}")
    else:
        lines.append("<!-- no concepts directly in this directory yet -->")
    lines.append("")

    if entries_subdirs:
        lines.append("# Subdirectories")
        lines.append("")
        for name, desc, relpath in entries_subdirs:
            suffix = f" - {desc}" if desc else ""
            lines.append(f"* [{name}]({relpath}){suffix}")
        lines.append("")

    return "\n".join(lines)


def write_index(dir_path, is_root, dry_run, describe_override=None):
    index_path = os.path.join(dir_path, "index.md")
    body = build_index_body(dir_path, is_root, describe_override)

    content = body
    if is_root:
        okf_version = read_root_okf_version(index_path)
        if okf_version:
            content = f'---\nokf_version: "{okf_version}"\n---\n\n' + body

    if dry_run:
        old = ""
        if os.path.exists(index_path):
            with open(index_path, "r", encoding="utf-8") as f:
                old = f.read()
        if old == content:
            print(f"[unchanged] {index_path}")
        else:
            print(f"[would change] {index_path}")
        return

    with open(index_path, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"Wrote {index_path}")


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("bundle_root")
    p.add_argument("--dir", default=None,
                    help="Only regenerate this directory's index.md (relative to "
                         "bundle_root). Default: every directory in the bundle.")
    p.add_argument("--describe", default=None,
                    help="Set/update this directory's one-line description marker.")
    p.add_argument("--dry-run", action="store_true",
                    help="Show which index.md files would change without writing them.")
    args = p.parse_args()

    root = os.path.abspath(args.bundle_root)
    if not os.path.isdir(root):
        eprint(f"not a directory: {root}")
        sys.exit(1)

    if args.dir:
        target_dir = os.path.join(root, args.dir)
        if not os.path.isdir(target_dir):
            eprint(f"not a directory: {target_dir}")
            sys.exit(1)
        is_root = os.path.abspath(target_dir) == root
        write_index(target_dir, is_root, args.dry_run, args.describe)
        return

    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in sorted(dirs) if d not in (".git", "node_modules", ".venv")]
        if not dir_has_markdown(dirpath):
            continue
        is_root = os.path.abspath(dirpath) == root
        write_index(dirpath, is_root, args.dry_run)


if __name__ == "__main__":
    main()
