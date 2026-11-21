# Third-party software

Tandem itself is MIT-licensed (see `LICENSE`). The Tandem image (`Dockerfile`) builds the per-person
runtime image inside it and downloads the programs below at image build time from their publishers,
verifying each download against a pinned checksum (npm packages are locked in `bun.lock`). This
repository does not contain or redistribute any of them.

| Component | Version | License | Source | Checksum |
| --- | --- | --- | --- | --- |
| Codex CLI | 0.160.1, aarch64 musl | Apache-2.0 | `https://github.com/openai/codex/releases/download/rust-v0.160.1/codex-aarch64-unknown-linux-musl.tar.gz` | sha256 `f54dc5852042445bf41da3aa31156f3cb02f52c5a1a04074de73dc5598f7e1f7` |
| Codex CLI | 0.160.1, x86_64 musl | Apache-2.0 | `https://github.com/openai/codex/releases/download/rust-v0.160.1/codex-x86_64-unknown-linux-musl.tar.gz` | sha256 `9226581be592d18f7e7f740a352fdb63aa61e45e39f7eb9b09d3888c84bba33f` |
| Codex code-mode host | 0.160.1, aarch64 musl | Apache-2.0 | `https://github.com/openai/codex/releases/download/rust-v0.160.1/codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz` | sha256 `e5e027e6689efda2e3570aa600179f0ebb18632803350e152ed6c9b97dcf9741` |
| Codex code-mode host | 0.160.1, x86_64 musl | Apache-2.0 | `https://github.com/openai/codex/releases/download/rust-v0.160.1/codex-code-mode-host-x86_64-unknown-linux-musl.tar.gz` | sha256 `8a69207d97545ac753b6585974e1e67a4c51ae5deacf06517db512bb25e0e3c2` |
| Claude Code | 2.1.330, linux-arm64 and linux-x64 | Anthropic's proprietary terms (not open source) | Anthropic's official npm packages `@anthropic-ai/claude-code-linux-arm64@2.1.330` and `@anthropic-ai/claude-code-linux-x64@2.1.330` | sha512 `578c9a9c…113dcb0` and `f469fe57…ec19ecd` (full values in `Dockerfile`) |
| Claude Agent SDK | 0.3.330 (gateway dependency, without its optional packages) | Anthropic's proprietary terms (not open source) | npm `@anthropic-ai/claude-agent-sdk@0.3.330` | locked in `bun.lock` |
| Grok CLI (Grok Build) | 1.0.89, linux-aarch64 | Source Apache-2.0 (`github.com/xai-org/grok-build`); xAI's release build, used under xAI's terms | `https://x.ai/cli/grok-1.0.89-linux-aarch64.gz` | sha256 `20496afea9dcec8ff1a3e3742a2966980888770d4ee845f80e5f0e5db56acb8b` |
| Grok CLI (Grok Build) | 1.0.89, linux-x86_64 | Source Apache-2.0 (`github.com/xai-org/grok-build`); xAI's release build, used under xAI's terms | `https://x.ai/cli/grok-1.0.89-linux-x86_64.gz` | sha256 `404456474906572060fa36745266caf1e967e9084e656da9572b42d35febf342` |
| Antigravity CLI (`agy`) | 1.5.11, linux-arm64 | Google's proprietary terms (not open source) | `https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.11-6132547114106880/linux-arm/cli_linux_arm64.tar.gz` | sha512 `5f703c88…13600585` (vendor manifest; full value in `Dockerfile`) |
| Antigravity CLI (`agy`) | 1.5.11, linux-x64 | Google's proprietary terms (not open source) | `https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.11-6132547114106880/linux-x64/cli_linux_x64.tar.gz` | sha512 `dad3c015…8ba3ce50` (vendor manifest; full value in `Dockerfile`) |
| goose (Block) | 1.60.2, aarch64 glibc | Apache-2.0 | `https://github.com/block/goose/releases/download/v1.60.2/goose-aarch64-unknown-linux-gnu.tar.gz` | sha256 `7e74d796e93b89df374715dc669149cb634f74d778de0b87bb7c031b5b093731` |
| goose (Block) | 1.60.2, x86_64 glibc | Apache-2.0 | `https://github.com/block/goose/releases/download/v1.60.2/goose-x86_64-unknown-linux-gnu.tar.gz` | sha256 `5f6e463621a8428617ae4870eecee7a00a253e9bbfccb6340dfaa4f0ec2aaf32` |
| Debian base image (multi-arch index) | trixie-slim | Debian licenses | `debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2` | pinned by digest |
| Bun base image (gateway, multi-arch index) | 1.3.9-slim | MIT | `oven/bun:1.3.9-slim@sha256:8ca06c7812d9050ccc4b80799685f395d6a0d051d3b7207dfd120e2b437b1ec9` | pinned by digest |
| jose (gateway dependency) | 6.1.3 | MIT | npm | `bun.lock` |
| Smokescreen (egress proxy) | v0.1.0, linux arm64 and amd64 | MIT | `https://github.com/stripe/smokescreen/releases/tag/v0.1.0` | sha256 `f15ddd0d…24b7c9` (arm64), `4e1e4474…1ec46` (amd64); full values in `Dockerfile` |
| crun (sandbox runtime) | Debian trixie package | GPL-2.0-or-later (libcrun LGPL-2.1-or-later) | Debian `crun`; source <https://github.com/containers/crun> | Debian archive signatures |
| Docker's default seccomp profile (`runtime/seccomp-docker-default.json`, copied unmodified) | moby/profiles `a0fa70805f742f7da15b367770d802ea2a86c68b` | Apache-2.0 | <https://github.com/moby/profiles/blob/a0fa70805f742f7da15b367770d802ea2a86c68b/seccomp/default.json> | pinned by commit |
| tini (init inside each sandbox) | Debian trixie package | MIT | Debian `tini`; source <https://github.com/krallin/tini> | Debian archive signatures |

