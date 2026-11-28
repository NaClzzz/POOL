#!/usr/bin/env bash
set -euo pipefail

# 单机生产一键更新脚本：先停应用释放物理内存，再串行构建与迁移，适配小内存服务器。
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [ ! -f .env.production ]; then
  echo "缺少 .env.production，请先从 .env.production.example 复制并填写配置" >&2
  exit 1
fi

if [ "${SKIP_PULL:-0}" != "1" ]; then
  git pull --ff-only
fi

if [ -z "${POOL_IMAGE_TAG:-}" ]; then
  POOL_IMAGE_TAG="$(git rev-parse --short HEAD)"
  export POOL_IMAGE_TAG
fi

export COMPOSE_PARALLEL_LIMIT=1

dc() {
  docker compose --env-file .env.production -f compose.production.yaml "$@"
}

echo "[deploy] tag=${POOL_IMAGE_TAG}"
dc --profile tools config --quiet
dc up -d --wait postgres redis
dc stop socket web
dc build web
dc build socket
dc --profile tools build migrate
dc build music
dc --profile tools run --rm migrate
dc up -d --wait
dc ps
