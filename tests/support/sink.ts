// A TurnSink that records everything a turn reports and answers questions with a test's function.
import type {
  Answers,
  Ask,
  ContextView,
  ToolView,
  TurnSink,
  UsageView,
} from "../../src/agents/types";

export class RecordingSink implements TurnSink {
  sessions: string[] = [];
  deltas: [string, string][] = [];
  texts = new Map<string, string>();
  tools: [string, ToolView][] = [];
  asks: Ask[] = [];
  contexts: (ContextView | null)[] = [];
  usages: UsageView[] = [];
  /** Called with each tool report (an abort when a tool starts, say). */
  onTool: ((t: ToolView) => void) | null = null;

  constructor(
    private answer: (
      ask: Ask,
    ) => Answers | null | Promise<Answers | null> = () => null,
  ) {}

  session(id: string) {
    this.sessions.push(id);
  }
  delta(item: string, append: string) {
    this.deltas.push([item, append]);
  }
  text(item: string, text: string) {
    this.texts.set(item, text);
  }
  tool(item: string, tool: ToolView) {
    this.tools.push([item, tool]);
    this.onTool?.(tool);
  }
  async ask(ask: Ask) {
    this.asks.push(ask);
    return this.answer(ask);
  }
  context(context: ContextView | null) {
    this.contexts.push(context);
  }
  usage(usage: UsageView) {
    this.usages.push(usage);
  }

  /** What the deltas built, per item. */
  streamed(item: string) {
    return this.deltas
      .filter(([i]) => i === item)
      .map(([, d]) => d)
      .join("");
  }
  /** Every reported text, joined (one turn is one message for Codex). */
  allText() {
    return [...this.texts.values()].join("\n");
  }
  /** The last status of each tool, by id. */
  toolStatus() {
    return Object.fromEntries(this.tools.map(([, t]) => [t.id, t.status]));
  }
}

/** Answers a permission question with one label. */
export const choose =
  (label: string) =>
  (ask: Ask): Answers => ({ [ask.prompts[0]!.id]: [label] });
