#!/usr/bin/env bash
# Raw Anthropic /v1/messages SSE frames, one `data:` line per event, through
# any base URL — no AI SDK in the way, so a malformed frame is visible as-is.
#
#   scripts/gateway-raw-sse.sh <base> <body.json>
#     base: https://api.anthropic.com (key: $ANTHROPIC_API_KEY)
#           http://localhost:8181/anthropic (key: $VK, a gateway virtual key)
#
# The ai-sdk user agent matters: Bifrost passes Anthropic frames through
# verbatim only for Claude Code's UA and re-renders everyone else's.
set -euo pipefail
base="${1:?usage: $0 <base> <body.json>}"; body="${2:?usage: $0 <base> <body.json>}"
key="${VK:-${ANTHROPIC_API_KEY:?set VK (gateway) or ANTHROPIC_API_KEY (direct)}}"
curl -sN "${base%/}/v1/messages" \
  -H "x-api-key: $key" \
  -H "anthropic-version: 2023-06-01" \
  -H "content-type: application/json" \
  -H "user-agent: ${UA:-ai-sdk/anthropic/4.0.56}" \
  --data @"$body" | grep --line-buffered '^data:'
