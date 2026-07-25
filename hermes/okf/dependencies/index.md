# Concepts

* [SQLite and PostgreSQL](dual-database.md) - Dual persistence targets selected by USE_POSTGRES, with Redis for runtime state. The Postgres path is currently non-functional.
* [Exchange integrations](exchange-integrations.md) - CCXT-style adapters for Binance, Bybit, OKX, Kraken and Coinbase Advanced. Each has distinct order semantics, margin models and reduce-only support.
* [Local Ollama-compatible model](local-llm.md) - Local Gemma/Ollama-compatible LLM used for narrative validation, sentiment weighting, optional signal generation and mode recommendation.
* [Market-data providers](market-data-providers.md) - CoinGecko, CoinMarketCap, CryptoCompare, Glassnode and Messari, accessed through a provider rotator.
* [Python sidecars](python-sidecars.md) - Freqtrade sidecar and the ML Python bridge, both requiring a local virtual environment.
