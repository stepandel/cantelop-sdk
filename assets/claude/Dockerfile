FROM node:22-bookworm-slim

# Stock CLI version is maintained here alongside the harness.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git gh ripgrep python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @anthropic-ai/claude-code@2.1.259 \
    && npm cache clean --force

# Embedded at package build time; requires no files from the consumer build context.
RUN mkdir -p /opt/app \
    && printf '%s' '__LOGIN_PTY_BASE64__' | base64 --decode > /opt/app/login-pty.py
