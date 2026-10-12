FROM node:22-bookworm-slim

# Stock CLI; keep aligned with @openai/codex-sdk in package.json.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @openai/codex@0.162.1 \
    && npm cache clean --force
