# ── Build stage ──────────────────────────────────────────────
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# ── Runtime stage ────────────────────────────────────────────
FROM node:20-alpine
WORKDIR /app

# curl is needed by the entrypoint to query ngrok's API
RUN apk add --no-cache curl

# Non-root user for security
RUN addgroup -S bot && adduser -S bot -G bot

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY private-bot.js ./
COPY jira-client.js ./

# Directory for persisted auth/subscription tokens
RUN mkdir -p /app/data && chown -R bot:bot /app

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER bot

EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "private-bot.js"]
