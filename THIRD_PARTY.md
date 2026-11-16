# Third-party software

Tandem itself is MIT-licensed (see `LICENSE`). The per-person runtime image (`runtime/Dockerfile`)
downloads the programs below at image build time from their publishers and verifies each download
against a pinned checksum. This repository does not contain or redistribute any of them.

| Component | Version | License | Source | Checksum |
| --- | --- | --- | --- | --- |
| Happy Agent (standalone daemon) | 2026.11.6-preview.7, linux-arm64 | MIT | `https://github.com/slopus/happy-agent/releases/download/v2026.11.6-preview.7/happy-agent-2026.11.6-preview.7-linux-arm64.tar.gz` | sha256 `7907e0b80b3ecfb2f7c615c38dc949ccb83cd7a98a6245fbb6dcd5ca3ce65a50` |
| Happy Agent (standalone daemon) | 2026.11.6-preview.7, linux-x64 | MIT | `https://github.com/slopus/happy-agent/releases/download/v2026.11.6-preview.7/happy-agent-2026.11.6-preview.7-linux-x64.tar.gz` | sha256 `4b6023e8380f50c0b7d04e12587fd599f6b3ba791061797ad9ed5cbef398106d` |
| Codex CLI | 0.160.1, aarch64 musl | Apache-2.0 | `https://github.com/openai/codex/releases/download/rust-v0.160.1/codex-aarch64-unknown-linux-musl.tar.gz` | sha256 `f54dc5852042445bf41da3aa31156f3cb02f52c5a1a04074de73dc5598f7e1f7` |
| Codex CLI | 0.160.1, x86_64 musl | Apache-2.0 | `https://github.com/openai/codex/releases/download/rust-v0.160.1/codex-x86_64-unknown-linux-musl.tar.gz` | sha256 `9226581be592d18f7e7f740a352fdb63aa61e45e39f7eb9b09d3888c84bba33f` |
| Codex code-mode host | 0.160.1, aarch64 musl | Apache-2.0 | `https://github.com/openai/codex/releases/download/rust-v0.160.1/codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz` | sha256 `e5e027e6689efda2e3570aa600179f0ebb18632803350e152ed6c9b97dcf9741` |
| Codex code-mode host | 0.160.1, x86_64 musl | Apache-2.0 | `https://github.com/openai/codex/releases/download/rust-v0.160.1/codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz` | sha256 `8a69207d97545ac753b6585974e1e67a4c51ae5deacf06517db512bb25e0e3c2` |
| Claude Code | 2.1.321, linux-arm64 and linux-x64 | Anthropic's proprietary terms (not open source) | Anthropic's official npm packages `@anthropic-ai/claude-code-linux-arm64@2.1.321` and `@anthropic-ai/claude-code-linux-x64@2.1.321` | sha512 `137efddf…c430952` and `956f8c85…87abb` (full values in `runtime/Dockerfile`) |
| Debian base image (multi-arch index) | trixie-slim | Debian licenses | `debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2` | pinned by digest |
| Bun base image (gateway, multi-arch index) | 1.3.9-slim | MIT | `oven/bun:1.3.9-slim@sha256:8ca06c7812d9050ccc4b80799685f395d6a0d051d3b7207dfd120e2b437b1ec9` | pinned by digest |
| jose (gateway dependency) | 6.1.3 | MIT | npm | `bun.lock` |

## Claude Code

Claude Code is Anthropic's proprietary software, used under Anthropic's terms
(<https://code.claude.com/docs/en/legal-and-compliance>). Tandem fetches it from Anthropic's official
npm package when *you* build the runtime image and never redistributes it.

**Do not publish prebuilt runtime images.** An image built from `runtime/Dockerfile` contains Claude Code
(both the copy installed at `/usr/local/bin/claude` and the copy embedded in the Happy Agent binary), so
pushing it to a public or shared registry would redistribute Anthropic's software. Build the image
yourself, where you run it.

Happy Agent's own release binary also embeds Claude Code through the Claude Agent SDK; that is part of
the Happy Agent release you download, under Happy Agent's and Anthropic's terms.
