# Use Node.js LTS version
FROM node:20-alpine AS base

# Install dependencies only when needed
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./
RUN npm ci --only=production && npm cache clean --force

# Build the application
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build the application
RUN npm run build

# Production image
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

# Create a non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 shady-trader

# Copy built application
COPY --from=builder --chown=shady-trader:nodejs /app/dist ./dist
COPY --from=deps --chown=shady-trader:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=shady-trader:nodejs /app/package.json ./

# Copy backend source for runtime
COPY --from=builder --chown=shady-trader:nodejs /app/backend ./backend
COPY --from=builder --chown=shady-trader:nodejs /app/server.ts ./

USER shady-trader

EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

CMD ["npm", "start"]