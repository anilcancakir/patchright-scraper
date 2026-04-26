# Changelog

## Unreleased

## v0.1.0 (2026-04-26)

Initial extraction from `kodizm-scrapper-api/docker/patchright-scraper/` at the moment the project gained its own home.

Includes:

- Fastify HTTP service for one-shot scraping (`POST /v1/scrape`)
- Short-lived session lifecycle (`POST /v1/sessions`, `POST /v1/sessions/{id}/scrape`, `DELETE /v1/sessions/{id}`)
- Patchright (Playwright stealth fork) backed by `mcr.microsoft.com/playwright:v1.56.0-jammy`
- Multi-stage Dockerfile, single platform (`linux/amd64`)
- Vitest test scaffold

Automation mode (Xvfb / VNC / mitmproxy) and the full step primitive set arrive in v0.2.0.
