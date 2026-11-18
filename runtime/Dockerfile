# Tandem runtime: one container runs one standalone Happy Agent daemon for one person.
# Build with BuildKit (docker buildx) for linux/arm64 and/or linux/amd64. Every download is pinned
# per architecture and verified by checksum. Do not publish images built from this file: they
# contain Claude Code, the Grok CLI and Google's Antigravity CLI (see THIRD_PARTY.md).

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
# Codex runs tool calls (MCP tools included) through this companion from the same release; without
# it every tool call fails with "failed to spawn code-mode host".
ARG CODEX_CODE_MODE_HOST_SHA256_ARM64=e5e027e6689efda2e3570aa600179f0ebb18632803350e152ed6c9b97dcf9741
ARG CODEX_CODE_MODE_HOST_SHA256_AMD64=8a69207d97545ac753b6585974e1e67a4c51ae5deacf06517db512bb25e0e3c2
# Claude Code as a real program, so the daemon's provider-CLI sign-in can run `claude auth login`
# (npm registry dist.integrity, hex).
ARG CLAUDE_CODE_VERSION=2.1.321
ARG CLAUDE_CODE_SHA512_ARM64=137efddf76d743f9171814aba4a8eb5dd91a49b3c431b00ba77238c9c4b47d13190aa9ed907368cfa517c048894a619b3f4b0152a5823024c69959d29c430952
ARG CLAUDE_CODE_SHA512_AMD64=956f8c8544e19d4da1afa42743dc600fc73a3960096d836988ccc843838968bc5c0724ece77bfbc15ff62331aca416dc3219f1168c75befa25b6e5b29bf87abb
# Grok CLI, so the daemon's provider-CLI sign-in can run `grok login --device-auth`; Happy's grok
# provider then reads its sign-in file. xAI publishes no checksum files: these are of the release
# files as downloaded, which match the MD5 that xAI's storage reports for them.
ARG GROK_VERSION=1.0.89
ARG GROK_SHA256_ARM64=20496afea9dcec8ff1a3e3742a2966980888770d4ee845f80e5f0e5db56acb8b
ARG GROK_SHA256_AMD64=404456474906572060fa36745266caf1e967e9084e656da9572b42d35febf342
# Google's Antigravity CLI (agy) for the antigravity harness (`agy acp`), which runs Gemini on the
# person's own Gemini API key (sha512 from the vendor's release manifests). The release path names
# the version and its build.
ARG AGY_RELEASE=1.5.11-6132547114106880
ARG AGY_SHA512_ARM64=5f703c88e01851061c87c07b1a4ca54c1f5a6826ffada9fb005974a099e9a552ddb1f9ba2fe1194e2829803482c86084babf8cf91530a528bc7f659613600585
ARG AGY_SHA512_AMD64=dad3c015e8964fcdc1639b13b7152f4cb84cb1bde385707e2bcdf095d6f1831f4f6521199aec499cc052f9e99906b7fdbc52c273df064d5cb7c84b068ba3ce50

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* && mkdir /out

RUN set -eu; \
    case "$TARGETARCH" in \
      arm64) happy=linux-arm64; happy_sha=$HAPPY_AGENT_SHA256_ARM64; \
             codex=aarch64-unknown-linux-musl; codex_sha=$CODEX_SHA256_ARM64; \
             host_sha=$CODEX_CODE_MODE_HOST_SHA256_ARM64; \
             claude=linux-arm64; claude_sha=$CLAUDE_CODE_SHA512_ARM64; \
             grok=linux-aarch64; grok_sha=$GROK_SHA256_ARM64; \
             agy=linux-arm/cli_linux_arm64; agy_sha=$AGY_SHA512_ARM64 ;; \
      amd64) happy=linux-x64; happy_sha=$HAPPY_AGENT_SHA256_AMD64; \
             codex=x86_64-unknown-linux-musl; codex_sha=$CODEX_SHA256_AMD64; \
             host_sha=$CODEX_CODE_MODE_HOST_SHA256_AMD64; \
             claude=linux-x64; claude_sha=$CLAUDE_CODE_SHA512_AMD64; \
             grok=linux-x86_64; grok_sha=$GROK_SHA256_AMD64; \
             agy=linux-x64/cli_linux_x64; agy_sha=$AGY_SHA512_AMD64 ;; \
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
RUN export HOME=/tmp/version-check DISABLE_AUTOUPDATER=1 AGY_CLI_DISABLE_AUTO_UPDATE=true \
 && mkdir -p "$HOME" \
 && happy-agent --version && codex --version 2>/dev/null && claude --version \
 && grok --version && agy --version \
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
# The pinned CLIs stay as built: Claude Code's updater is off, and agy's (which otherwise starts a
# background download whenever its folder is writable) is off with exactly this value.
ENV HOME=/home/agent \
    DISABLE_AUTOUPDATER=1 \
    AGY_CLI_DISABLE_AUTO_UPDATE=true
ENTRYPOINT ["/usr/local/bin/agent-runtime-entrypoint"]
