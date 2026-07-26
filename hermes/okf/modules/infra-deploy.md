---
type: Module
title: Infrastructure and deployment
description: Kubernetes manifests, Docker compose, Dockerfile, Postgres init and the GitHub Actions CI/CD pipeline.
resource: https://github.com/skenglord/Shady_Trader/tree/63f1ecc0a2a90b8035cd8773e897e0953577c523/k8s
tags:
  - infra
  - kubernetes
  - ci
  - deployment
timestamp: 2026-07-26T00:00:00Z
---

# Overview

Twenty-one files under `k8s/`, plus `docker/`, `docker-compose.yml`, `Dockerfile` and `.github/workflows`.
PR #14 repaired the broken deploy path (selector/template label alignment, orphaned env entry, probe and
sidecar indentation) and added a `validate-manifests` kubeconform job that both deploy jobs depend on.

# Files that matter

* `k8s/deployment.yaml` — app/postgres/redis Deployments; selectors now subsets of template labels.
* `k8s/configmap.yaml` — init SQL block, content-identical to the docker init file.
* `docker/postgres/init.sql` — bootstrap only; zero CREATE TABLE, no seed INSERT.
* `.github/workflows/ci-cd.yml` — quality, test, build, validate-manifests, deploy jobs.

# Risks

* [CI is red on main](/risks/ci-red-on-main.md) — G-076
