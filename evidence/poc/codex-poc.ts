import { spawn } from "node:child_process";
import { chownSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { handle } from "./mock-openai.ts";
const [key, policyName = "externalSandbox", approval = "never"] = process.argv.slice(2) as [string, string?, string?];
const person = `tandem-${key}`;
const uid = JSON.parse(readFileSync("/var/lib/tandem/uids.json", "utf8"))[key];
const home = `/var/lib/tandem/homes/${key}`;
const tmpl = JSON.parse(readFileSync(`/var/lib/tandem/bundles/${person}/config.json`, "utf8"));
const baseEnv: string[] = tmpl.process.env.filter((e: string) => /^(PATH|HOME|TMPDIR|HTTPS?_PROXY|https?_proxy|USER|LANG)=/.test(e));
const parent = `/sys/fs/cgroup/sandboxes/${person}-poc`;
if (!existsSync(parent)) mkdirSync(parent);
writeFileSync(`${parent}/cgroup.subtree_control`, "+memory +pids +cpu");
const name = `${person}-c${process.pid}`;
const dir = `/tmp/poc/b-${name}`;
mkdirSync(dir, { recursive: true });
const spec = structuredClone(tmpl);
const provider = ["-c", 'model_provider="mock"', "-c", 'model_providers.mock.name="mock"', "-c", 'model_providers.mock.base_url="http://127.0.0.1:4799/v1"', "-c", 'model_providers.mock.wire_api="responses"', "-c", 'model_providers.mock.env_key="MOCK_API_KEY"'];
spec.process.args = ["/usr/bin/tini", "-s", "--", "sh", "-c", 'socat TCP-LISTEN:4799,bind=127.0.0.1,fork,reuseaddr UNIX-CONNECT:/home/agent/.poc-mock.sock 2>/dev/null & exec with-egress "$@"', "sh", "codex", "app-server", ...provider];
spec.process.cwd = "/home/agent";
spec.process.env = [...baseEnv, "MOCK_API_KEY=x", "NO_PROXY=127.0.0.1,localhost", "RUST_LOG=warn"];
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
child.stderr.on("data", (d) => process.stderr.write("[codex] " + String(d).slice(0, 400)));
let buf = "", seq = 0;
const waiting = new Map<number, (m: any) => void>();
let turnDone: (v: any) => void; const turnFinished = new Promise((r) => (turnDone = r));
child.stdout.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id !== undefined && m.method === undefined) { waiting.get(m.id)?.(m); waiting.delete(m.id); continue; }
    if (m.id !== undefined && m.method) { // server -> client request (approval)
      console.log(ms(), "SERVER_REQUEST", m.method, JSON.stringify(m.params).slice(0, 200));
      child.stdin.write(JSON.stringify({ id: m.id, result: { decision: "accept" } }) + "\n");
      continue;
    }
    if (/delta|tokenUsage|rateLimits/.test(m.method)) continue;
    console.log(ms(), "NOTE", m.method, JSON.stringify(m.params).slice(0, 260));
    if (m.method === "turn/completed") turnDone(m.params);
  }
});
const req = (method: string, params: unknown) => new Promise<any>((res) => { const id = ++seq; waiting.set(id, res); child.stdin.write(JSON.stringify({ id, method, params }) + "\n"); });
const init = await req("initialize", { clientInfo: { name: "tandem_poc", title: "Tandem", version: "0.0.1" }, capabilities: { experimentalApi: true } });
console.log(ms(), "INIT", JSON.stringify(init).slice(0, 200));
child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
mkdirSync(`${home}/projects/chats`, { recursive: true }); chownSync(`${home}/projects/chats`, uid, uid);
const ts = await req("thread/start", { cwd: "/home/agent/projects/chats", model: "gpt-mock", approvalPolicy: approval });
console.log(ms(), "THREAD", JSON.stringify(ts).slice(0, 300));
const policies: Record<string, unknown> = {
  workspaceWrite: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  externalSandbox: { type: "externalSandbox", networkAccess: "enabled" },
  dangerFullAccess: { type: "dangerFullAccess" },
};
const turn = await req("turn/start", { threadId: ts.result.thread.id, input: [{ type: "text", text: "RUN_TOOL please", text_elements: [] }], sandboxPolicy: policies[policyName!], approvalPolicy: approval });
console.log(ms(), "TURN", JSON.stringify(turn).slice(0, 200));
await Promise.race([turnFinished, Bun.sleep(60000)]);
console.log(ms(), "peak MiB", (Number(readFileSync(`${parent}/memory.peak`, "utf8")) / 2 ** 20).toFixed(0));
child.kill(); spawn("crun", ["delete", "-f", name]);
process.exit(0);
