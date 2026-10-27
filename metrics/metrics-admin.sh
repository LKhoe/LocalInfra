#!/bin/sh
# docker exec localinfra-metrics metrics-admin <command>   (see admin.mjs)
exec node /app/admin.mjs "$@"
