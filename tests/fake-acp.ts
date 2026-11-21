// A deterministic stand-in for the ACP agents Tandem runs, shaped like each real one where it
// matters to the client (capabilities, models, modes, options, errors), for unit tests:
//
//   bun tests/fake-acp.ts agy acp --disable-telemetry      Antigravity: models per effort, modes
//   bun tests/fake-acp.ts grok agent --no-leader stdio     Grok Build: resume, `_meta` usage
//   bun tests/fake-acp.ts goose acp                        goose: load only, config options
//   bun tests/fake-acp.ts grok login --device-auth         Grok's device sign-in
//
// The prompt's text picks the behaviour: TOOL (a shell call that asks first), SLOW (runs until
// cancelled), THINK (reasoning, then text), RECALL (says the earlier prompts it holds), CONFIG (says
// its model, effort, mode and MCP servers), FAIL:<text> (a JSON-RPC error with the vendor's text),
// AUTH (auth required), EXIT (dies mid-turn), EDIT (an edit inside the workspace). Sessions live in
// $HOME/.fake-acp so another process can load or resume them; every request is logged there.
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";

const [program, ...args] = process.argv.slice(2) as [string, ...string[]];
const HOME = process.env.HOME!;
const DIR = `${HOME}/.fake-acp`;
mkdirSync(`${DIR}/sessions`, { recursive: true });
const log = (entry: unknown) =>
  appendFileSync(
    `${DIR}/log.jsonl`,
    JSON.stringify({ pid: process.pid, program, ...(entry as object) }) + "\n",
  );

// ---------------------------------------------------------------------------------------------
// grok login / logout

if (program === "grok" && args[0] === "login") {
  const mode = existsSync(`${DIR}/login-mode`)
    ? readFileSync(`${DIR}/login-mode`, "utf8").trim()
    : "success";
  log({
    login: args,
    mode,
    env: { DISABLE_TELEMETRY: process.env.DISABLE_TELEMETRY },
  });
  if (mode === "unavailable") {
    process.stderr.write(
      "Error: Device code request failed (HTTP 503): unavailable\n",
    );
    process.exit(1);
  }
  if (mode === "hang") setInterval(() => {}, 1000);
  else {
    process.stderr.write(
      "To sign in, open this URL in your browser:\n  https://accounts.x.ai/oauth2/device?user_code=ABCD-1234\n" +
        "  (Could not open browser automatically — open the URL above manually.)\n" +
        "Confirm this code in your browser:\n  ABCD-1234\n" +
        "\x1b[90mOnly continue with a code you requested. Don't share it with anyone.\x1b[0m\nWaiting for authorization...\n",
    );
    setTimeout(
      () => {
        if (mode === "success" || mode === "slow") {
          mkdirSync(`${HOME}/.grok`, { recursive: true });
          writeFileSync(
            `${HOME}/.grok/auth.json`,
            JSON.stringify({ fake: { key: "token" } }),
          );
          process.stderr.write("✓ Signed in as person@example.invalid\n");
          process.stdout.write("\n");
          process.exit(0);
        }
        if (mode === "expire") {
          process.stderr.write(
            "Error: Device code expired. Run `grok login --device-auth` again.\n",
          );
          process.exit(1);
        }
        if (mode === "deny") {
          process.stderr.write(
            "Error: Authorization denied. The user rejected the request.\n",
          );
          process.exit(1);
        }
      },
      mode === "slow" ? 5000 : 150,
    );
  }
} else if (program === "grok" && args[0] === "logout") {
  log({ logout: true });
  rmSync(`${HOME}/.grok/auth.json`, { force: true });
  process.stderr.write("Logged out\n");
  process.exit(0);
} else serve();

// ---------------------------------------------------------------------------------------------
// The ACP server

type Session = {
  id: string;
  cwd: string;
  history: { role: "user" | "agent"; text: string }[];
  model: string;
  effort: string | null;
  mode: string;
  mcpServers: unknown;
  meta: unknown;
};

