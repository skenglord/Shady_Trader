# Kubernetes deployment prerequisites

The manifests deliberately contain no credentials. Before applying them, create
`shady-trader-secrets` from a protected secret manager or a local, untracked env
file containing these keys:

```text
POSTGRES_USER
POSTGRES_PASSWORD
API_TRADER_TOKEN
API_ADMIN_TOKEN
BINANCE_API_KEY
BINANCE_SECRET_KEY
KRAKEN_API_KEY
KRAKEN_PRIVATE_KEY
GEMINI_API_KEY
FREQTRADE_API_USER
FREQTRADE_API_PASS
FREQTRADE_JWT_SECRET_KEY
```

For a local cluster, create the Secret without writing it to the repository:

```sh
kubectl create secret generic shady-trader-secrets \
  --from-env-file=.env.k8s \
  --dry-run=client -o yaml | kubectl apply -f -
```

Also create the `shady-trader-tls` Secret for the host configured in
`ingress.yaml`, and replace `trading.example.com` with the operator's hostname
in both the ingress and `CORS_ORIGIN`. `LIVE_TRADING_ENABLED` is explicitly
false in the Deployment. Keep it false until risk, order reconciliation, and
exchange testnet acceptance criteria in `documentation/operational_gameplan.md`
are satisfied.
