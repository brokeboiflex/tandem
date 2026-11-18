// Runtime controller: one private container + named volume per person, behind a small interface
// so a Kubernetes implementation can replace the Docker one.
import { createHmac } from "node:crypto";
import { hostname } from "node:os";
import type { Config } from "./config";
import { DockerError, dockerClient, type ExecResult } from "./docker";
import {
  chooseAddresses,
  chooseOciRuntime,
  dockerApiAccess,
  inCidr,
  isAddressPoolExhausted,
  ISOLATED_GATEWAY,
  peerAddresses,
  pinPlan,
  reservedAddresses,
  runtimeContainerSpec,
  runtimeNetworkSpec,
  type LaunchValues,
  type Peer,
  type PeerAddresses,
  type Posture,
} from "./security";

export const BRIDGE_PORT = 24790;
const TOKEN_PATH = "/home/agent/.happy/agent/token";
/**
 * The settings that name a runtime's peers, read inside the runtime: a Docker API proxy redacts
 * container environments (deploy/sockguard.yaml allowlists this exact command).
 */
export const LAUNCH_VALUES_COMMAND = [
  "sh",
  "-c",
  'echo "$HAPPY_BRIDGE_ALLOW" "$MCP_PROXY_URL" "$HTTPS_PROXY"',
];
/**
 * The daemon's runs and sign-ins, asked over its own socket inside the runtime: this answers also
 * when the gateway cannot reach the runtime's bridge. Read-only; the token goes through a shell
 * builtin to curl's standard input, never into a process's arguments.
 */
export const ACTIVITY_COMMAND = [
  "sh",
  "-c",
  't=$(cat /home/agent/.happy/agent/token) && for p in projects/chats provider-clis/claude provider-clis/codex provider-clis/grok; do echo "authorization: Bearer $t" | curl -sf -m 10 -H @- --unix-socket /home/agent/.happy/agent/server.sock "http://runtime/v0/$p" && echo || exit 1; done',
];

/**
 * Claude Code's names for its models ("Opus 5.5" for the `opus` alias), read from the person's own
 * signed-in Claude Code through its stream-json `initialize` request: no turn, nothing sent to a
 * model. Happy's catalog names only the aliases ("Claude Code · Opus").
 */
export const CLAUDE_MODELS_COMMAND = [
  "sh",
  "-c",
  `cd /tmp && echo '{"type":"control_request","request_id":"models","request":{"subtype":"initialize"}}' | timeout 20 claude -p --input-format stream-json --output-format stream-json --verbose 2>/dev/null | grep -m 1 '"control_response"'`,
];

/**
 * Whether Google accepts the person's Gemini API key: its free model list, asked from inside the
 * runtime through the egress proxy. The key goes from its file to curl's standard input through a
 * shell builtin, never into a process's arguments. (Happy's provider check cannot vouch for the
 * Antigravity account on an API key: it looks for Antigravity's own sign-in.)
 */
export const GEMINI_KEY_COMMAND = [
  "sh",
  "-c",
  'k=$(cat /home/agent/.agent-runtime/gemini-api-key) && echo "x-goog-api-key: $k" | curl -sf -m 15 -o /dev/null -H @- "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1"',
];

/** A running runtime as the gateway sees it. `token` is the daemon's owner token: memory only. */
export type RuntimeHandle = {
  key: string;
  url: string;
  token: string;
  startedAt: number;
};

/**
 * A running runtime was created with gateway or egress proxy addresses on its network that cannot
 * be restored (another container holds them, or the Engine refuses fixed addresses), so it cannot
 * reach the gateway or the Internet. It works again only once restarted.
 */
export class StaleRuntime extends Error {}

export interface Runtime {
  /**
   * Creates and starts the runtime when needed; resolves once its daemon token is readable.
   * Rejects with StaleRuntime for a running runtime that must be restarted to be reachable.
   */
  ensure(key: string): Promise<RuntimeHandle>;
  stop(key: string): Promise<void>;
  restart(key: string): Promise<RuntimeHandle>;
  /** Keys of runtimes that are running now (rediscovery after a gateway restart). */
  listRunning(): Promise<string[]>;
  /** The running runtime's own address on the private network: MCP proxy requests come from it. */
  address(key: string): Promise<string | null>;
  exec(key: string, cmd: string[]): Promise<ExecResult>;
  /** Writes one owner-only file into the runtime's home volume without argv or environment. */
  writePrivateFile(
    key: string,
    dir: string,
    name: string,
    content: string,
  ): Promise<void>;
  /**
   * The daemon's project (GET /v0/projects/chats) and provider CLIs, read inside the runtime, also
   * when its bridge is unreachable. Null when the daemon does not answer.
   */
  activity?(key: string): Promise<{ project: any; clis: any[] } | null>;
  /** Which protections this host provides (detected once). */
  posture?(): Promise<Posture>;
  /** Housekeeping on the idle sweep: releases private networks of runtimes that stopped. */
  sweep?(): Promise<void>;
  /** True for a source address inside a runtime network (a runtime talking to the gateway). */
  isRuntimeAddress?(ip: string): boolean;
}

