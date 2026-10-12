FROM node:22-bookworm-slim

# Stock CLI; this version is the installed Agent SDK's claudeCodeVersion.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @anthropic-ai/claude-code@2.1.259 \
    && npm cache clean --force
