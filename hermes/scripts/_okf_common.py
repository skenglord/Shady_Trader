"""Shared helpers for OKF skill scripts.

Deliberately dependency-free (Python 3 stdlib only) so these scripts run on
any machine an agent finds itself on. Implements a *minimal* YAML-frontmatter
parser sufficient for OKF frontmatter (flat scalar keys + one level of list
values) -- not a general YAML parser. Good enough because the spec itself
keeps frontmatter deliberately simple (see SPEC.md §4.1).
"""
from __future__ import annotations

import os
import re
import sys
from datetime import datetime, timezone

RESERVED_FILENAMES = {"index.md", "log.md"}

FRONTMATTER_DELIM = "---"


class FrontmatterError(Exception):
    pass


def split_frontmatter(text):
    """Return (frontmatter_text_or_None, body_text).

    frontmatter_text is None if the file has no frontmatter block at all
    (i.e. doesn't start with a '---' line). Raises FrontmatterError if it
    starts with '---' but the block is never closed (unparseable).
    """
    lines = text.split("\n")
    if not lines or lines[0].strip() != FRONTMATTER_DELIM:
        return None, text
    for i in range(1, len(lines)):
        if lines[i].strip() == FRONTMATTER_DELIM:
            fm_text = "\n".join(lines[1:i])
            body_text = "\n".join(lines[i + 1:])
            return fm_text, body_text
    raise FrontmatterError("opening '---' found but no closing '---'")


_INLINE_LIST_RE = re.compile(r"^\[(.*)$\]$")


def _strip_quotes(s):
    s = s.strip()
    if len(s) >= 2 and s[0] == s[-1] and s[0] in ("'", '"'):
        return s[1:-1]
    return s


def parse_frontmatter(fm_text):
    """Parse a minimal flat YAML frontmatter block into a dict.

    Supports: scalar `key: value`, inline lists `key: [a, b, c]`, and block
    lists:
        key:
          - a
          - b
    Raises FrontmatterError on anything it can't confidently parse (better to
    flag a file as unparseable than to silently misread it).
    """
    result = {}
    lines = fm_text.split("\n")
    i = 0
    n = len(lines)
    while i < n:
        raw = lines[i]
        line = raw.rstrip()
        if not line.strip():
            i += 1
            continue
        if raw[:1] in (" ", "\t", "-"):
            raise FrontmatterError(
                f"unexpected indentation/list item with no preceding key: {raw!r}"
            )
        m = re.match(r"^([A-Za-z0-9_.\-]+):\s*(.*)$", line)
        if not m:
            raise FrontmatterError(f"unparseable line: {raw!r}")
        key, value = m.group(1), m.group(2)
        value = value.strip()
        if value == "":
            # possible block list on following indented '-' lines
            items = []
            j = i + 1
            while j < n and re.match(r"^\s*-\s*", lines[j]):
                item = re.sub(r"^\s*-\s*", "", lines[j]).strip()
                items.append(_strip_quotes(item))
                j += 1
            if items:
                result[key] = items
                i = j
                continue
            result[key] = None
            i += 1
            continue
        m_list = re.match(r"^\[(.*)]\s*$", value)
        if m_list:
            inner = m_list.group(1).strip()
            if inner == "":
                result[key] = []
            else:
                result[key] = [_strip_quotes(v) for v in inner.split(",")]
            i += 1
            continue
        result[key] = _strip_quotes(value)
        i += 1
    return result


def dump_scalar(value):
    """Render a scalar for frontmatter output, quoting if it contains ':' etc."""
    if value is None:
        return ""
    s = str(value)
    looks_numeric_or_bool = bool(re.match(r"^-?\d+(\.\d+)?$", s)) or s.lower() in (
        "true", "false", "null", "yes", "no", "~"
    )
    if (
        any(c in s for c in [":", "#", "{", "}", "[", "]", ",", "&", "*", "!",
                              "|", ">", "'", '"', "%", "@", "`"])
        or s.strip() != s or s == "" or looks_numeric_or_bool
    ):
        escaped = s.replace('"', '\\"')
        return f'"{escaped}"'
    return s


def dump_frontmatter(fields):
    """fields: list of (key, value) in desired order. value may be str/list/None."""
    lines = ["---"]
    for key, value in fields:
        if value is None or value == "":
            continue
        if isinstance(value, (list, tuple)):
            items = ", ".join(dump_scalar(v) for v in value)
            lines.append(f"{key}: [{items}]")
        else:
            lines.append(f"{key}: {dump_scalar(value)}")
    lines.append("---")
    return "\n".join(lines)


def now_iso8601():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def is_reserved(filename):
    return filename in RESERVED_FILENAMES


def iter_markdown_files(bundle_root):
    """Yield absolute paths of every .md file in the bundle, in sorted order."""
    for root, dirs, files in os.walk(bundle_root):
        dirs.sort()
        dirs[:] = [d for d in dirs if d not in (".git", "node_modules", ".venv")]
        for f in sorted(files):
            if f.endswith(".md"):
                yield os.path.join(root, f)


def iter_concept_files(bundle_root):
    for path in iter_markdown_files(bundle_root):
        if not is_reserved(os.path.basename(path)):
            yield path


_LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")


def extract_links(body_text):
    """Return list of (link_text, url) for markdown links in a body."""
    return _LINK_RE.findall(body_text)


def resolve_link(bundle_root, source_path, url):
    """Resolve a markdown link target to an absolute filesystem path, or None
    if it's clearly external (has a scheme like http://, mailto:, etc.) or
    otherwise not resolvable within the bundle.
    """
    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.\-]*://", url) or url.startswith("mailto:"):
        return None
    url = url.split("#", 1)[0]
    if url == "":
        return None
    if url.startswith("/"):
        target = os.path.normpath(os.path.join(bundle_root, url.lstrip("/")))
    else:
        target = os.path.normpath(os.path.join(os.path.dirname(source_path), url))
    return target


def concept_id(bundle_root, path):
    rel = os.path.relpath(path, bundle_root)
    rel = rel.replace(os.sep, "/")
    if rel.endswith(".md"):
        rel = rel[:-3]
    return rel


def eprint(*args, **kwargs):
    print(*args, file=sys.stderr, **kwargs)
