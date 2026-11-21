// acp-poc.ts <person-key> <agent>: one ACP agent in its own one-shot sandbox against the mock.
import { spawn } from "node:child_process";
import { chownSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { handle } from "./mock-all.ts";
const [key, agent] = process.argv.slice(2) as [string, string];
const M = "http://127.0.0.1:4799";
const AGENTS: Record<string, { args: string[]; env: Record<string, string> }> = {
  agy: { args: ["agy", "acp"], env: { GEMINI_API_KEY: "AIzaMock", GOOGLE_GEMINI_BASE_URL: M } },
  grok: { args: ["grok", "agent", "stdio"], env: { XAI_API_KEY: "xai-mock", GROK_XAI_API_BASE_URL: `${M}/v1`, GROK_MODELS_BASE_URL: `${M}/v1`, DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", GROK_DISABLE_AUTOUPDATER: "1" } },
  goose: { args: ["goose", "acp"], env: { GOOSE_PROVIDER: "openrouter", GOOSE_MODEL: "mock-model", OPENROUTER_API_KEY: "sk-or-mock", OPENROUTER_HOST: M, GOOSE_DISABLE_KEYRING: "1", GOOSE_MODE: "smart_approve", GOOSE_TELEMETRY_ENABLED: "false" } },
};
const a = AGENTS[agent]!;
const person = `tandem-${key}`;
const uid = JSON.parse(readFileSync("/var/lib/tandem/uids.json", "utf8"))[key];
const home = `/var/lib/tandem/homes/${key}`;
const tmpl = JSON.parse(readFileSync(`/var/lib/tandem/bundles/${person}/config.json`, "utf8"));
const baseEnv: string[] = tmpl.process.env.filter((e: string) => /^(PATH|HOME|TMPDIR|HTTPS?_PROXY|https?_proxy|USER|LANG)=/.test(e));
const parent = `/sys/fs/cgroup/sandboxes/${person}-poc`;
if (!existsSync(parent)) mkdirSync(parent);
writeFileSync(`${parent}/cgroup.subtree_control`, "+memory +pids +cpu");
const name = `${person}-a${process.pid}`;
const dir = `/tmp/poc/b-${name}`;
mkdirSync(dir, { recursive: true });
const spec = structuredClone(tmpl);
spec.process.args = ["/usr/bin/tini", "-s", "--", "sh", "-c", 'socat TCP-LISTEN:4799,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/home/agent/.poc-mock.sock 2>/dev/null & exec with-egress "$@"', "sh", ...a.args];
spec.process.cwd = "/home/agent";
spec.process.env = [...baseEnv, "NO_PROXY=127.0.0.1,localhost", ...Object.entries(a.env).map(([k, v]) => `${k}=${v}`)];
spec.linux.cgroupsPath = `/sandboxes/${person}-poc/${name}`;
delete spec.linux.resources;
spec.mounts = spec.mounts.filter((m: any) => m.destination !== "/run/tandem/mcp.sock");
writeFileSync(`${dir}/config.json`, JSON.stringify(spec));
const sock = `${home}/.poc-mock.sock`;
rmSync(sock, { force: true });
Bun.serve({ unix: sock, fetch: handle });
chownSync(sock, uid, uid);
const t0 = performance.now();
const ms = () => (performance.now() - t0).toFixed(0);
const child = spawn("crun", ["--cgroup-manager=cgroupfs", "run", "--no-pivot", "--no-new-keyring", "--bundle", dir, name], { stdio: ["pipe", "pipe", "pipe"] });
let err = ""; child.stderr.on("data", (d) => (err += d));
let buf = "", seq = 0;
const waiting = new Map<number, (m: any) => void>();
const kinds: Record<string, number> = {};
let text = "";
child.stdout.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m: any; try { m = JSON.parse(line); } catch { console.log("NONJSON", line.slice(0, 200)); continue; }
    if (m.id !== undefined && m.method === undefined) { waiting.get(m.id)?.(m); waiting.delete(m.id); continue; }
    if (m.method === "session/request_permission") {
      const opt = m.params.options.find((o: any) => /allow/.test(o.kind)) ?? m.params.options[0];
      console.log(ms(), "PERMISSION", m.params.toolCall?.title ?? "", "->", opt.optionId, JSON.stringify(m.params.options.map((o: any) => o.kind)));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { outcome: { outcome: "selected", optionId: opt.optionId } } }) + "\n");
      continue;
    }
    if (m.id !== undefined) { console.log(ms(), "CLIENT_REQ", m.method); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } }) + "\n"); continue; }
    const u = m.params?.update;
    const k = u?.sessionUpdate ?? m.method;
    kinds[k] = (kinds[k] ?? 0) + 1;
    if (u?.sessionUpdate === "agent_message_chunk") text += u.content?.text ?? "";
    if (u?.sessionUpdate === "tool_call" || u?.sessionUpdate === "tool_call_update") console.log(ms(), k, u.status ?? "", u.title ?? "", JSON.stringify(u.rawOutput ?? u.content ?? "").slice(0, 160));
  }
});
const req = (method: string, params: unknown, timeout = 30000) => new Promise<any>((res) => { const id = ++seq; waiting.set(id, res); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); res({ timeout: method }); } }, timeout); });
const init = await req("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
console.log(ms(), "INIT", JSON.stringify(init.result ?? init).slice(0, 500));
const s = await req("session/new", { cwd: "/home/agent/projects/chats", mcpServers: [] });
console.log(ms(), "SESSION", JSON.stringify(s.result ?? s).slice(0, 500));
const sid = s.result?.sessionId;
if (sid) {
  const r = await req("session/prompt", { sessionId: sid, prompt: [{ type: "text", text: "RUN_TOOL please" }] }, 60000);
  console.log(ms(), "PROMPT_DONE", JSON.stringify(r.result ?? r).slice(0, 300));
}
console.log("kinds", JSON.stringify(kinds));
console.log("text", JSON.stringify(text.slice(0, 400)));
console.log("peak MiB", (Number(readFileSync(`${parent}/memory.peak`, "utf8")) / 2 ** 20).toFixed(0));
if (err) console.log("stderr tail", err.slice(-600).replace(/\x1b\[[0-9;]*m/g, ""));
child.kill(); spawn("crun", ["delete", "-f", name]);
process.exit(0);
