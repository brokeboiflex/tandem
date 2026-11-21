# Tandem: ONE image and ONE container. The gateway (Bun) runs every vendor program of every person in
# a sandbox of its own (crun: the person's uid and their own namespaces) on the runtime filesystem
# built below and kept read-only in this image. No KVM, no Docker socket. Build with BuildKit for
# linux/amd64 or linux/arm64. Every download is pinned per architecture and verified by checksum. Do
# not publish images built from this file: they contain Claude Code, the Grok CLI and Google's
# Antigravity CLI (see THIRD_PARTY.md).

# Multi-arch index digest (covers linux/amd64 and linux/arm64).
ARG BASE=debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2

# Downloads run natively on the build machine; only the selected target's artifacts are kept.
FROM --platform=$BUILDPLATFORM ${BASE} AS fetch
ARG TARGETARCH
# Codex (`codex app-server`; the gateway speaks its 0.160.1 protocol). GitHub asset digests.
ARG CODEX_VERSION=0.160.1
ARG CODEX_SHA256_ARM64=f54dc5852042445bf41da3aa31156f3cb02f52c5a1a04074de73dc5598f7e1f7
ARG CODEX_SHA256_AMD64=9226581be592d18f7e7f740a352fdb63aa61e45e39f7eb9b09d3888c84bba33f
# Codex runs tool calls (MCP tools included) through this companion from the same release; without
# it every tool call fails with "failed to spawn code-mode host".
ARG CODEX_CODE_MODE_HOST_SHA256_ARM64=e5e027e6689efda2e3570aa600179f0ebb18632803350e152ed6c9b97dcf9741
ARG CODEX_CODE_MODE_HOST_SHA256_AMD64=8a69207d97545ac753b6585974e1e67a4c51ae5deacf06517db512bb25e0e3c2
# Claude Code, the program the gateway's Claude Agent SDK runs, also for `claude auth login` (npm
# registry dist.integrity, hex).
ARG CLAUDE_CODE_VERSION=2.1.321
ARG CLAUDE_CODE_SHA512_ARM64=137efddf76d743f9171814aba4a8eb5dd91a49b3c431b00ba77238c9c4b47d13190aa9ed907368cfa517c048894a619b3f4b0152a5823024c69959d29c430952
ARG CLAUDE_CODE_SHA512_AMD64=956f8c8544e19d4da1afa42743dc600fc73a3960096d836988ccc843838968bc5c0724ece77bfbc15ff62331aca416dc3219f1168c75befa25b6e5b29bf87abb
# Grok CLI (Grok Build: `grok agent stdio`, `grok login --device-auth`). xAI publishes no checksum
# files: these are of the release files as downloaded, which match the MD5 that xAI's storage reports
# for them.
ARG GROK_VERSION=1.0.89
ARG GROK_SHA256_ARM64=20496afea9dcec8ff1a3e3742a2966980888770d4ee845f80e5f0e5db56acb8b
ARG GROK_SHA256_AMD64=404456474906572060fa36745266caf1e967e9084e656da9572b42d35febf342
# Google's Antigravity CLI (`agy acp`), which runs Gemini on the person's own Gemini API key (sha512
# from the vendor's release manifests). The release path names the version and its build.
ARG AGY_RELEASE=1.5.11-6132547114106880
ARG AGY_SHA512_ARM64=5f703c88e01851061c87c07b1a4ca54c1f5a6826ffada9fb005974a099e9a552ddb1f9ba2fe1194e2829803482c86084babf8cf91530a528bc7f659613600585
ARG AGY_SHA512_AMD64=dad3c015e8964fcdc1639b13b7152f4cb84cb1bde385707e2bcdf095d6f1831f4f6521199aec499cc052f9e99906b7fdbc52c273df064d5cb7c84b068ba3ce50
# Block's goose (`goose acp`) for OpenRouter models on the person's own key. GitHub asset digests of
# the glibc builds (the release publishes no checksum files).
ARG GOOSE_VERSION=1.60.2
ARG GOOSE_SHA256_ARM64=7e74d796e93b89df374715dc669149cb634f74d778de0b87bb7c031b5b093731
ARG GOOSE_SHA256_AMD64=5f6e463621a8428617ae4870eecee7a00a253e9bbfccb6340dfaa4f0ec2aaf32

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* && mkdir /out

