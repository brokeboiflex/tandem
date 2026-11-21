// The gateway's own state, in one SQLite file in DATA_DIR. It lives outside every person's home:
// a home is writable from that person's sandbox, so nothing the gateway trusts (API keys, MCP
// registrations, the conversation list) is kept there. Reads of conversations and messages answer
// from here, so they never start anything.
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ContextView,
  Failure,
  ProviderId,
  ToolView,
  UsageView,
} from "./agents/types";

export type ConversationRow = {
  id: string;
  provider: ProviderId;
  model: string;
  effort: string | null;
  /** The vendor's own session/thread id, once the first turn has one. */
  session: string | null;
  /** The person's own title, else null. */
  title: string | null;
  /** Generated from the first message. */
  autoTitle: string | null;
  archivedAt: number | null;
  createdAt: number;
  lastActivityAt: number;
  context: ContextView | null;
  usage: UsageView | null;
};

export type RunRow = {
  id: string;
  conversation: string;
  status: "running" | "completed" | "aborted" | "failed";
  failure: Failure | null;
  startedAt: number;
  endedAt: number | null;
};

export type MessageRow = {
  id: string;
  conversation: string;
  runId: string | null;
  role: "user" | "assistant" | "error";
  createdAt: number;
  text: string;
  tools: ToolView[];
  failure: Failure | null;
};

export type McpRegistration = {
  name: string;
  url: string;
  enabledTools?: string[];
  description?: string;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  person TEXT NOT NULL, id TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
  effort TEXT, session TEXT, title TEXT, auto_title TEXT, archived_at INTEGER,
  created_at INTEGER NOT NULL, last_activity_at INTEGER NOT NULL, context TEXT, usage TEXT,
  PRIMARY KEY (person, id)
);
CREATE INDEX IF NOT EXISTS conversations_activity
  ON conversations (person, archived_at, last_activity_at DESC, id);
