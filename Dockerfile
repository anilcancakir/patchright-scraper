# syntax=docker/dockerfile:1.6
#
# patchright-scraper unified image. Single Dockerfile, two runtime modes:
#   - default (pool):  headless, just the Node service.
#   - automation:      ENABLE_XVFB=1 + opt-in ENABLE_VNC / ENABLE_MITM.
#                      entrypoint.sh boots Xvfb / x11vnc / websockify /
#                      mitmdump conditionally before exec'ing Node.
# Built for linux/amd64 (mcr.microsoft.com/playwright base).

FROM mcr.microsoft.com/playwright:v1.56.0-jammy AS builder

WORKDIR /app

COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund

COPY src ./src
RUN npx tsc -p tsconfig.json

FROM mcr.microsoft.com/playwright:v1.56.0-jammy

LABEL org.opencontainers.image.title="anilcancakir/patchright-scraper" \
      org.opencontainers.image.description="Patchright HTTP service + automation runtime for the kodizm scraping platform." \
      org.opencontainers.image.source="https://github.com/anilcancakir/patchright-scraper" \
      org.opencontainers.image.licenses="MIT"

ENV DEBIAN_FRONTEND=noninteractive

# Automation packages live in the runtime layer unconditionally; the
# entrypoint flips them on per-container via env. Keeps a single image
# that serves both pool and per-session use cases.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        tini \
        xvfb \
        x11vnc \
        websockify \
        novnc \
        python3 \
        python3-pip \
        ca-certificates \
        curl \
    && pip3 install --no-cache-dir mitmproxy==11.0.0 requests==2.32.3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && npx patchright install chrome \
    && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY mitm ./mitm
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV NODE_ENV=production \
    PORT=8190 \
    HOST=0.0.0.0 \
    PROFILE_ROOT=/data/profiles \
    LOG_LEVEL=info \
    ENABLE_XVFB=0 \
    ENABLE_VNC=0 \
    ENABLE_MITM=0

VOLUME ["/data/profiles", "/data/captures", "/data/inject"]
EXPOSE 8190 6080 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:8190/v1/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/server.js"]
