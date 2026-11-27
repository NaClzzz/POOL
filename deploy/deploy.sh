#!/usr/bin/env bash
set -euo pipefail

# 单机生产一键更新脚本：拉取代码 -> 构建镜像 -> 停应用跑迁移 -> 启动并校验状态。
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

dc() {
  docker compose --env-file .env.production -f compose.production.yaml "$@"
}

echo "[deploy] tag=${POOL_IMAGE_TAG}"
dc --profile tools config --quiet
dc --profile tools build
dc up -d --wait postgres redis
dc stop socket web
dc --profile tools run --rm migrate
dc up -d --wait
dc ps
