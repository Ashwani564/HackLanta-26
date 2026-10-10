#!/usr/bin/env bash
# Publish an ffmpeg Lambda layer (Linux arm64) so the bot can send and understand iPhone voice notes.
# Downloads the static ffmpeg build shipped by the `ffmpeg-static` npm package (ffmpeg 6.1.1 by John Van Sickle,
# GPL-3.0-or-later; it runs only inside your own AWS account and is never committed to git).
# Needs `aws login`. Afterwards run `npm run deploy` so the function picks up the newest layer.
set -euo pipefail
REGION="${AWS_REGION:-us-east-2}"
LAYER=dining-bot-ffmpeg
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$WORK"
npm init -y >/dev/null
npm_config_platform=linux npm_config_arch=arm64 npm install ffmpeg-static@5.3.0 --no-audit --no-fund >/dev/null
mkdir -p layer/bin
cp node_modules/ffmpeg-static/ffmpeg layer/bin/ffmpeg
chmod 755 layer/bin/ffmpeg
file layer/bin/ffmpeg | grep -q "ARM aarch64" || { echo "expected a Linux arm64 binary, got: $(file layer/bin/ffmpeg)"; exit 1; }
(cd layer && zip -qr ../ffmpeg-layer.zip .)
SIZE=$(stat -f%z ffmpeg-layer.zip 2>/dev/null || stat -c%s ffmpeg-layer.zip)
echo "layer zip: $((SIZE / 1024 / 1024)) MB"
[ "$SIZE" -lt 50000000 ] || { echo "layer is over Lambda's 50 MB direct-upload limit"; exit 1; }

aws lambda publish-layer-version --region "$REGION" --layer-name "$LAYER" \
  --compatible-architectures arm64 --compatible-runtimes nodejs22.x \
  --description "ffmpeg 6.1.1 static (GPL-3.0), linux arm64" \
  --zip-file "fileb://ffmpeg-layer.zip" --query LayerVersionArn --output text
