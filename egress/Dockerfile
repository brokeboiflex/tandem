# Tandem egress proxy: Stripe's Smokescreen (HTTP CONNECT proxy with a hostname allowlist that also
# refuses private, loopback, link-local and CGNAT addresses) for the runtimes' internal networks.
# The release binary is pinned per architecture and verified by checksum.

# Multi-arch index digest (covers linux/amd64 and linux/arm64).
ARG BASE=alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f

FROM --platform=$BUILDPLATFORM ${BASE} AS fetch
ARG TARGETARCH
# https://github.com/stripe/smokescreen/releases/tag/v0.1.0 (SHA256SUMS of the release).
ARG SMOKESCREEN_VERSION=v0.1.0
ARG SMOKESCREEN_SHA256_ARM64=f15ddd0dc2b2cbc6d7318f441928939eb9bedfab2a1881508af3096a1e24b7c9
ARG SMOKESCREEN_SHA256_AMD64=4e1e447449e3cc653dae956208588722b5c8fe8ce894f633adc756a851d1ec46
RUN set -eu; \
    case "$TARGETARCH" in \
      arm64) sha=$SMOKESCREEN_SHA256_ARM64 ;; \
      amd64) sha=$SMOKESCREEN_SHA256_AMD64 ;; \
      *) echo "unsupported TARGETARCH '$TARGETARCH'" >&2; exit 1 ;; \
    esac; \
    name="smokescreen_${SMOKESCREEN_VERSION}_linux_${TARGETARCH}"; \
    wget -q -O /tmp/s.tgz "https://github.com/stripe/smokescreen/releases/download/${SMOKESCREEN_VERSION}/${name}.tar.gz"; \
    echo "${sha}  /tmp/s.tgz" | sha256sum -c -; \
    tar -xzf /tmp/s.tgz -C /tmp; \
    install -D -m 0755 "/tmp/${name}/smokescreen" /out/smokescreen

FROM ${BASE}
COPY --from=fetch /out/smokescreen /usr/local/bin/smokescreen
COPY allowlist.txt /etc/tandem-egress/allowlist.txt
COPY entrypoint.sh /usr/local/bin/egress-entrypoint
RUN chmod 0644 /etc/tandem-egress/allowlist.txt && chmod 0755 /usr/local/bin/egress-entrypoint
USER 65532:65532
EXPOSE 4750
ENTRYPOINT ["/usr/local/bin/egress-entrypoint"]
