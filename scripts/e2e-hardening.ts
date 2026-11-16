// End-to-end proof of the four protections against a running stack (docker compose up), with or
// without the socket proxy and gVisor. Uses the Docker CLI on the host (DOCKER_HOST is honoured)
// to look inside runtimes the way an agent with a shell would.
//
//   bun scripts/e2e-hardening.ts
//
// Expects the defaults of .env.example (EGRESS_MODE=auto, read-only root, non-root user ...).
import { devToken } from "../src/auth";
import { runtimeKey } from "../src/runtime";

const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:8787";
const PREFIX = process.env.RUNTIME_PREFIX || "tandem";
const secret = process.env.DEV_AUTH_SECRET ?? "";
const serviceSecret = process.env.SERVICE_SECRET ?? "";
if (secret.length < 32 || serviceSecret.length < 32)
  throw new Error(
    "Run from the project directory so Bun loads .env (AUTH_MODE=dev).",
  );
const run = Date.now().toString(36);

let failures = 0;
const check = (ok: boolean, label: string, detail = "") => {
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}`,
  );
  if (!ok) failures++;
};
const info = (line: string) => console.log(`      ${line}`);
const docker = (...args: string[]) => {
  const p = Bun.spawnSync(["docker", ...args]);
  return {
    code: p.exitCode,
    out: p.stdout.toString().trim(),
    err: p.stderr.toString().trim(),
  };
};
/** A shell command inside a container, as its own user. */
const sh = (container: string, script: string, user?: string) =>
  docker("exec", ...(user ? ["-u", user] : []), container, "sh", "-c", script);
const container = (subject: string) =>
  `${PREFIX}-rt-${runtimeKey(serviceSecret, subject)}`;
const inspect = (name: string, format: string) =>
  docker("inspect", "-f", format, name).out;

async function start(subject: string) {
  const token = await devToken(secret, subject);
  const res = await fetch(`${BASE}/v1/providers`, {
    headers: { authorization: `Bearer ${token}` },
  });
  return res.status;
}

// --- Setup: two people, two runtimes ----------------------------------------------------------
const alice = `e2e-hard-alice-${run}`;
const bob = `e2e-hard-bob-${run}`;
check(
  (await start(alice)) === 200 && (await start(bob)) === 200,
  "two runtimes start",
);
const A = container(alice);
const B = container(bob);
const health = (await fetch(`${BASE}/healthz`).then((r) => r.json())) as {
  egress: string;
};
check(
  ["allowlist", "open", "off"].includes(health.egress),
  "GET /healthz reports the egress mode",
  health.egress,
);
const gatewayLogs =
  docker("logs", `${PREFIX}-gateway`).out +
  "\n" +
  docker("logs", `${PREFIX}-gateway`).err;
const posture =
  gatewayLogs
    .split("\n")
    .filter((l) => l.startsWith("security:"))
    .at(-1) ?? "";
info(posture);
for (const w of gatewayLogs
  .split("\n")
  .filter((l) => l.startsWith("WARNING:"))
  .slice(-4))
  info(w.slice(0, 160));

// --- 1. Sandbox ------------------------------------------------------------------------------
const engineRuntimes = docker(
  "info",
  "-f",
  "{{range $k, $v := .Runtimes}}{{$k}} {{end}}",
).out.split(" ");
const runtime = inspect(A, "{{.HostConfig.Runtime}}");
if (engineRuntimes.includes("runsc")) {
  check(
    runtime === "runsc",
    "gVisor available: the runtime runs under runsc",
    runtime,
  );
  const kernel = sh(A, "dmesg 2>/dev/null | head -1; uname -r").out;
  check(
    /gvisor|Starting gVisor/i.test(kernel),
    "the agent sees gVisor's kernel, not the host's",
    kernel.replace(/\n/g, " | "),
  );
} else {
  check(
    runtime === "runc" || runtime === "",
    "no gVisor on this Engine: the default runtime with a startup warning",
    runtime || "default",
  );
  check(
    gatewayLogs.includes("gVisor (runsc) is not installed"),
    "the gateway warned about the missing gVisor",
  );
}

// --- 2. Locked-down runtime container ----------------------------------------------------------
const status = sh(
  A,
  "id -u; grep -E '^(CapEff|CapBnd|CapPrm|NoNewPrivs)' /proc/self/status",
).out;
check(status.split("\n")[0] === "10001", "runs as non-root uid 10001");
check(
  /CapEff:\s+0+\b/.test(status) && /CapBnd:\s+0+\b/.test(status),
  "no capabilities, not even in the bounding set",
);
check(/NoNewPrivs:\s+1/.test(status), "no-new-privileges is set");
const limits = inspect(
  A,
  "{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}} {{.HostConfig.PidsLimit}} {{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Privileged}}",
);
check(
  limits === `${2048 * 1024 * 1024} 2000000000 512 true false`,
  "memory, CPU and pids limits; read-only root; not privileged",
  limits,
);
check(
  sh(A, "touch /usr/local/bin/x").code !== 0,
  "the root filesystem is read-only",
);
check(
  sh(A, "echo x > /tmp/x && cat /tmp/x").out === "x",
  "/tmp is a writable scratch tmpfs",
);
check(sh(A, "cp /bin/true /tmp/t && /tmp/t").code !== 0, "/tmp is noexec");
const escape = sh(
  A,
  [
    "test -e /var/run/docker.sock && echo docker-socket",
    "mount -t tmpfs none /mnt 2>/dev/null && echo mount",
    "chroot / true 2>/dev/null && echo chroot",
    "su -c true root </dev/null 2>/dev/null && echo su",
    "echo c > /proc/sysrq-trigger 2>/dev/null && echo sysrq",
    "ls /dev | grep -E '^(sd|nvme|vd|mem|kmem|port)' && echo devices",
    "true",
  ].join("; "),
).out;
check(
  escape === "",
  "no Docker socket, mount, chroot, su, sysrq or raw devices",
  escape.replace(/\n/g, ","),
);
const tools = sh(
  A,
  'set -e; cd "$HOME/projects/chats"; mkdir -p e2e && cd e2e; printf "hello\\n" > note.txt; ' +
    "sed -i s/hello/world/ note.txt; git init -q; git add note.txt; " +
    "git -c user.name=e2e -c user.email=e2e@tandem.invalid commit -qm one; git log --oneline | wc -l; cat note.txt; " +
    'bash -c "echo \\$((6*7))"; claude --version | head -1; codex --version | head -1',
);
check(
  tools.code === 0 && tools.out.startsWith("1\nworld\n42"),
  "shell, file and git tools work in the workspace",
  tools.out.split("\n").slice(3).join(", ") || tools.err.slice(0, 120),
);
check(
  /happy-agent-10001/.test(sh(A, 'ls "$TMPDIR"').out),
  "Happy unpacks Claude Code into TMPDIR on the volume (works with a read-only root)",
);
const codexSandbox = sh(
  A,
  'cd "$HOME/projects/chats" && codex sandbox -- sh -c "echo ok" 2>&1',
);
info(
  `codex's own bwrap sandbox inside the runtime: ${codexSandbox.code === 0 ? "works" : `unavailable (${codexSandbox.out.split("\n")[0]?.slice(0, 90)})`}`,
);

