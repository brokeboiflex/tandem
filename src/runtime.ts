// Runtime controller: one private container + named volume per person, behind a small interface
// so a Kubernetes implementation can replace the Docker one.
import { createHmac } from "node:crypto";
import { hostname } from "node:os";
import type { Config } from "./config";
import { DockerError, dockerClient, type ExecResult } from "./docker";

export const BRIDGE_PORT = 24790;
const TOKEN_PATH = "/home/agent/.happy/agent/token";

/** A running runtime as the gateway sees it. `token` is the daemon's owner token: memory only. */
export type RuntimeHandle = {
  key: string;
  url: string;
  token: string;
  startedAt: number;
};

export interface Runtime {
  /** Creates and starts the runtime when needed; resolves once its daemon token is readable. */
  ensure(key: string): Promise<RuntimeHandle>;
  stop(key: string): Promise<void>;
  restart(key: string): Promise<RuntimeHandle>;
  /** Keys of runtimes that are running now (rediscovery after a gateway restart). */
  listRunning(): Promise<string[]>;
  exec(key: string, cmd: string[]): Promise<ExecResult>;
  /** Writes one owner-only file into the runtime's home volume without argv or environment. */
  writePrivateFile(
    key: string,
    dir: string,
    name: string,
    content: string,
  ): Promise<void>;
}

/** Deterministic, non-reversible runtime identity for a person. */
export function runtimeKey(secret: string, subject: string) {
  return createHmac("sha256", secret)
    .update(`subject:${subject}`)
    .digest("hex")
    .slice(0, 24);
}

export class DockerRuntime implements Runtime {
  private docker;
  private tokens = new Map<string, string>();
  private bridgeAllow?: Promise<string>;
  private volumeOverrides = new Map<string, string>();

  constructor(private cfg: Config) {
    this.docker = dockerClient(cfg.dockerHost);
    for (const [subject, volume] of cfg.devVolumeOverrides)
      this.volumeOverrides.set(runtimeKey(cfg.serviceSecret, subject), volume);
  }

  private label = (name: string) => `${this.cfg.runtimePrefix}.${name}`;
  private container = (key: string) => `${this.cfg.runtimePrefix}-rt-${key}`;
  private volume = (key: string) =>
    this.volumeOverrides.get(key) ?? `${this.cfg.runtimePrefix}-home-${key}`;

  private async inspect(key: string): Promise<any | null> {
    try {
      return await this.docker.json(
        "GET",
        `/containers/${this.container(key)}/json`,
      );
    } catch (e) {
      if (e instanceof DockerError && e.status === 404) return null;
      throw e;
    }
  }

  /** Only the gateway's own address may reach a runtime's bridge port. */
  private allow() {
    return (this.bridgeAllow ??= (async () => {
      if (this.cfg.bridgeAllow) return this.cfg.bridgeAllow;
      const self = await this.docker.json(
        "GET",
        `/containers/${hostname()}/json`,
      );
      const ip =
        self?.NetworkSettings?.Networks?.[this.cfg.runtimeNetwork]?.IPAddress;
      if (!ip)
        throw new Error(
          `gateway is not attached to ${this.cfg.runtimeNetwork}; set BRIDGE_ALLOW`,
        );
      return `${ip}/32`;
    })());
  }

  async ensure(key: string): Promise<RuntimeHandle> {
    const allow = await this.allow();
    const volume = this.volume(key);
    let c = await this.inspect(key);
    const image = await this.docker.json(
      "GET",
      `/images/${encodeURIComponent(this.cfg.runtimeImage)}/json`,
    );
    const stale =
      c &&
      (c.Image !== image.Id ||
        c.Config.Labels?.[this.label("bridge-allow")] !== allow ||
        c.Config.Labels?.[this.label("volume")] !== volume ||
        (c.Config.Labels?.[this.label("platform")] ?? "") !== this.cfg.runtimePlatform);
    // A stale container is replaced only while stopped, so running work is never cut off.
    if (stale && !c.State.Running) {
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
      await this.create(key, volume, allow);
    }
    if (!c?.State?.Running)
      await this.docker.raw("POST", `/containers/${this.container(key)}/start`);
    return this.handle(key);
  }

  private async create(key: string, volume: string, allow: string) {
    const q = new URLSearchParams({ name: this.container(key) });
    // Empty means the Engine's own platform; otherwise run that platform's image variant.
    if (this.cfg.runtimePlatform) q.set("platform", this.cfg.runtimePlatform);
    try {
      await this.docker.json("POST", `/containers/create?${q}`, {
        Image: this.cfg.runtimeImage,
        Hostname: "runtime",
        Env: [`HAPPY_BRIDGE_ALLOW=${allow}`],
        Labels: {
          [this.label("runtime")]: "1",
          [this.label("key")]: key,
          [this.label("bridge-allow")]: allow,
          [this.label("volume")]: volume,
          [this.label("platform")]: this.cfg.runtimePlatform,
          ...(this.volumeOverrides.has(key)
            ? { [this.label("dev-volume-override")]: "1" }
            : {}),
        },
        StopTimeout: 30,
        HostConfig: {
          Init: true,
          CapDrop: ["ALL"],
          SecurityOpt: ["no-new-privileges"],
          // /tmp stays on the container's disk layer: Happy extracts its 341 MiB Claude Code binary
          // there, which a tmpfs would charge to memory on every running runtime.
          Mounts: [{ Type: "volume", Source: volume, Target: "/home/agent" }],
          NetworkMode: this.cfg.runtimeNetwork,
          Memory: this.cfg.runtimeMemoryMb * 1024 * 1024,
          NanoCpus: Math.round(this.cfg.runtimeCpus * 1e9),
          PidsLimit: this.cfg.runtimePids,
          RestartPolicy: { Name: "no" },
          // No PortBindings: runtimes are reachable only on the private network.
        },
      });
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
      const r = await this.docker.exec(this.container(key), [
        "cat",
        TOKEN_PATH,
      ]);
      const token = r.stdout.trim();
      if (r.exitCode === 0 && /^[A-Za-z0-9_-]{43}$/.test(token)) {
        this.tokens.set(key, token);
        return token;
      }
      await Bun.sleep(250); // a fresh volume gets its token on the daemon's first start
    }
    throw new Error("runtime daemon token did not appear");
  }

  async stop(key: string) {
    await this.docker.raw(
      "POST",
      `/containers/${this.container(key)}/stop?t=30`,
    );
  }

  async restart(key: string) {
    await this.docker.raw(
      "POST",
      `/containers/${this.container(key)}/restart?t=30`,
    );
    return this.handle(key);
  }

  async listRunning() {
    const filters = JSON.stringify({
      label: [`${this.label("runtime")}=1`],
      status: ["running"],
    });
    const list = await this.docker.json<any[]>(
      "GET",
      `/containers/json?filters=${encodeURIComponent(filters)}`,
    );
    return list.map((c) => c.Labels[this.label("key")]).filter(Boolean);
  }

  exec(key: string, cmd: string[]) {
    return this.docker.exec(this.container(key), cmd);
  }

  writePrivateFile(key: string, dir: string, name: string, content: string) {
    return this.docker.putFile(this.container(key), dir, name, content);
  }
}
