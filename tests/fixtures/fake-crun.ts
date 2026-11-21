// A stand-in for crun in the runtime tests: no namespaces, no cgroups. `run` reads the bundle and
// runs the program after tini and agent-run directly, with exactly the spec's environment, in the
// home's host directory, in the foreground like crun; `kill`, `delete`, `list` and `state` act on
// what it started. Every call is recorded. Its state directory is FAKE_CRUN_STATE (set by the
// wrapper script the tests write, since the runtime gives crun only PATH).
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { constants } from "node:os";

const state = process.env.FAKE_CRUN_STATE!;
const boxes = join(state, "boxes");
mkdirSync(boxes, { recursive: true });
mkdirSync(join(state, "configs"), { recursive: true });
const [manager, cmd, ...rest] = process.argv.slice(2);
const id = rest.at(-1)!;
appendFileSync(
  join(state, "calls.jsonl"),
  JSON.stringify({
    manager,
    args: [cmd, ...rest],
    env: Object.keys(process.env),
  }) + "\n",
);
type Box = { status: string; pid?: number };
const boxFile = (id: string) => join(boxes, `${id}.json`);
const read = (id: string): Box | null =>
  existsSync(boxFile(id))
    ? JSON.parse(readFileSync(boxFile(id), "utf8"))
    : null;
const fail = (message: string) => {
  process.stderr.write(`fake crun: ${message}\n`);
  process.exit(1);
};

if (cmd === "run") {
  const bundle = rest[rest.indexOf("--bundle") + 1]!;
  const config = JSON.parse(readFileSync(join(bundle, "config.json"), "utf8"));
  writeFileSync(join(state, "configs", `${id}.json`), JSON.stringify(config));
  // [tini, -s, --, agent-run, DIR, ...program]
  const [dir, ...program] = config.process.args.slice(4);
  const home = config.mounts.find(
    (m: any) => m.destination === "/home/agent",
  ).source;
  // Paths in the sandbox's home are the home's host directory here.
  const host = (path: string) => path.replace(/^\/home\/agent(?=\/|$)/, home);
  const cwd = host(dir);
  mkdirSync(cwd, { recursive: true });
  const env = Object.fromEntries(
    config.process.env.map((e: string) => e.split(/=(.*)/s).slice(0, 2)),
  );
  const p = Bun.spawn(program.map(host), {
    cwd,
    env,
    stdio: ["inherit", "inherit", "inherit"],
  });
  writeFileSync(boxFile(id), JSON.stringify({ status: "running", pid: p.pid }));
  const code = await p.exited;
  // Like crun run: the container is deleted when its process ends.
  rmSync(boxFile(id), { force: true });
  process.exit(p.signalCode ? 128 + constants.signals[p.signalCode] : code);
} else if (cmd === "kill") {
  const box = read(rest[0]!);
  if (!box?.pid) fail("container does not exist");
  try {
    process.kill(box!.pid!, `SIG${rest[1]}` as NodeJS.Signals);
  } catch {}
} else if (cmd === "delete") {
  const box = read(id);
  if (!box) fail("container does not exist");
  if (box!.pid)
    try {
      process.kill(box!.pid, "SIGKILL");
    } catch {}
  rmSync(boxFile(id), { force: true });
} else if (cmd === "list") {
  const all = readdirSync(boxes).map((f) => ({
    id: f.replace(/\.json$/, ""),
    status: read(f.replace(/\.json$/, ""))!.status,
  }));
  process.stdout.write(JSON.stringify(all));
} else if (cmd === "state") {
  const box = read(id);
  if (!box) fail("container does not exist");
  process.stdout.write(JSON.stringify({ id, status: box!.status }));
}
