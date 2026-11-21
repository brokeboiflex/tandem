// The runtimes' only way out: Stripe's Smokescreen (an HTTP CONNECT proxy with a hostname
// allowlist that refuses private, loopback, link-local and CGNAT addresses), run by the gateway on
// the container's loopback, which no sandbox can reach, and a Unix socket relayed to it, which is
// bind-mounted into every sandbox (src/security.ts).
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import type { Config } from "./config";
import { smokescreenAcl } from "./security";

/** Smokescreen's own port, on the container's loopback only. */
export const SMOKESCREEN_PORT = 4750;
const SMOKESCREEN = "/usr/local/bin/smokescreen";

/** Smokescreen's command line: its config, its ACL and the private ranges allowed anyway. */
export function smokescreenArgs(cfg: Config, dir: string) {
  return [
    SMOKESCREEN,
    "--listen-ip",
    "127.0.0.1",
    "--listen-port",
    String(SMOKESCREEN_PORT),
    "--config-file",
    join(dir, "config.yaml"),
    "--egress-acl-file",
    join(dir, "acl.yaml"),
    ...cfg.egressAllowRanges.flatMap((r) => ["--allow-range", r]),
  ];
}

/**
 * Starts Smokescreen (restarted if it exits) and the relay socket. Resolves once both listen; the
 * relay's socket is `socket`, world-connectable because every sandbox user needs it.
 */
export async function startEgress(
  cfg: Config,
  socket: string,
  log: (...args: unknown[]) => void = console.log,
): Promise<{ stop(): void }> {
  const dir = join(cfg.dataDir, "egress");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "acl.yaml"), smokescreenAcl(cfg), { mode: 0o600 });
  writeFileSync(join(dir, "config.yaml"), "allow_missing_role: true\n", {
    mode: 0o600,
  });
  let stopped = false;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  const spawn = () => {
    child = Bun.spawn(smokescreenArgs(cfg, dir), {
      stdout: "ignore",
      stderr: "inherit",
    });
    void child.exited.then((code) => {
      if (stopped) return;
      log(`egress proxy exited (${code}); restarting`);
      setTimeout(spawn, 1000);
    });
  };
  spawn();
  // Wait until Smokescreen accepts connections.
  for (const until = Date.now() + 15_000; ; await Bun.sleep(100)) {
    const up = await new Promise<boolean>((resolve) => {
      const s = connect(SMOKESCREEN_PORT, "127.0.0.1")
        .once("connect", () => (s.destroy(), resolve(true)))
        .once("error", () => resolve(false));
    });
    if (up) break;
    if (Date.now() > until) throw new Error("the egress proxy did not start");
  }
  mkdirSync(dirname(socket), { recursive: true, mode: 0o711 });
  rmSync(socket, { force: true });
  const relay: Server = createServer((inbound) => {
    const outbound = connect(SMOKESCREEN_PORT, "127.0.0.1");
    inbound.pipe(outbound).pipe(inbound);
    const close = () => (inbound.destroy(), outbound.destroy());
    inbound.on("error", close);
    outbound.on("error", close);
  });
  await new Promise<void>((resolve, reject) =>
    relay.once("error", reject).listen(socket, () => resolve()),
  );
  chmodSync(socket, 0o666);
  return {
    stop() {
      stopped = true;
      relay.close();
      child?.kill();
    },
  };
}
