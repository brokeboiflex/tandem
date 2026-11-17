// Hardening: settings, detection and the exact container/network specs, plus the Docker runtime
// controller against a fake Engine (per-runtime networks, fallback, release, sweep).
import { afterAll, describe, expect, test } from "bun:test";
import { hostname } from "node:os";
import { loadConfig, type Config } from "../src/config";
import { proxyToken } from "../src/mcp";
import {
  ACTIVITY_COMMAND,
  DockerRuntime,
  LAUNCH_VALUES_COMMAND,
  StaleRuntime,
} from "../src/runtime";
import { socketProxyPolicy } from "./fake-daemon";
import {
  chooseAddresses,
  chooseOciRuntime,
  dockerApiAccess,
  egressEnv,
  inCidr,
  isAddressPoolExhausted,
  peerAddresses,
  pinPlan,
  reservedAddresses,
  runtimeContainerSpec,
  runtimeNetworkSpec,
  RUNTIME_TMPDIR,
} from "../src/security";

const BASE_ENV = {
  AUTH_MODE: "dev",
  DEV_AUTH_SECRET: "d".repeat(32),
  SERVICE_SECRET: "s".repeat(32),
};

/** loadConfig() with exactly these variables (plus the required secrets). */
function configWith(vars: Record<string, string> = {}): Config {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env))
    if (/^(RUNTIME_|EGRESS_|BRIDGE_ALLOW|MCP_)/.test(k)) delete process.env[k];
  Object.assign(process.env, BASE_ENV, vars);
  try {
    return loadConfig();
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, saved);
  }
}

describe("settings", () => {
  test("safe defaults for every protection", () => {
    const cfg = configWith();
    expect(cfg.runtimeOciRuntime).toBe("auto");
    expect(cfg.runtimeUser).toBe("10001:10001");
    expect(cfg.runtimeCapAdd).toEqual([]);
    expect(cfg.runtimeNoNewPrivileges).toBe(true);
    expect(cfg.runtimeReadOnlyRootfs).toBe(true);
    expect(cfg.runtimeTmpfsMb).toBe(256);
    expect([cfg.runtimeMemoryMb, cfg.runtimeCpus, cfg.runtimePids]).toEqual([
      2048, 2, 512,
    ]);
    expect(cfg.runtimeDockerProxy).toBe("auto");
    expect(cfg.networkIsolation).toBe("auto");
    expect(cfg.egressMode).toBe("auto");
    expect(cfg.egressProxy).toBe("tandem-egress:4750");
    expect(cfg.runtimeNetwork).toBe("tandem-runtimes");
  });

  test("one prefix names a whole instance; empty limits mean the default, 0 means none", () => {
    const cfg = configWith({
      RUNTIME_PREFIX: "acme-tandem",
      RUNTIME_MEMORY_MB: "",
      RUNTIME_PIDS: "0",
    });
    expect(cfg.runtimeNetwork).toBe("acme-tandem-runtimes");
    expect(cfg.egressProxy).toBe("acme-tandem-egress:4750");
    expect(cfg.runtimeMemoryMb).toBe(2048);
    expect(cfg.runtimePids).toBe(0);
  });

  test("each protection can be relaxed explicitly", () => {
    const cfg = configWith({
      RUNTIME_OCI_RUNTIME: "default",
      RUNTIME_USER: "",
      RUNTIME_CAP_ADD: "net_bind_service, CAP_SYS_PTRACE",
      RUNTIME_NO_NEW_PRIVILEGES: "false",
      RUNTIME_READ_ONLY_ROOTFS: "false",
      RUNTIME_DOCKER_PROXY: "none",
      RUNTIME_NETWORK_ISOLATION: "shared",
      EGRESS_MODE: "open",
    });
    expect(cfg.runtimeCapAdd).toEqual(["NET_BIND_SERVICE", "CAP_SYS_PTRACE"]);
    expect(cfg.runtimeUser).toBe("");
    expect(cfg.runtimeNoNewPrivileges).toBe(false);
    expect(cfg.runtimeReadOnlyRootfs).toBe(false);
    expect(cfg.egressMode).toBe("open");
  });

  test("invalid values are refused at startup", () => {
    for (const [k, v] of [
      ["EGRESS_MODE", "everything"],
      ["RUNTIME_NETWORK_ISOLATION", "none"],
      ["RUNTIME_DOCKER_PROXY", "maybe"],
      ["RUNTIME_CAP_ADD", "SYS_ADMIN;rm"],
      ["RUNTIME_OCI_RUNTIME", "../runsc"],
      ["RUNTIME_PREFIX", "Tandem Prod"],
      ["RUNTIME_MEMORY_MB", "-1"],
      ["EGRESS_PROXY", "http://proxy:3128"],
    ])
      expect(() => configWith({ [k!]: v! })).toThrow();
  });
});

describe("detection", () => {
  const docker = ["io.containerd.runc.v2", "runc"];
  test("auto picks gVisor when the Engine has it", () => {
    expect(chooseOciRuntime("auto", [...docker, "runsc"])).toEqual({
      runtime: "runsc",
      sandbox: "gvisor (runsc)",
    });
  });
  test("auto falls back to the Engine default with a warning (Docker Desktop, no gVisor)", () => {
    const r = chooseOciRuntime("auto", docker, "runc");
    expect(r.runtime).toBeNull();
    expect(r.sandbox).toBe("runc");
    expect(r.warning).toContain("gVisor (runsc) is not installed");
  });
  test("default keeps the Engine default silently; an explicit runtime is required", () => {
    expect(chooseOciRuntime("default", [...docker, "runsc"])).toEqual({
      runtime: null,
      sandbox: "runc",
    });
    expect(chooseOciRuntime("kata", [...docker, "kata"]).runtime).toBe("kata");
    expect(chooseOciRuntime("runsc-kvm", ["runsc-kvm"]).sandbox).toBe(
      "gvisor (runsc-kvm)",
    );
    expect(() => chooseOciRuntime("runsc", docker)).toThrow(
      /offers only: io.containerd.runc.v2, runc/,
    );
  });
  test("a socket proxy is recognised by its refusal of the plugin list", () => {
    expect(dockerApiAccess(200)).toBe("unrestricted");
    expect(dockerApiAccess(403)).toBe("restricted");
    expect(dockerApiAccess(405)).toBe("restricted");
  });
  test("Docker's exhausted-pool error is recognised", () => {
    expect(
      isAddressPoolExhausted(
        "POST /networks/create: 400 all predefined address pools have been fully subnetted",
      ),
    ).toBe(true);
    expect(
      isAddressPoolExhausted(
        "could not find an available, non-overlapping IPv4 address pool among the defaults to assign to the network",
      ),
    ).toBe(true);
    expect(isAddressPoolExhausted("network with name x already exists")).toBe(
      false,
    );
  });
  test("CIDR matching", () => {
    expect(inCidr("172.19.0.3", "172.19.0.0/16")).toBe(true);
    expect(inCidr("::ffff:172.19.0.3", "172.19.0.0/16")).toBe(true);
    expect(inCidr("172.20.0.3", "172.19.0.0/16")).toBe(false);
    expect(inCidr("10.0.0.1", "10.0.0.1/32")).toBe(true);
    expect(inCidr("fe80::1", "10.0.0.0/8")).toBe(false);
  });
});