// --- 3. Docker API access of the gateway --------------------------------------------------------
const apiHost = docker(
  "exec",
  `${PREFIX}-gateway`,
  "printenv",
  "RUNTIME_DOCKER_HOST",
).out;
if (!apiHost.startsWith("unix:///var/run/tandem-docker")) {
  check(
    posture.includes("docker_api=unrestricted") &&
      gatewayLogs.includes("unrestricted Docker API access"),
    "plain socket: the gateway reports unrestricted access and warns",
    apiHost,
  );
} else {
  // A container that is not Tandem's, next to the stack.
  const foreign = `${PREFIX}-e2e-foreign-${run}`;
  docker(
    "run",
    "-d",
    "--name",
    foreign,
    "--network",
    "none",
    "--entrypoint",
    "sleep",
    inspect(A, "{{.Config.Image}}"),
    "300",
  );
  const probe = `
    const sock = process.env.RUNTIME_DOCKER_HOST.slice(7);
    const api = (m, p, b) => fetch("http://d/v1.44" + p, { unix: sock, method: m, body: b && JSON.stringify(b), headers: b ? { "content-type": "application/json" } : {} }).then(async (r) => r.status);
    const image = ${JSON.stringify(inspect(A, "{{.Config.Image}}"))};
    const base = { Image: image, User: "10001:10001", HostConfig: { CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"], Memory: 1 << 28, PidsLimit: 64 } };
    const out = {
      listAll: await fetch("http://d/v1.44/containers/json?all=1", { unix: sock }).then((r) => r.json()).then((l) => l.map((c) => c.Names[0])),
      inspectForeign: await api("GET", "/containers/${foreign}/json"),
      stopForeign: await api("POST", "/containers/${foreign}/stop"),
      execForeign: await api("POST", "/containers/${foreign}/exec", { Cmd: ["cat", "/home/agent/.happy/agent/token"], User: "10001:10001" }),
      privileged: await api("POST", "/containers/create?name=${PREFIX}-rt-e2e-priv", { ...base, HostConfig: { ...base.HostConfig, Privileged: true } }),
      hostBind: await api("POST", "/containers/create?name=${PREFIX}-rt-e2e-bind", { ...base, HostConfig: { ...base.HostConfig, Binds: ["/:/host"] } }),
      capAdd: await api("POST", "/containers/create?name=${PREFIX}-rt-e2e-cap", { ...base, HostConfig: { ...base.HostConfig, CapAdd: ["SYS_ADMIN"] } }),
      hostPid: await api("POST", "/containers/create?name=${PREFIX}-rt-e2e-pid", { ...base, HostConfig: { ...base.HostConfig, PidMode: "host" } }),
      rootUser: await api("POST", "/containers/create?name=${PREFIX}-rt-e2e-root", { ...base, User: "0" }),
      otherImage: await api("POST", "/containers/create?name=${PREFIX}-rt-e2e-img", { ...base, Image: "docker.io/library/alpine:3.22" }),
      rootExec: await api("POST", "/containers/${A}/exec", { Cmd: ["cat", "/home/agent/.happy/agent/token"], User: "root" }),
      otherExec: await api("POST", "/containers/${A}/exec", { Cmd: ["sh", "-c", "id"], User: "10001:10001" }),
      imageList: await api("GET", "/images/json"),
      allowedInspect: await api("GET", "/containers/${A}/json"),
    };
    console.log(JSON.stringify(out));`;
  const r = docker("exec", `${PREFIX}-gateway`, "bun", "-e", probe);
  let o: any = {};
  try {
    o = JSON.parse(r.out);
  } catch {
    info(`probe failed: ${r.err.slice(0, 200)}`);
  }
  const denied = (s: number) => s === 403 || s === 404;
  check(
    o.allowedInspect === 200,
    "through the proxy the gateway still manages its runtimes",
  );
  check(
    Array.isArray(o.listAll) &&
      !o.listAll.includes(`/${foreign}`) &&
      o.listAll.every((n: string) => n.startsWith(`/${PREFIX}-`)),
    "listing shows only Tandem's containers",
    `${o.listAll?.length} visible`,
  );
  check(
    denied(o.inspectForeign) && denied(o.stopForeign) && denied(o.execForeign),
    "a non-Tandem container cannot be inspected, stopped or exec'd",
    `${o.inspectForeign}/${o.stopForeign}/${o.execForeign}`,
  );
  check(
    [
      o.privileged,
      o.hostBind,
      o.capAdd,
      o.hostPid,
      o.rootUser,
      o.otherImage,
    ].every(denied),
    "no privileged, host-path, extra-capability, host-PID, root or foreign-image container",
    [
      o.privileged,
      o.hostBind,
      o.capAdd,
      o.hostPid,
      o.rootUser,
      o.otherImage,
    ].join("/"),
  );
  check(
    denied(o.rootExec) && denied(o.otherExec),
    "no root exec and no command outside the gateway's own",
    `${o.rootExec}/${o.otherExec}`,
  );
  check(
    denied(o.imageList),
    "other Docker API sections are refused",
    String(o.imageList),
  );
  docker("rm", "-f", foreign);
}

