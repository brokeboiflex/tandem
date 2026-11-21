// The gateway's own store: paging back by runs, search, and runs a dead gateway left running.
import { expect, test } from "bun:test";
import { Store } from "../src/store";
import { fail } from "../src/agents/failures";

const conv = (s: Store, person: string, id: string, at: number, title: string | null = null) =>
  s.createConversation(person, { id, provider: "claude", model: "claude-code/default", effort: "high", title, createdAt: at });

test("messages page back by runs, oldest first within a page", () => {
  const s = new Store(":memory:");
  conv(s, "p", "c1", 1);
  for (let i = 1; i <= 5; i++) {
    s.addRun("p", "c1", `r${i}`, i);
    s.putMessage("p", { id: `u${i}`, conversation: "c1", runId: `r${i}`, role: "user", createdAt: i, text: `q${i}`, tools: [], failure: null });
    s.putMessage("p", { id: `a${i}`, conversation: "c1", runId: `r${i}`, role: "assistant", createdAt: i, text: `a${i}`, tools: [], failure: null });
    s.endRun("p", `r${i}`, "completed", null, i);
  }
  const last = s.page("p", "c1", { limit: 2 });
  expect(last.runs.map((r) => r.id)).toEqual(["r4", "r5"]);
  expect(last.messages.map((m) => m.id)).toEqual(["u4", "a4", "u5", "a5"]);
  expect(last.hasMore).toBe(true);
  const older = s.page("p", "c1", { limit: 2, before: "r4" });
  expect(older.runs.map((r) => r.id)).toEqual(["r2", "r3"]);
  const first = s.page("p", "c1", { limit: 2, before: "r2" });
  expect(first.runs.map((r) => r.id)).toEqual(["r1"]);
  expect(first.hasMore).toBe(false);
  // An update keeps the message where it was.
  s.putMessage("p", { id: "u1", conversation: "c1", runId: "r1", role: "user", createdAt: 1, text: "edited", tools: [], failure: null });
  expect(s.page("p", "c1", { limit: 1, before: "r2" }).messages.map((m) => m.text)).toEqual(["edited", "a1"]);
  // Another person sees nothing of it.
  expect(s.page("q", "c1", { limit: 10 }).runs).toEqual([]);
});

test("conversations: newest first, search by shown title, archived ones left out", () => {
  const s = new Store(":memory:");
  conv(s, "p", "c1", 1, "Quarterly report");
  conv(s, "p", "c2", 2);
  s.updateConversation("p", "c2", { autoTitle: "draft an email" });
  conv(s, "p", "c3", 3, "archived");
  s.updateConversation("p", "c3", { archivedAt: 4 });
  expect(s.listConversations("p", { limit: 10 }).rows.map((c) => c.id)).toEqual(["c2", "c1"]);
  expect(s.listConversations("p", { limit: 10, query: "EMAIL" }).rows.map((c) => c.id)).toEqual(["c2"]);
  const page = s.listConversations("p", { limit: 1 });
  expect(page.more).toBe(true);
  expect(s.listConversations("p", { limit: 1, cursor: { at: 2, id: "c2" } }).rows.map((c) => c.id)).toEqual(["c1"]);
});

test("runs left running by a stopped gateway fail; keys and settings stay per person", () => {
  const s = new Store(":memory:");
  conv(s, "p", "c1", 1);
  s.addRun("p", "c1", "r1", 1);
  expect(s.failInterruptedRuns(fail.failed(), 2)).toBe(1);
  expect(s.run("p", "r1")).toMatchObject({ status: "failed", failure: { code: "failed" }, endedAt: 2 });
  s.setApiKey("p", "openrouter", "sk-or-x");
  expect(s.apiKey("q", "openrouter")).toBeNull();
  s.setApiKey("p", "openrouter", null);
  expect(s.apiKey("p", "openrouter")).toBeNull();
  s.setSetting("p", "instructions", "hi");
  expect(s.setting<string>("p", "instructions")).toBe("hi");
});
