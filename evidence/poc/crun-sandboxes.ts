// A `Sandboxes` for proofs on the VM: each process in a crun sandbox of its own, built from the
// gateway's bundle template (the person's uid, home, read-only rootfs, seccomp, no capabilities),
// plus a relay of 127.0.0.1:4799 to a mock vendor API's Unix socket in the person's home.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Sandboxes, SandboxSpawnOptions } from "../../src/agents/types";

export type CrunOptions = {
  key: string;
  uid: number;
  /** The person's home on this disk, bind-mounted at /home/agent. */
  home: string;
  /** The person's TMPDIR on this disk, bind-mounted at /var/tmp/agent. */
  tmp: string;
  /** A gateway bundle config.json to copy the sandbox from. */
  template: string;
  /** Where bundles go. */
  dir: string;
  /** The mock API's socket name in the home (relayed to 127.0.0.1:4799 inside). */
  mockSock?: string;
  /** An MCP proxy socket on this disk, mounted at /run/tandem/mcp.sock and relayed to 127.0.0.1:8790. */
  mcpSock?: string;
};

export class CrunSandboxes implements Sandboxes {
  #n = 0;
  readonly spawned: { label: string; args: string[]; env: Record<string, string> }[] = [];
  constructor(private o: CrunOptions) {
    const parent = `/sys/fs/cgroup/sandboxes/tandem-${o.key}-acp`;
    if (!existsSync(parent)) mkdirSync(parent);
    writeFileSync(`${parent}/cgroup.subtree_control`, "+memory +pids +cpu");
  }
  homeOf() {
    return this.o.home;
  }
  get peakMiB() {
    const f = `/sys/fs/cgroup/sandboxes/tandem-${this.o.key}-acp/memory.peak`;
    return existsSync(f) ? Math.round(Number(readFileSync(f, "utf8")) / 2 ** 20) : null;
  }
  async spawn(key: string, args: string[], opts: SandboxSpawnOptions = {}): Promise<ChildProcess> {
    const label = opts.label ?? "p";
    const name = `tandem-${key}-acp-${label}-${process.pid}-${++this.#n}`;
    const dir = `${this.o.dir}/b-${name}`;
    mkdirSync(dir, { recursive: true });
    const tmpl = JSON.parse(readFileSync(this.o.template, "utf8"));
    const spec = structuredClone(tmpl);
    spec.process.user = { uid: this.o.uid, gid: this.o.uid, additionalGids: [] };
    const relays = [
      "socat TCP-LISTEN:4750,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/run/tandem/egress.sock 2>/dev/null &",
      this.o.mockSock && `socat TCP-LISTEN:4799,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/home/agent/${this.o.mockSock} 2>/dev/null &`,
      this.o.mcpSock && "socat TCP-LISTEN:8790,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/run/tandem/mcp.sock 2>/dev/null &",
      // The relays need a moment before the program's first request.
      "sleep 0.05; exec \"$@\"",
    ].filter(Boolean).join(" ");
    spec.process.args = ["/usr/bin/tini", "-s", "--", "sh", "-c", relays, "sh", ...args];
    spec.process.cwd = opts.cwd ?? "/home/agent";
    const base: string[] = tmpl.process.env.filter((e: string) => !/^MCP_PROXY_/.test(e));
    const env = { ...Object.fromEntries(base.map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)])), ...opts.env };
    spec.process.env = Object.entries(env).map(([k, v]) => `${k}=${v}`);
    this.spawned.push({ label, args, env: opts.env ?? {} });
    spec.linux.cgroupsPath = `/sandboxes/tandem-${key}-acp/${label}-${this.#n}`;
    delete spec.linux.resources;
    spec.mounts = spec.mounts
      .filter((m: any) => m.destination !== "/run/tandem/mcp.sock")
      .map((m: any) =>
        m.destination === "/home/agent" ? { ...m, source: this.o.home }
        : m.destination === "/var/tmp/agent" ? { ...m, source: this.o.tmp }
        : m.destination === "/etc/passwd" ? { ...m, source: `/var/lib/tandem/run/${key}/passwd` }
        : m.destination === "/etc/group" ? { ...m, source: `/var/lib/tandem/run/${key}/group` }
        : m);
    if (this.o.mcpSock)
      spec.mounts.push({ destination: "/run/tandem/mcp.sock", type: "bind", source: this.o.mcpSock, options: ["bind"] });
    writeFileSync(`${dir}/config.json`, JSON.stringify(spec));
    const child = spawn("crun", ["--cgroup-manager=cgroupfs", "run", "--no-pivot", "--no-new-keyring", "--bundle", dir, name], { stdio: ["pipe", "pipe", "pipe"] });
    // kill() stops the sandbox: TERM to its init, KILL after a grace period.
    let killing = false;
    child.kill = () => {
      if (killing || child.exitCode !== null) return true;
      killing = true;
      spawn("crun", ["kill", name, "TERM"], { stdio: "ignore" });
      setTimeout(() => {
        if (child.exitCode === null) spawn("crun", ["kill", "-a", name, "KILL"], { stdio: "ignore" });
      }, 3000).unref();
      return true;
    };
    child.once("exit", () => {
      spawn("crun", ["delete", "-f", name], { stdio: "ignore" }).once("exit", () => rmSync(dir, { recursive: true, force: true }));
    });
    return child;
  }
  async exec(key: string, args: string[], opts: { env?: Record<string, string>; stdin?: Buffer; cwd?: string } = {}) {
    const child = await this.spawn(key, args, { env: opts.env, cwd: opts.cwd, label: "x" });
    let stdout = "", stderr = "";
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    child.stdin!.end(opts.stdin ?? Buffer.alloc(0));
    const timer = setTimeout(() => child.kill(), 30_000);
    const exitCode = await new Promise<number>((r) => child.once("exit", (c) => r(c ?? 1)));
    clearTimeout(timer);
    return { exitCode, stdout, stderr };
  }
}
