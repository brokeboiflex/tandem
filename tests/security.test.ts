// Hardening: settings, detection and the exact container/network specs, plus the Docker runtime
// controller against a fake Engine (per-runtime networks, fallback, release, sweep).
import { afterAll, describe, expect, test } from "bun:test";
import { hostname } from "node:os";
import { loadConfig, type Config } from "../src/config";
import { proxyToken } from "../src/mcp";
import { DockerRuntime } from "../src/runtime";
import { socketProxyPolicy } from "./fake-daemon";
import {
  chooseOciRuntime,
  dockerApiAccess,
  egressEnv,
  inCidr,
  isAddressPoolExhausted,
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

function fakeEngine(opts: {
  runtimes?: string[];
  plugins?: number;
  poolExhausted?: boolean;
  egressRunning?: boolean;
  /** An Engine before 28: no isolated gateway mode, so the host keeps an address on the bridge. */
  oldEngine?: boolean;
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
  let ip = 1;
  const json = (data: unknown, status = 200) => Response.json(data, { status });
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
      if (path === "/containers/tandem-egress/json") return json(egress);
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
        const subnet = `172.30.${networks.size}`;
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
        const who = [self, egress].find(
          (c) => c.Id === body.Container || c.Name === `/${body.Container}`,
        );
        if (!who) return json({ message: "no such container" }, 404);
        if (m[2] === "connect") {
          if (n.Containers[who.Id])
            return json({ message: "endpoint already exists in network" }, 403);
          n.Containers[who.Id] = {
            Name: who.Name.slice(1),
            IPv4Address: `172.30.0.${++ip}/24`,
          };
        } else delete n.Containers[who.Id];
        return new Response(null, { status: 200 });
      }
      if ((m = path.match(/^\/networks\/([^/]+)$/))) {
        const n = networks.get(m[1]!);
        if (req.method === "DELETE") {
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
          Image: "sha256:img",
          Config: { Labels: body.Labels, Env: body.Env },
          HostConfig: body.HostConfig,
          NetworkSettings: {
            Networks: {
              [body.HostConfig.NetworkMode]: { IPAddress: `172.30.0.${++ip}` },
            },
          },
          State: { Running: false },
        });
        return json({ Id: name }, 201);
      }
      if ((m = path.match(/^\/containers\/([^/]+)\/(start|stop)$/))) {
        const c = containers.get(m[1]!);
        if (!c) return json({ message: "no such container" }, 404);
        c.State = {
          Running: m[2] === "start",
          StartedAt: new Date().toISOString(),
        };
        return new Response(null, { status: 204 });
      }
      if ((m = path.match(/^\/containers\/([^/]+)\/json$/))) {
        const c = containers.get(m[1]!);
        return c ? json(c) : json({ message: "no such container" }, 404);
      }
      if (
        (m = path.match(/^\/containers\/([^/]+)$/)) &&
        req.method === "DELETE"
      ) {
        containers.delete(m[1]!);
        return new Response(null, { status: 204 });
      }
      if (path === "/containers/json")
        return json(
          [...containers.values()]
            .filter((c) => c.State.Running)
            .map((c) => ({ Labels: c.Config.Labels })),
        );
      if ((m = path.match(/^\/containers\/([^/]+)\/exec$/)))
        return json({ Id: "e1" }, 201);
      if (path === "/exec/e1/start") {
        const out = new TextEncoder().encode("t".repeat(43));
        const frame = new Uint8Array(8 + out.length);
        frame[0] = 1;
        new DataView(frame.buffer).setUint32(4, out.length);
        frame.set(out, 8);
        return new Response(frame, { headers: { connection: "close" } });
      }
      if (path === "/exec/e1/json") return json({ ExitCode: 0 });
      return json({ message: `fake engine: ${req.method} ${path}` }, 500);
    },
  });
  return { server, calls, containers, networks, self, egress };
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
    expect(Object.keys(net.Containers).sort()).toEqual(
      [engine.egress.Id, engine.self.Id].sort(),
    );
    const c = engine.containers.get(`tandem-rt-${KEY}`);
    expect(c.HostConfig.NetworkMode).toBe(`tandem-net-${KEY}`);
    expect(c.HostConfig.Runtime).toBe("runsc");
    const gatewayIp = net.Containers[engine.self.Id].IPv4Address.split("/")[0];
    expect(c.Config.Labels["tandem.bridge-allow"]).toBe(`${gatewayIp}/32`);
    const egressIp = net.Containers[engine.egress.Id].IPv4Address.split("/")[0];
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

  test("a network left by a runtime stopped outside the gateway is swept; the runtime is recreated on its next start", async () => {
    const engine = fakeEngine({});
    const { rt } = controller(engine);
    await rt.ensure(KEY);
    engine.containers.get(`tandem-rt-${KEY}`).State = { Running: false }; // docker stop
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
    expect(c.Config.Env).toContain(
      `MCP_PROXY_URL=http://${gatewayIp}:8790/mcp/${KEY}`,
    );
    expect(await rt.address(KEY)).toBe(
      c.NetworkSettings.Networks["tandem-runtimes"].IPAddress,
    );
  });

  test("the controller's own exec runs as the runtime user and is allowlisted for the socket proxy", async () => {
    const engine = fakeEngine({});
    const { rt } = controller(engine);
    await rt.ensure(KEY);
    const execs = engine.calls
      .filter((c) => /^\/containers\/[^/]+\/exec$/.test(c.path))
      .map((c) => c.body);
    expect(execs.length).toBeGreaterThan(0);
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
  });
});
