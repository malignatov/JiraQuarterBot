#!/bin/sh
set -e

# ── Symlink persisted token files from the volume ────────────
# The bot reads/writes .private-bot-auth and .private-bot-subscription
# in the working directory.  We point them at the mounted volume so
# they survive container restarts.
for f in .private-bot-auth .private-bot-subscription; do
  if [ ! -L "/app/$f" ]; then
    # If there's already a real file (first run before volume existed), move it
    [ -f "/app/$f" ] && mv "/app/$f" "/app/data/$f" 2>/dev/null || true
    ln -sf "/app/data/$f" "/app/$f"
  fi
done

# ── Discover the ngrok tunnel URL ────────────────────────────
if [ -n "$NGROK_ENABLED" ] && [ "$NGROK_ENABLED" = "true" ]; then
  NGROK_API="http://ngrok:4040/api/tunnels"
  echo "⏳ Waiting for ngrok tunnel…"

  MAX_ATTEMPTS=30
  ATTEMPT=0
  NGROK_URL=""

  while [ -z "$NGROK_URL" ] && [ "$ATTEMPT" -lt "$MAX_ATTEMPTS" ]; do
    ATTEMPT=$((ATTEMPT + 1))
    sleep 2
    NGROK_URL=$(curl -sf "$NGROK_API" 2>/dev/null \
      | sed -n 's/.*"public_url":"\(https:[^"]*\)".*/\1/p' \
      | head -1) || true
  done

  if [ -z "$NGROK_URL" ]; then
    echo "❌ Could not discover ngrok tunnel after ${MAX_ATTEMPTS} attempts"
    exit 1
  fi

  echo "✅ ngrok tunnel: $NGROK_URL"

  # Override the webhook/oauth URLs with the live ngrok address
  export RINGCENTRAL_OAUTH_REDIRECT_URI="${NGROK_URL}/oauth"
  export WEBHOOKS_DELIVERY_ADDRESS="${NGROK_URL}/webhook-callback"
fi

echo "🚀 Starting bot…"
exec "$@"
