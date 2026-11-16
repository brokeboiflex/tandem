// Server-Sent Events: a tiny frame parser (daemon stream, e2e client) and frame encoder.
export type SseFrame = { id: string; event: string; data: string };

export async function* sseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const frame: SseFrame = { id: "", event: "message", data: "" };
      let seen = false;
      for (const line of raw.split("\n")) {
        if (!line || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const key = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        seen = true;
        if (key === "id") frame.id = value;
        else if (key === "event") frame.event = value;
        else if (key === "data")
          frame.data = frame.data ? `${frame.data}\n${value}` : value;
      }
      if (seen) yield frame;
    }
  }
}

const encoder = new TextEncoder();
export const sseEncode = (event: string, data: unknown) =>
  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
export const sseComment = (text: string) => encoder.encode(`: ${text}\n\n`);