describe("generated specs", () => {
  const input = {
    key: "k".repeat(24),
    volume: "tandem-home-x",
    network: "tandem-net-x",
    allow: "172.19.0.2/32",
    ociRuntime: "runsc" as string | null,
    egress: "allowlist" as const,
    egressProxy: "172.19.0.3:4750",
    directHosts: ["tandem-gateway", "172.19.0.2"],
    imageId: "sha256:1",
    devVolumeOverride: false,
    mcpProxyUrl: `http://172.19.0.2:8790/mcp/${"k".repeat(24)}`,
  };

  test("runtime container: non-root, no capabilities, read-only, limited, sandboxed, private", () => {
    const spec = runtimeContainerSpec(configWith(), input);
    const h = spec.HostConfig as Record<string, unknown>;
    expect(spec.User).toBe("10001:10001");
    expect(h.Runtime).toBe("runsc");
    expect(h.CapDrop).toEqual(["ALL"]);
    expect(h.CapAdd).toBeUndefined();
    expect(h.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(h.ReadonlyRootfs).toBe(true);
    expect(h.Tmpfs).toEqual({
      "/tmp": "rw,noexec,nosuid,nodev,size=256m,mode=1777",
    });
    expect(h.Memory).toBe(2048 * 1024 * 1024);
    expect(h.NanoCpus).toBe(2e9);
    expect(h.PidsLimit).toBe(512);
    expect(h.NetworkMode).toBe("tandem-net-x");
    expect(h.Mounts).toEqual([
      { Type: "volume", Source: "tandem-home-x", Target: "/home/agent" },
    ]);
    for (const absent of [
      "Privileged",
      "Binds",
      "PortBindings",
      "PublishAllPorts",
      "Devices",
      "PidMode",
      "IpcMode",
      "UsernsMode",
    ])
      expect(h[absent]).toBeUndefined();
    expect(spec.Env).toContain("HAPPY_BRIDGE_ALLOW=172.19.0.2/32");
    expect(spec.Env).toContain(`TMPDIR=${RUNTIME_TMPDIR}`);
    expect(spec.Env).toContain("HTTPS_PROXY=http://172.19.0.3:4750"); // an address: no DNS in gVisor
    expect(spec.Env).toContain(
      "NO_PROXY=localhost,127.0.0.1,::1,tandem-gateway,172.19.0.2",
    );
    expect(spec.Labels["tandem.network"]).toBe("tandem-net-x");
    // The gateway's MCP proxy by address on this network, with the runtime's own proxy token.
    expect(spec.Env).toContain(`MCP_PROXY_URL=${input.mcpProxyUrl}`);
    expect(spec.Env).toContain(
      `MCP_PROXY_TOKEN=${proxyToken("s".repeat(32), input.key)}`,
    );
  });

  test("relaxed settings change exactly their own field", () => {
    const spec = runtimeContainerSpec(
      configWith({
        RUNTIME_USER: "",
        RUNTIME_CAP_ADD: "NET_BIND_SERVICE",
        RUNTIME_NO_NEW_PRIVILEGES: "false",
        RUNTIME_READ_ONLY_ROOTFS: "false",
        RUNTIME_MEMORY_MB: "0",
      }),
      { ...input, ociRuntime: null, egress: "off" },
    );
    const h = spec.HostConfig as Record<string, unknown>;
    expect("User" in spec).toBe(false);
    expect(h.CapDrop).toEqual(["ALL"]);
    expect(h.CapAdd).toEqual(["NET_BIND_SERVICE"]);
    expect(h.SecurityOpt).toEqual([]);
    expect(h.ReadonlyRootfs).toBe(false);
    expect(h.Tmpfs).toBeUndefined();
    expect(h.Runtime).toBeUndefined();
    expect(h.Memory).toBe(0);
    expect(spec.Env.some((e) => /PROXY=/i.test(e))).toBe(false);
  });

  test("the spec label changes with anything that should recreate a stopped runtime", () => {
    const cfg = configWith();
    const hash = (over: object, c = cfg) =>
      runtimeContainerSpec(c, { ...input, ...over }).Labels["tandem.spec"];
    const base = hash({});
    expect(hash({})).toBe(base);
    for (const over of [
      { imageId: "sha256:2" },
      { allow: "172.19.0.9/32" },
      { ociRuntime: null },
      { network: "tandem-runtimes" },
      { egress: "off" },
      { mcpProxyUrl: `http://172.19.0.9:8790/mcp/${"k".repeat(24)}` },
    ])
      expect(hash(over)).not.toBe(base);
    expect(hash({}, configWith({ RUNTIME_PIDS: "256" }))).not.toBe(base);
  });

  test("runtime networks are internal unless egress is off", () => {
    const cfg = configWith();
    expect(runtimeNetworkSpec(cfg, "tandem-net-k", "allowlist", "k")).toEqual({
      Name: "tandem-net-k",
      Driver: "bridge",
      Internal: true,
      // No address for the host on the bridge: host services stay unreachable.
      Options: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" },
      Labels: { "tandem.runtime-network": "1", "tandem.key": "k" },
    });
    expect(
      runtimeNetworkSpec(cfg, "n", "allowlist", "k", false).Options,
    ).toBeUndefined(); // an Engine before 28
    expect(runtimeNetworkSpec(cfg, "n", "off", "k").Options).toBeUndefined();
    expect(runtimeNetworkSpec(cfg, "tandem-runtimes", "open").Internal).toBe(
      true,
    );
    expect(runtimeNetworkSpec(cfg, "tandem-runtimes", "off").Labels).toEqual({
      "tandem.runtime-network": "1",
      "tandem.shared": "1",
    });
    expect(runtimeNetworkSpec(cfg, "tandem-runtimes", "off").Internal).toBe(
      false,
    );
  });

  test("egress variables in both spellings; nothing when egress is off", () => {
    expect(egressEnv("off", "p:1", [])).toEqual([]);
    expect(egressEnv("open", "p:1", ["gw"])).toEqual([
      "HTTPS_PROXY=http://p:1",
      "https_proxy=http://p:1",
      "HTTP_PROXY=http://p:1",
      "http_proxy=http://p:1",
      "NO_PROXY=localhost,127.0.0.1,::1,gw",
      "no_proxy=localhost,127.0.0.1,::1,gw",
    ]);
  });
});

// --- The Docker runtime controller against a fake Engine ---------------------------------------

type Call = { method: string; path: string; body: any };

const frame = (text: string) => {
  const out = new TextEncoder().encode(text);
  const f = new Uint8Array(8 + out.length);
  f[0] = 1;
  new DataView(f.buffer).setUint32(4, out.length);
  f.set(out, 8);
  return f;
};

/**
 * A small Docker Engine. Networks hand out addresses like Docker 29 (the lowest free one, a fixed one
 * on request, Docker's own errors), runtime containers join their network when they start, and exec
 * answers the controller's commands from the container's own settings.
 */
function fakeEngine(opts: {
  runtimes?: string[];
  plugins?: number;
  poolExhausted?: boolean;
  egressRunning?: boolean;
  /** An Engine before 28: no isolated gateway mode, so the host keeps an address on the bridge. */
  oldEngine?: boolean;
  /** Docker Engine 29.0.0-29.0.3: no fixed addresses on networks without a configured subnet. */
  noFixedAddresses?: boolean;
}) {
  const calls: Call[] = [];
  const containers = new Map<string, any>();
  const networks = new Map<string, any>();
  const self = { Id: "self".padEnd(64, "0"), Name: "/tandem-gateway" };
  const egress = {
    Id: "egress".padEnd(64, "0"),
    Name: "/tandem-egress",
    State: { Running: opts.egressRunning ?? true },
  };
  /** Other containers on runtime networks (a neighbour, a debugging container). */
  const others: any[] = [];
  /** What a runtime's daemon answers inside it (ACTIVITY_COMMAND), by container name. */
  const activity = new Map<string, string>();
  const execs = new Map<string, { c: any; cmd: string[] }>();
  let subnets = 0;
  const find = (ref: string) =>
    [self, egress, ...others, ...containers.values()].find(
      (c) => c.Id === ref || c.Name === `/${ref}`,
    );
  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const subnetOf = (n: any) => n.IPAM.Config[0].Subnet as string;
  /** Docker 29's choice: the address asked for, or the lowest free one. */
  function allocate(n: any, want?: string): string | Response {
    const used = new Set(
      Object.values<any>(n.Containers).map((m) => m.IPv4Address.split("/")[0]),
    );
    if (n.IPAM.Config[0].Gateway) used.add(n.IPAM.Config[0].Gateway);
    const prefix = subnetOf(n).split(".").slice(0, 3).join(".");
    if (want) {
      if (opts.noFixedAddresses)
        return json(
          {
            message:
              "invalid endpoint settings:\nuser specified IP address is supported only when connecting to networks with user configured subnets",
          },
          400,
        );
      if (!inCidr(want, subnetOf(n)))
        return json(
          {
            message: `invalid endpoint settings:\nno configured subnet contains IP address ${want}`,
          },
          400,
        );
      if (used.has(want)) return json({ message: "Address already in use" }, 403);
      return want;
    }
    for (let i = 1; i < 255; i++)
      if (!used.has(`${prefix}.${i}`)) return `${prefix}.${i}`;
    return json({ message: "no available IPv4 addresses" }, 500);
  }
  function join(n: any, c: any, want?: string) {
    const ip = allocate(n, want);
    if (ip instanceof Response) return ip;
    n.Containers[c.Id] = { Name: c.Name.slice(1), IPv4Address: `${ip}/24` };
    return ip;
  }
  const leave = (c: any) => {
    for (const n of networks.values()) delete n.Containers[c.Id];
  };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname.replace(/^\/v1\.\d+/, "");
      const text = req.method === "GET" ? "" : await req.text();
      const body = text && text.startsWith("{") ? JSON.parse(text) : null;
      calls.push({ method: req.method, path: path + url.search, body });
      let m: RegExpMatchArray | null;
      if (path === "/info")
        return json({
          Runtimes: Object.fromEntries(
            (opts.runtimes ?? ["runc"]).map((r) => [r, {}]),
          ),
          DefaultRuntime: "runc",
        });
      if (path === "/plugins") return json([], opts.plugins ?? 200);
      if (path === `/containers/${hostname()}/json`) return json(self);
      if ((m = path.match(/^\/images\/(.+)\/json$/)))
        return json({ Id: "sha256:img" });
      if (path === "/networks/create") {
        if (networks.has(body.Name)) return json({ message: "exists" }, 409);
        if (opts.poolExhausted && body.Labels["tandem.key"])
          return json(
            {
              message: "all predefined address pools have been fully subnetted",
            },
            400,
          );
        if (opts.oldEngine && body.Options)
          return json({ message: "invalid gateway mode: isolated" }, 400);
        const subnet = `172.30.${++subnets}`;
        networks.set(body.Name, {
          ...body,
          Containers: {},
          IPAM: {
            Config: [
              {
                Subnet: `${subnet}.0/24`,
                ...(body.Options ? {} : { Gateway: `${subnet}.1` }),
              },
            ],
          },
        });
        return json({ Id: body.Name }, 201);
      }
      if ((m = path.match(/^\/networks\/([^/]+)\/(connect|disconnect)$/))) {
        const n = networks.get(m[1]!);
        if (!n) return json({ message: "no such network" }, 404);
        // Like the Engine: accepts an ID or a name, keys endpoints by ID.
        const who = find(body.Container);
        if (!who) return json({ message: "no such container" }, 404);
        if (m[2] === "disconnect") {
          if (!n.Containers[who.Id])
            return json(
              {
                message: `container ${who.Id} is not connected to network ${m[1]}`,
              },
              500,
            );
          delete n.Containers[who.Id];
          return new Response(null, { status: 200 });
        }
        if (n.Containers[who.Id])
          return json(
            {
              message: `endpoint with name ${who.Name.slice(1)} already exists in network ${m[1]}`,
            },
            403,
          );
        const joined = join(n, who, body.EndpointConfig?.IPAMConfig?.IPv4Address);
        return joined instanceof Response
          ? joined
          : new Response(null, { status: 200 });
      }
      if ((m = path.match(/^\/networks\/([^/]+)$/))) {
        const n = networks.get(m[1]!);
        if (req.method === "DELETE") {
          if (n && Object.keys(n.Containers).length)
            return json({ message: "network has active endpoints" }, 403);
          networks.delete(m[1]!);
          return new Response(null, { status: n ? 204 : 404 });
        }
        return n ? json(n) : json({ message: "no such network" }, 404);
      }
      if (path.startsWith("/networks"))
        return json(
          [...networks.values()].map((n) => ({
            Name: n.Name,
            Labels: n.Labels,
          })),
        );
      if (path === "/volumes/create") return json({}, 201);
      if (path === "/containers/create") {
        const name = url.searchParams.get("name")!;
        containers.set(name, {
          Id: name,
          Name: `/${name}`,
          Image: "sha256:img",
          Config: { Labels: body.Labels, Env: body.Env },
          HostConfig: body.HostConfig,
          NetworkSettings: { Networks: {} },
          State: { Running: false },
        });
        return json({ Id: name }, 201);
      }
      if ((m = path.match(/^\/containers\/([^/]+)\/(start|stop|restart)$/))) {
        const c = containers.get(m[1]!);
        if (!c) return json({ message: "no such container" }, 404);
        const net = c.HostConfig.NetworkMode;
        leave(c);
        c.NetworkSettings.Networks = {};
        if (m[2] !== "stop") {
          const n = networks.get(net);
          if (!n) return json({ message: `network ${net} not found` }, 404);
          const ip = join(n, c);
          if (ip instanceof Response) return ip;
          c.NetworkSettings.Networks[net] = { IPAddress: ip };
        }
        c.State = {
          Running: m[2] !== "stop",
          StartedAt: new Date().toISOString(),
        };
        return new Response(null, { status: 204 });
      }
      if ((m = path.match(/^\/containers\/([^/]+)\/json$/))) {
        const c = find(m[1]!);
        return c ? json(c) : json({ message: "no such container" }, 404);
      }
      if (
        (m = path.match(/^\/containers\/([^/]+)$/)) &&
        req.method === "DELETE"
      ) {
        const c = containers.get(m[1]!);
        if (c?.State.Running)
          return json({ message: "container is running" }, 409);
        containers.delete(m[1]!);
        return new Response(null, { status: 204 });
      }
      if (path === "/containers/json")
        return json(
          [...containers.values()]
            .filter((c) => c.State.Running)
            .map((c) => ({ Id: c.Id, Labels: c.Config.Labels })),
        );
      if ((m = path.match(/^\/containers\/([^/]+)\/exec$/))) {
        const c = find(decodeURIComponent(m[1]!));
        if (!c?.State?.Running)
          return json({ message: "container is not running" }, 409);
        const id = `e${execs.size + 1}`;
        execs.set(id, { c, cmd: body.Cmd });
        return json({ Id: id }, 201);
      }
      if ((m = path.match(/^\/exec\/([^/]+)\/start$/))) {
        const { c, cmd } = execs.get(m[1]!)!;
        const env = (name: string) =>
          (c.Config?.Env ?? [])
            .find((e: string) => e.startsWith(`${name}=`))
            ?.slice(name.length + 1) ?? "";
        let out = "";
        if (cmd[0] === "cat") out = "t".repeat(43);
        else if (JSON.stringify(cmd) === JSON.stringify(LAUNCH_VALUES_COMMAND))
          out = `${env("HAPPY_BRIDGE_ALLOW")} ${env("MCP_PROXY_URL")} ${env("HTTPS_PROXY")}\n`;
        else if (JSON.stringify(cmd) === JSON.stringify(ACTIVITY_COMMAND))
          out =
            activity.get(c.Name.slice(1)) ??
            `${JSON.stringify({ project: { agents: [] } })}\n${JSON.stringify({ providerCli: { id: "claude", operation: null } })}\n${JSON.stringify({ providerCli: { id: "codex", operation: null } })}\n`;
        return new Response(frame(out), { headers: { connection: "close" } });
      }
      if ((m = path.match(/^\/exec\/([^/]+)\/json$/))) return json({ ExitCode: 0 });
      return json({ message: `fake engine: ${req.method} ${path}` }, 500);
    },
  });
  /** `docker compose up --force-recreate`: a new container under the same name, on no runtime network. */
  const recreate = (c: { Id: string }, id: string) => {
    leave(c);
    c.Id = id.padEnd(64, "0");
  };
  /** A container that is not Tandem's, attached to a runtime network at `ip`. */
  const intruder = (network: string, ip?: string) => {
    const c = { Id: `x${others.length}`.padEnd(64, "0"), Name: `/intruder-${others.length}` };
    others.push(c);
    return join(networks.get(network), c, ip);
  };
  return {
    server,
    calls,
    containers,
    networks,
    self,
    egress,
    activity,
    recreate,
    intruder,
    join: (network: string, c: any, ip?: string) =>
      join(networks.get(network), c, ip),
  };
}

