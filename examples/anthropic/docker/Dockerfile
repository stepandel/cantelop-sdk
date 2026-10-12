FROM node:22-bookworm-slim

# Stock CLI; keep aligned with nativeCli in package.json.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git ripgrep python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @anthropic-ai/claude-code@2.1.259 \
    && npm cache clean --force

COPY runtime/login-pty.py /opt/app/login-pty.py