function serve() {
  log({
    start: args,
    env: pick(process.env, [
      "GEMINI_API_KEY",
      "OPENROUTER_API_KEY",
      "GOOSE_PROVIDER",
      "GOOSE_MODEL",
      "GOOSE_DISABLE_KEYRING",
      "GOOSE_MODE",
      "GOOSE_TELEMETRY_OFF",
      "DISABLE_TELEMETRY",
      "GROK_MANAGED_CONFIG",
      "GROK_MEMTRACE",
      "GROK_DISABLE_AUTOUPDATER",
      "DISABLE_ERROR_REPORTING",
      "AGY_CLI_DISABLE_AUTO_UPDATE",
    ]),
  });
  if (
    program === "agy" &&
    !existsSync(`${HOME}/.gemini/antigravity-cli/settings.json`)
  )
    log({ warning: "no agy settings" });
  let buf = "";
  let seq = 0;
  const waiting = new Map<number, (m: any) => void>();
  const open = new Map<string, Session>();
  const cancels = new Map<string, () => void>();
  let customNotifications = false;
  const send = (m: unknown) =>
    process.stdout.write(
      JSON.stringify({ jsonrpc: "2.0", ...(m as object) }) + "\n",
    );
  const request = (method: string, params: unknown) =>
    new Promise<any>((resolve) => {
      const id = ++seq;
      waiting.set(id, resolve);
      send({ id, method, params });
    });
  const update = (sessionId: string, u: unknown, meta?: unknown) =>
    send({
      method: "session/update",
      params: { sessionId, update: u, ...(meta ? { _meta: meta } : {}) },
    });
  const file = (id: string) => `${DIR}/sessions/${encodeURIComponent(id)}.json`;
  const save = (s: Session) => writeFileSync(file(s.id), JSON.stringify(s));
  const loadFile = (id: string): Session | null =>
    existsSync(file(id)) ? JSON.parse(readFileSync(file(id), "utf8")) : null;

  const credential = () =>
    program === "agy"
      ? !!process.env.GEMINI_API_KEY
      : program === "goose"
        ? !!process.env.OPENROUTER_API_KEY
        : existsSync(`${HOME}/.grok/auth.json`);

  function advertised(s: Session) {
    if (program === "agy") {
      const efforts: Record<string, string[]> = {
        "gemini-4-carbon": ["high", "medium", "low"],
        "gemini-4-hydrogen": ["high", "xhigh", "medium", "low"],
        "gemini-3.1-pro": ["high", "low"],
      };
      const label = (b: string) =>
        b
          .replace("gemini-", "Gemini ")
          .replace("-carbon", " Carbon")
          .replace("-hydrogen", " Hydrogen")
          .replace("-pro", " Pro");
      const base = s.model.replace(/-(low|medium|high|xhigh)$/, "");
      return {
        models: {
          availableModels: Object.entries(efforts).flatMap(([b, es]) =>
            es.map((e) => ({
              modelId: `${b}-${e}`,
              name: `${label(b)} (${e[0]!.toUpperCase()}${e.slice(1)})`,
            })),
          ),
          currentModelId: s.model,
        },
        modes: {
          currentModeId: s.mode,
          availableModes: ["default", "accept-edits", "plan"].map((id) => ({
            id,
            name: id,
          })),
        },
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: base,
            options: Object.keys(efforts).map((value) => ({
              value,
              name: label(value),
            })),
          },
          {
            id: "thought_level",
            name: "Thinking Level",
            category: "thought_level",
            type: "select",
            currentValue: s.effort ?? "low",
            options: (efforts[base] ?? ["low"]).map((value) => ({
              value,
              name: value,
            })),
          },
          {
            id: "mode",
            name: "Mode",
            category: "mode",
            type: "select",
            currentValue: s.mode,
            options: ["default", "accept-edits", "plan"].map((value) => ({
              value,
              name: value,
            })),
          },
        ],
      };
    }
    if (program === "grok") {
      const models = [
        {
          modelId: "grok-4.6",
          name: "Grok 4.6",
          _meta: {
            totalContextTokens: 500000,
            reasoningEffort: "high",
            reasoningEfforts: ["xhigh", "high", "medium", "low"].map(
              (value) => ({ id: value, value, default: value === "high" }),
            ),
          },
        },
        {
          modelId: "grok-build",
          name: "Grok Build",
          _meta: { totalContextTokens: 256000 },
        },
      ];
      const cur = models.find((m) => m.modelId === s.model) ?? models[0]!;
      return {
        models: { currentModelId: s.model, availableModels: models },
        configOptions: [
          {
            id: "model",
            name: "Model",
            category: "model",
            type: "select",
            currentValue: s.model,
            options: models.map((m) => ({ value: m.modelId, name: m.name })),
          },
          ...(cur._meta.reasoningEfforts
            ? [
                {
                  id: "reasoning_effort",
                  name: "Reasoning Effort",
                  category: "thought_level",
                  type: "select",
                  currentValue: s.effort ?? "high",
                  options: cur._meta.reasoningEfforts.map((e) => ({
                    value: e.value,
                    name: e.value,
                  })),
                },
              ]
            : []),
        ],
      };
    }
    const reasoning = !/kimi|glm/.test(s.model);
    return {
      modes: {
        currentModeId: s.mode,
        availableModes: ["auto", "approve", "smart_approve"].map((id) => ({
          id,
          name: id,
        })),
      },
      configOptions: [
        {
          id: "provider",
          name: "Provider",
          type: "select",
          currentValue: "openrouter",
          options: [{ value: "openrouter", name: "OpenRouter" }],
        },
        {
          id: "mode",
          name: "Mode",
          category: "mode",
          type: "select",
          currentValue: s.mode,
          options: ["auto", "approve", "smart_approve"].map((value) => ({
            value,
            name: value,
          })),
        },
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: s.model,
          options: [{ value: s.model, name: s.model }],
        },
        {
          id: "thinking_effort",
          name: "Thinking effort",
          category: "thought_level",
          type: "select",
          currentValue: s.effort ?? "off",
          options: (reasoning
            ? ["off", "low", "medium", "high", "max"]
            : ["off"]
          ).map((value) => ({ value, name: value })),
        },
      ],
    };
  }

  const initial = () =>
    program === "agy"
      ? "gemini-3.1-pro-low"
      : program === "grok"
        ? "grok-4.6"
        : (process.env.GOOSE_MODEL ?? "mock-model");
  const initialMode = () =>
    program === "agy"
      ? "default"
      : program === "grok"
        ? "default"
        : (process.env.GOOSE_MODE ?? "auto");

  async function handle(m: any) {
    const p = m.params ?? {};
    log({ method: m.method, params: p });
    const reply = (result: unknown) => send({ id: m.id, result });
    const error = (code: number, message: string, data?: unknown) =>
      send({
        id: m.id,
        error: { code, message, ...(data === undefined ? {} : { data }) },
      });
    switch (m.method) {
      case "initialize":
        customNotifications = p.clientCapabilities?._meta?.goose?.customNotifications === true;
        return reply({
          protocolVersion: 1,
          agentCapabilities:
            program === "agy"
              ? {
                  loadSession: true,
                  sessionCapabilities: { resume: {}, close: {}, list: {} },
                }
              : program === "grok"
                ? {
                    loadSession: true,
                    mcpCapabilities: { http: true, sse: true },
                    sessionCapabilities: { list: {}, resume: {}, close: {} },
                  }
                : {
                    loadSession: true,
                    mcpCapabilities: { http: true, sse: false },
                    sessionCapabilities: { list: {}, delete: {}, close: {} },
                  },
          authMethods: [],
        });
      case "session/new": {
        if (!credential()) return error(-32000, "Authentication required");
        const id =
          program === "goose"
            ? `20261121_${Date.now() % 100000}${Math.floor(Math.random() * 100)}`
            : crypto.randomUUID();
        const s: Session = {
          id,
          cwd: p.cwd,
          history: [],
          model: initial(),
          effort: null,
          mode: initialMode(),
          mcpServers: p.mcpServers,
          meta: p._meta ?? null,
        };
        open.set(id, s);
        save(s);
        return reply({ sessionId: id, ...advertised(s) });
      }
      case "session/load":
      case "session/resume": {
        if (m.method === "session/resume" && program === "goose")
          return error(-32601, "Method not found");
        const s = loadFile(p.sessionId);
        if (!s)
          return error(-32002, "Resource not found", {
            sessionId: p.sessionId,
          });
        s.mcpServers = p.mcpServers;
        open.set(s.id, s);
        if (m.method === "session/load")
          for (const h of s.history)
            update(s.id, {
              sessionUpdate:
                h.role === "user"
                  ? "user_message_chunk"
                  : "agent_message_chunk",
              content: { type: "text", text: h.text },
            });
        return reply(advertised(s));
      }
      case "session/close":
        open.delete(p.sessionId);
        return reply({});
      case "session/delete":
        open.delete(p.sessionId);
        rmSync(file(p.sessionId), { force: true });
        return reply({});
      case "session/set_model": {
        if (program === "goose") return error(-32601, "Method not found");
        const s = open.get(p.sessionId);
        if (!s) return error(-32002, "Resource not found");
        const known = JSON.stringify(advertised(s).models ?? {});
        if (!known.includes(`"${p.modelId}"`))
          return error(-32602, "Invalid params", "unknown model id");
        s.model = p.modelId;
        if (program === "agy")
          s.effort = p.modelId.match(/-(low|medium|high|xhigh)$/)?.[1] ?? null;
        save(s);
        return reply({});
      }
      case "session/set_mode": {
        const s = open.get(p.sessionId);
        if (!s) return error(-32002, "Resource not found");
        s.mode = p.modeId;
        save(s);
        update(s.id, {
          sessionUpdate: "current_mode_update",
          currentModeId: p.modeId,
        });
        return reply({});
      }
      case "session/set_config_option": {
        const s = open.get(p.sessionId);
        if (!s) return error(-32002, "Resource not found");
        const opt = advertised(s).configOptions.find(
          (o: any) => o.id === p.configId,
        );
        if (!opt) return error(-32602, "Invalid params", "unknown option");
        if (p.configId === "model") {
          if (
            program !== "goose" &&
            !opt.options.some((o: any) => o.value === p.value)
          )
            return error(-32602, "Invalid params", "unknown model");
          s.model =
            program === "agy" ? `${p.value}-${s.effort ?? "low"}` : p.value;
        } else if (opt.category === "thought_level") {
          if (!opt.options.some((o: any) => o.value === p.value))
            return error(-32602, "Invalid params", "unknown effort");
          s.effort = p.value;
          if (program === "agy")
            s.model = `${s.model.replace(/-(low|medium|high|xhigh)$/, "")}-${p.value}`;
        } else if (p.configId === "mode") s.mode = p.value;
        save(s);
        return reply({ configOptions: advertised(s).configOptions });
      }
      case "session/prompt":
        return prompt(m, p);
      case "_x.ai/auth/check_subscription":
        if (program !== "grok") return error(-32601, "Method not found");
        return reply({
          authenticated: true,
          meta: {
            email: "person@example.invalid",
            subscription_tier: "SuperGrok",
          },
        });
      default:
        return error(-32601, "Method not found");
    }
  }

  /** Prompts refused as busy, by session. */
  const busy = new Map<string, number>();
  async function prompt(m: any, p: any) {
    const reply = (result: unknown) => send({ id: m.id, result });
    const s = open.get(p.sessionId) ?? loadFile(p.sessionId);
    if (!s)
      return send({
        id: m.id,
        error: { code: -32002, message: "Resource not found" },
      });
    const text: string = (p.prompt ?? [])
      .map((b: any) => b.text ?? "")
      .join("");
    // goose after session/load: a run of its own is still finishing; twice "busy", then the prompt.
    if (text.includes("BUSY") && (busy.get(s.id) ?? 0) < 2) {
      busy.set(s.id, (busy.get(s.id) ?? 0) + 1);
      return send({
        id: m.id,
        error: {
          code: -32602,
          message: "Invalid params",
          data: `session already has active run \`resume_${s.id}\`; use _goose/unstable/session/steer`,
        },
      });
    }
    const turn = s.history.filter((h) => h.role === "user").length + 1;
    const say = (t: string, messageId?: string) => {
      update(s.id, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: t },
        ...(messageId ? { messageId } : {}),
      });
      s.history.push({ role: "agent", text: t });
    };
    const done = (stopReason: string) => {
      s.history.push({ role: "user", text });
      save(s);
      const usage = {
        inputTokens: 1000 * turn,
        outputTokens: 20,
        cachedReadTokens: 100,
        cachedWriteTokens: 0,
        totalTokens: 1000 * turn + 20,
      };
      if (program === "grok")
        return reply({
          stopReason,
          _meta: {
            totalTokens: 1200 * turn,
            usage: {
              inputTokens: 1000,
              outputTokens: 20,
              cachedReadTokens: 100,
              cacheCreationTokens: 5,
            },
          },
        });
      // goose: its last request in the response, the session's totals in its own notification
      // (to clients that ask); agy: this turn's.
      if (program === "goose" && customNotifications)
        send({
          method: "_goose/unstable/session/update",
          params: { sessionId: s.id, update: { sessionUpdate: "usage_update", used: 1000, contextLimit: 128000, accumulatedInputTokens: 1000 * turn, accumulatedOutputTokens: 20 * turn } },
        });
      return reply({
        stopReason,
        usage: { ...usage, inputTokens: 1000, totalTokens: 1020 },
      });
    };
    if (program !== "grok")
      update(s.id, {
        sessionUpdate: "usage_update",
        used: 1000 * turn,
        size: program === "agy" ? 1048576 : 128000,
      });
    if (text.includes("AUTH"))
      return send({
        id: m.id,
        error: {
          code: -32000,
          message: "Authentication required",
          data: { reason: "turn_failed" },
        },
      });
    const failure = text.match(/FAIL:(.*)$/s)?.[1];
    if (failure !== undefined) {
      if (program === "grok" && /429/.test(failure))
        return send({
          id: m.id,
          error: { code: -32003, message: "Rate limited", data: failure },
        });
      if (program === "grok" && /401/.test(failure))
        return send({
          id: m.id,
          error: {
            code: -32603,
            message: "Internal error",
            data: { message: failure, http_status: 401 },
          },
        });
      if (program === "goose" && /credits/.test(failure))
        return send({
          id: m.id,
          error: {
            code: -32603,
            message: "Please add credits to your OpenRouter account.",
            data: { reason: "credits_exhausted" },
          },
        });
      return send({
        id: m.id,
        error: {
          code: -32603,
          message: "Internal error",
          data: { details: failure },
        },
      });
    }
    // agy's own way to report a failed model request: as assistant text, then a normal end.
    const shown = text.match(/SHOWERR=(.*)$/s)?.[1];
    if (shown !== undefined) {
      say(` ⚠ API error (attempt 1): ${shown}`);
      if (!shown.includes("RECOVER")) {
        say(` ⚠ agent executor error: generating and executing: ${shown}`);
        return done("end_turn");
      }
      say("recovered");
      return done("end_turn");
    }
    if (text.includes("EXIT")) {
      process.stderr.write("panic: something broke\n");
      process.exit(3);
    }
    if (text.includes("THINK")) {
      update(s.id, {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "secret thoughts" },
      });
      say("thought about it");
      return done("end_turn");
    }
    if (text.includes("RECALL")) {
      say(
        `earlier: ${s.history
          .filter((h) => h.role === "user")
          .map((h) => h.text)
          .join(" | ")}`,
      );
      return done("end_turn");
    }
    if (text.includes("CONFIG")) {
      say(
        JSON.stringify({
          model: s.model,
          effort: s.effort,
          mode: s.mode,
          mcpServers: s.mcpServers,
          meta: s.meta,
        }),
      );
      return done("end_turn");
    }
    if (text.includes("TOOL") || text.includes("EDIT")) {
      const edit = text.includes("EDIT");
      const call = edit
        ? {
            toolCallId: "call_1",
            title: "Write notes.md",
            kind: "edit",
            status: "pending",
            locations: [{ path: `${s.cwd}/notes.md` }],
            rawInput: { path: "notes.md" },
          }
        : {
            toolCallId: "call_1",
            title: "echo hi",
            kind: "execute",
            status: "pending",
            rawInput: { command: "echo hi" },
            ...(program === "agy"
              ? { name: "run_command" }
              : program === "goose"
                ? { _meta: { goose: { toolCall: { toolName: "shell" } } } }
                : { name: "run_terminal_command" }),
          };
      say("Let me run it.", "m1");
      update(s.id, { sessionUpdate: "tool_call", ...call });
      const options =
        program === "agy"
          ? [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "deny", name: "Deny", kind: "reject_once" },
            ]
          : program === "grok"
            ? [
                {
                  optionId: "always-allow",
                  name: "Always allow",
                  kind: "allow_always",
                },
                {
                  optionId: "allow-once",
                  name: "Allow once",
                  kind: "allow_once",
                },
                {
                  optionId: "reject-once",
                  name: "Reject",
                  kind: "reject_once",
                },
              ]
            : [
                "allow_always",
                "allow_once",
                "reject_once",
                "reject_always",
              ].map((k) => ({ optionId: k, name: k, kind: k }));
      const answer = await request("session/request_permission", {
        sessionId: s.id,
        toolCall: { ...call },
        options,
      });
      log({ permission: answer });
      const chosen = options.find(
        (o) => o.optionId === answer?.outcome?.optionId,
      );
      if (answer?.outcome?.outcome === "cancelled") {
        update(s.id, {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_1",
          status: "failed",
        });
        return done("cancelled");
      }
      if (chosen?.kind.startsWith("allow")) {
        update(s.id, {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_1",
          status: "in_progress",
        });
        update(s.id, {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_1",
          status: "completed",
          rawOutput: { stdout: "hi" },
        });
        say("ran it: hi", "m2");
      } else {
        update(s.id, {
          sessionUpdate: "tool_call_update",
          toolCallId: "call_1",
          status: "failed",
        });
        say("it was denied", "m2");
      }
      return done("end_turn");
    }
    if (text.includes("SLOW")) {
      update(s.id, {
        sessionUpdate: "tool_call",
        toolCallId: "call_slow",
        title: "sleep 600",
        kind: "execute",
        status: "in_progress",
      });
      await new Promise<void>((r) => cancels.set(s.id, r));
      update(s.id, {
        sessionUpdate: "tool_call_update",
        toolCallId: "call_slow",
        status: "failed",
      });
      return done("cancelled");
    }
    say("Hello");
    say(", world");
    return done("end_turn");
  }

  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d: string) => {
    buf += d;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.method === undefined) {
        waiting.get(m.id)?.(m.result);
        waiting.delete(m.id);
      } else if (m.method === "session/cancel") {
        log({ method: "session/cancel", params: m.params });
        cancels.get(m.params.sessionId)?.();
        cancels.delete(m.params.sessionId);
      } else void handle(m);
    }
  });
  process.stdin.on("end", () => process.exit(0));
  process.on("SIGTERM", () => {
    log({ signal: "SIGTERM" });
    process.exit(0);
  });
}

function pick(env: NodeJS.ProcessEnv, names: string[]) {
  return Object.fromEntries(
    names.filter((n) => env[n] !== undefined).map((n) => [n, env[n]]),
  );
}