RUN set -eu; \
    case "$TARGETARCH" in \
      arm64) codex=aarch64-unknown-linux-musl; codex_sha=$CODEX_SHA256_ARM64; \
             host_sha=$CODEX_CODE_MODE_HOST_SHA256_ARM64; \
             claude=linux-arm64; claude_sha=$CLAUDE_CODE_SHA512_ARM64; \
             grok=linux-aarch64; grok_sha=$GROK_SHA256_ARM64; \
             agy=linux-arm/cli_linux_arm64; agy_sha=$AGY_SHA512_ARM64; \
             goose=aarch64-unknown-linux-gnu; goose_sha=$GOOSE_SHA256_ARM64 ;; \
      amd64) codex=x86_64-unknown-linux-musl; codex_sha=$CODEX_SHA256_AMD64; \
             host_sha=$CODEX_CODE_MODE_HOST_SHA256_AMD64; \
             claude=linux-x64; claude_sha=$CLAUDE_CODE_SHA512_AMD64; \
             grok=linux-x86_64; grok_sha=$GROK_SHA256_AMD64; \
             agy=linux-x64/cli_linux_x64; agy_sha=$AGY_SHA512_AMD64; \
             goose=x86_64-unknown-linux-gnu; goose_sha=$GOOSE_SHA256_AMD64 ;; \
      *) echo "unsupported TARGETARCH '$TARGETARCH': build with docker buildx --platform linux/arm64 or linux/amd64" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/codex.tar.gz \
      "https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-${codex}.tar.gz"; \
    echo "${codex_sha}  /tmp/codex.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/codex.tar.gz -C /tmp; \
    install -m 0755 "/tmp/codex-${codex}" /out/codex; \
    curl -fsSL -o /tmp/code-mode-host.tar.gz \
      "https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-code-mode-host-${codex}.tar.gz"; \
    echo "${host_sha}  /tmp/code-mode-host.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/code-mode-host.tar.gz -C /tmp; \
    install -m 0755 "/tmp/codex-code-mode-host-${codex}" /out/codex-code-mode-host; \
    curl -fsSL -o /tmp/claude.tgz \
      "https://registry.npmjs.org/@anthropic-ai/claude-code-${claude}/-/claude-code-${claude}-${CLAUDE_CODE_VERSION}.tgz"; \
    echo "${claude_sha}  /tmp/claude.tgz" | sha512sum -c -; \
    tar -xzf /tmp/claude.tgz -C /tmp package/claude; \
    install -m 0755 /tmp/package/claude /out/claude; \
    curl -fsSL -o /tmp/grok.gz \
      "https://x.ai/cli/grok-${GROK_VERSION}-${grok}.gz"; \
    echo "${grok_sha}  /tmp/grok.gz" | sha256sum -c -; \
    gunzip -c /tmp/grok.gz > /out/grok; \
    chmod 0755 /out/grok; \
    curl -fsSL -o /tmp/agy.tar.gz \
      "https://storage.googleapis.com/antigravity-public/antigravity-cli/${AGY_RELEASE}/${agy}.tar.gz"; \
    echo "${agy_sha}  /tmp/agy.tar.gz" | sha512sum -c -; \
    tar -xzf /tmp/agy.tar.gz -C /tmp antigravity; \
    install -m 0755 /tmp/antigravity /out/agy; \
    curl -fsSL -o /tmp/goose.tar.gz \
      "https://github.com/block/goose/releases/download/v${GOOSE_VERSION}/goose-${goose}.tar.gz"; \
    echo "${goose_sha}  /tmp/goose.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/goose.tar.gz -C /tmp ./goose; \
    install -m 0755 /tmp/goose /out/goose; \
    rm -rf /tmp/*

