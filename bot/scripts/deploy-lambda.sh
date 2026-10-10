#!/usr/bin/env bash
# Build and deploy the Lambda webhook bot (infra/bot-lambda.yaml). Needs `aws login` first.
#   bot/scripts/deploy-lambda.sh            build + deploy stack + upload code
#   bot/scripts/deploy-lambda.sh --code     build + upload code only
set -euo pipefail
cd "$(dirname "$0")/.."
REGION="${AWS_REGION:-us-east-2}"
STACK=dining-bot
OUT=dist/lambda

echo "==> bundling"
rm -rf "$OUT" && mkdir -p "$OUT"
npx esbuild src/lambda.ts --bundle --platform=node --target=node22 --format=esm --sourcemap \
  --outfile="$OUT/index.mjs" --external:sharp --external:heif2jpeg \
  --external:nice-grpc --external:nice-grpc-common --external:@grpc/grpc-js \
  --banner:js="import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);" --log-level=warning
# Installed (not bundled) packages, at the same versions as node_modules:
# - sharp, heif2jpeg: native, so install the Linux arm64 builds Lambda needs
# - gRPC peers: Photon's SDK checks at runtime that these resolve as real packages
ver() { node -p "require('./node_modules/$1/package.json').version"; }
printf '{"type":"module","private":true}\n' > "$OUT/package.json"
npm install --prefix "$OUT" --no-save --no-audit --no-fund --omit=dev --os=linux --cpu=arm64 --libc=glibc \
  "sharp@$(ver sharp)" "heif2jpeg@$(ver heif2jpeg)" \
  "nice-grpc@$(ver nice-grpc)" "nice-grpc-common@$(ver nice-grpc-common)" "@grpc/grpc-js@$(ver @grpc/grpc-js)" >/dev/null
# Fonts for the plan card: Lambda has none, so text would render as boxes. Read by src/meetup-card.ts from ./fonts.
cp -R assets/fonts "$OUT/fonts"
# Git Bash on Windows has no zip; Windows' own tar (bsdtar) writes zip files.
if command -v zip >/dev/null; then (cd "$OUT" && rm -f ../lambda.zip && zip -qr ../lambda.zip .)
else (cd "$OUT" && rm -f ../lambda.zip && "$SYSTEMROOT/System32/tar.exe" -a -cf ../lambda.zip *); fi
echo "    $(du -h dist/lambda.zip | cut -f1) dist/lambda.zip"

if [[ "${1:-}" != "--code" ]]; then
  echo "==> deploying stack $STACK"
  DB=$(aws cloudformation describe-stacks --region "$REGION" --stack-name dining-vector-db \
    --query 'Stacks[0].Outputs' --output json)
  CLUSTER=$(node -e 'const o=JSON.parse(process.argv[1]);console.log(o.find(x=>x.OutputKey==="ClusterArn").OutputValue)' "$DB")
  SECRET=$(node -e 'const o=JSON.parse(process.argv[1]);console.log(o.find(x=>x.OutputKey==="SecretArn").OutputValue)' "$DB")
  # Newest ffmpeg layer, if one was published (scripts/build-ffmpeg-layer.sh). Without it voice notes are off.
  FFMPEG_LAYER=$(aws lambda list-layer-versions --region "$REGION" --layer-name dining-bot-ffmpeg \
    --query 'LayerVersions[0].LayerVersionArn' --output text 2>/dev/null || true)
  [[ "$FFMPEG_LAYER" == "None" ]] && FFMPEG_LAYER=""
  [[ -z "$FFMPEG_LAYER" ]] && echo "    (no ffmpeg layer yet: voice notes stay off. Run scripts/build-ffmpeg-layer.sh)"
  aws cloudformation deploy --region "$REGION" --stack-name "$STACK" --template-file ../infra/bot-lambda.yaml \
    --capabilities CAPABILITY_IAM --no-fail-on-empty-changeset \
    --parameter-overrides "DbClusterArn=$CLUSTER" "DbSecretArn=$SECRET" "FfmpegLayerArn=$FFMPEG_LAYER" \
    ${HEALTH_SHORTCUT_URL:+"HealthShortcutUrl=$HEALTH_SHORTCUT_URL"}  # only when set, so a plain deploy keeps the stored link
fi

echo "==> uploading code"
aws lambda update-function-code --region "$REGION" --function-name dining-bot \
  --zip-file fileb://dist/lambda.zip --query 'LastUpdateStatus' --output text >/dev/null
aws lambda wait function-updated-v2 --region "$REGION" --function-name dining-bot
echo "==> webhook URL: $(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='WebhookUrl'].OutputValue" --output text)"