// --- 4. Network isolation and egress ------------------------------------------------------------
const netA = inspect(A, "{{.HostConfig.NetworkMode}}");
const netB = inspect(B, "{{.HostConfig.NetworkMode}}");
const ipB = inspect(
  B,
  `{{(index .NetworkSettings.Networks "${netB}").IPAddress}}`,
);
const members = docker(
  "network",
  "inspect",
  "-f",
  "{{range .Containers}}{{.Name}} {{end}}",
  netA,
)
  .out.split(" ")
  .filter(Boolean)
  .sort();
const internal = docker("network", "inspect", "-f", "{{.Internal}}", netA).out;
check(
  netA !== netB && internal === (health.egress === "off" ? "false" : "true"),
  "each runtime has its own internal network",
  `${netA}, internal=${internal}`,
);
check(
  members.join(" ") ===
    [A, `${PREFIX}-egress`, `${PREFIX}-gateway`]
      .filter((n) => health.egress !== "off" || n !== `${PREFIX}-egress`)
      .sort()
      .join(" "),
  "its only peers are the gateway and the egress proxy",
  members.join(" "),
);
const curl = (args: string) =>
  sh(A, `curl -s -o /dev/null -w '%{http_code}' -m 8 ${args}; echo " exit=$?"`)
    .out;
