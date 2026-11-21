#!/bin/sh
# Packs a root filesystem into a one-layer image archive in `docker save` format, which the gateway
# loads into microsandbox (src/runtime.ts), and writes the archive's sha256 next to it.
# Usage: pack-image <rootfs> <out-dir> <amd64|arm64>
set -eu
root=$1 out=$2 arch=$3
work=$(mktemp -d)
mkdir -p "$out"
tar --numeric-owner --xattrs -C "$root" -cf "$work/layer.tar" .
layer=$(sha256sum "$work/layer.tar" | cut -d' ' -f1)
mv "$work/layer.tar" "$work/$layer.tar"
# What runtime/entrypoint.sh and the CLIs expect; the gateway also passes HOME and TMPDIR itself.
cat > "$work/config.json" <<JSON
{"architecture":"$arch","os":"linux","config":{"User":"agent","WorkingDir":"/home/agent","Env":["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin","HOME=/home/agent","DISABLE_AUTOUPDATER=1","AGY_CLI_DISABLE_AUTO_UPDATE=true"],"Entrypoint":["/usr/local/bin/agent-runtime-entrypoint"]},"rootfs":{"type":"layers","diff_ids":["sha256:$layer"]}}
JSON
config=$(sha256sum "$work/config.json" | cut -d' ' -f1)
mv "$work/config.json" "$work/$config.json"
printf '[{"Config":"%s.json","RepoTags":["tandem-runtime:packed"],"Layers":["%s.tar"]}]\n' \
  "$config" "$layer" > "$work/manifest.json"
tar -C "$work" -cf "$out/runtime.tar" manifest.json "$config.json" "$layer.tar"
sha256sum "$out/runtime.tar" | cut -d' ' -f1 > "$out/runtime.tar.sha256"
rm -rf "$work"
