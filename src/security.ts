// What keeps people apart: each person's runtime is its own microVM (src/runtime.ts), and these
// rules decide what a microVM may reach. Pure functions, so tests need no hypervisor.
import { readFileSync } from "node:fs";
import type { Config } from "./config";

/** Big temporary files (Happy unpacks Claude Code here) go to the home, once per person. */
export const RUNTIME_TMPDIR = "/home/agent/.cache/tmp";

/** The vendor hosts the runtimes need (README, Security): one hostname or `*.domain` per line. */
export const ALLOWLIST_FILE = new URL(
  "../runtime/egress-allowlist.txt",
  import.meta.url,
);

export type Posture = {
  sandbox: "microvm";
  egress: "allowlist" | "open";
  warnings: string[];
};

/**
 * Where runtimes may connect. `allowlist`: only the listed hosts (ports 80 and 443) and ranges.
 * `open`: any public address, plus the listed ranges. Private networks, the host, link-local and
 * cloud metadata addresses stay unreachable in both, except for the listed ranges.
 */
export type EgressRules =
  | { mode: "allowlist"; exact: string[]; suffixes: string[]; ranges: string[] }
  | { mode: "open"; ranges: string[] };

const HOST_RE =
  /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

/** Hostnames from the allowlist file plus EGRESS_ALLOW_DOMAINS, validated and sorted. */
export function parseHosts(
  text: string,
  extra: string[],
): { exact: string[]; suffixes: string[] } {
  const exact = new Set<string>();
  const suffixes = new Set<string>();
  const lines = text
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim())
    .filter(Boolean);
  for (const raw of [...lines, ...extra]) {
    const host = raw.toLowerCase();
    if (!HOST_RE.test(host))
      throw new Error(`egress allowlist: "${raw}" is not a hostname`);
    // `*.example.com` is every subdomain; the apex needs its own line, as before.
    if (host.startsWith("*.")) suffixes.add(host.slice(2));
    else exact.add(host);
  }
  // A suffix rule matches its apex too, so listing both keeps one rule.
  for (const s of suffixes) exact.delete(s);
  return { exact: [...exact].sort(), suffixes: [...suffixes].sort() };
}

export function egressRules(
  cfg: Config,
  allowlist = readFileSync(ALLOWLIST_FILE, "utf8"),
): EgressRules {
  const ranges = [...cfg.egressAllowRanges].sort();
  if (cfg.egressMode === "open") return { mode: "open", ranges };
  return {
    mode: "allowlist",
    ...parseHosts(allowlist, cfg.egressAllowDomains),
    ranges,
  };
}