/**
 * The proxy's answer to CONNECT: 200 tunnel, 407 refused by policy, 502 the destination did not
 * answer (a flaky Internet path, not a policy decision: retried).
 */
const tunnel = async (url: string) => {
  let code = "";
  for (let i = 0; i < 3; i++) {
    code = sh(A, `curl -s -o /dev/null -w '%{http_connect}' -m 15 ${url}`).out;
    if (code !== "502" && code !== "000") break;
    await Bun.sleep(2000);
  }
  return code;
};
if (health.egress === "allowlist") {
  const allowed = await tunnel("https://api.anthropic.com/");
  check(
    allowed === "200",
    "egress to an allowed vendor domain works through the proxy",
    `CONNECT ${allowed}`,
  );
  const blocked = await tunnel("https://example.com/");
  check(
    blocked === "407",
    "egress to a domain outside the allowlist is refused",
    `CONNECT ${blocked}`,
  );
  const extra = (process.env.EGRESS_ALLOW_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d && !d.startsWith("*"))[0];
  if (extra) {
    const code = await tunnel(`https://${extra}/`);
    check(
      code === "200",
      `an EGRESS_ALLOW_DOMAINS entry is reachable (${extra})`,
      `CONNECT ${code}`,
    );
  }
}
if (health.egress !== "off") {
  const direct = curl("--noproxy '*' https://1.1.1.1/");
  check(
    /^000/.test(direct),
    "no direct route out, bypassing the proxy",
    direct,
  );
  check(
    sh(A, "getent hosts example.com").code !== 0,
    "no DNS for outside names inside the runtime",
  );
  const gwIp = inspect(
    `${PREFIX}-gateway`,
    `{{(index .NetworkSettings.Networks "${netA}").IPAddress}}`,
  );
  const ssrf = curl(`--noproxy '' -x $HTTPS_PROXY http://${gwIp}:8787/healthz`);
  check(
    !/^2/.test(ssrf),
    "the egress proxy refuses private addresses (here the gateway's)",
    ssrf,
  );
}
// Other runtimes, other apps and the host.
sh(
  B,
  "socat TCP-LISTEN:8099,fork,reuseaddr SYSTEM:'echo bob' >/dev/null 2>&1 &",
);
const other = `${PREFIX}-e2e-other-${run}`;
docker("network", "create", `${other}-net`);
docker(
  "run",
  "-d",
  "--name",
  other,
  "--network",
  `${other}-net`,
  "--entrypoint",
  "socat",
  inspect(A, "{{.Config.Image}}"),
  "TCP-LISTEN:8099,fork,reuseaddr",
  "SYSTEM:echo other",
);
const ipOther = inspect(
  other,
  `{{(index .NetworkSettings.Networks "${other}-net").IPAddress}}`,
);
// A service on the Docker host itself (host network namespace), like an admin UI or a database.
const port = String(18000 + Math.floor(Math.random() * 1000));
const hostSvc = `${PREFIX}-e2e-hostsvc-${run}`;
docker(
  "run",
  "-d",
  "--name",
  hostSvc,
  "--network",
  "host",
  "--entrypoint",
  "socat",
  inspect(A, "{{.Config.Image}}"),
  `TCP-LISTEN:${port},fork,reuseaddr`,
  "SYSTEM:echo host",
);
await Bun.sleep(1000);
const gatewayOf = (net: string) =>
  docker(
    "network",
    "inspect",
    "-f",
    "{{range .IPAM.Config}}{{.Gateway}}{{end}}",
    net,
  ).out;
