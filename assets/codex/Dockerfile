FROM rust:1.95-bookworm AS native

# Immutable fork revision verified by the native repository's Linux CI.
RUN git init /native \
    && cd /native \
    && git fetch --depth 1 https://github.com/stepandel/cantelop-codex-native.git 9a80fe92a2cfa689afd47fed4f9f5e28249cecf2 \
    && git checkout --detach FETCH_HEAD
WORKDIR /native/codex-rs
# Bound memory use on image builders; keep reusable compiler output out of the image.
RUN --mount=type=cache,id=cantelop-codex-registry,sharing=locked,target=/usr/local/cargo/registry \
    --mount=type=cache,id=cantelop-codex-target,sharing=locked,target=/native/codex-rs/target \
    CARGO_PROFILE_RELEASE_DEBUG=0 CARGO_PROFILE_RELEASE_STRIP=symbols \
    CARGO_PROFILE_RELEASE_LTO=false CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16 \
    cargo build --jobs 2 --locked --release -p codex-app-server --bin codex-app-server \
    && cp target/release/codex-app-server /native/cantelop-codex

FROM node:22-bookworm-slim
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git ripgrep python3 libssl3 bubblewrap \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @openai/codex@0.162.1 \
    && npm cache clean --force
COPY --from=native /native/cantelop-codex /usr/local/bin/cantelop-codex
COPY --from=native /native/LICENSE /native/NOTICE /usr/local/share/cantelop-codex/
COPY --from=native /native/cantelop/LICENSE /usr/local/share/cantelop-codex/LICENSE.cantelop
COPY --from=native /native/cantelop/compatibility.json /usr/local/share/cantelop-codex/compatibility.json
RUN mkdir -p /opt/app \
    && printf '%s' '__LOGIN_PTY_BASE64__' | base64 --decode > /opt/app/login-pty.py
