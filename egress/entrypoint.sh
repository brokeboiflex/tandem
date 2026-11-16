#!/bin/sh
# Writes Smokescreen's ACL from the environment (the same .env as the gateway), then runs it.
#   EGRESS_MODE           auto/allowlist: only the allowlist; open: any public host; off: no proxy
#   EGRESS_ALLOW_DOMAINS  extra hostnames, comma-separated; "*.example.com" covers subdomains only
#   EGRESS_ALLOW_RANGES   private CIDRs runtimes may reach anyway (e.g. an internal registry)
# Private, loopback, link-local and CGNAT addresses stay refused in every mode unless listed in
# EGRESS_ALLOW_RANGES; that is Smokescreen's default.
set -euf # no pathname expansion: "*.example.com" is a hostname glob

case ${EGRESS_MODE:-auto} in
  auto | allowlist) action=enforce ;;
  open) action=open ;;
  off)
    echo "egress proxy idle: EGRESS_MODE=off gives runtimes direct Internet access" >&2
    exec sleep 2147483647
    ;;
  *) echo "EGRESS_MODE must be auto, allowlist, open or off" >&2; exit 64 ;;
esac

dir=${EGRESS_CONFIG_DIR:-/tmp}
domains=$(
  { grep -v '^[[:space:]]*\(#\|$\)' /etc/tandem-egress/allowlist.txt
    printf '%s\n' "${EGRESS_ALLOW_DOMAINS:-}" | tr ', ' '\n\n'
  } | tr 'A-Z' 'a-z' | sed '/^$/d' | sort -u
)
{
  echo "version: v1"
  echo "services: []"
  echo "default:"
  echo "  name: tandem-runtimes"
  echo "  project: tandem"
  echo "  action: $action"
  echo "  allowed_domains:"
  for d in $domains; do
    case $d in
      *[!a-z0-9.*-]*) echo "EGRESS_ALLOW_DOMAINS: invalid hostname '$d'" >&2; exit 64 ;;
    esac
    echo "    - \"$d\""
  done
} > "$dir/acl.yaml"
printf 'allow_missing_role: true\n' > "$dir/config.yaml"

set -- --listen-ip 0.0.0.0 --listen-port 4750 \
  --config-file "$dir/config.yaml" --egress-acl-file "$dir/acl.yaml"
for r in $(printf '%s' "${EGRESS_ALLOW_RANGES:-}" | tr ',' ' '); do
  set -- "$@" --allow-range "$r"
done
echo "egress proxy: mode=${EGRESS_MODE:-auto} action=$action domains=$(echo $domains | wc -w) allow_ranges=${EGRESS_ALLOW_RANGES:-none}" >&2
exec /usr/local/bin/smokescreen "$@"
