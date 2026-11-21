// The scripted model shared by the mock's API dialects (scripts/mock-vendor/index.ts): what a
// turn does, decided from the person's latest message and the tools offered.
import { appendFileSync } from "node:fs";
const LOG = process.env.MOCK_LOG ?? "/tmp/poc/mock.log";
export const log = (s: string) => appendFileSync(LOG, s + "\n");
const PROBE =
  "id -u; grep -E 'CapEff|NoNewPrivs|Seccomp:' /proc/self/status; echo TMP=$TMPDIR; echo hi > probe.txt && cat probe.txt";
const SLOW = "echo started; sleep 300; echo late";
const SHELL =
  /^(run_shell_command|shell|bash|exec_command|shell_command|run_command|run_terminal_command|execute|developer__shell|terminal|command)$/i;
const SHELLISH = /shell|bash|command|exec|terminal/i;
export type Tool = { name: string; schema: any };
export function argsFor(schema: any, command: string | null, fixed: Record<string, unknown> = {}) {
  const props = schema?.properties ?? {};
  const key =
    ["command", "cmd", "CommandLine", "script"].find((k) => k in props) ??
    (schema?.required ?? [])[0] ??
    "command";
  const out: Record<string, unknown> =
    command === null
      ? { ...fixed }
      : {
          [key]: props[key]?.type === "array" ? ["bash", "-lc", command] : command,
          // Only what this agent's tool has (a schema may refuse unknown arguments).
          ...Object.fromEntries(Object.entries(fixed).filter(([k]) => k in props)),
        };
  for (const r of schema?.required ?? []) {
    if (r in out) continue;
    const t = String(props[r]?.type ?? "string").toLowerCase();
    out[r] = /cwd|dir/i.test(r)
      ? "/home/agent/projects/chats"
      : t === "number" || t === "integer"
        ? 0
        : t === "boolean"
          ? false
          : t === "array"
            ? []
            : t === "object"
              ? {}
              : "probe";
  }
  return out;
}
const pickShell = (tools: Tool[]) =>
  tools.find((t) => SHELL.test(t.name)) ??
  tools.find((t) => SHELLISH.test(t.name));

export type Decision =
  | { text: string }
  | { call: { name: string; args: Record<string, unknown> } }
  | { fail: "401" | "429" | "quota" };

/** What the scripted model does: `last` is the newest user turn, `earlier` everything before it. */
export function decide(
  last: unknown,
  earlier: unknown,
  toolResult: string | null,
  tools: Tool[],
): Decision {
  if (toolResult !== null) {
    log("TOOL_RESULT " + toolResult.slice(0, 400));
    return { text: "TOOL_RESULT_SEEN " + toolResult.slice(0, 300) };
  }
  const said = JSON.stringify(last ?? "");
  if (said.includes("FAIL_401")) return { fail: "401" };
  if (said.includes("FAIL_429")) return { fail: "429" };
  if (said.includes("FAIL_QUOTA")) return { fail: "quota" };
  const shell = pickShell(tools);
  if (said.includes("RUN_SLOW") && shell) {
    log("CALL " + shell.name + " (slow)");
    // agy backgrounds a command it is not told to wait for (WaitMsBeforeAsync).
    return { call: { name: shell.name, args: argsFor(shell.schema, SLOW, { WaitMsBeforeAsync: 600000 }) } };
  }
  if (said.includes("RUN_MCP")) {
    const t = tools.find((x) => x.name.includes("lookup_customer"));
    if (t) {
      log("CALL " + t.name);
      return { call: { name: t.name, args: argsFor(t.schema, null, { id: "42" }) } };
    }
    // Grok Build offers MCP tools through its use_tool dispatcher (found with search_tool).
    const use = tools.find((x) => x.name === "use_tool");
    if (use) {
      log("CALL use_tool app__lookup_customer");
      return { call: { name: "use_tool", args: { tool_name: "app__lookup_customer", tool_input: { id: "42" } } } };
    }
    log("NO MCP TOOL in " + tools.map((x) => x.name).join(","));
  }
  if (said.includes("RUN_TOOL") && shell) {
    log("CALL " + shell.name);
    return { call: { name: shell.name, args: argsFor(shell.schema, PROBE) } };
  }
  if (said.includes("RECALL")) {
    const seen = [
      ...JSON.stringify(earlier ?? "").matchAll(/REMEMBER ([A-Za-z0-9-]+)/g),
    ].map((m) => m[1]);
    log("RECALL " + (seen.join(",") || "nothing"));
    return {
      text: seen.length
        ? `RECALLED ${[...new Set(seen)].join(" ")}`
        : "RECALLED nothing",
    };
  }
  return { text: "hello from mock" };
}