const otherGw = gatewayOf(`${other}-net`);
const fromOther = (target: string) =>
  docker(
    "run",
    "--rm",
    "--network",
    `${other}-net`,
    "--entrypoint",
    "curl",
    inspect(A, "{{.Config.Image}}"),
    "-s",
    "-m",
    "3",
    target,
  ).out;
check(
  sh(B, "curl -s -m 3 telnet://127.0.0.1:8099 </dev/null").out === "bob" &&
    fromOther(`telnet://${otherGw}:${port}`) === "host",
  "control: Bob's listener and the host service answer where they should",
  `host service on port ${port}, reached from an ordinary network via ${otherGw}`,
);
const reach = (target: string) =>
  sh(A, `curl -s -m 3 --noproxy '*' ${target} </dev/null; echo " exit=$?"`).out;
const answered = (target: string, word: string) =>
  reach(target).startsWith(word);
check(
  !answered(`telnet://${ipB}:8099`, "bob"),
  "a runtime cannot reach another runtime",
  reach(`telnet://${ipB}:8099`),
);
check(
  !answered(`telnet://${ipOther}:8099`, "other"),
  "a runtime cannot reach other apps' containers",
  reach(`telnet://${ipOther}:8099`),
);
// The runtime network's own host address (none in isolated gateway mode), another network's, the
// default bridge's and Docker's name for the host.
const hostTargets = [
  gatewayOf(netA),
  otherGw,
  "172.17.0.1",
  "host.docker.internal",
].filter((h) => h && h !== "invalid IP");
const reachedHost = hostTargets.filter((h) =>
  answered(`telnet://${h}:${port}`, "host"),
);
check(
  reachedHost.length === 0,
  "a runtime cannot reach services on the Docker host",
  `tried ${hostTargets.join(", ")}`,
);
docker("rm", "-f", hostSvc);
check(
  !members.some((m) => m.includes("docker-proxy")) &&
    sh(A, "test -S /var/run/tandem-docker/docker.sock").code !== 0,
  "the Docker API proxy is not reachable from a runtime (no shared network or socket)",
);
// Runtimes know the gateway by address (NO_PROXY): Docker's DNS does not answer inside gVisor.
const gwAddr = inspect(
  `${PREFIX}-gateway`,
  `{{(index .NetworkSettings.Networks "${netA}").IPAddress}}`,
);
const gw = `http://${gwAddr}:8787`;
info(
  `gateway name from inside the runtime: ${sh(A, `getent hosts ${PREFIX}-gateway`).code === 0 ? "resolves" : "does not resolve (use its address)"}`,
);
check(
  /^200 exit=0/.test(
    sh(
      A,
      `curl -s -o /dev/null -w '%{http_code}' -m 5 ${gw}/healthz; echo " exit=$?"`,
    ).out,
  ),
  "the gateway is the runtime's peer (healthz answers directly, NO_PROXY)",
);
// The MCP proxy likewise: the gateway's address on this runtime's own network, outside the egress
// proxy, and unreachable from any other runtime.
const mcpUrl = sh(A, 'printf %s "$MCP_PROXY_URL"').out;
const mcpProbe = (from: string, url: string, extra = "") =>
  sh(
    from,
    `curl -s -o /dev/null -w '%{http_code}' -m 5 ${extra} -X POST -H "authorization: Bearer $MCP_PROXY_TOKEN" ` +
      `-H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"ping"}' ${url}/none; echo " exit=$?"`,
  ).out;
