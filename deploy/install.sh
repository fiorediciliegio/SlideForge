#!/usr/bin/env bash
# SlideForge 云主机安装脚本（Ubuntu/Debian，小内存主机适配）
# 用法：sudo bash deploy/install.sh
set -euo pipefail

echo "==> 安装系统依赖（Node 22 + Chromium 运行库）"
apt-get update
apt-get install -y curl git ca-certificates gnupg \
  libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
  libpango-1.0-0 libcairo2 fonts-noto-cjk golang-go python3

if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

APP_DIR=${APP_DIR:-/opt/slideforge}
echo "==> 部署到 $APP_DIR"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone https://github.com/xiaoyuankele/SlideForge.git "$APP_DIR"
fi
cd "$APP_DIR"
git pull

echo "==> 安装依赖"
npm install --no-audit --no-fund
cd executas/ppt-engine && npm install --no-audit --no-fund && cd ../..

echo "==> 构建引擎（生成 vendor 导出 bundle）"
cd executas/ppt-engine && npm run build && cd ../..

echo "==> 构建 Go 网关"
mkdir -p .bin
(cd services/gateway && go build -o ../../.bin/slideforge-gateway ./cmd/gateway)

echo "==> 配置环境（请编辑 $APP_DIR/.env）"
if [ ! -f .env ]; then
  cp deploy/env.example .env
  echo "首次安装：请编辑 .env 填入 OPENAI_API_KEY 与 SLIDEFORGE_ADMIN_TOKEN"
fi

echo "==> 安装 systemd 服务"
cp deploy/slideforge.service /etc/systemd/system/slideforge.service
cp deploy/slideforge-engine.service /etc/systemd/system/slideforge-engine.service
cp deploy/slideforge-brain.service /etc/systemd/system/slideforge-brain.service
cp deploy/slideforge-gateway.service /etc/systemd/system/slideforge-gateway.service
cp deploy/slideforge-gateway@.service /etc/systemd/system/slideforge-gateway@.service
mkdir -p /etc/slideforge
cp deploy/gateway-8081.env /etc/slideforge/gateway-8081.env
cp deploy/gateway-8082.env /etc/slideforge/gateway-8082.env
systemctl daemon-reload
systemctl enable slideforge slideforge-engine slideforge-brain slideforge-gateway
echo "完成。启动：systemctl start slideforge-gateway；日志：journalctl -u slideforge-gateway -f"
echo "引擎默认 ENGINE_CONCURRENCY=1；请按实际峰值内存配置服务器，容量数据见 .scratch/engine-job-service/验收记录.md。"