FROM ${BASE} AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git socat procps bubblewrap tini \
 && rm -rf /var/lib/apt/lists/*

COPY --from=fetch /out/ /usr/local/bin/

# Version sanity checks with a throwaway HOME so nothing lands in the image's home directories.
RUN export HOME=/tmp/version-check DISABLE_AUTOUPDATER=1 AGY_CLI_DISABLE_AUTO_UPDATE=true \
      GOOSE_DISABLE_KEYRING=1 \
 && mkdir -p "$HOME" \
 && codex --version 2>/dev/null && claude --version \
 && grok --version && agy --version && goose --version \
 && rm -rf "$HOME"

RUN useradd --create-home --home-dir /home/agent --uid 10001 --user-group --shell /bin/bash agent \
 && chmod 0700 /home/agent \
 && install -d -m 0755 /var/tmp/agent

# The first program of every sandbox (src/runtime.ts), and the vendor settings every person's
# programs read from the system (docs/agent-layer.md): Claude Code's managed settings and Codex's
# system config and requirements. (COPY --chmod would give the new directories the files' mode.)
COPY runtime/agent-run /usr/local/bin/agent-run
COPY runtime/etc/claude-code/managed-settings.json /etc/claude-code/
COPY runtime/etc/codex/config.toml runtime/etc/codex/requirements.toml /etc/codex/
RUN chmod 0755 /usr/local/bin/agent-run /etc/claude-code /etc/codex \
 && chmod 0644 /etc/claude-code/managed-settings.json /etc/codex/config.toml /etc/codex/requirements.toml


# Stripe's Smokescreen, the runtimes' egress proxy (src/egress.ts). Release binary pinned per
# architecture (SHA256SUMS of https://github.com/stripe/smokescreen/releases/tag/v0.1.0).
FROM --platform=$BUILDPLATFORM ${BASE} AS smokescreen
ARG TARGETARCH
ARG SMOKESCREEN_VERSION=v0.1.0
ARG SMOKESCREEN_SHA256_ARM64=f15ddd0dc2b2cbc6d7318f441928939eb9bedfab2a1881508af3096a1e24b7c9
ARG SMOKESCREEN_SHA256_AMD64=4e1e447449e3cc653dae956208588722b5c8fe8ce894f633adc756a851d1ec46
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
RUN set -eu; \
    case "$TARGETARCH" in \
      arm64) sha=$SMOKESCREEN_SHA256_ARM64 ;; \
      amd64) sha=$SMOKESCREEN_SHA256_AMD64 ;; \
      *) echo "unsupported TARGETARCH '$TARGETARCH'" >&2; exit 1 ;; \
    esac; \
    name="smokescreen_${SMOKESCREEN_VERSION}_linux_${TARGETARCH}"; \
    curl -fsSL -o /tmp/s.tgz "https://github.com/stripe/smokescreen/releases/download/${SMOKESCREEN_VERSION}/${name}.tar.gz"; \
    echo "${sha}  /tmp/s.tgz" | sha256sum -c -; \
    tar -xzf /tmp/s.tgz -C /tmp; \
    install -D -m 0755 "/tmp/${name}/smokescreen" /out/smokescreen

FROM oven/bun:1.3.9-slim@sha256:8ca06c7812d9050ccc4b80799685f395d6a0d051d3b7207dfd120e2b437b1ec9 AS bun

# The Tandem container: the gateway, crun, Smokescreen and the runtime filesystem. It runs as root:
# creating sandboxes needs it, and the sandboxes (their own uids, no capabilities), not this
# container, are what separate people (README, Security).
FROM ${BASE}
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates crun \
 && rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=smokescreen /out/smokescreen /usr/local/bin/smokescreen
COPY --from=runtime / /opt/tandem/rootfs/
WORKDIR /app
COPY package.json bun.lock ./
# No optional dependencies: the Claude Agent SDK's would add a second, bundled Claude Code; the SDK
# runs the pinned /usr/local/bin/claude of the runtime filesystem instead.
RUN bun install --frozen-lockfile --production --omit=optional
COPY src ./src
COPY public ./public
COPY runtime/egress-allowlist.txt runtime/seccomp-docker-default.json ./runtime/
ENV DATA_DIR=/var/lib/tandem \
    RUNTIME_ROOTFS=/opt/tandem/rootfs \
    BIND_HOST=0.0.0.0
VOLUME /var/lib/tandem
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --retries=3 --start-period=60s \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["bun", "src/gateway.ts"]
