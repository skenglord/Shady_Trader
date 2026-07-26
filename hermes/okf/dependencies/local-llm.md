---
type: Dependency
title: Local Ollama-compatible model
description: Local Gemma/Ollama-compatible LLM used for narrative validation, sentiment weighting, optional signal generation and mode recommendation.
resource: https://ollama.com/
tags:
  - ai
  - llm
  - governance
timestamp: 2026-07-26T00:00:00Z
---

# Concern

A nondeterministic local model currently sits in a path that can influence risk mode. It must be reduced
to advisory output behind a schema-validated gateway with recorded model, prompt and parameter versions,
and must be disabled or snapshot-pinned for backtests to remain reproducible.
