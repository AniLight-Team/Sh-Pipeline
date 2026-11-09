#!/bin/bash

set -Eeuo pipefail

APP_DIR="/root/Sh-Pipeline"
ENV_FILE="/root/envs/pipeline/.env"
PM2_NAME="Sh-Pipeline"

echo "====================================="
echo "Starting Sh-Pipeline deployment..."
echo "====================================="

cd "$APP_DIR"

echo "[1/7] Fetching latest code..."
git fetch origin

echo "[2/7] Resetting to latest main..."
git reset --hard origin/main

echo "[3/7] Installing environment file..."
if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: $ENV_FILE not found"
    exit 1
fi

cp "$ENV_FILE" "$APP_DIR/.env"

echo "[4/7] Installing dependencies..."
if [ -f "$APP_DIR/package-lock.json" ]; then
    npm ci
else
    npm install
fi

echo "[5/7] Building project (UI + Backend)..."
npm run build

echo "[6/7] Reloading or starting PM2..."
pm2 reload "$PM2_NAME" --update-env || pm2 start dist/backend/index.js --name "$PM2_NAME"

echo "====================================="
echo "Deployment completed successfully"
echo "====================================="