/** Deterministic, non-reversible runtime identity for a person. */
export function runtimeKey(secret: string, subject: string) {
  return createHmac("sha256", secret)
    .update(`subject:${subject}`)
    .digest("hex")
    .slice(0, 24);
}

/** Detected once per gateway process. */
type Setup = {
  posture: Posture;
  /** The gateway's own container (null when BRIDGE_ALLOW pins an address outside Docker). */
  self: { id: string; name: string } | null;
  /** The egress proxy's container name (attached by name, so a recreated one is found again). */
  egress: { host: string } | null;
};

const ipv4Config = (n: any) =>
  (n?.IPAM?.Config ?? []).find((c: any) => /^\d+\.\d+\.\d+\.\d+\//.test(c?.Subnet ?? ""));

export class DockerRuntime implements Runtime {
  private docker;
  private tokens = new Map<string, string>();
  private volumeOverrides = new Map<string, string>();
  private ready?: Promise<Setup>;
  /** Keys with an ensure() in flight: the sweep leaves their networks alone. */
  private busy = new Map<string, number>();
  private subnets = new Set<string>();
  private warned = new Set<string>();
  /** False once the Engine refused isolated gateway mode (Docker Engine before 28). */
  private isolatedGateway = true;
  /** Changes to one network's members, one at a time. */
  private queues = new Map<string, Promise<void>>();
  /** What each runtime container was created with (by container ID): it never changes. */
  private launched = new Map<string, LaunchValues>();

  constructor(
    private cfg: Config,
    private log: (...args: unknown[]) => void = console.log,
  ) {
    this.docker = dockerClient(cfg.dockerHost);
    for (const [subject, volume] of cfg.devVolumeOverrides)
      this.volumeOverrides.set(runtimeKey(cfg.serviceSecret, subject), volume);
  }

  private label = (name: string) => `${this.cfg.runtimePrefix}.${name}`;
  private container = (key: string) => `${this.cfg.runtimePrefix}-rt-${key}`;
  private volume = (key: string) =>
    this.volumeOverrides.get(key) ?? `${this.cfg.runtimePrefix}-home-${key}`;
  /** Each runtime gets its own network shared only with the gateway and the egress proxy. */
  private ownNetwork = (key: string) => `${this.cfg.runtimePrefix}-net-${key}`;

  private async inspect(key: string): Promise<any | null> {
    return this.get(`/containers/${this.container(key)}/json`);
  }

  private async get(path: string): Promise<any | null> {
    try {
      return await this.docker.json("GET", path);
    } catch (e) {
      if (e instanceof DockerError && e.status === 404) return null;
      throw e;
    }
  }

  private warnOnce(message: string) {
    if (this.warned.has(message)) return;
    this.warned.add(message);
    this.log(`WARNING: ${message}`);
  }

  posture() {
    return this.setup().then((s) => s.posture);
  }

  /** Detects what this Docker Engine offers and finds the gateway's and egress proxy's containers. */
  private setup(): Promise<Setup> {
    return (this.ready ??= (async () => {
      const cfg = this.cfg;
      const warnings: string[] = [];
      const info = await this.docker.json("GET", "/info");
      const oci = chooseOciRuntime(
        cfg.runtimeOciRuntime,
        Object.keys(info?.Runtimes ?? {}),
        info?.DefaultRuntime || "runc",
      );
      if (oci.warning) warnings.push(oci.warning);

      const plugins = await this.docker
        .raw("GET", "/plugins")
        .then((r) => r.status)
        .catch((e) => (e instanceof DockerError ? e.status : 0));
      const dockerApi = dockerApiAccess(plugins);
      if (dockerApi === "unrestricted" && cfg.runtimeDockerProxy === "required")
        throw new Error(
          "RUNTIME_DOCKER_PROXY=required, but RUNTIME_DOCKER_HOST answers every Docker API call: put the socket proxy in front (compose.socket-proxy.yaml)",
        );
      if (dockerApi === "unrestricted" && cfg.runtimeDockerProxy === "auto")
        warnings.push(
          "The gateway has unrestricted Docker API access, which is root on this host. Use the socket proxy (compose.socket-proxy.yaml, README) or set RUNTIME_DOCKER_PROXY=none to accept this.",
        );

      // The gateway attaches itself to every runtime network, so it has to be a container here.
      const me = await this.get(`/containers/${hostname()}/json`);
      const self: Setup["self"] = me
        ? { id: me.Id, name: String(me.Name ?? "").replace(/^\//, "") }
        : null;
      if (!self && !cfg.bridgeAllow)
        throw new Error(
          "the gateway is not running in a Docker container of this Engine; set BRIDGE_ALLOW",
        );
      let network: Posture["network"] =
        cfg.networkIsolation === "shared" ? "shared" : "per_runtime";
      if (!self && network === "per_runtime") {
        network = "shared";
        warnings.push(
          `The gateway runs outside Docker (BRIDGE_ALLOW), so runtimes share ${cfg.runtimeNetwork} and can reach each other. Run the gateway in a container for one network per runtime.`,
        );
      }

      let egress: Posture["egress"] =
        cfg.egressMode === "auto" ? "allowlist" : cfg.egressMode;
      let egressContainer: Setup["egress"] = null;
      if (egress !== "off") {
        const host = cfg.egressProxy.split(":")[0]!;
        const c = await this.get(`/containers/${host}/json`);
        if (c?.State?.Running) egressContainer = { host };
        else if (cfg.egressMode === "auto") {
          egress = "off";
          warnings.push(
            `The egress proxy (${host}) is not running, so runtimes get direct Internet access. Start it (compose.yaml) or set EGRESS_MODE=off to accept this.`,
          );
        } else
          throw new Error(
            `EGRESS_MODE=${cfg.egressMode}, but the egress proxy container ${host} is not running`,
          );
      }

      const posture: Posture = {
        ociRuntime: oci.runtime,
        sandbox: oci.sandbox,
        dockerApi,
        egress,
        network,
        warnings,
      };
      return { posture, self, egress: egressContainer };
    })().catch((e) => {
      this.ready = undefined; // a Docker hiccup at boot must not stick
      throw e;
    }));
  }

  /** Runs changes to one network's members one at a time (pins and removals). */
  private serial<T>(network: string, job: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(network) ?? Promise.resolve()).then(job, job);
    const tail = run.then(
      () => {},
      () => {},
    );
    this.queues.set(network, tail);
    void tail.then(() => {
      if (this.queues.get(network) === tail) this.queues.delete(network);
    });
    return run;
  }

  /**
   * Puts the gateway and the egress proxy (by name: it may have been recreated) on a runtime network
   * at their addresses: those its running runtimes were created with, or the reserved ones on a
   * network nobody runs on yet. Either one somewhere else, for example a recreated egress proxy that
   * Docker gave the gateway's old address, leaves and joins again at its own. Resolves to the
   * network as it is afterwards.
   */
  private pin(network: string, s: Setup): Promise<any> {
    return this.serial(network, () => this.pinNow(network, s));
  }

  private async pinNow(network: string, s: Setup) {
    const n = await this.docker.json("GET", `/networks/${network}`);
    const config = ipv4Config(n);
    const refs: [Peer, string, (id: string, m: any) => boolean][] = [];
    if (s.self) refs.push(["gateway", s.self.id, (id) => id === s.self!.id]);
    if (s.egress)
      refs.push(["egress", s.egress.host, (_, m) => m.Name === s.egress!.host]);
    const members = Object.entries<any>(n?.Containers ?? {}).map(([id, m]) => ({
      id,
      name: String(m.Name ?? ""),
      ip: String(m.IPv4Address ?? "").split("/")[0]!,
      peer: refs.find(([, , is]) => is(id, m))?.[0],
    }));
    let want: PeerAddresses = {};
    if (config?.Subnet) {
      const current: PeerAddresses = {};
      for (const m of members) if (m.peer) current[m.peer] = m.ip;
      const launched = await Promise.all(
        members
          .filter(
            (m) => !m.peer && m.name.startsWith(`${this.cfg.runtimePrefix}-rt-`),
          )
          .map((m) => this.launchValues(m.id)),
      );
      const expected = launched
        .filter((v): v is LaunchValues => !!v)
        .map((v) => peerAddresses(v, config.Subnet));
      const unknown = expected.length < launched.length;
      want = chooseAddresses(
        current,
        expected,
        reservedAddresses(config.Subnet, config.Gateway ? [config.Gateway] : []),
      );
      // A runtime whose settings could not be read may depend on where a peer is now: move nothing.
      if (unknown) Object.assign(want, current);
    }
    const plan = pinPlan(
      members,
      refs.map(([peer]) => peer),
      want,
    );
    for (const peer of plan.blocked)
      this.warnOnce(
        `The ${peer} cannot take its address ${want[peer]} on ${network}: another container holds it. Runtimes there that expect it are restarted once idle.`,
      );
    if (!plan.disconnect.length && !plan.connect.length) return n;
    const ref = (peer: Peer) => refs.find(([p]) => p === peer)![1];
    for (const peer of plan.disconnect)
      await this.docker
        .json("POST", `/networks/${network}/disconnect`, { Container: ref(peer) })
        .catch((e) => {
          if (!(e instanceof DockerError && /not connected/i.test(e.message)))
            throw e;
        });
    for (const { peer, ip } of plan.connect) {
      await this.connect(network, ref(peer), ip);
      const was = members.find((m) => m.peer === peer)?.ip;
      if (was)
        this.log(`${peer} moved on ${network}: ${was} -> ${ip ?? "any"}`);
    }
    return this.docker.json("GET", `/networks/${network}`);
  }

  /** Joins a network at `ip`; where Docker puts it when the Engine (or its API proxy) refuses that. */
  private async connect(network: string, container: string, ip?: string) {
    const join = (endpoint?: object) =>
      this.docker
        .json("POST", `/networks/${network}/connect`, {
          Container: container,
          ...(endpoint ? { EndpointConfig: endpoint } : {}),
        })
        .catch((e) => {
          if (!(e instanceof DockerError && /already exists/i.test(e.message)))
            throw e;
        });
    if (!ip) return join();
    try {
      await join({ IPAMConfig: { IPv4Address: ip } });
    } catch (e) {
      if (!(e instanceof DockerError)) throw e;
      this.warnOnce(
        `Docker refused a fixed address on a runtime network (${e.message.slice(0, 160)}), so runtimes running while the gateway or the egress proxy is recreated may have to be restarted once idle (README, Operations).`,
      );
      await join();
    }
  }

  /** What a runtime container was created with, read once inside it; null while it cannot be read. */
  private async launchValues(id: string): Promise<LaunchValues | null> {
    const known = this.launched.get(id);
    if (known) return known;
    const r = await this.docker
      .exec(id, LAUNCH_VALUES_COMMAND, this.cfg.runtimeUser || "agent")
      .catch(() => null);
    if (r?.exitCode !== 0) return null;
    const [allow = "", mcpProxyUrl = "", httpsProxy = ""] = r.stdout
      .replace(/\n$/, "")
      .split(" ");
    const v = { allow, mcpProxyUrl, httpsProxy };
    this.launched.set(id, v);
    return v;
  }

  /**
   * Addresses on a runtime network: the gateway's (the only source the bridge port accepts) and
   * the egress proxy's. Runtimes get addresses, not names: Docker's embedded DNS does not answer
   * inside gVisor sandboxes.
   */
  private addressesOn(
    network: string,
    n: any,
    s: Setup,
  ): { allow: string; gateway?: string; egress?: string } {
    for (const c of n?.IPAM?.Config ?? []) {
      if (c?.Subnet) this.subnets.add(c.Subnet);
      if (c?.Gateway && n.Internal)
        this.warnOnce(
          `Runtime networks have a host-side address (${network}: ${c.Gateway}), so services on the Docker host that listen on all interfaces are reachable from runtimes. Docker Engine 28 or later removes it (isolated gateway mode).`,
        );
    }
    const ipOf = (match: (id: string, c: any) => boolean) => {
      for (const [id, c] of Object.entries<any>(n?.Containers ?? {}))
        if (match(id, c))
          return String(c.IPv4Address ?? "").split("/")[0] || undefined;
    };
    const egress = s.egress
      ? ipOf((_, c) => c.Name === s.egress!.host)
      : undefined;
    if (s.egress && !egress)
      throw new Error(`egress proxy is not attached to ${network}`);
    // Also with BRIDGE_ALLOW, a gateway in a container is the runtime's MCP proxy at this address.
    const gateway = s.self ? ipOf((id) => id === s.self!.id) : undefined;
    if (this.cfg.bridgeAllow || !s.self)
      return { allow: this.cfg.bridgeAllow, gateway, egress };
    if (!gateway) throw new Error(`gateway is not attached to ${network}`);
    return { allow: `${gateway}/32`, gateway, egress };
  }

  /**
   * Rejoins a running runtime's network where the runtime expects the gateway and the egress proxy
   * (after either was recreated). StaleRuntime when those addresses cannot be restored.
   */
  private async rejoin(c: any, s: Setup) {
    const network = c.HostConfig.NetworkMode;
    const n = await this.pin(network, s);
    const at = this.addressesOn(network, n, s);
    const subnet = ipv4Config(n)?.Subnet;
    const v = subnet ? await this.launchValues(c.Id) : null;
    const want = v ? peerAddresses(v, subnet) : {};
    const lost = (["gateway", "egress"] as const).filter(
      (peer) => want[peer] && want[peer] !== at[peer],
    );
    if (lost.length)
      throw new StaleRuntime(
        `${lost.join(" and ")} no longer at ${lost.map((p) => want[p]).join(", ")} on ${network}`,
      );
  }

  /** Creates (or reuses) the network a stopped runtime will start on; `fresh` when just created. */
  private async networkFor(
    key: string,
    s: Setup,
  ): Promise<{ name: string; fresh: boolean; n: any }> {
    const own = s.posture.network === "per_runtime";
    const name = own ? this.ownNetwork(key) : this.cfg.runtimeNetwork;
    const spec = runtimeNetworkSpec(
      this.cfg,
      name,
      s.posture.egress,
      own ? key : undefined,
      this.isolatedGateway,
    );
    let fresh = true;
    try {
      await this.docker.json("POST", "/networks/create", spec);
    } catch (e) {
      if (!(e instanceof DockerError)) throw e;
      if (
        e.status === 400 &&
        /gateway.?mode/i.test(e.message) &&
        this.isolatedGateway
      ) {
        this.isolatedGateway = false; // an older Engine: addressesOn() warns about the host address
        return this.networkFor(key, s);
      }
      if (e.status === 409) {
        fresh = false;
        const existing = await this.get(`/networks/${name}`);
        // A network from another egress mode or an older Tandem: recreate a private one; report a
        // shared one.
        const wanted = (spec as { Options?: Record<string, string> }).Options?.[
          ISOLATED_GATEWAY
        ];
        if (
          existing &&
          (existing.Internal !== spec.Internal ||
            (wanted && existing.Options?.[ISOLATED_GATEWAY] !== wanted))
        ) {
          if (own) {
            await this.removeNetwork(name, s);
            return this.networkFor(key, s);
          }
          this.warnOnce(
            `${name} was created with other settings (Internal=${existing.Internal}); remove it once no runtime uses it`,
          );
        }
      } else if (
        own &&
        this.cfg.networkIsolation === "auto" &&
        isAddressPoolExhausted(e.message)
      ) {
        this.warnOnce(
          `Docker has no free address pool for another runtime network; runtimes now share ${this.cfg.runtimeNetwork} (they can reach each other). Enlarge default-address-pools (README) or set RUNTIME_NETWORK_ISOLATION=shared.`,
        );
        const shared = this.cfg.runtimeNetwork;
        await this.docker
          .json(
            "POST",
            "/networks/create",
            runtimeNetworkSpec(
              this.cfg,
              shared,
              s.posture.egress,
              undefined,
              this.isolatedGateway,
            ),
          )
          .catch((e2) => {
            if (!(e2 instanceof DockerError && e2.status === 409)) throw e2;
          });
        return { name: shared, fresh: false, n: await this.pin(shared, s) };
      } else throw e;
    }
    return { name, fresh, n: await this.pin(name, s) };
  }

  private removeNetwork(name: string, s: Setup) {
    return this.serial(name, async () => {
      for (const id of [s.egress?.host, s.self?.id])
        if (id)
          await this.docker
            .json("POST", `/networks/${name}/disconnect`, { Container: id })
            .catch(() => {});
      await this.docker.raw("DELETE", `/networks/${name}`).catch((e) => {
        if (!(e instanceof DockerError && e.status === 404)) throw e;
      });
    });
  }

  /**
   * Where a runtime reaches the gateway's MCP proxy: MCP_PROXY_URL, or the gateway's address on that
   * runtime's own network (an address, not a name: Docker's DNS does not answer inside gVisor; and in
   * NO_PROXY, so it bypasses the egress proxy). Empty (no MCP servers in the runtime) without either.
   */
  private mcpProxyUrl(key: string, gateway?: string) {
    const base =
      this.cfg.mcpProxyUrl ||
      (gateway ? `http://${gateway}:${this.cfg.mcpProxyPort}` : "");
    return base ? `${base}/mcp/${key}` : "";
  }

  async ensure(key: string): Promise<RuntimeHandle> {
    this.busy.set(key, (this.busy.get(key) ?? 0) + 1);
    try {
      return await this.ensureNow(key);
    } finally {
      const n = (this.busy.get(key) ?? 1) - 1;
      if (n) this.busy.set(key, n);
      else this.busy.delete(key);
    }
  }

  private async ensureNow(key: string): Promise<RuntimeHandle> {
    const s = await this.setup();
    const volume = this.volume(key);
    let c = await this.inspect(key);
    if (c?.State?.Running) {
      // After a gateway restart: rejoin the runtime's network so it is reachable again.
      await this.rejoin(c, s);
      return this.handle(key);
    }
    const image = await this.docker.json(
      "GET",
      `/images/${encodeURIComponent(this.cfg.runtimeImage)}/json`,
    );
    const network = await this.networkFor(key, s);
    const at = this.addressesOn(network.name, network.n, s);
    const spec = runtimeContainerSpec(this.cfg, {
      key,
      volume,
      network: network.name,
      allow: at.allow,
      ociRuntime: s.posture.ociRuntime,
      egress: s.posture.egress,
      egressProxy: `${at.egress}:${this.cfg.egressProxy.split(":")[1]}`,
      // Runtimes reach the gateway (and its MCP proxy) directly, never through the egress proxy.
      directHosts: [
        s.self?.name,
        at.gateway,
        this.cfg.mcpProxyUrl && new URL(this.cfg.mcpProxyUrl).hostname,
      ].filter((h): h is string => !!h),
      imageId: image.Id,
      devVolumeOverride: this.volumeOverrides.has(key),
      mcpProxyUrl: this.mcpProxyUrl(key, at.gateway),
    });
    // A stopped runtime is recreated whenever anything in its spec changed (image, settings, the
    // gateway's address, a network that was recreated). Running work is never cut off.
    const stale =
      c &&
      (c.Image !== image.Id ||
        network.fresh ||
        c.Config.Labels?.[this.label("spec")] !==
          spec.Labels[this.label("spec")]);
    if (stale) {
      await this.docker.raw("DELETE", `/containers/${this.container(key)}`);
      c = null;
    }
    if (!c) {
      if (this.volumeOverrides.has(key))
        await this.docker.json("GET", `/volumes/${volume}`); // dev override must already exist
      else
        await this.docker.json("POST", "/volumes/create", {
          Name: volume,
          Labels: { [this.label("home")]: "1", [this.label("key")]: key },
        });
      await this.create(key, spec);
    }
    await this.docker.raw("POST", `/containers/${this.container(key)}/start`);
    return this.handle(key);
  }

  private async create(key: string, spec: object) {
    const q = new URLSearchParams({ name: this.container(key) });
    // Empty means the Engine's own platform; otherwise run that platform's image variant.
    if (this.cfg.runtimePlatform) q.set("platform", this.cfg.runtimePlatform);
    try {
      await this.docker.json("POST", `/containers/create?${q}`, spec);
    } catch (e) {
      if (!(e instanceof DockerError && e.status === 409)) throw e; // created concurrently
    }
  }

  private async handle(key: string): Promise<RuntimeHandle> {
    const c = await this.inspect(key);
    if (!c?.State?.Running) throw new Error("runtime is not running");
    return {
      key,
      url: `http://${this.container(key)}:${BRIDGE_PORT}`,
      token: await this.token(key),
      startedAt: Date.parse(c.State.StartedAt),
    };
  }

  /** Reads the daemon token once per runtime through the exec API; kept only in memory. */
  private async token(key: string): Promise<string> {
    const cached = this.tokens.get(key);
    if (cached) return cached;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const r = await this.exec(key, ["cat", TOKEN_PATH]);
      const token = r.stdout.trim();
      if (r.exitCode === 0 && /^[A-Za-z0-9_-]{43}$/.test(token)) {
        this.tokens.set(key, token);
        return token;
      }
      await Bun.sleep(250); // a fresh volume gets its token on the daemon's first start
    }
    throw new Error("runtime daemon token did not appear");
  }

  /**
   * The runtime's address on its own network (per runtime, or the shared fallback), where its MCP
   * proxy requests come from. Read fresh on every call: a recreated runtime gets a new address.
   */
  async address(key: string) {
    const c = await this.inspect(key);
    const network = c?.HostConfig?.NetworkMode;
    return (
      (c?.State?.Running &&
        network &&
        c.NetworkSettings?.Networks?.[network]?.IPAddress) ||
      null
    );
  }

  async stop(key: string) {
    await this.docker.raw(
      "POST",
      `/containers/${this.container(key)}/stop?t=30`,
    );
    // A stopped runtime keeps nothing outside its volume: drop its container and private network
    // so idle people hold no network (address pools are limited). The next start recreates both.
    const s = await this.setup();
    const network = this.ownNetwork(key);
    const c = await this.inspect(key);
    if (c?.HostConfig?.NetworkMode !== network || c.State?.Running) return;
    await this.docker.raw("DELETE", `/containers/${this.container(key)}`);
    // Another container still on it keeps the network: the sweep removes it later.
    await this.removeNetwork(network, s).catch((e) =>
      this.log(`network kept for now: ${(e as Error).message}`),
    );
  }

  async restart(key: string) {
    // Restarting keeps the runtime's settings, so it cannot help one that lost its peers' addresses.
    const c = await this.inspect(key);
    if (c?.State?.Running) await this.rejoin(c, await this.setup());
    await this.docker.raw(
      "POST",
      `/containers/${this.container(key)}/restart?t=30`,
    );
    return this.handle(key);
  }

  private async running() {
    const filters = JSON.stringify({
      label: [`${this.label("runtime")}=1`],
      status: ["running"],
    });
    return this.docker.json<any[]>(
      "GET",
      `/containers/json?filters=${encodeURIComponent(filters)}`,
    );
  }

  async listRunning() {
    return (await this.running())
      .map((c) => c.Labels[this.label("key")])
      .filter(Boolean);
  }

  /**
   * Removes private networks whose runtime is not running (stopped outside the gateway), and puts the
   * gateway and the egress proxy back where the runtimes still running expect them.
   */
  async sweep() {
    const s = await this.setup();
    const filters = JSON.stringify({
      label: [`${this.label("runtime-network")}=1`],
    });
    const networks = await this.docker.json<any[]>(
      "GET",
      `/networks?filters=${encodeURIComponent(filters)}`,
    );
    const containers = await this.running();
    const running = new Set(
      containers.map((c) => c.Labels[this.label("key")]).filter(Boolean),
    );
    for (const id of this.launched.keys())
      if (!containers.some((c) => c.Id === id)) this.launched.delete(id);
    for (const n of networks) {
      const key = n.Labels?.[this.label("key")];
      if (key && !running.has(key) && !this.busy.has(key))
        await this.removeNetwork(n.Name, s).catch(() => {});
      // A recreated egress proxy (compose up) joins the networks still in use at its address.
      else await this.pin(n.Name, s).catch(() => {});
    }
  }

  isRuntimeAddress(ip: string) {
    for (const subnet of this.subnets) if (inCidr(ip, subnet)) return true;
    return false;
  }

  /** Always as the runtime's own user, named explicitly so a socket proxy can verify it. */
  exec(key: string, cmd: string[]) {
    return this.docker.exec(
      this.container(key),
      cmd,
      this.cfg.runtimeUser || "agent",
    );
  }

  async activity(key: string) {
    const r = await this.exec(key, ACTIVITY_COMMAND).catch(() => null);
    if (r?.exitCode !== 0) return null;
    try {
      const [project, ...clis] = r.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      return {
        project: project.project,
        clis: clis.map((c) => c.providerCli),
      };
    } catch {
      return null;
    }
  }

  writePrivateFile(key: string, dir: string, name: string, content: string) {
    return this.docker.putFile(this.container(key), dir, name, content);
  }
}
