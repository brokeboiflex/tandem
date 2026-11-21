// Operator commands inside the Tandem container (docker compose exec tandem bun src/cli.ts ...):
//   ls                      the people with a home: runtime key, uid, how many sandboxes run
//   exec <key> -- CMD...    runs CMD as that person in a one-shot sandbox like theirs (their home,
//                           the egress proxy); its output and exit code pass through
//   stop <key>              stops every sandbox of that person
// It never creates a person: the key must already have a uid. It runs next to the gateway, so it
// leaves the gateway's sandboxes alone at setup (no sweep).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config";
import { SandboxRuntime } from "./runtime";

const cfg = loadConfig();
const runtime = new SandboxRuntime(cfg, { log: () => {}, sweep: false });
const uids: Record<string, number> = existsSync(join(cfg.dataDir, "uids.json"))
  ? JSON.parse(readFileSync(join(cfg.dataDir, "uids.json"), "utf8"))
  : {};
const [command, key, ...rest] = process.argv.slice(2);
const known = (k?: string): k is string => {
  if (k && uids[k]) return true;
  console.error(`unknown runtime key: ${k ?? "(none)"}`);
  process.exit(2);
};

if (command === "ls") {
  const running = (await runtime.list()).filter((s) => s.status === "running");
  for (const [k, uid] of Object.entries(uids))
    console.log(
      `${k}  uid ${uid}  ${running.filter((s) => s.key === k).length} running`,
    );
} else if (
  command === "exec" &&
  known(key) &&
  rest[0] === "--" &&
  rest.length > 1
) {
  const r = await runtime.exec(key, rest.slice(1));
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exit(r.exitCode);
} else if (command === "stop" && known(key)) {
  await runtime.stopAll(key);
} else {
  console.error("usage: cli.ts ls | exec <key> -- CMD... | stop <key>");
  process.exit(2);
}
