# localinfra-metrics: Node + one npm dependency (postgres, no transitive deps), from the lockfile.
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY schema.mjs aggregate.mjs store.mjs server.mjs admin.mjs ./
COPY metrics-admin.sh /usr/local/bin/metrics-admin
# /run/metrics is the metrics_summary volume; a new named volume takes this owner
RUN chmod 755 /usr/local/bin/metrics-admin && mkdir -p /run/metrics && chown node:node /run/metrics

USER node
ENV PORT=4100 \
    METRICS_SUMMARY_PATH=/run/metrics/summary.json
EXPOSE 4100
CMD ["node", "/app/server.mjs"]
