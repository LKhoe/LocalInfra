#!/bin/sh
# docker exec localinfra-llm llm-admin <command>   (see admin.mjs)
exec node /app/admin.mjs "$@"
