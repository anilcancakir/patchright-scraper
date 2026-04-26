# syntax=docker/dockerfile:1.6
#
# Patchright HTTP service container. Builds against the official
# Playwright base image so the patched Chrome channel works out of the
# box on linux/amd64.

FROM mcr.microsoft.com/playwright:v1.56.0-jammy AS builder

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund

COPY src ./src
RUN npx tsc -p tsconfig.json

FROM mcr.microsoft.com/playwright:v1.56.0-jammy

LABEL org.opencontainers.image.title="kodizm/patchright-scraper" \
      org.opencontainers.image.description="Patchright Fastify HTTP service for the kodizm scraping platform." \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && npx patchright install chrome \
    && npm cache clean --force

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production \
    PORT=8190 \
    HOST=0.0.0.0 \
    PROFILE_ROOT=/data/profiles \
    LOG_LEVEL=info

VOLUME ["/data/profiles"]
EXPOSE 8190

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:8190/v1/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "dist/server.js"]
