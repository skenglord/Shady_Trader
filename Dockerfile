# Node and Python are both required: the app's Freqtrade workers invoke the
# pinned Freqtrade CLI, while the optional sidecar runs its authenticated API.
FROM node:22-bookworm-slim AS base

FROM base AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv python3-dev build-essential libffi-dev libssl-dev \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY backend/freqtrade/requirements.txt ./backend/freqtrade/requirements.txt
RUN npm ci && npm cache clean --force
RUN python3 -m venv /app/backend/freqtrade/venv \
    && /app/backend/freqtrade/venv/bin/pip install --no-cache-dir --upgrade pip wheel setuptools \
    && /app/backend/freqtrade/venv/bin/pip install --no-cache-dir -r backend/freqtrade/requirements.txt

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV FREQTRADE_VENV_DIR=/app/backend/freqtrade/venv

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-venv libgomp1 libstdc++6 libffi8 libssl3 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 1001 nodejs \
    && useradd --system --uid 1001 --gid nodejs --create-home shady-trader

COPY --from=builder --chown=shady-trader:nodejs /app/dist ./dist
COPY --from=deps --chown=shady-trader:nodejs /app/node_modules ./node_modules
COPY --from=deps --chown=shady-trader:nodejs /app/backend/freqtrade/venv ./backend/freqtrade/venv
COPY --from=builder --chown=shady-trader:nodejs /app/package.json ./
COPY --from=builder --chown=shady-trader:nodejs /app/backend ./backend
COPY --from=builder --chown=shady-trader:nodejs /app/server.ts ./

USER shady-trader

EXPOSE 3000 8081

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/api/health/live', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

CMD ["npm", "start"]