## Claude Code

Claude Code is Anthropic's proprietary software, used under Anthropic's terms
(<https://code.claude.com/docs/en/legal-and-compliance>). Tandem fetches it from Anthropic's official
npm package when *you* build the runtime image and never redistributes it.

**Do not publish prebuilt Tandem images.** An image built from `Dockerfile` contains Claude Code
(installed at `/usr/local/bin/claude`), so pushing it to a public or shared registry would
redistribute Anthropic's software. Build the image yourself, where you run it. The gateway's npm
dependencies are installed without their optional dependencies, so no second Claude Code is bundled.

## Grok CLI and Antigravity CLI

The Grok CLI is xAI's release build of the Apache-2.0 Grok Build source. xAI publishes no checksum
files, so `Dockerfile` pins the SHA-256 of the files as downloaded (they match the MD5 that
xAI's storage reports). Google's Antigravity CLI (`agy`) is proprietary and pinned to the SHA-512 in
Google's release manifest; Tandem runs it only on a person's own Gemini API key, never on an
Antigravity sign-in. Both are downloaded from their vendors when *you* build the runtime image and
never redistributed by this repository, and the same rule applies: do not publish prebuilt Tandem
images. Their use is governed by xAI's and Google's terms (see README, Vendor terms).

## Happy Agent

Earlier Tandem versions ran [Happy Agent](https://github.com/slopus/happy-agent) (MIT) in every
workspace. Tandem no longer downloads or runs it, but its vendor integrations were the map for
Tandem's own (`src/agents/`, `src/signin/`): how it drives the Claude Agent SDK, `codex app-server`,
ACP agents and the vendors' sign-in CLIs. Happy Agent's copyright and permission notice:
"Copyright (c) 2026 rig Contributors. Permission is hereby granted, free of charge, to any person
obtaining a copy of this software …" (MIT; full text in its repository's `LICENSE`).
