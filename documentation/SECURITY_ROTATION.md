# Security: Exposed API Key Rotation

## Summary

A Cerebras API key was exposed in plaintext in the committed `settings.json`
file (VS Code workspace settings, key field `codelynx.cerebrasApiKey`) at and
before baseline commit `942dc974`.

The key is identified only by its `csk-` prefix and the file path
`settings.json`. The full key value is intentionally **not** reproduced here.

## What was done

- `settings.json` was removed from the tracked tree via `git rm` and staged for
  deletion.
- `.gitignore` was updated with rules for `settings.json` and
  `.vscode/settings.json` so that workspace-settings files are never committed
  again.

## Required operator action — key rotation

The exposed key **MUST** be rotated by the operator:

1. **Revoke** the exposed key in the Cerebras console.
2. **Generate** a new key.
3. **Store** the new key only in a local environment variable or VS Code *user*
   settings (outside this repository). Never place it in a repo-tracked file.

## Git history rewrite — out of scope

Git history rewrite is deliberately **out of scope** for this automated run.
The key persists in git history until a human-approved history rewrite and
force-push are performed. That manual follow-up remains the responsibility of
the operator/maintainer.

## Related exposure — frontend tokens (separate task)

A related-but-separate frontend token exposure exists:
`VITE_ADMIN_TOKEN`, `VITE_TRADER_TOKEN`, and `GEMINI_API_KEY` are exposed in the
Vite bundle. That issue is handled by a **separate task**; those tokens must
also be rotated by the operator.
