#!/usr/bin/env bash
# Re-register the Photon (Spectrum) webhook so it points at the dining-bot Lambda Function URL.
#   1. checks you're in the right AWS account
#   2. lists and deletes the project's existing webhooks
#   3. registers the Function URL again
#   4. stores the new signing secret as `webhookSecret` in photon/project-secret (never printed)
#   5. forces the Lambda to restart so it picks the new secret up
# Usage: bash scripts/rewebhook.sh
set -euo pipefail

EXPECTED_ACCOUNT=446205069613
REGION=us-east-2
SECRET_ID=photon/project-secret
FN=dining-bot
API=https://spectrum.photon.codes

account=$(aws sts get-caller-identity --query Account --output text)
[ "$account" = "$EXPECTED_ACCOUNT" ] || { echo "wrong AWS account: $account (expected $EXPECTED_ACCOUNT). run aws login." >&2; exit 1; }
echo "AWS account ok: $account"

sec=$(aws secretsmanager get-secret-value --region "$REGION" --secret-id "$SECRET_ID" --query SecretString --output text)
id=$(jq -r .projectId <<<"$sec")
pw=$(jq -r .projectSecret <<<"$sec")
url=$(aws lambda get-function-url-config --region "$REGION" --function-name "$FN" --query FunctionUrl --output text)
echo "webhook target: $url"

base="$API/projects/$id/webhooks/"
echo "--- existing webhooks"
list=$(curl -sS -u "$id:$pw" "$base")
jq 'del(.. | .signingSecret?)' <<<"$list"

for wid in $(jq -r '(if (.data | type) == "array" then .data else (.data.webhooks // []) end)[] | .id' <<<"$list"); do
  code=$(curl -sS -o /dev/null -w '%{http_code}' -X DELETE -u "$id:$pw" "$base$wid/")
  echo "deleted $wid -> HTTP $code"
done

echo "--- registering"
res=$(curl -sS -X POST -u "$id:$pw" -H 'Content-Type: application/json' -d "$(jq -nc --arg u "$url" '{webhookUrl:$u}')" "$base")
jq -e '.succeed == true' <<<"$res" >/dev/null || { echo "register failed:"; jq 'del(.. | .signingSecret?)' <<<"$res"; exit 1; }
echo "registered: $(jq -r '.data.id + " -> " + .data.webhookUrl' <<<"$res")"

aws secretsmanager put-secret-value --region "$REGION" --secret-id "$SECRET_ID" \
  --secret-string "$(jq -c --arg s "$(jq -r .data.signingSecret <<<"$res")" '.webhookSecret = $s' <<<"$sec")" >/dev/null
echo "saved new webhookSecret in $SECRET_ID"

# A config change recycles the Lambda's warm containers, which cached the old secret.
aws lambda update-function-configuration --region "$REGION" --function-name "$FN" --description "webhook re-registered $(date -u +%FT%TZ)" >/dev/null
echo "restarted $FN. text the bot now."
