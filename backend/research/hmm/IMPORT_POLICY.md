# Import Policy

This directory is **research-only**. It must never be imported by production code.

```bash
# This command must return zero results:
grep -rn "research/hmm" backend/ src/ --include="*.ts" --include="*.tsx" --include="*.js"
```

Any violation indicates a bug that must be fixed before merge.