const engines: ReturnType<typeof fakeEngine>[] = [];
afterAll(() => engines.forEach((e) => e.server.stop(true)));

function controller(
  engine: ReturnType<typeof fakeEngine>,
  vars: Record<string, string> = {},
) {
  engines.push(engine);
  const logs: string[] = [];
  const cfg = configWith({
    RUNTIME_DOCKER_HOST: `tcp://127.0.0.1:${engine.server.port}`,
    ...vars,
  });
  return { rt: new DockerRuntime(cfg, (...a) => logs.push(a.join(" "))), logs };
}

/** Each container's address on a network, by container name. */
const addresses = (engine: ReturnType<typeof fakeEngine>, network: string) =>
  Object.fromEntries(
    Object.values<any>(engine.networks.get(network).Containers).map((m) => [
      m.Name,
      m.IPv4Address.split("/")[0],
    ]),
  );

/** Calls that start, stop, restart or remove a runtime container. */
const lifecycle = (engine: ReturnType<typeof fakeEngine>, key: string) =>
  engine.calls.filter(
    (c) =>
      c.path.startsWith(`/containers/tandem-rt-${key}`) &&
      !/\/(json|exec)$/.test(c.path),
  );

describe("Docker runtime controller", () => {
  const KEY = "a".repeat(24);

  test("each runtime gets its own internal network shared only with the gateway and the egress proxy", async () => {
    const engine = fakeEngine({ runtimes: ["runc", "runsc"] });
    const { rt } = controller(engine);
    const posture = await rt.posture();
    expect(posture).toMatchObject({
      ociRuntime: "runsc",
      dockerApi: "unrestricted",
      egress: "allowlist",
      network: "per_runtime",
    });
    expect(posture.warnings).toHaveLength(1); // unrestricted Docker API only
    await rt.ensure(KEY);
    const net = engine.networks.get(`tandem-net-${KEY}`);
    expect(net.Internal).toBe(true);
    const c = engine.containers.get(`tandem-rt-${KEY}`);
    expect(Object.keys(net.Containers).sort()).toEqual(
      [engine.egress.Id, engine.self.Id, c.Id].sort(),
    );
    expect(c.HostConfig.NetworkMode).toBe(`tandem-net-${KEY}`);
    expect(c.HostConfig.Runtime).toBe("runsc");
    // The gateway and the egress proxy take the network's last two addresses; the runtime the first.
    const subnet = net.IPAM.Config[0].Subnet.replace(/\.0\/24$/, "");
    expect(addresses(engine, `tandem-net-${KEY}`)).toEqual({
      "tandem-gateway": `${subnet}.254`,
      "tandem-egress": `${subnet}.253`,
      [`tandem-rt-${KEY}`]: `${subnet}.1`,
    });
    const gatewayIp = `${subnet}.254`;
    expect(c.Config.Labels["tandem.bridge-allow"]).toBe(`${gatewayIp}/32`);
    const egressIp = `${subnet}.253`;
    const env: string[] = engine.calls.find((x) =>
      x.path.startsWith("/containers/create"),
    )!.body.Env;
    // Addresses, not names: Docker's embedded DNS does not answer inside gVisor.
    expect(env).toContain(`HTTPS_PROXY=http://${egressIp}:4750`);
    expect(env).toContain(
      `NO_PROXY=localhost,127.0.0.1,::1,tandem-gateway,${gatewayIp}`,
    );
    expect(rt.isRuntimeAddress(gatewayIp)).toBe(true);
    expect(rt.isRuntimeAddress("10.1.2.3")).toBe(false);
    // The MCP proxy: the gateway's address on this runtime's own network (in NO_PROXY above), and
    // the runtime's address there is the only source the proxy accepts for it.
    expect(env).toContain(`MCP_PROXY_URL=http://${gatewayIp}:8790/mcp/${KEY}`);
    expect(await rt.address(KEY)).toBe(
      c.NetworkSettings.Networks[`tandem-net-${KEY}`].IPAddress,
    );

    // An idle stop releases the container and the network; the next start recreates both.
    await rt.stop(KEY);
    expect(engine.containers.has(`tandem-rt-${KEY}`)).toBe(false);
    expect(engine.networks.has(`tandem-net-${KEY}`)).toBe(false);
    await rt.ensure(KEY);
    expect(engine.containers.get(`tandem-rt-${KEY}`).State.Running).toBe(true);
  });

  test("a recreated gateway and egress proxy return to the addresses a running runtime was created with, without restarting it", async () => {
    const engine = fakeEngine({});
    await controller(engine).rt.ensure(KEY);
    const net = `tandem-net-${KEY}`;
    const before = addresses(engine, net);
    const started = engine.containers.get(`tandem-rt-${KEY}`).State.StartedAt;
    // `docker compose up -d --force-recreate gateway egress`, the hostile way: the new egress proxy
    // joins first and takes the gateway's address.
    engine.recreate(engine.egress, "egress2");
    engine.recreate(engine.self, "self2");
    engine.join(net, engine.egress, before["tandem-gateway"]);
    engine.calls.length = 0;
    const { rt, logs } = controller(engine); // the new gateway process
    expect((await rt.ensure(KEY)).key).toBe(KEY);
    expect(addresses(engine, net)).toEqual(before);
    expect(lifecycle(engine, KEY)).toEqual([]);
    expect(engine.containers.get(`tandem-rt-${KEY}`).State.StartedAt).toBe(
      started,
    );
    expect(logs.join("\n")).toContain(
      `egress moved on ${net}: ${before["tandem-gateway"]} -> ${before["tandem-egress"]}`,
    );
    // Moving them is a disconnect and fixed-address connects, nothing else.
    expect(
      engine.calls
        .filter((c) => c.method === "POST" && c.path.startsWith("/networks/"))
        .map((c) => `${c.path.split("/").at(-1)} ${c.body.EndpointConfig?.IPAMConfig?.IPv4Address ?? ""}`.trim()),
    ).toEqual([
      "disconnect",
      `connect ${before["tandem-gateway"]}`,
      `connect ${before["tandem-egress"]}`,
    ]);
    // A plain gateway restart (--no-deps) changes nothing else either.
    engine.recreate(engine.self, "self3");
    engine.calls.length = 0;
    await controller(engine).rt.ensure(KEY);
    expect(addresses(engine, net)).toEqual(before);
    expect(lifecycle(engine, KEY)).toEqual([]);
  });

  test("a runtime from an older Tandem keeps working: the gateway takes the addresses it was created with", async () => {
    const engine = fakeEngine({});
    const { rt: old } = controller(engine);
    await old.ensure(KEY);
    // Recreate the runtime the way Tandem did before fixed addresses: gateway, egress proxy and
    // runtime took the lowest free addresses, in that order.
    const net = `tandem-net-${KEY}`;
    const n = engine.networks.get(net);
    const c = engine.containers.get(`tandem-rt-${KEY}`);
    n.Containers = {};
    const gw = engine.join(net, engine.self) as string;
    const eg = engine.join(net, engine.egress) as string;
    engine.join(net, c);
    c.Config.Env = c.Config.Env.map((e: string) =>
      e
        .replace(/^(HAPPY_BRIDGE_ALLOW=).*/, `$1${gw}/32`)
        .replace(/^(MCP_PROXY_URL=http:\/\/)[^:]+/, `$1${gw}`)
        .replace(/^(HTTPS_PROXY=http:\/\/)[^:]+/, `$1${eg}`),
    );
    // The upgrade recreated both; the new egress proxy got the gateway's old address first.
    engine.recreate(engine.egress, "egress2");
    engine.recreate(engine.self, "self2");
    engine.join(net, engine.egress);
    expect(addresses(engine, net)["tandem-egress"]).toBe(gw);
    engine.calls.length = 0;
    await controller(engine).rt.ensure(KEY);
    expect(addresses(engine, net)).toMatchObject({
      "tandem-gateway": gw,
      "tandem-egress": eg,
    });
    expect(lifecycle(engine, KEY)).toEqual([]);
  });

  test("addresses another container holds: StaleRuntime until the runtime is stopped; its volume is never touched", async () => {
    const engine = fakeEngine({});
    await controller(engine).rt.ensure(KEY);
    const net = `tandem-net-${KEY}`;
    const gw = addresses(engine, net)["tandem-gateway"];
    engine.recreate(engine.self, "self2");
    engine.intruder(net, gw);
    engine.calls.length = 0;
    const { rt, logs } = controller(engine);
    expect(rt.ensure(KEY)).rejects.toBeInstanceOf(StaleRuntime);
    await Bun.sleep(50);
    // A restart keeps the runtime's settings, so it would not help: refused before restarting.
    expect(rt.restart(KEY)).rejects.toBeInstanceOf(StaleRuntime);
    await Bun.sleep(50);
    expect(lifecycle(engine, KEY)).toEqual([]);
    expect(logs.join("\n")).toContain("another container holds it");
    // The gateway stops it once idle (src/gateway.ts). The intruder keeps the network, so the next
    // start reuses it with the gateway wherever Docker puts it, and the new runtime expects that.
    await rt.stop(KEY);
    expect(logs.join("\n")).toContain("network kept for now");
    await rt.ensure(KEY);
    const c = engine.containers.get(`tandem-rt-${KEY}`);
    expect(c.State.Running).toBe(true);
    expect(c.Config.Env).toContain(
      `HAPPY_BRIDGE_ALLOW=${addresses(engine, net)["tandem-gateway"]}/32`,
    );
    expect(
      engine.calls.filter((c) => c.path.startsWith("/volumes") && c.method !== "POST" && c.method !== "GET"),
    ).toEqual([]);
  });

  test("the sweep puts a recreated egress proxy back at its address", async () => {
    const engine = fakeEngine({});
    const { rt } = controller(engine);
    await rt.ensure(KEY);
    const net = `tandem-net-${KEY}`;
    const before = addresses(engine, net);
    engine.recreate(engine.egress, "egress2"); // compose up -d --force-recreate --no-deps egress
    expect(addresses(engine, net)["tandem-egress"]).toBeUndefined();
    await rt.sweep();
    expect(addresses(engine, net)).toEqual(before);
    // The address a runtime was created with is read once per container (inside it: a Docker API
    // proxy redacts environments).
    await rt.sweep();
    const reads = engine.calls.filter(
      (c) =>
        c.path.endsWith("/exec") &&
        JSON.stringify(c.body.Cmd) === JSON.stringify(LAUNCH_VALUES_COMMAND),
    );
    expect(reads).toHaveLength(1);
  });

  test("an Engine that refuses fixed addresses still works, with a warning; a lost address makes the runtime stale", async () => {
    const engine = fakeEngine({ noFixedAddresses: true });
    const { rt, logs } = controller(engine);
    await rt.ensure(KEY);
    expect(engine.containers.get(`tandem-rt-${KEY}`).State.Running).toBe(true);
    expect(logs.join("\n")).toContain("Docker refused a fixed address");
    const net = `tandem-net-${KEY}`;
    const before = addresses(engine, net);
    // The hostile order still recovers: once the egress proxy leaves the gateway's address, it is
    // the lowest free one again.
    engine.recreate(engine.egress, "egress2");
    engine.recreate(engine.self, "self2");
    engine.join(net, engine.egress);
    expect(addresses(engine, net)["tandem-egress"]).toBe(
      before["tandem-gateway"],
    );
    await controller(engine).rt.ensure(KEY);
    expect(addresses(engine, net)).toEqual(before);
    // Another container that took the gateway's address meanwhile cannot be worked around.
    engine.recreate(engine.self, "self3");
    engine.intruder(net);
    expect(controller(engine).rt.ensure(KEY)).rejects.toBeInstanceOf(
      StaleRuntime,
    );
    await Bun.sleep(50);
  });

  test("the daemon's activity is read inside the runtime", async () => {
    const engine = fakeEngine({});
    const { rt } = controller(engine);
    await rt.ensure(KEY);
    expect(await rt.activity(KEY)).toEqual({
      project: { agents: [] },
      clis: [
        { id: "claude", operation: null },
        { id: "codex", operation: null },
      ],
    });
    engine.activity.set(`tandem-rt-${KEY}`, "not json\n");
    expect(await rt.activity(KEY)).toBeNull();
  });

  test("a network left by a runtime stopped outside the gateway is swept; the runtime is recreated on its next start", async () => {
    const engine = fakeEngine({});
    const { rt } = controller(engine);
    await rt.ensure(KEY);
    const c = engine.containers.get(`tandem-rt-${KEY}`);
    c.State = { Running: false }; // docker stop
    for (const n of engine.networks.values()) delete n.Containers[c.Id];
    await rt.sweep();
    expect(engine.networks.has(`tandem-net-${KEY}`)).toBe(false);
    await rt.ensure(KEY);
    const deletes = engine.calls.filter(
      (c) => c.method === "DELETE" && c.path === `/containers/tandem-rt-${KEY}`,
    );
    expect(deletes).toHaveLength(1); // stale: its old network no longer exists
    expect(engine.containers.get(`tandem-rt-${KEY}`).State.Running).toBe(true);
  });

  test("auto isolation falls back to the shared network when Docker's address pools are used up", async () => {
    const engine = fakeEngine({ poolExhausted: true });
    const { rt, logs } = controller(engine);
    await rt.ensure(KEY);
    expect(
      engine.containers.get(`tandem-rt-${KEY}`).HostConfig.NetworkMode,
    ).toBe("tandem-runtimes");
    expect(engine.networks.get("tandem-runtimes").Internal).toBe(true);
    expect(logs.join("\n")).toContain("no free address pool");
    // The MCP proxy follows the runtime onto the shared network.
    const c = engine.containers.get(`tandem-rt-${KEY}`);
    const gatewayIp = engine.networks
      .get("tandem-runtimes")
      .Containers[engine.self.Id].IPv4Address.split("/")[0];
    expect(gatewayIp).toEndWith(".254"); // fixed there as well
    expect(c.Config.Env).toContain(
      `MCP_PROXY_URL=http://${gatewayIp}:8790/mcp/${KEY}`,
    );
    expect(await rt.address(KEY)).toBe(
      c.NetworkSettings.Networks["tandem-runtimes"].IPAddress,
    );
    // A second runtime shares it; after a gateway restart both find it where they expect it.
    const OTHER = "b".repeat(24);
    await rt.ensure(OTHER);
    engine.recreate(engine.self, "self2");
    const { rt: next } = controller(engine);
    await next.ensure(KEY);
    await next.ensure(OTHER);
    expect(addresses(engine, "tandem-runtimes")["tandem-gateway"]).toBe(
      gatewayIp,
    );
    expect(lifecycle(engine, KEY)).toHaveLength(1); // its one start
  });

  test("the controller's own exec runs as the runtime user and is allowlisted for the socket proxy", async () => {
    const engine = fakeEngine({});
    const { rt } = controller(engine);
    await rt.ensure(KEY);
    engine.recreate(engine.self, "self2");
    await controller(engine).rt.ensure(KEY); // reads what the runtime was created with
    await rt.activity(KEY);
    const execs = engine.calls
      .filter((c) => /^\/containers\/[^/]+\/exec$/.test(c.path))
      .map((c) => c.body);
    expect(new Set(execs.map((e) => e.Cmd[0] + " " + (e.Cmd[2] ?? e.Cmd[1]).slice(0, 4))).size).toBe(3);
    const policy = await socketProxyPolicy();
    for (const e of execs) {
      expect(e.User).toBe("10001:10001");
      expect(policy.commands.has(JSON.stringify(e.Cmd))).toBe(true);
    }
  });

  test("MCP_PROXY_URL replaces the detected proxy address and bypasses the egress proxy", async () => {
    const engine = fakeEngine({});
    const { rt } = controller(engine, {
      MCP_PROXY_URL: "http://mcp-proxy.internal:9000/",
    });
    await rt.ensure(KEY);
    const env: string[] = engine.containers.get(`tandem-rt-${KEY}`).Config.Env;
    expect(env).toContain(
      `MCP_PROXY_URL=http://mcp-proxy.internal:9000/mcp/${KEY}`,
    );
    expect(env.find((e) => e.startsWith("NO_PROXY="))).toEndWith(
      ",mcp-proxy.internal",
    );
  });

  test("per_runtime isolation never falls back", async () => {
    const engine = fakeEngine({ poolExhausted: true });
    const { rt } = controller(engine, {
      RUNTIME_NETWORK_ISOLATION: "per_runtime",
    });
    expect(rt.ensure(KEY)).rejects.toThrow(/address pools/);
  });

  test("required protections stop the gateway instead of degrading", async () => {
    expect(
      controller(fakeEngine({}), { RUNTIME_OCI_RUNTIME: "runsc" }).rt.posture(),
    ).rejects.toThrow(/RUNTIME_OCI_RUNTIME=runsc/);
    expect(
      controller(fakeEngine({}), {
        RUNTIME_DOCKER_PROXY: "required",
      }).rt.posture(),
    ).rejects.toThrow(/RUNTIME_DOCKER_PROXY=required/);
    expect(
      controller(fakeEngine({ egressRunning: false }), {
        EGRESS_MODE: "allowlist",
      }).rt.posture(),
    ).rejects.toThrow(/egress proxy/);
  });

  test("automatic modes degrade with a warning when the host lacks a protection", async () => {
    const { rt } = controller(
      fakeEngine({ plugins: 403, egressRunning: false }),
    );
    const p = await rt.posture();
    expect(p).toMatchObject({
      ociRuntime: null,
      sandbox: "runc",
      dockerApi: "restricted",
      egress: "off",
    });
    expect(p.warnings.join("\n")).toMatch(/gVisor[\s\S]*egress proxy/);
  });

  test("an Engine without isolated gateway mode still works, with a warning about host services", async () => {
    const engine = fakeEngine({ oldEngine: true });
    const { rt, logs } = controller(engine);
    await rt.ensure(KEY);
    expect(engine.containers.get(`tandem-rt-${KEY}`).State.Running).toBe(true);
    expect(engine.networks.get(`tandem-net-${KEY}`).Internal).toBe(true);
    expect(logs.join("\n")).toContain("host-side address");
    // The bridge keeps the first address; the gateway still takes the last.
    expect(addresses(engine, `tandem-net-${KEY}`)["tandem-gateway"]).toEndWith(
      ".254",
    );
  });

  test("egress off: runtime networks get a route out and runtimes no proxy variables", async () => {
    const engine = fakeEngine({});
    const { rt } = controller(engine, { EGRESS_MODE: "off" });
    await rt.ensure(KEY);
    expect(engine.networks.get(`tandem-net-${KEY}`).Internal).toBe(false);
    const env: string[] = engine.calls.find((c) =>
      c.path.startsWith("/containers/create"),
    )!.body.Env;
    expect(env.some((e) => e.startsWith("HTTPS_PROXY="))).toBe(false);
    // Only the gateway is pinned; a gateway restart still finds the runtime reachable.
    engine.recreate(engine.self, "self2");
    await controller(engine, { EGRESS_MODE: "off" }).rt.ensure(KEY);
    expect(lifecycle(engine, KEY)).toHaveLength(1);
  });
});

