# Tandem runtime: one container runs one standalone Happy Agent daemon for one person.
# Build with BuildKit (docker buildx) for linux/arm64 and/or linux/amd64. Every download is pinned
# per architecture and verified by checksum. Do not publish images built from this file: they
# contain Claude Code (see THIRD_PARTY.md).

# Multi-arch index digest (covers linux/amd64 and linux/arm64).
ARG BASE=debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2

# Downloads run natively on the build machine; only the selected target's artifacts are kept.
FROM --platform=$BUILDPLATFORM ${BASE} AS fetch
ARG TARGETARCH
# Happy Agent standalone release (Bun-compiled single binary; embeds Claude Code 2.1.321 through the
# Claude Agent SDK for the claude_code harness). Checksums: the release's .sha256 files, which match
# GitHub's asset digests.
ARG HAPPY_AGENT_VERSION=2026.11.6-preview.7
ARG HAPPY_AGENT_SHA256_ARM64=7907e0b80b3ecfb2f7c615c38dc949ccb83cd7a98a6245fbb6dcd5ca3ce65a50
ARG HAPPY_AGENT_SHA256_AMD64=4b6023e8380f50c0b7d04e12587fd599f6b3ba791061797ad9ed5cbef398106d
# Codex: the version Happy Agent pins and tests its codex_cli harness against (GitHub asset digests).
ARG CODEX_VERSION=0.160.1
ARG CODEX_SHA256_ARM64=f54dc5852042445bf41da3aa31156f3cb02f52c5a1a04074de73dc5598f7e1f7
ARG CODEX_SHA256_AMD64=9226581be592d18f7e7f740a352fdb63aa61e45e39f7eb9b09d3888c84bba33f
# Claude Code as a real program, so the daemon's provider-CLI sign-in can run `claude auth login`
# (npm registry dist.integrity, hex).
ARG CLAUDE_CODE_VERSION=2.1.321
ARG CLAUDE_CODE_SHA512_ARM64=137efddf76d743f9171814aba4a8eb5dd91a49b3c431b00ba77238c9c4b47d13190aa9ed907368cfa517c048894a619b3f4b0152a5823024c69959d29c430952
ARG CLAUDE_CODE_SHA512_AMD64=956f8c8544e19d4da1afa42743dc600fc73a3960096d836988ccc843838968bc5c0724ece77bfbc15ff62331aca416dc3219f1168c75befa25b6e5b29bf87abb

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* && mkdir /out

RUN set -eu; \
    case "$TARGETARCH" in \
      arm64) happy=linux-arm64; happy_sha=$HAPPY_AGENT_SHA256_ARM64; \
             codex=aarch64-unknown-linux-musl; codex_sha=$CODEX_SHA256_ARM64; \
             claude=linux-arm64; claude_sha=$CLAUDE_CODE_SHA512_ARM64 ;; \
      amd64) happy=linux-x64; happy_sha=$HAPPY_AGENT_SHA256_AMD64; \
             codex=x86_64-unknown-linux-musl; codex_sha=$CODEX_SHA256_AMD64; \
             claude=linux-x64; claude_sha=$CLAUDE_CODE_SHA512_AMD64 ;; \
      *) echo "unsupported TARGETARCH '$TARGETARCH': build with docker buildx --platform linux/arm64 or linux/amd64" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/codex.tar.gz \
      "https://github.com/openai/codex/releases/download/rust-v${CODEX_VERSION}/codex-${codex}.tar.gz"; \
    echo "${codex_sha}  /tmp/codex.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/codex.tar.gz -C /tmp; \
    install -m 0755 "/tmp/codex-${codex}" /out/codex; \
    curl -fsSL -o /tmp/claude.tgz \
      "https://registry.npmjs.org/@anthropic-ai/claude-code-${claude}/-/claude-code-${claude}-${CLAUDE_CODE_VERSION}.tgz"; \
    echo "${claude_sha}  /tmp/claude.tgz" | sha512sum -c -; \
    tar -xzf /tmp/claude.tgz -C /tmp package/claude; \
    install -m 0755 /tmp/package/claude /out/claude; \
    curl -fsSL -o /tmp/happy-agent.tar.gz \
      "https://github.com/slopus/happy-agent/releases/download/v${HAPPY_AGENT_VERSION}/happy-agent-${HAPPY_AGENT_VERSION}-${happy}.tar.gz"; \
    echo "${happy_sha}  /tmp/happy-agent.tar.gz" | sha256sum -c -; \
    tar -xzf /tmp/happy-agent.tar.gz -C /tmp; \
    install -m 0755 "/tmp/happy-agent-${happy}" /out/happy-agent; \
    rm -rf /tmp/*

FROM ${BASE}
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git socat procps bubblewrap \
 && rm -rf /var/lib/apt/lists/*

COPY --from=fetch /out/ /usr/local/bin/

# Version sanity checks with a throwaway HOME so nothing lands in the image's home directories.
RUN export HOME=/tmp/version-check DISABLE_AUTOUPDATER=1 \
 && mkdir -p "$HOME" \
 && happy-agent --version && codex --version 2>/dev/null && claude --version \
 && rm -rf "$HOME"

RUN useradd --create-home --home-dir /home/agent --uid 10001 --user-group --shell /bin/bash agent \
 && chmod 0700 /home/agent

COPY happy.toml /opt/agent-runtime/happy.toml
COPY entrypoint.sh /usr/local/bin/agent-runtime-entrypoint
COPY happy-api /usr/local/bin/happy-api
RUN chmod 0644 /opt/agent-runtime/happy.toml \
 && chmod 0755 /usr/local/bin/agent-runtime-entrypoint /usr/local/bin/happy-api

USER agent
WORKDIR /home/agent
ENV HOME=/home/agent \
    DISABLE_AUTOUPDATER=1
ENTRYPOINT ["/usr/local/bin/agent-runtime-entrypoint"]
