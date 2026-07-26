---
title: "ASTS — OKF Bundle Guide"
programme: ASTS-HARDENING
baseline_sha: "63f1ecc0a2a90b8035cd8773e897e0953577c523"
okf_version: "0.1"
---

# OKF Bundle Guide

How to read and update the knowledge bundle at [`okf/`](okf/index.md). **Read this before touching the
bundle.**

## What it is

A conformant **Open Knowledge Format v0.1** bundle: plain, tagged, linked markdown describing this
codebase. It is the knowledge layer the whole programme reads from.

| | Count |
|---|---:|
| Modules | 20 |
| Risks | 28 |
| Dependencies | 5 |
| Indexes + log | 5 |
| **Total files** | **58** |

Validated **CONFORMANT** with zero warnings and 0 unresolved links at baseline `63f1ecc0a2a90b8035cd8773e897e0953577c523`.

## Why it exists

Without it, every agent re-derives the same understanding from a 3,500-line document and reaches slightly
different conclusions — the semantic drift the contracts-first approach exists to prevent. With it, an
agent loads one concept file and gets the anchors, the evidence, the related risks and the gap IDs in one
place.

## Layout

```text
okf/
  index.md                    root index (the ONLY index with frontmatter: okf_version)
  log.md                      change history, newest first
  modules/
    index.md                  auto-generated
    <name>.md                 one Module per coherent unit
  risks/
    index.md
    <name>.md                 one Risk per concern (clustered by root cause)
  dependencies/
    index.md
    <name>.md                 one Dependency per external library/service
```

## Reading path for an agent

1. **Start at your task's `okf_concepts`** — every task spec must name at least one.
2. **Read the Risk concept** — it carries gap IDs, exact anchors and verification status.
3. **Read the linked Module concept** — it gives you the surrounding file map.
4. **Check `risks/closed-by-pr14.md`** — do not fix what is already fixed.
5. **Only then** open the source at the cited anchor.

## Frontmatter

Exactly **one required field: `type`** (free text). Everything else is recommended:

```text
---
type: Risk
title: Exchange treated as a fire-and-forget side effect
description: One-line summary.
resource: https://github.com/skenglord/Shady_Trader/blob/<sha>/path#L419-L436
tags:
  - p0
  - execution
  - verified
timestamp: 2026-07-26T00:00:00Z
---
```

**Do not** add frontmatter to any `index.md` except the bundle root (which carries only `okf_version`).

## Tag vocabulary

| Tag | Meaning |
|---|---|
| `p0` `p1` `p2` `p3` | Severity |
| `verified` | Anchor read from source |
| `unverified` | Plausible; **verify before acting** |
| `root-cause` | Heads a cluster — read this first |
| `partially-closed` `closed` | Wholly or partly resolved |
| `money-path` | Touches capital — strongest evidence required |
| `security-relevant` | Requires independent security review |
| `new-finding` | Not in the original register |
| `resolved-by-pr14` | Closed by the merged branch |

**Filter by tag to scope work.** `money-path` + `verified` gives the tasks that matter most and have
anchors ready.

## Links

One convention only: **bundle-root-relative** paths.

```markdown
[Exchange as side effect](/risks/exchange-as-side-effect.md)
```

Never wikilinks, never relative `../` paths, never bare names. Broken links are **tolerated by design**
(they may mean not-yet-written knowledge) — but never invent a target that does not exist.

## Updating the bundle

Use the scripts; do not hand-edit YAML mechanics.

```bash
# New concept
python3 scripts/new_concept.py okf risks/<name> \
  --type "Risk" --title "..." --description "..." \
  --resource "https://github.com/skenglord/Shady_Trader/blob/<sha>/<path>#L<start>-L<end>" \
  --tags p0,execution,verified

# Regenerate indexes after ANY add/remove
python3 scripts/gen_index.py okf

# Log the change
python3 scripts/add_log_entry.py okf --kind Update \
  --text "Closed G-001..G-002 via E3. complete=true; total bundle files=<N>."

# Validate — surface the exact PASS/FAIL lines
python3 scripts/validate.py okf --check-links
```

## When to update

| Event | Action |
|---|---|
| Gap closed | Update the Risk's verification status; log it |
| UNVERIFIED gap verified | Add the real anchor; retag `verified`; log it |
| UNVERIFIED gap **not reproducible** | Mark `not_reproducible` with what you searched. **Do not delete it** — absence is a finding |
| New defect found | New Risk concept with a real anchor |
| Module restructured (Phase 9) | Update anchors in that Module **and every Risk citing it** |
| Baseline moves | Update `resource` URIs; **re-verify line numbers — they drift** |

## Rules

1. **Never fabricate** a `resource` URI, anchor or description. Missing facts → `<!-- TODO: verify -->` and
   say so.
2. **Never treat unknown `type` values, missing optional fields or broken links as errors** — the spec
   forbids rejecting a bundle for those.
3. **Never put runtime state, caches, source copies or build output in the bundle.** It is a curated
   knowledge layer, not a repo mirror.
4. **Keep it minimal.** Plain markdown, one link convention, free-text `type`, no self-maintaining
   machinery. The five scripts are the only tooling this format needs.
5. **Do not create a Risk per gap.** 76 gaps became 28 Risks by clustering on root cause. One Risk per
   *defect*, listing its gap IDs — a Risk per row would recreate the flat list the clustering exists to
   replace.
6. **Regenerate indexes** after any add or remove. An unlinked concept is invisible to triage.
7. **Run `validate.py`** rather than eyeballing frontmatter.

## Anchor drift warning

Every anchor is valid at `63f1ecc0a2a90b8035cd8773e897e0953577c523`. As the programme edits code, **line numbers move**. Before editing at a
cited anchor:

1. Read the concept for the anchor and the quoted evidence.
2. Open the file and confirm the code still matches that description.
3. If it moved, locate it by content and **update the concept**.
4. If it is gone, it may already be fixed — check `git log` before assuming a defect.

**Anchors are navigation aids backed by evidence quotes, not immutable coordinates.** The quoted evidence
is what makes a drifted anchor recoverable — always record it.
