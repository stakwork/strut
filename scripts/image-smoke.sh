#!/usr/bin/env bash
# Boots a strut image on the Ladybug backend with NO network and drives it over
# its own loopback: /health must report the ladybug workspace, a workflow must
# publish, a run of it must succeed. That proves the image carries Ladybug's
# vector + fts extensions (Dockerfile) and that nothing the boot needs is
# downloaded. publish-image.yml runs it before the push; by hand:
#
#   docker build -t strut:local . && scripts/image-smoke.sh strut:local
#
# Embeddings are off: MiniLM is fetched into /data/models on first use (the
# compose keeps it in a volume) and a container with no egress cannot — the
# switch desktop.js flips when the model is not staged. Needs docker + jq.
set -euo pipefail
image="${1:?usage: $0 <image>}"
key="smoke-$$"
cid=$(docker run -d --network none \
  -e STRUT_WORKSPACE_BACKEND=ladybug -e STRUT_GRAPH_EMBEDDINGS=off -e STRUT_API_KEY="$key" "$image")
cleanup() {
  local code=$?
  if [ "$code" -ne 0 ]; then echo "--- container log ---"; docker logs "$cid" 2>&1 | tail -40; fi
  docker rm -f "$cid" >/dev/null 2>&1 || true
  exit "$code"
}
trap cleanup EXIT
# curl runs INSIDE the container: with --network none there is no port to publish.
api() { docker exec "$cid" curl -fsS -H "authorization: Bearer $key" -H "content-type: application/json" "$@"; }

for _ in $(seq 1 90); do
  health=$(api http://127.0.0.1:3000/health 2>/dev/null) && break
  sleep 1
done
echo "health: ${health:-no answer after 90 s}"
echo "$health" | jq -e '.workspace.backend == "ladybug" and (.workspace.path | endswith("graph.lbug"))' >/dev/null \
  || { echo "expected the ladybug workspace"; exit 1; }

published=$(api -X POST http://127.0.0.1:3000/workflows \
  -d '{"name":"smoke","steps":[{"id":"hello","type":"log","config":{"message":"hello from {{ input.who }}"}}]}')
echo "published: $published"
wf=$(echo "$published" | jq -r .workflow)

run=$(api -X POST "http://127.0.0.1:3000/workflows/$wf/run" -d '{"input":{"who":"ladybug"}}')
runId=$(echo "$run" | jq -r .runId)
status=running
for _ in $(seq 1 60); do
  # 404 until the launch has written the log's first line; `partial: true` while it runs.
  summary=$(api "http://127.0.0.1:3000/workflows/$wf/runs/$runId" 2>/dev/null) || { sleep 1; continue; }
  status=$(echo "$summary" | jq -r '.status // "running"')
  [ "$status" != "running" ] && break
  sleep 1
done
echo "run $runId: $summary"
[ "$status" = "success" ] || { echo "expected a successful run, got $status"; exit 1; }
echo "$summary" | jq -e '.output == "hello from ladybug"' >/dev/null || { echo "unexpected output"; exit 1; }
echo "OK: $image boots on ladybug with no network, publishes and runs a workflow"