describe("fixed addresses on runtime networks", () => {
  test("the gateway and the egress proxy take the subnet's last two addresses", () => {
    expect(reservedAddresses("172.25.0.0/16")).toEqual({
      gateway: "172.25.255.254",
      egress: "172.25.255.253",
    });
    expect(reservedAddresses("192.168.16.0/20")).toEqual({
      gateway: "192.168.31.254",
      egress: "192.168.31.253",
    });
    expect(reservedAddresses("10.9.8.0/29")).toEqual({
      gateway: "10.9.8.6",
      egress: "10.9.8.5",
    });
    expect(reservedAddresses("10.9.8.0/29", ["10.9.8.6"])).toEqual({
      gateway: "10.9.8.5",
      egress: "10.9.8.4",
    });
    expect(reservedAddresses("10.9.8.0/30")).toBeNull();
    expect(reservedAddresses("fd00::/64")).toBeNull();
  });

  test("what a runtime was created with, read from its own settings", () => {
    const subnet = "172.25.0.0/16";
    const key = "k".repeat(24);
    // Before fixed addresses (as on the main stack before this change) and after.
    expect(
      peerAddresses(
        {
          allow: "172.25.0.1/32",
          mcpProxyUrl: `http://172.25.0.1:8790/mcp/${key}`,
          httpsProxy: "http://172.25.0.2:4750",
        },
        subnet,
      ),
    ).toEqual({ gateway: "172.25.0.1", egress: "172.25.0.2" });
    // BRIDGE_ALLOW as a range: the MCP proxy URL names the gateway.
    expect(
      peerAddresses(
        {
          allow: "172.16.0.0/12",
          mcpProxyUrl: `http://172.25.255.254:8790/mcp/${key}`,
          httpsProxy: "http://172.25.255.253:4750",
        },
        subnet,
      ),
    ).toEqual({ gateway: "172.25.255.254", egress: "172.25.255.253" });
    // An operator's MCP_PROXY_URL, egress off, a gateway outside Docker: nothing on this network.
    expect(
      peerAddresses(
        {
          allow: "192.168.1.10/32",
          mcpProxyUrl: `http://mcp-proxy.internal:9000/mcp/${key}`,
          httpsProxy: "",
        },
        subnet,
      ),
    ).toEqual({});
  });

  test("where each one belongs: where the running runtimes expect it, else the reserved address", () => {
    const reserved = { gateway: "10.0.0.254", egress: "10.0.0.253" };
    expect(chooseAddresses({}, [], reserved)).toEqual(reserved);
    expect(
      chooseAddresses({ gateway: "10.0.0.7" }, [{}], reserved),
    ).toEqual(reserved);
    expect(
      chooseAddresses(
        { gateway: "10.0.0.2", egress: "10.0.0.1" },
        [{ gateway: "10.0.0.1", egress: "10.0.0.2" }],
        reserved,
      ),
    ).toEqual({ gateway: "10.0.0.1", egress: "10.0.0.2" });
    // A shared network of runtimes from before and after an old gateway restart: where it is now
    // when some expect that (nothing moves), otherwise where most expect it.
    const mixed = [
      { gateway: "10.0.0.1" },
      { gateway: "10.0.0.5" },
      { gateway: "10.0.0.5" },
    ];
    expect(chooseAddresses({ gateway: "10.0.0.1" }, mixed, reserved).gateway).toBe(
      "10.0.0.1",
    );
    expect(chooseAddresses({ gateway: "10.0.0.9" }, mixed, reserved).gateway).toBe(
      "10.0.0.5",
    );
  });

  test("the moves that put each one at its address", () => {
    const want = { gateway: "10.0.0.1", egress: "10.0.0.2" };
    const both = ["gateway", "egress"] as const;
    const rt = { ip: "10.0.0.3" };
    expect(
      pinPlan(
        [{ peer: "gateway", ip: "10.0.0.1" }, { peer: "egress", ip: "10.0.0.2" }, rt],
        [...both],
        want,
      ),
    ).toEqual({ disconnect: [], connect: [], blocked: [] });
    // A new gateway: it joins at its address.
    expect(pinPlan([{ peer: "egress", ip: "10.0.0.2" }, rt], [...both], want)).toEqual({
      disconnect: [],
      connect: [{ peer: "gateway", ip: "10.0.0.1" }],
      blocked: [],
    });
    // The bug: the new egress proxy took the gateway's address and the gateway the proxy's.
    expect(
      pinPlan(
        [{ peer: "egress", ip: "10.0.0.1" }, { peer: "gateway", ip: "10.0.0.2" }, rt],
        [...both],
        want,
      ),
    ).toEqual({
      disconnect: ["gateway", "egress"],
      connect: [
        { peer: "gateway", ip: "10.0.0.1" },
        { peer: "egress", ip: "10.0.0.2" },
      ],
      blocked: [],
    });
    // The egress proxy on the gateway's address, the gateway not there yet.
    expect(pinPlan([{ peer: "egress", ip: "10.0.0.1" }, rt], [...both], want)).toEqual({
      disconnect: ["egress"],
      connect: [
        { peer: "gateway", ip: "10.0.0.1" },
        { peer: "egress", ip: "10.0.0.2" },
      ],
      blocked: [],
    });
    // Another container holds the gateway's address: nothing is moved for it.
    expect(
      pinPlan([{ ip: "10.0.0.1" }, { peer: "gateway", ip: "10.0.0.4" }, { peer: "egress", ip: "10.0.0.2" }], [...both], want),
    ).toEqual({ disconnect: [], connect: [], blocked: ["gateway"] });
    expect(pinPlan([{ ip: "10.0.0.1" }, { peer: "egress", ip: "10.0.0.2" }], [...both], want)).toEqual({
      disconnect: [],
      connect: [{ peer: "gateway" }],
      blocked: ["gateway"],
    });
  });
});