CREATE TABLE IF NOT EXISTS runs (
  person TEXT NOT NULL, id TEXT NOT NULL, conversation TEXT NOT NULL, seq INTEGER NOT NULL,
  status TEXT NOT NULL, failure TEXT, started_at INTEGER NOT NULL, ended_at INTEGER,
  PRIMARY KEY (person, id)
);
CREATE INDEX IF NOT EXISTS runs_conversation ON runs (person, conversation, seq);
CREATE TABLE IF NOT EXISTS messages (
  person TEXT NOT NULL, id TEXT NOT NULL, conversation TEXT NOT NULL, run_id TEXT,
  seq INTEGER NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL, text TEXT NOT NULL,
  tools TEXT NOT NULL, failure TEXT,
  PRIMARY KEY (person, id)
);
CREATE INDEX IF NOT EXISTS messages_run ON messages (person, run_id, seq);
CREATE TABLE IF NOT EXISTS providers (
  person TEXT NOT NULL, provider TEXT NOT NULL, view TEXT NOT NULL, checked_at INTEGER NOT NULL,
  PRIMARY KEY (person, provider)
);
CREATE TABLE IF NOT EXISTS api_keys (
  person TEXT NOT NULL, provider TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (person, provider)
);
CREATE TABLE IF NOT EXISTS settings (
  person TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,
  PRIMARY KEY (person, name)
);
`;

const parse = <T>(v: unknown): T | null => {
  if (typeof v !== "string") return null;
  try {
    return JSON.parse(v) as T;
  } catch {
    return null;
  }
};

const toConversation = (r: any): ConversationRow => ({
  id: r.id,
  provider: r.provider,
  model: r.model,
  effort: r.effort ?? null,
  session: r.session ?? null,
  title: r.title ?? null,
  autoTitle: r.auto_title ?? null,
  archivedAt: r.archived_at ?? null,
  createdAt: r.created_at,
  lastActivityAt: r.last_activity_at,
  context: parse(r.context),
  usage: parse(r.usage),
});

const toRun = (r: any): RunRow => ({
  id: r.id,
  conversation: r.conversation,
  status: r.status,
  failure: parse(r.failure),
  startedAt: r.started_at,
  endedAt: r.ended_at ?? null,
});

const toMessage = (r: any): MessageRow => ({
  id: r.id,
  conversation: r.conversation,
  runId: r.run_id ?? null,
  role: r.role,
  createdAt: r.created_at,
  text: r.text,
  tools: parse(r.tools) ?? [],
  failure: parse(r.failure),
});

const COLUMNS: Record<string, string> = {
  model: "model",
  effort: "effort",
  session: "session",
  title: "title",
  autoTitle: "auto_title",
  archivedAt: "archived_at",
  lastActivityAt: "last_activity_at",
  context: "context",
  usage: "usage",
};

export class Store {
  readonly db: Database;
  #seq = Date.now() * 1000;

  constructor(path: string) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const fresh = !existsSync(path);
      this.db = new Database(path, { create: true });
      if (fresh) chmodSync(path, 0o600);
    } else this.db = new Database(":memory:");
    this.db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = OFF;",
    );
    this.db.exec(SCHEMA);
  }

  /** Strictly increasing within this process, ordered across restarts (time-based). */
  #next() {
    return (this.#seq = Math.max(this.#seq + 1, Date.now() * 1000));
  }

  close() {
    this.db.close();
  }

  // --- Conversations ---------------------------------------------------------------------------

  createConversation(
    person: string,
    c: Pick<
      ConversationRow,
      "id" | "provider" | "model" | "effort" | "title" | "createdAt"
    >,
  ): ConversationRow {
    this.db
      .query(
        `INSERT INTO conversations (person, id, provider, model, effort, title, created_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        person,
        c.id,
        c.provider,
        c.model,
        c.effort,
        c.title,
        c.createdAt,
        c.createdAt,
      );
    return this.conversation(person, c.id)!;
  }

  /** Archived conversations included; callers decide. */
  conversation(person: string, id: string): ConversationRow | null {
    const r = this.db
      .query(`SELECT * FROM conversations WHERE person = ? AND id = ?`)
      .get(person, id);
    return r ? toConversation(r) : null;
  }

  updateConversation(
    person: string,
    id: string,
    patch: Partial<Omit<ConversationRow, "id" | "provider" | "createdAt">>,
  ) {
    const sets: string[] = [];
    const values: any[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = COLUMNS[k];
      if (!col) continue;
      sets.push(`${col} = ?`);
      values.push(
        k === "context" || k === "usage"
          ? v == null
            ? null
            : JSON.stringify(v)
          : v,
      );
    }
    if (!sets.length) return;
    this.db
      .query(
        `UPDATE conversations SET ${sets.join(", ")} WHERE person = ? AND id = ?`,
      )
      .run(...values, person, id);
  }

  /**
   * Newest activity first, archived ones left out. `cursor` continues after the last row of the
   * previous page; `query` matches the displayed title, case-insensitively.
   */
  listConversations(
    person: string,
    opts: {
      limit: number;
      cursor?: { at: number; id: string } | null;
      query?: string;
    },
  ): { rows: ConversationRow[]; more: boolean } {
    const where = ["person = ?", "archived_at IS NULL"];
    const values: any[] = [person];
    if (opts.query) {
      where.push(`instr(lower(coalesce(title, auto_title, '')), ?) > 0`);
      values.push(opts.query.toLowerCase());
    }
    if (opts.cursor) {
      where.push(`(last_activity_at < ? OR (last_activity_at = ? AND id > ?))`);
      values.push(opts.cursor.at, opts.cursor.at, opts.cursor.id);
    }
    const rows = this.db
      .query(
        `SELECT * FROM conversations WHERE ${where.join(" AND ")}
         ORDER BY last_activity_at DESC, id ASC LIMIT ?`,
      )
      .all(...values, opts.limit + 1)
      .map(toConversation);
    return { rows: rows.slice(0, opts.limit), more: rows.length > opts.limit };
  }

  // --- Runs and messages -----------------------------------------------------------------------

  addRun(
    person: string,
    conversation: string,
    id: string,
    startedAt: number,
  ): RunRow {
    this.db
      .query(
        `INSERT INTO runs (person, id, conversation, seq, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)`,
      )
      .run(person, id, conversation, this.#next(), startedAt);
    return this.run(person, id)!;
  }

  run(person: string, id: string): RunRow | null {
    const r = this.db
      .query(`SELECT * FROM runs WHERE person = ? AND id = ?`)
      .get(person, id);
    return r ? toRun(r) : null;
  }

  endRun(
    person: string,
    id: string,
    status: RunRow["status"],
    failure: Failure | null,
    at: number,
  ) {
    this.db
      .query(
        `UPDATE runs SET status = ?, failure = ?, ended_at = ? WHERE person = ? AND id = ?`,
      )
      .run(status, failure ? JSON.stringify(failure) : null, at, person, id);
  }

  /** Upserts one message; its position is fixed by its first write. */
  putMessage(person: string, m: MessageRow) {
    this.db
      .query(
        `INSERT INTO messages (person, id, conversation, run_id, seq, role, created_at, text, tools, failure)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (person, id) DO UPDATE SET text = excluded.text, tools = excluded.tools,
           failure = excluded.failure`,
      )
      .run(
        person,
        m.id,
        m.conversation,
        m.runId,
        this.#next(),
        m.role,
        m.createdAt,
        m.text,
        JSON.stringify(m.tools),
        m.failure ? JSON.stringify(m.failure) : null,
      );
  }

  /**
   * The newest `limit` runs (before run `before` when given), oldest first, with their messages in
   * order; `hasMore` when older runs exist.
   */
  page(
    person: string,
    conversation: string,
    opts: { limit: number; before?: string | null },
  ): { runs: RunRow[]; messages: MessageRow[]; hasMore: boolean } {
    const anchor = opts.before
      ? (this.db
          .query(
            `SELECT seq FROM runs WHERE person = ? AND conversation = ? AND id = ?`,
          )
          .get(person, conversation, opts.before) as { seq: number } | null)
      : null;
    const rows = this.db
      .query(
        `SELECT * FROM runs WHERE person = ? AND conversation = ? ${anchor ? "AND seq < ?" : ""}
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(
        ...([
          person,
          conversation,
          ...(anchor ? [anchor.seq] : []),
          opts.limit + 1,
        ] as any[]),
      );
    const runs = rows.slice(0, opts.limit).reverse().map(toRun);
    const messages = runs.length
      ? this.db
          .query(
            `SELECT * FROM messages WHERE person = ? AND run_id IN (${runs.map(() => "?").join(",")})
             ORDER BY seq ASC`,
          )
          .all(person, ...runs.map((r) => r.id))
          .map(toMessage)
      : [];
    return { runs, messages, hasMore: rows.length > opts.limit };
  }

  /** At startup: a run the previous gateway process left running ended with it. */
  failInterruptedRuns(failure: Failure, at: number) {
    return this.db
      .query(
        `UPDATE runs SET status = 'failed', failure = ?, ended_at = ? WHERE status = 'running'`,
      )
      .run(JSON.stringify(failure), at).changes;
  }

  // --- Provider cache, API keys, settings ------------------------------------------------------

  provider<T>(
    person: string,
    provider: ProviderId,
  ): { view: T; checkedAt: number } | null {
    const r: any = this.db
      .query(
        `SELECT view, checked_at FROM providers WHERE person = ? AND provider = ?`,
      )
      .get(person, provider);
    const view = r ? parse<T>(r.view) : null;
    return view ? { view, checkedAt: r.checked_at } : null;
  }

  putProvider(
    person: string,
    provider: ProviderId,
    view: unknown,
    checkedAt: number,
  ) {
    this.db
      .query(
        `INSERT INTO providers (person, provider, view, checked_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (person, provider) DO UPDATE SET view = excluded.view, checked_at = excluded.checked_at`,
      )
      .run(person, provider, JSON.stringify(view), checkedAt);
  }

  apiKey(person: string, provider: string): string | null {
    const r: any = this.db
      .query(`SELECT value FROM api_keys WHERE person = ? AND provider = ?`)
      .get(person, provider);
    return r?.value ?? null;
  }

  setApiKey(person: string, provider: string, value: string | null) {
    if (value === null)
      this.db
        .query(`DELETE FROM api_keys WHERE person = ? AND provider = ?`)
        .run(person, provider);
    else
      this.db
        .query(
          `INSERT INTO api_keys (person, provider, value) VALUES (?, ?, ?)
           ON CONFLICT (person, provider) DO UPDATE SET value = excluded.value`,
        )
        .run(person, provider, value);
  }

  setting<T>(person: string, name: string): T | null {
    const r: any = this.db
      .query(`SELECT value FROM settings WHERE person = ? AND name = ?`)
      .get(person, name);
    return r ? parse<T>(r.value) : null;
  }

  setSetting(person: string, name: string, value: unknown) {
    if (value === null || value === undefined)
      this.db
        .query(`DELETE FROM settings WHERE person = ? AND name = ?`)
        .run(person, name);
    else
      this.db
        .query(
          `INSERT INTO settings (person, name, value) VALUES (?, ?, ?)
           ON CONFLICT (person, name) DO UPDATE SET value = excluded.value`,
        )
        .run(person, name, JSON.stringify(value));
  }
}
