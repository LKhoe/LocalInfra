#!/bin/bash
# Runs the two processes of localinfra-llm:
#   ollama serve   the local model, on 127.0.0.1:11434 only (apps never reach it)
#   node server    the gateway apps call, on :4000
# When either one stops, the other is stopped too and the container exits, so Docker
# restarts the whole thing (restart: unless-stopped).
#
# The local model (LLM_LOCAL_MODEL) is pulled into /data/models on first start, about
# 800 MB for gemma3:1b. Meanwhile the gateway already answers (free and paid models);
# without internet the pull is retried every 5 minutes.
set -euo pipefail

: "${LLM_LOCAL_MODEL:?LLM_LOCAL_MODEL must be set}"

ollama serve &
ollama_pid=$!
node /app/server.mjs &
gateway_pid=$!
trap 'kill -TERM "$ollama_pid" "$gateway_pid" 2>/dev/null || true' TERM INT

# The pull's progress bars would fill the log: only its last lines, when it fails
pull() {
  local out
  echo "[ollama] downloading $LLM_LOCAL_MODEL"
  out=$(ollama pull "$LLM_LOCAL_MODEL" 2>&1) || { tail -n 2 <<<"$out" >&2; return 1; }
}
(
  until ollama list >/dev/null 2>&1; do sleep 1; done
  until ollama show "$LLM_LOCAL_MODEL" >/dev/null 2>&1 || pull; do
    echo "[ollama] could not pull $LLM_LOCAL_MODEL, retrying in 5 minutes" >&2
    sleep 300
  done
  echo "[ollama] local model $LLM_LOCAL_MODEL is ready"
) &

status=0
wait -n "$ollama_pid" "$gateway_pid" || status=$?
kill -TERM "$ollama_pid" "$gateway_pid" 2>/dev/null || true
wait || true
echo "a process stopped (exit $status): stopping the container" >&2
exit $(( status == 0 ? 1 : status ))
