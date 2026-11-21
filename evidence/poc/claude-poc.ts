import { query } from "@anthropic-ai/claude-agent-sdk";
import { spawn } from "node:child_process";
import { chownSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { handle } from "./mock-anthropic.ts";
const key = process.argv[2]!;
const person = `tandem-${key}`;
const uid = JSON.parse(readFileSync("/var/lib/tandem/uids.json", "utf8"))[key];
const home = `/var/lib/tandem/homes/${key}`;
const tmpl = JSON.parse(readFileSync(`/var/lib/tandem/bundles/${person}/config.json`, "utf8"));
console.log("template args", JSON.stringify(tmpl.process.args), "cgroup", tmpl.linux.cgroupsPath);
const baseEnv: string[] = tmpl.process.env.filter((e: string) => /^(PATH|HOME|TMPDIR|HTTPS?_PROXY|https?_proxy|USER|LANG)=/.test(e));
// Per-person parent cgroup holds the person's limit; each vendor process is a child sandbox under it.
const parent = `/sys/fs/cgroup/sandboxes/${person}-poc`;
if (!existsSync(parent)) mkdirSync(parent);
writeFileSync(`${parent}/cgroup.subtree_control`, "+memory +pids +cpu");
writeFileSync(`${parent}/memory.max`, String(2 * 2 ** 30));
let n = 0;
function sandboxed(args: string[], env: Record<string, string>, cwd: string, signal?: AbortSignal) {
  const name = `${person}-p${process.pid}-${++n}`;
  const dir = `/tmp/poc/b-${name}`;
  mkdirSync(dir, { recursive: true });
  const spec = structuredClone(tmpl);
  spec.process.args = ["/usr/bin/tini", "-s", "--", "sh", "-c", 'socat TCP-LISTEN:4799,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/home/agent/.poc-mock.sock 2>/dev/null & exec with-egress "$@"', "sh", ...args];
  spec.process.cwd = cwd;
  spec.process.env = [...baseEnv, ...Object.entries(env).map(([k, v]) => `${k}=${v}`)];
  spec.linux.cgroupsPath = `/sandboxes/${person}-poc/${name}`;
  delete spec.linux.resources;
  spec.mounts = spec.mounts.filter((m: any) => m.destination !== "/run/tandem/mcp.sock");
  writeFileSync(`${dir}/config.json`, JSON.stringify(spec));
  const child = spawn("crun", ["--cgroup-manager=cgroupfs", "run", "--no-pivot", "--no-new-keyring", "--bundle", dir, name], { stdio: ["pipe", "pipe", "pipe"], signal });
  child.on("exit", () => { spawn("crun", ["delete", "-f", name]); rmSync(dir, { recursive: true, force: true }); });
  return child;
}
const sock = `${home}/.poc-mock.sock`;
rmSync(sock, { force: true });
Bun.serve({ unix: sock, fetch: handle });
chownSync(sock, uid, uid);
mkdirSync(`${home}/projects/chats`, { recursive: true });
const t0 = performance.now();
const ms = () => (performance.now() - t0).toFixed(0);
let peak = 0;
const sample = setInterval(() => { try { peak = Math.max(peak, Number(readFileSync(`${parent}/memory.current`, "utf8"))); } catch {} }, 100);
const q = query({
  prompt: "RUN_TOOL please",
  options: {
    cwd: "/home/agent/projects/chats",
    pathToClaudeCodeExecutable: "/usr/local/bin/claude",
    model: "claude-sonnet-4-5",
    env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:4799", ANTHROPIC_API_KEY: "sk-ant-mock", NO_PROXY: "127.0.0.1,localhost", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_AUTOUPDATER: "1" },
    canUseTool: async (name, input) => { console.log(ms(), "PERMISSION", name, JSON.stringify(input).slice(0, 120)); return { behavior: "allow", updatedInput: input }; },
    stderr: (d) => { if (!/^\d+ \|/.test(d)) process.stderr.write("[cli] " + d.slice(0, 300)); },
    spawnClaudeCodeProcess: ({ command, args, cwd, env, signal }) => {
      const pass = Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && (k.startsWith("CLAUDE") || k.startsWith("ANTHROPIC") || k === "NO_PROXY" || k.startsWith("DISABLE")))) as Record<string, string>;
      console.log(ms(), "SPAWN", command, JSON.stringify(args), "env:", Object.keys(pass).join(","));
      return sandboxed([command, ...args], pass, cwd ?? "/home/agent", signal);
    },
  },
});
for await (const m of q) {
  const s = JSON.stringify(m);
  if (m.type === "system" && m.subtype === "init") console.log(ms(), "INIT model", m.model, "tools", m.tools.length, "session", m.session_id);
  else if (m.type === "assistant") console.log(ms(), "ASSISTANT", s.slice(0, 300));
  else if (m.type === "user") console.log(ms(), "USER", s.slice(0, 500));
  else if (m.type === "result") { console.log(ms(), "RESULT", m.subtype, JSON.stringify(m.result).slice(0, 400), "usage", JSON.stringify(m.usage).slice(0, 200)); break; }
  else console.log(ms(), m.type, (m as any).subtype ?? "");
}
clearInterval(sample);
console.log("person cgroup memory peak during turn MiB", (peak / 2 ** 20).toFixed(0));
process.exit(0);
