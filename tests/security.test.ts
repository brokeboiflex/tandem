// What keeps people apart: the egress rules, the configuration that selects them, and the microVM
// controller (src/runtime.ts) against a fake microsandbox that records every call.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config";
import { proxyToken, PROXY_TOKEN_ENV } from "../src/mcp";
import {
  BRIDGE_HOST_PORTS,
  BRIDGE_PORT,
  buildPolicy,
  freePort,
  imageRef,
  MCP_VSOCK_PORT,
  MicroVmRuntime,
  type Msb,
} from "../src/runtime";
import { egressRules, parseHosts, RUNTIME_TMPDIR } from "../src/security";

const BASE_ENV = {
  AUTH_MODE: "dev",
  DEV_AUTH_SECRET: "d".repeat(32),
  SERVICE_SECRET: "s".repeat(32),
};

/** loadConfig() with exactly these variables (plus the required secrets). */
function configWith(vars: Record<string, string> = {}): Config {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env))
    if (/^(RUNTIME_|EGRESS_|DATA_DIR|MCP_)/.test(k)) delete process.env[k];
  Object.assign(process.env, BASE_ENV, vars);
  try {
    return loadConfig();
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

const work = mkdtempSync("/tmp/tandem-sec-");
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("configuration", () => {
  test("defaults: allowlist egress, 2 GiB and 2 CPUs per microVM, data in /var/lib/tandem", () => {
    const cfg = configWith();
    expect(cfg).toMatchObject({
      egressMode: "allowlist",
      runtimeMemoryMb: 2048,
      runtimeCpus: 2,
      dataDir: "/var/lib/tandem",
      runtimeImageArchive: "/opt/tandem/runtime.tar",
      runtimeImage: "",
    });
  });

  test("invalid values stop the gateway with the variable's name", () => {
    for (const [vars, message] of [
      [{ EGRESS_MODE: "off" }, "EGRESS_MODE"],
      [{ EGRESS_ALLOW_RANGES: "10.0.0.0" }, "EGRESS_ALLOW_RANGES"],
      [{ RUNTIME_MEMORY_MB: "0" }, "RUNTIME_MEMORY_MB"],
      [{ RUNTIME_MEMORY_MB: "256" }, "RUNTIME_MEMORY_MB"],
      [{ RUNTIME_CPUS: "0" }, "RUNTIME_CPUS"],
      [{ DATA_DIR: "relative/path" }, "DATA_DIR"],
      [{ DATA_DIR: `/${"x".repeat(70)}` }, "DATA_DIR"],
      [{ RUNTIME_PREFIX: "Has.Dots" }, "RUNTIME_PREFIX"],
    ] as const)
      expect(() => configWith(vars)).toThrow(message);
  });
});

describe("egress rules", () => {
  test("the shipped allowlist parses; wildcards become suffix rules that also cover the apex", () => {
    const rules = egressRules(configWith());
    expect(rules.mode).toBe("allowlist");
    if (rules.mode !== "allowlist") return;
    expect(rules.suffixes).toContain("anthropic.com");
    expect(rules.suffixes).toContain("openai.com");
    // A suffix rule matches its apex, so the apex is not listed twice.
    expect(rules.exact).not.toContain("anthropic.com");
    expect(rules.exact).toContain("openrouter.ai");
  });

  test("EGRESS_ALLOW_DOMAINS and EGRESS_ALLOW_RANGES add to the list; bad names are refused", () => {
    const rules = egressRules(
      configWith({
        EGRESS_ALLOW_DOMAINS: "registry.npmjs.org, *.internal.example",
        EGRESS_ALLOW_RANGES: "10.20.0.0/16",
      }),
    );
    expect(rules).toMatchObject({
      mode: "allowlist",
      ranges: ["10.20.0.0/16"],
    });
    if (rules.mode !== "allowlist") return;
    expect(rules.exact).toContain("registry.npmjs.org");
    expect(rules.suffixes).toContain("internal.example");
    expect(() => parseHosts("", ["exa mple.com"])).toThrow("not a hostname");
    expect(() => parseHosts("http://x.com\n", [])).toThrow("not a hostname");
  });

  test("open mode: public addresses plus the listed ranges", () => {
    expect(egressRules(configWith({ EGRESS_MODE: "open" }))).toEqual({
      mode: "open",
      ranges: [],
    });
  });

  test("the microsandbox policy: deny by default, DNS to its gateway, the hosts on 80/443, the ranges", () => {
    const allow = buildPolicy(RecordingPolicy as any, {
      mode: "allowlist",
      exact: ["openrouter.ai"],
      suffixes: ["anthropic.com"],
      ranges: ["10.20.0.0/16"],
    }) as RecordingPolicy;
    expect(allow.calls).toEqual([
      "defaultIngress(allow)",
      "defaultEgress(deny)",
      "egress: udp tcp port(53) allowHost",
      'egress: tcp ports([80,443]) allowDomains(["openrouter.ai"])',
      'egress: tcp ports([80,443]) allowDomainSuffixes(["anthropic.com"])',
      "egress: tcp allow(cidr(10.20.0.0/16))",
    ]);
    // Open without ranges keeps microsandbox's own default: public internet only.
    expect(
      buildPolicy(RecordingPolicy as any, { mode: "open", ranges: [] }),
    ).toBeNull();
    const open = buildPolicy(RecordingPolicy as any, {
      mode: "open",
      ranges: ["10.20.0.0/16"],
    }) as RecordingPolicy;
    expect(open.calls).toContain("egress: allowPublic");
    expect(open.calls).not.toContain("defaultEgress(allow)");
  });
});

/** Records a NetworkPolicyBuilder chain as readable lines. */
class RecordingPolicy {
  calls: string[] = [];
  defaultIngress(a: string) {
    this.calls.push(`defaultIngress(${a})`);
    return this;
  }
  defaultEgress(a: string) {
    this.calls.push(`defaultEgress(${a})`);
    return this;
  }
  egress(configure: (r: any) => any) {
    const parts: string[] = [];
    const rule: any = new Proxy(
      {},
      {
        get:
          (_, name: string) =>
          (...args: any[]) => {
            if (name === "allow")
              args[0]({ cidr: (c: string) => parts.push(`allow(cidr(${c}))`) });
            else
              parts.push(
                args.length
                  ? `${name}(${args.map((a) => JSON.stringify(a)).join(",")})`
                  : name,
              );
            return rule;
          },
      },
    );
    configure(rule);
    this.calls.push(`egress: ${parts.join(" ")}`);
    return this;
  }
}

// --- The microVM controller against a fake microsandbox ------------------------------------------

type FakeBox = {
  name: string;
  status: "running" | "stopped" | "crashed";
  labels: Record<string, string>;
  spec: Record<string, unknown>;
  execs: { file: string; args: string[]; user?: string; stdin?: string }[];
  detached: { file: string; user?: string; env: Record<string, string> }[];
  daemon: boolean;
  files: Map<string, string>;
};

function fakeMsb() {
  const boxes = new Map<string, FakeBox>();
  const images = new Set<string>();
  const log: string[] = [];
  const opts = () => {
    const o: any = { args: [], env: {} };
    const b: any = {
      args: (a: string[]) => ((o.args = a), b),
      user: (u: string) => ((o.user = u), b),
      env: (k: string, v: string) => ((o.env[k] = v), b),
      timeout: () => b,
      stdinBytes: (d: Buffer) => ((o.stdin = d.toString()), b),
    };
    return { o, b };
  };
  const connected = (box: FakeBox) => ({
    async execWith(file: string, configure: (b: any) => any) {
      const { o, b } = opts();
      configure(b);
      box.execs.push({ file, args: o.args, user: o.user, stdin: o.stdin });
      let code = 0;
      let stdout = "";
      if (file === "pgrep") code = box.daemon ? 0 : 1;
      else if (file === "cat") {
        const v = box.files.get(o.args[0]);
        code = v === undefined ? 1 : 0;
        stdout = v ?? "";
      } else if (file === "sh" &&
        o.args[1]?.includes('cat > "$1/$2.tmp"')
      )
        // sh -c <script> <$0> <$1 dir> <$2 name>
        box.files.set(`${o.args[3]}/${o.args[4]}`, o.stdin);
      return { status: { code }, stdout: () => stdout };
    },
    async execDetachedWith(file: string, configure: (b: any) => any) {
      const { o, b } = opts();
      configure(b);
      box.detached.push({ file, user: o.user, env: o.env });
      box.daemon = true;
      box.files.set("/home/agent/.happy/agent/token", "T".repeat(43));
      return {};
    },
    async stopWithTimeout() {
      log.push(`stop ${box.name}`);
      box.status = "stopped";
      box.daemon = false;
    },
    async kill() {
      box.status = "stopped";
    },
  });
  const handle = (box: FakeBox) => ({
    name: box.name,
    get status() {
      return box.status;
    },
    updatedAt: new Date(1_000),
    config: () => ({ labels: box.labels }),
    connect: async () => connected(box),
    startDetached: async () => {
      log.push(`start ${box.name}`);
      box.status = "running";
      return connected(box);
    },
  });
  const notFound = (what: string) =>
    Object.assign(new Error(`${what} not found`), {
      code: what === "image" ? "imageNotFound" : "sandboxNotFound",
    });
  const msb = {
    Image: {
      get: async (ref: string) => {
        if (!images.has(ref)) throw notFound("image");
        return {};
      },
      load: async (path: string, o: { tag: string }) => {
        log.push(`load ${path} as ${o.tag}`);
        images.add(o.tag);
        return [];
      },
    },
    Sandbox: {
      builder: (name: string) => {
        const spec: any = { labels: {}, volumes: [], ports: [], vsock: [] };
        const b: any = {
          image: (v: string) => ((spec.image = v), b),
          cpus: (v: number) => ((spec.cpus = v), b),
          memory: (v: number) => ((spec.memory = v), b),
          user: (v: string) => ((spec.user = v), b),
          label: (k: string, v: string) => ((spec.labels[k] = v), b),
          volume: (guest: string, configure: (m: any) => any) => {
            const mount: any = { guest };
            const m: any = {
              bind: (h: string) => ((mount.bind = h), m),
              owner: (u: number, g: number) => ((mount.owner = [u, g]), m),
            };
            configure(m);
            spec.volumes.push(mount);
            return b;
          },
          port: (h: number, g: number) => (spec.ports.push([h, g]), b),
          vsock: (path: string, port: number) => (
            spec.vsock.push([path, port]),
            b
          ),
          detached: (v: boolean) => ((spec.detached = v), b),
          network: (configure: (n: any) => any) => {
            const n: any = {
              strict: (v: boolean) => ((spec.strict = v), n),
              policyFromBuilder: (p: any) => ((spec.policy = p.calls), n),
            };
            configure(n);
            return b;
          },
          create: async () => {
            log.push(`create ${name}`);
            boxes.set(name, {
              name,
              status: "running",
              labels: spec.labels,
              spec,
              execs: [],
              detached: [],
              daemon: false,
              files: new Map(),
            });
          },
        };
        return b;
      },
      get: async (name: string) => {
        const box = boxes.get(name);
        if (!box) throw notFound("sandbox");
        return handle(box);
      },
      remove: async (name: string) => {
        log.push(`remove ${name}`);
        boxes.delete(name);
      },
      listWith: async () => ({
        sandboxes: [...boxes.values()].map(handle),
        nextCursor: undefined,
      }),
    },
    NetworkPolicyBuilder: RecordingPolicy,
  };
  return { msb: msb as unknown as Msb, boxes, log, images };
}

function controller(vars: Record<string, string> = {}) {
  const dataDir = mkdtempSync(join(work, "data-"));
  const archive = join(dataDir, "runtime.tar");
  writeFileSync(`${archive}.sha256`, `${"ab".repeat(32)}\n`);
  const cfg = configWith({
    DATA_DIR: dataDir,
    RUNTIME_IMAGE_ARCHIVE: archive,
    ...vars,
  });
  const fake = fakeMsb();
  const rt = new MicroVmRuntime(cfg, () => {}, fake.msb);
  return { cfg, rt, ...fake };
}

describe("one microVM per person", () => {
  const KEY = "0123456789abcdef01234567";

  test("the runtime image is loaded once, by its build digest", async () => {
    const { rt, log } = controller();
    await rt.posture();
    await rt.ensure(KEY);
    expect(log.filter((l) => l.startsWith("load"))).toEqual([
      expect.stringMatching(/ as tandem-runtime:abababababababab$/),
    ]);
    expect(imageRef(join(controller().cfg.dataDir, "runtime.tar"))).toBe(
      "tandem-runtime:abababababababab",
    );
  });

  test("created with the person's home, a loopback bridge port, a private vsock route and the egress policy", async () => {
    const { cfg, rt, boxes } = controller();
    const h = await rt.ensure(KEY);
    const box = boxes.get(`tandem-${KEY}`)!;
    expect(box.spec).toMatchObject({
      image: "tandem-runtime:abababababababab",
      cpus: 2,
      memory: 2048,
      user: "agent",
      detached: true,
      strict: false,
      volumes: [
        {
          guest: "/home/agent",
          bind: `${cfg.dataDir}/homes/${KEY}`,
          owner: [10001, 10001],
        },
      ],
      ports: [[BRIDGE_HOST_PORTS.first, BRIDGE_PORT]],
      vsock: [[`${cfg.dataDir}/run/${KEY}.sock`, MCP_VSOCK_PORT]],
    });
    expect((box.spec.policy as string[])[1]).toBe("defaultEgress(deny)");
    expect(box.labels).toMatchObject({
      "tandem.runtime": "1",
      "tandem.key": KEY,
      "tandem.port": String(BRIDGE_HOST_PORTS.first),
    });
    expect(h).toMatchObject({
      key: KEY,
      url: `http://127.0.0.1:${BRIDGE_HOST_PORTS.first}`,
      token: "T".repeat(43),
    });
    expect(rt.mcpSocket(KEY)).toBe(`${cfg.dataDir}/run/${KEY}.sock`);
  });

  test("the daemon starts once per boot as `agent`, with the MCP route and its token in its environment only", async () => {
    const { cfg, rt, boxes } = controller();
    await rt.ensure(KEY);
    await rt.ensure(KEY); // already running: nothing new
    const box = boxes.get(`tandem-${KEY}`)!;
    expect(box.detached).toEqual([
      {
        file: "/usr/local/bin/agent-runtime-entrypoint",
        user: "agent",
        env: {
          HOME: "/home/agent",
          TMPDIR: RUNTIME_TMPDIR,
          MCP_PROXY_URL: `http://127.0.0.1:8790/mcp/${KEY}`,
          MCP_VSOCK_PORT: String(MCP_VSOCK_PORT),
          [PROXY_TOKEN_ENV]: proxyToken(cfg.serviceSecret, KEY),
        },
      },
    ]);
    // The previous boot's owner token is removed first, so only the new daemon's is read.
    expect(box.execs.filter((e) => e.file === "rm")).toEqual([
      { file: "rm", args: ["-f", "/home/agent/.happy/agent/token"], user: "agent", stdin: undefined },
    ]);
    // Every command runs as the runtime's own user.
    expect(box.execs.every((e) => e.user === "agent")).toBe(true);
  });

  test("each person gets their own bridge port; a stopped one keeps it", async () => {
    const { rt, boxes } = controller();
    const a = await rt.ensure("a".repeat(24));
    const b = await rt.ensure("b".repeat(24));
    expect(a.url).not.toBe(b.url);
    await rt.stop("a".repeat(24));
    const c = await rt.ensure("c".repeat(24));
    expect([a.url, b.url]).not.toContain(c.url);
    expect((await rt.ensure("a".repeat(24))).url).toBe(a.url);
    expect(boxes.size).toBe(3);
  });

  test("stop is graceful; a stopped runtime starts again with its home; a changed spec recreates it, keeping its port", async () => {
    const { rt, boxes, log } = controller();
    const first = await rt.ensure(KEY);
    await rt.stop(KEY);
    expect(boxes.get(`tandem-${KEY}`)!.status).toBe("stopped");
    expect(await rt.listRunning()).toEqual([]);
    await rt.ensure(KEY);
    expect(log.filter((l) => /^(create|start|remove)/.test(l))).toEqual([
      `create tandem-${KEY}`,
      `start tandem-${KEY}`,
    ]);
    expect(await rt.listRunning()).toEqual([KEY]);
    await rt.stop(KEY);
    // Another egress setting: the stopped microVM is recreated; the home is a separate directory.
    const changed = new MicroVmRuntime(
      { ...(rt as any).cfg, egressMode: "open" },
      () => {},
      (rt as any).msb ? await (rt as any).msb : undefined,
    );
    const again = await changed.ensure(KEY);
    expect(log.slice(-2)).toEqual([
      `remove tandem-${KEY}`,
      `create tandem-${KEY}`,
    ]);
    expect(again.url).toBe(first.url);
  });

  test("a running runtime is never recreated for a changed spec", async () => {
    const { rt, log } = controller();
    await rt.ensure(KEY);
    const changed = new MicroVmRuntime(
      { ...(rt as any).cfg, runtimeMemoryMb: 4096 },
      () => {},
      await (rt as any).msb,
    );
    await changed.ensure(KEY);
    expect(log.filter((l) => l.startsWith("remove"))).toEqual([]);
  });

  test("private files go in through standard input as `agent`, never in a command line", async () => {
    const { rt, boxes } = controller();
    await rt.ensure(KEY);
    await rt.writePrivateFile(
      KEY,
      "/home/agent/.agent-runtime",
      "anthropic-api-key",
      "sk-secret\n",
    );
    const box = boxes.get(`tandem-${KEY}`)!;
    const write = box.execs.find((e) => e.stdin !== undefined)!;
    expect(write.user).toBe("agent");
    expect(write.stdin).toBe("sk-secret\n");
    expect(JSON.stringify(write.args)).not.toContain("sk-secret");
    expect(box.files.get("/home/agent/.agent-runtime/anthropic-api-key")).toBe(
      "sk-secret\n",
    );
    expect(rt.writePrivateFile(KEY, "/etc", "passwd", "x")).rejects.toThrow(
      "outside the runtime home",
    );
    expect(
      rt.writePrivateFile(KEY, "/home/agent", "../x", "x"),
    ).rejects.toThrow("outside the runtime home");
  });

  test("a runtime being stopped outside the gateway is waited out, then started again", async () => {
    const { rt, boxes, log } = controller();
    await rt.ensure(KEY);
    const box = boxes.get(`tandem-${KEY}`)!;
    // `msb stop` from outside: draining for a while, then stopped.
    (box as any).status = "draining";
    box.daemon = false;
    setTimeout(() => ((box as any).status = "stopped"), 700);
    const again = await rt.restart(KEY);
    expect(again.token).toBe("T".repeat(43));
    expect(box.status).toBe("running");
    expect(log.filter((l) => l.startsWith("start"))).toEqual([`start tandem-${KEY}`]);
  });

  test("a start that loses a race to another start uses the runtime that is running", async () => {
    const { rt, boxes, msb } = controller();
    await rt.ensure(KEY);
    await rt.stop(KEY);
    const real = (msb as any).Sandbox.get;
    (msb as any).Sandbox.get = async (name: string) => {
      const h = await real(name);
      return {
        ...h,
        get status() {
          return boxes.get(name)!.status;
        },
        config: h.config,
        connect: h.connect,
        startDetached: async () => {
          boxes.get(name)!.status = "running"; // someone else started it first
          throw new Error("cannot start sandbox: already running");
        },
      };
    };
    expect((await rt.ensure(KEY)).key).toBe(KEY);
  });

  test("a connection that fails is dropped: the next call reconnects", async () => {
    const { rt, msb } = controller();
    await rt.ensure(KEY);
    const real = (msb as any).Sandbox.get;
    let broken = true;
    (msb as any).Sandbox.get = async (name: string) => {
      const h = await real(name);
      if (!broken) return h;
      return { ...h, status: "running", connect: async () => ({ execWith: async () => { throw new Error("stale"); } }) };
    };
    (rt as any).connected.clear();
    expect(rt.exec(KEY, ["true"])).rejects.toThrow("stale");
    await Bun.sleep(0);
    broken = false;
    expect((await rt.exec(KEY, ["pgrep", "-x", "happy-agent"])).exitCode).toBe(0);
  });

  test("RUNTIME_IMAGE must already be in the image store; nothing is loaded for it", async () => {
    const { rt, log } = controller({
      RUNTIME_IMAGE: "registry.example/tandem-runtime:1",
    });
    expect(rt.ensure(KEY)).rejects.toThrow("not in microsandbox's image store");
    expect(log.filter((l) => l.startsWith("load"))).toEqual([]);
  });

  test("bridge ports run out explicitly", () => {
    const used = new Set<number>();
    for (let p = BRIDGE_HOST_PORTS.first; p <= BRIDGE_HOST_PORTS.last; p++)
      used.add(p);
    expect(freePort(used)).toBeNull();
    used.delete(BRIDGE_HOST_PORTS.first + 7);
    expect(freePort(used)).toBe(BRIDGE_HOST_PORTS.first + 7);
  });
});
