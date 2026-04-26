#!/usr/bin/env bash
#
# Local-dev build for the patchright-scraper image. Public Docker Hub
# releases happen via .github/workflows/release-docker.yml on every
# v*.*.* tag push; this script only covers the LAN-dev shortcut where
# you want to iterate without going through GitHub.
#
# Usage:
#   bash build.sh                                 # docker build only
#   KODIZM_DOCKER_HOST=root@192.168.68.155 \
#     bash build.sh                               # build + ssh load to LAN host

set -euo pipefail

PLATFORM="${PLATFORM:-linux/amd64}"
IMAGE_NAME="${IMAGE_NAME:-kodizm/patchright-scraper}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SOURCE_REV="$(git rev-parse --short HEAD 2>/dev/null || echo "unversioned")"
TAG_SHA="${IMAGE_NAME}:${SOURCE_REV}"
TAG_LATEST="${IMAGE_NAME}:latest"

echo "Building ${TAG_SHA} for ${PLATFORM}..."
docker buildx build \
    --platform "${PLATFORM}" \
    --output type=docker \
    --tag "${TAG_SHA}" \
    --tag "${TAG_LATEST}" \
    "${SCRIPT_DIR}"

if [[ -n "${KODIZM_DOCKER_HOST:-}" ]]; then
    echo "Shipping ${TAG_SHA} to ${KODIZM_DOCKER_HOST}..."
    docker save "${TAG_SHA}" "${TAG_LATEST}" \
        | gzip \
        | ssh "${KODIZM_DOCKER_HOST}" 'gunzip | docker load'
    echo "Image available on ${KODIZM_DOCKER_HOST}."
else
    echo "KODIZM_DOCKER_HOST not set, leaving image on the local host only."
fi

echo "Done. Tagged ${TAG_SHA} and ${TAG_LATEST}."