check(
  mcpUrl === `http://${gwAddr}:${process.env.MCP_PROXY_PORT || 8790}/mcp/${runtimeKey(serviceSecret, alice)}` &&
    /^200 exit=0/.test(mcpProbe(A, '"$MCP_PROXY_URL"')),
  "the runtime reaches the gateway's MCP proxy by address, without the egress proxy",
  mcpUrl.replace(/\/mcp\/.*/, "/mcp/<key>"),
);
const mcpFromB = [mcpProbe(B, mcpUrl, "--noproxy '*'"), mcpProbe(B, mcpUrl)];
check(
  /^000/.test(mcpFromB[0]!) &&
    (health.egress === "off" || /^407/.test(mcpFromB[1]!)),
  "another runtime cannot reach this runtime's MCP proxy address (directly or through the egress proxy)",
  mcpFromB.join(", "),
);
const mint = sh(
  A,
  `curl -s -o /dev/null -w '%{http_code}' -m 5 -X POST -H 'content-type: application/json' -d '{"subject":"${bob}"}' ${gw}/dev/token`,
).out;
check(
  mint === "404",
  "a runtime cannot mint service tokens on the gateway",
  mint,
);
docker("rm", "-f", other);
docker("network", "rm", `${other}-net`);

// A real Claude Code turn with its Bash tool in this runtime, against a stand-in API on the runtime's
// network (no account needed): the tool must run as the agent, write into the workspace and report.
const mock = `${PREFIX}-e2e-mock-${run}`;
docker(
  "run",
  "-d",
  "--name",
  mock,
  "--network",
  netA,
  "--entrypoint",
  "bun",
  inspect(`${PREFIX}-gateway`, "{{.Config.Image}}"),
  "-e",
  await Bun.file(new URL("./mock-anthropic.ts", import.meta.url)).text(),
);
await Bun.sleep(2000);
const mockIp = inspect(
  mock,
  `{{(index .NetworkSettings.Networks "${netA}").IPAddress}}`,
);
const turn = sh(
  A,
  `cd "$HOME/projects/chats" && ANTHROPIC_BASE_URL=http://${mockIp}:8080 ANTHROPIC_API_KEY=sk-ant-api03-e2e ` +
    `NO_PROXY="$NO_PROXY,${mockIp}" no_proxy="$no_proxy,${mockIp}" timeout 120 claude -p "MOCKTOOL: run it" ` +
    `--allowedTools Bash --output-format text 2>&1 | tail -3; cat mock-proof.txt`,
).out;
check(
  /TOOL RESULT: shell-tool-ok\s+10001/.test(turn) &&
    turn.endsWith("shell-tool-ok"),
  "Claude Code's Bash tool runs in the runtime and writes to the workspace",
  turn.replace(/\n/g, " | ").slice(0, 120),
);
docker("rm", "-f", mock);

// What the vendors' CLIs contacted through the egress proxy (from its decision log).
if (health.egress !== "off") {
  const decisions = docker("logs", `${PREFIX}-egress`)
    .err.split("\n")
    .filter((l) => l.includes("CANONICAL-PROXY-DECISION"));
  const hosts = (allow: boolean) =>
    [
      ...new Set(
        decisions
          .filter((l) => l.includes(`"allow":${allow}`))
          .map((l) => /"requested_host":"([^"]+)"/.exec(l)?.[1]),
      ),
    ]
      .filter(Boolean)
      .sort();
  info(`egress allowed so far: ${hosts(true).join(", ") || "none"}`);
  info(`egress refused so far: ${hosts(false).join(", ") || "none"}`);
}

console.log(
  failures ? `E2E HARDENING FAILED (${failures})` : "E2E HARDENING PASSED",
);
process.exit(failures ? 1 : 0);
