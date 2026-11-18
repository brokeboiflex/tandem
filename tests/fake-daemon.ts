// A small stateful stand-in for one person's Happy Agent daemon, served over real HTTP, plus a fake
// Runtime that hands the gateway one such daemon per runtime key. Shapes follow tests/fixtures.
import { readFileSync } from "node:fs";
import {
  CLAUDE_MODELS_COMMAND,
  StaleRuntime,
  type Runtime,
  type RuntimeHandle,
} from "../src/runtime";

const config = (
  await Bun.file(`${import.meta.dir}/fixtures/config-signed-out.json`).json()
).config;
const OPENING = [
  "Opening browser to sign in…",
  "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?<redacted>",
];
export const GOOD_CODE_PREFIX = "goodcode";

export function fakeDaemon(token: string) {
  const requests: { method: string; path: string; body: string }[] = [];
  const streams = new Set<ReadableStreamDefaultController>();
  const agents = new Map<string, any>();
  const drafts = new Map<string, any>();
  let project: any = null;
  let bots = [
    {
      id: "chiefofstaff",
      status: "active",
      version: "v1",
      systemKey: "chief_of_staff",
    },
  ];
  const clis: Record<string, any> = {
    claude: {
      id: "claude",
      installation: { status: "installed" },
      signIn: { status: "signed_out", account: null, methods: ["browser"] },
      operation: null,
    },
    codex: {
      id: "codex",
      installation: { status: "installed" },
      signIn: {
        status: "signed_out",
        account: null,
        methods: ["browser", "device"],
      },
      operation: null,
    },
  };
  let opSeq = 0;
  const json = (data: unknown, status = 200) => Response.json(data, { status });

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const body = req.method === "GET" ? "" : await req.text();
      requests.push({ method: req.method, path: path + url.search, body });
      if (req.headers.get("authorization") !== `Bearer ${token}`)
        return json({ code: "unauthorized" }, 401);
      const data = body ? JSON.parse(body) : {};
      let m: RegExpMatchArray | null;
      if (path === "/v0/health") return json({ ready: true });
      if (path === "/v0/config") return json({ config });
      if (path === "/v0/bots") return json({ bots });
      if ((m = path.match(/^\/v0\/bots\/(\w+)\/archive$/))) {
        if (req.headers.get("if-match") !== "v1")
          return json({ code: "conflict" }, 409);
        bots = bots.map((b) =>
          b.id === m![1] ? { ...b, status: "archived" } : b,
        );
        return json({ bot: bots[0] });
      }
      if (path === "/v0/projects" && req.method === "POST") {
        project = {
          id: "chats",
          initialization: { status: "ready" },
          agents: [],
        };
        return json({ project });
      }
      if (path === "/v0/projects/chats")
        return project
          ? json({ project: { ...project, agents: [...agents.values()] } })
          : json({ code: "not_found" }, 404);
      if ((m = path.match(/^\/v0\/provider-clis\/(claude|codex)$/)))
        return json({ providerCli: clis[m[1]!] });
      if ((m = path.match(/^\/v0\/provider-clis\/(claude|codex)\/sign-in$/))) {
        const id = m[1]!;
        clis[id].operation = {
          id: `op${++opSeq}`,
          kind: "sign_in",
          status: "waiting",
          output: id === "claude" ? [...OPENING] : ["device code shown"],
          error: null,
          authorization:
            id === "claude"
              ? {
                  method: "browser",
                  url: `https://claude.com/cai/oauth/authorize?attempt=${opSeq}`,
                  userCode: null,
                  openedByProgram: true,
                  acceptsCode: true,
                  expiresAt: Date.now() + 600_000,
                }
              : {
                  method: "device",
                  url: "https://auth.openai.com/codex/device",
                  userCode: "ABCD-12345",
                  openedByProgram: false,
                  acceptsCode: false,
                  expiresAt: Date.now() + 600_000,
                },
        };
        return json({ providerCli: clis[id] });
      }
      if (
        (m = path.match(/^\/v0\/provider-clis\/(claude|codex)\/sign-in\/code$/))
      ) {
        const op = clis[m[1]!].operation;
        if (data.code.startsWith(GOOD_CODE_PREFIX)) {
          Object.assign(op, {
            status: "succeeded",
            finishedAt: Date.now(),
            authorization: null,
          });
          clis[m[1]!].signIn = {
            status: "signed_in",
            account: { email: "user@example.com", plan: "Max" },
            methods: ["browser"],
          };
        } else if (data.code.includes("#")) {
          op.output.push(
            "Login failed: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.",
          );
          Object.assign(op, {
            status: "failed",
            error: { code: "sign_in_failed", message: "x" },
            authorization: null,
          });
        } else
          op.output.push(
            "Invalid code. Please make sure the full code was copied.",
          );
        if (data.code.includes("echo"))
          return json({ code: "internal", error: `bad ${data.code}` }, 500); // a misbehaving daemon
        return json({ providerCli: clis[m[1]!] });
      }
      if ((m = path.match(/^\/v0\/provider-clis\/(claude|codex)\/cancel$/))) {
        const op = clis[m[1]!].operation;
        if (op && ["running", "waiting"].includes(op.status))
          Object.assign(op, { status: "cancelled", authorization: null });
        return json({ providerCli: clis[m[1]!] });
      }
      if (path === "/v0/providers/claude/verify")
        return json({ status: "failed", performedLevel: "inference" });
      if (path === "/v0/agents" && req.method === "POST") {
        const agent = {
          id: data.id,
          workspaceId: data.workspaceId,
          parentAgentId: null,
          title: data.title ?? null,
          status: "idle",
          pendingQuestionId: null,
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
          archivedAt: null,
        };
        agents.set(agent.id, agent);
        return json({ agent }, 201);
      }
      if ((m = path.match(/^\/v0\/agents\/(\w+)(?:\/(\w+))?$/))) {
        const agent = agents.get(m[1]!);
        if (!agent) return json({ code: "not_found" }, 404);
        const sub = m[2];
        if (!sub) return json({ agent });
        if (sub === "draft" && req.method === "PUT")
          drafts.set(agent.id, data.draft);
        if (sub === "draft")
          return json({
            draft: { value: drafts.get(agent.id) ?? null, updatedAt: 1 },
          });
        if (sub === "mode") return json({ mode: agent.mode ?? null });
        if (sub === "question") return json({ question: null });
        if (sub === "usage")
          return json({ context: agent.context ?? null, usage: agent.usage ?? {} });
        if (sub === "messages")
          return json({ runs: agent.runs ?? [], hasMore: false, cursor: "c" });
        if (sub === "abort") return json({ agent }, 202);
        if (sub === "archive") {
          agent.archivedAt = Date.now();
          return json({ agent });
        }
        if (sub === "send") {
          agent.mode = data.mode;
          // The turn's measurement, as Happy records it after an inference.
          const { providerId, modelId } = data.mode;
          agent.context = {
            approximate: false,
            contextTokens: 1200,
            contextWindow: config.models[modelId]?.contextWindow ?? null,
            providerId,
            modelId,
          };
          agent.usage = {
            [providerId]: {
              [modelId]: { input: 1100, output: 100, cacheRead: 900, cacheWrite: 50 },
            },
          };
          const message = {
            id: data.id,
            role: "user",
            createdAt: Date.now(),
            content: [{ type: "text", text: data.text }],
            metadata: {},
            status: "pending",
            mode: data.mode,
          };
          agent.lastActivityAt = Date.now();
          agent.runs = [
            ...(agent.runs ?? []),
            {
              id: data.id,
              status: "completed",
              reason: "completed",
              messages: [
                message,
                {
                  id: `${data.id}a`,
                  role: "agent",
                  createdAt: Date.now(),
                  content: [{ type: "text", text: "pong" }],
                  metadata: {},
                },
              ],
            },
          ];
          return json({ message, cursor: "c" }, 202);
        }
      }
      if (path === "/v0/events/stream")
        return new Response(
          new ReadableStream({
            start: (c) => {
              streams.add(c);
              c.enqueue(
                new TextEncoder().encode(
                  'event: hello\ndata: {"cursor":"c0"}\n\n',
                ),
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      return json({ code: "not_found" }, 404);
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    clis,
    agents,
    /** Pushes one journal event to every open event stream. */
    push(type: string, payload: unknown) {
      const frame = `id: ${crypto.randomUUID()}\nevent: ${type}\ndata: ${JSON.stringify({ cursor: "c", type, payload })}\n\n`;
      for (const c of streams)
        try {
          c.enqueue(new TextEncoder().encode(frame));
        } catch {
          streams.delete(c); // that stream was closed by the gateway
        }
    },
    stop: () => server.stop(true),
  };
}

export type FakeDaemon = ReturnType<typeof fakeDaemon>;

/** deploy/sockguard.yaml: the exec commands and archive folders the socket proxy lets through. */
export async function socketProxyPolicy() {
  const policy = Bun.YAML.parse(
    await Bun.file(new URL("../deploy/sockguard.yaml", import.meta.url)).text(),
  ) as any;
  return {
    commands: new Set<string>(
      policy.request_body.exec.allowed_commands.map((c: string[]) =>
        JSON.stringify(c),
      ),
    ),
    paths: policy.request_body.container_archive.allowed_paths as string[],
  };
}

export class FakeRuntime implements Runtime {
  daemons = new Map<string, FakeDaemon>();
  calls: string[] = [];
  /** Every command run inside a runtime, in full (checked against the socket proxy's policy). */
  execs: string[][] = [];
  files: { key: string; dir: string; name: string; content: string }[] = [];
  /** The volume as the runtime would see it: "<key>:<path>" -> content. */
  volume = new Map<string, string>();
  /** Claude Code's answer to CLAUDE_MODELS_COMMAND (a recorded one). */
  claudeInitialize = readFileSync(new URL("./fixtures/claude-initialize.json", import.meta.url), "utf8");
  /** When set, every `cat` ends with this exit code, as if killed by a restart. */
  failReads?: number;
  /** Source address a runtime's requests come from; tests change it to play a neighbour. */
  addresses = new Map<string, string>();
  /** How long starting a runtime takes (a real one takes a second or more). */
  startDelayMs = 0;
  /** Running runtimes that lost their network addresses: unreachable until stopped. */
  stale = new Set<string>();
  /** What a runtime's daemon reports from inside (activity), by key. */
  agents = new Map<string, any[]>();
  private token = "t".repeat(43);

  private handle(key: string): RuntimeHandle {
    let d = this.daemons.get(key);
    if (!d) this.daemons.set(key, (d = fakeDaemon(this.token)));
    return { key, url: d.url, token: this.token, startedAt: Date.now() };
  }
  async ensure(key: string) {
    this.calls.push(`ensure ${key}`);
    await Bun.sleep(this.startDelayMs);
    if (this.stale.has(key))
      throw new StaleRuntime("gateway no longer at 172.30.0.1");
    return this.handle(key);
  }
  async restart(key: string) {
    this.calls.push(`restart ${key}`);
    if (this.stale.has(key))
      throw new StaleRuntime("gateway no longer at 172.30.0.1");
    return this.handle(key);
  }
  async stop(key: string) {
    this.calls.push(`stop ${key}`);
    this.stale.delete(key);
  }
  async activity(key: string) {
    this.calls.push(`activity ${key}`);
    return { project: { agents: this.agents.get(key) ?? [] }, clis: [] };
  }
  async listRunning() {
    return [];
  }
  async exec(key: string, cmd: string[]) {
    const models = JSON.stringify(cmd) === JSON.stringify(CLAUDE_MODELS_COMMAND);
    this.calls.push(`exec ${key} ${models ? "claude-models" : cmd[0]}`);
    this.execs.push([...cmd]);
    if (cmd[0] === "cat" && this.failReads)
      return { exitCode: this.failReads, stdout: "" };
    if (cmd[0] === "cat") {
      const content = this.volume.get(`${key}:${cmd[1]}`);
      return { exitCode: content === undefined ? 1 : 0, stdout: content ?? "" };
    }
    if (cmd[0] === "rm")
      for (const path of cmd.slice(1)) this.volume.delete(`${key}:${path}`);
    if (models) return { exitCode: 0, stdout: this.claudeInitialize };
    return { exitCode: 0, stdout: "" };
  }
  async address(key: string) {
    return this.daemons.has(key) ? (this.addresses.get(key) ?? "127.0.0.1") : null;
  }
  async writePrivateFile(
    key: string,
    dir: string,
    name: string,
    content: string,
  ) {
    this.calls.push(`write ${key} ${dir}/${name}`);
    this.files.push({ key, dir, name, content });
    this.volume.set(`${key}:${dir}/${name}`, content);
  }
  /** Simulates `docker stop` or a crash behind the gateway's back. */
  kill(key: string) {
    this.daemons.get(key)?.stop();
    this.daemons.delete(key);
  }
  stopAll() {
    for (const d of this.daemons.values()) d.stop();
  }
}
