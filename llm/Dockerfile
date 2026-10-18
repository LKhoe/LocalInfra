# One container: Ollama (the local model) + the LLM gateway (Node, no npm dependencies;
# SQLite is node:sqlite). Built on the Node image with only Ollama's CPU build copied in:
# the official Ollama image carries ~3.5 GB of CUDA libraries the Pi has no use for.
ARG NODE_VERSION=24
ARG OLLAMA_VERSION=0.35.1
FROM ollama/ollama:${OLLAMA_VERSION} AS ollama
RUN rm -rf /usr/lib/ollama/cuda_* /usr/lib/ollama/rocm* /usr/lib/ollama/vulkan*

FROM node:${NODE_VERSION}-bookworm-slim

# ca-certificates: Ollama downloads the model over HTTPS
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=ollama /usr/bin/ollama /usr/bin/ollama
COPY --from=ollama /usr/lib/ollama /usr/lib/ollama

WORKDIR /app
COPY store.mjs server.mjs admin.mjs ./
COPY start.sh /usr/local/bin/localinfra-llm-start
COPY llm-admin.sh /usr/local/bin/llm-admin
# /data is the llm_data volume (database + downloaded models); a new named volume takes this owner
RUN chmod 755 /usr/local/bin/localinfra-llm-start /usr/local/bin/llm-admin \
 && mkdir /data && chown node:node /data

# Not root: Ollama keeps its key and models in /data
USER node
ENV HOME=/data \
    OLLAMA_MODELS=/data/models \
    OLLAMA_HOST=127.0.0.1:11434 \
    LLM_LOCAL_URL=http://127.0.0.1:11434 \
    LLM_DB=/data/llm.sqlite \
    PORT=4000 \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
EXPOSE 4000
ENTRYPOINT ["localinfra-llm-start"]
CMD []
