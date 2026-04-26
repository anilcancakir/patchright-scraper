# Patchright HTTP service

Fastify Node service that wraps Patchright (patched Playwright) and
exposes a small `/v1` API the Laravel platform consumes through
`PatchrightClient`. Built as a `linux/amd64` image and shipped to the
remote Docker host via `build.sh`.

## Endpoints

| Method | Path                          | Purpose                                    |
| ------ | ----------------------------- | ------------------------------------------ |
| GET    | `/v1/health`                  | liveness probe                             |
| POST   | `/v1/scrape`                  | one-shot scrape, fresh ephemeral context   |
| POST   | `/v1/sessions`                | create or look up a persistent context     |
| GET    | `/v1/sessions`                | list active sessions                       |
| DELETE | `/v1/sessions/:id`            | close a session and free resources         |
| POST   | `/v1/sessions/:id/scrape`     | scrape inside an existing session          |

## Build and ship

```bash
KODIZM_DOCKER_HOST=root@192.168.68.155 \
  bash docker/patchright-scraper/build.sh
```

Sessions persist their profile under `/data/profiles/{session_id}` so
mount that path as a host-side volume when long-lived sessions need
to survive container restarts.
