// Minimal Docker Engine API client: plain HTTP over the Engine socket (or a socket proxy over TCP).
// Only the calls the runtime controller needs; no Docker CLI, no credential helpers.

export class DockerError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type ExecResult = { exitCode: number; stdout: string };

export function dockerClient(host: string) {
  const unix = host.startsWith("unix://")
    ? host.slice("unix://".length)
    : undefined;
  const base = unix ? "http://docker" : host.replace(/^tcp:\/\//, "http://");
  const prefix = `${base}/v1.44`;

  async function raw(
    method: string,
    path: string,
    body?: BodyInit,
    contentType = "application/json",
  ) {
    const res = await fetch(prefix + path, {
      method,
      body,
      unix,
      headers: body === undefined ? {} : { "content-type": contentType },
    } as RequestInit);
    if (res.status >= 400) {
      // Engine error messages describe the request (names, paths); they never carry exec output.
      const text = await res.text();
      let message = text;
      try {
        message = JSON.parse(text).message ?? text;
      } catch {}
      throw new DockerError(
        res.status,
        `${method} ${path.split("?")[0]}: ${res.status} ${message}`.slice(
          0,
          300,
        ),
      );
    }
    return res;
  }

  async function json<T = any>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await raw(
      method,
      path,
      body === undefined ? undefined : JSON.stringify(body),
    );
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  /** Runs a command in a running container; stdout is returned to the caller only, never logged. */
  async function exec(
    container: string,
    cmd: string[],
    user?: string,
  ): Promise<ExecResult> {
    const { Id } = await json<{ Id: string }>(
      "POST",
      `/containers/${encodeURIComponent(container)}/exec`,
      {
        Cmd: cmd,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        ...(user ? { User: user } : {}),
      },
    );
    const bytes = await hijack(
      `/exec/${Id}/start`,
      JSON.stringify({ Detach: false, Tty: false }),
    );
    const stdout = demux(bytes, 1);
    const info = await json<{ ExitCode: number | null }>(
      "GET",
      `/exec/${Id}/json`,
    );
    return { exitCode: info.ExitCode ?? -1, stdout };
  }

  /**
   * Exec output comes over a hijacked connection. Like the Docker CLI, ask for the upgrade
   * explicitly: the Engine then answers 101 and streams until the command exits, and socket proxies
   * (Sockguard always upgrades) behave the same way. fetch() cannot read an upgraded connection.
   */
  async function hijack(path: string, body: string): Promise<Uint8Array> {
    const url = new URL(prefix + path);
    const request =
      `POST ${url.pathname} HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\n` +
      `Connection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    const chunks: Uint8Array[] = [];
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`POST ${path}: timed out`)),
        60_000,
      );
      const handlers = {
        open: (socket: { write(data: string): number }) =>
          void socket.write(request),
        data: (socket: { end(): void }, data: Uint8Array) => {
          chunks.push(new Uint8Array(data));
          // A stream (101) ends when the Engine closes it; a sized reply ends after Content-Length.
          const head = Buffer.concat(chunks);
          const end = head.indexOf("\r\n\r\n");
          if (head.subarray(9, 12).toString() === "101") return;
          const length = /\r\ncontent-length: *(\d+)/i.exec(
            head.subarray(0, Math.max(end, 0)).toString(),
          );
          if (end >= 0 && length && head.length >= end + 4 + Number(length[1]))
            socket.end();
        },
        close: () => (clearTimeout(timer), resolve()),
        error: (_: unknown, e: Error) => (clearTimeout(timer), reject(e)),
      };
      const connect = unix
        ? Bun.connect({ unix, socket: handlers })
        : Bun.connect({
            hostname: url.hostname,
            port: Number(url.port || 80),
            socket: handlers,
          });
      connect.catch(reject);
    });
    const all = Buffer.concat(chunks);
    const end = all.indexOf("\r\n\r\n");
    const status = Number(
      all.subarray(0, Math.max(end, 0)).toString().split(" ")[1],
    );
    if (end < 0 || !(status === 101 || status === 200))
      throw new DockerError(
        status || 502,
        `POST ${path}: ${status || "no response"}`,
      );
    return new Uint8Array(all.subarray(end + 4));
  }

  /** Writes one private file into a container (also a stopped one) through the archive API. */
  async function putFile(
    container: string,
    dir: string,
    name: string,
    content: string,
    mode = 0o600,
  ) {
    const q = new URLSearchParams({ path: dir, copyUIDGID: "true" });
    await raw(
      "PUT",
      `/containers/${encodeURIComponent(container)}/archive?${q}`,
      tarOne(name, content, mode).buffer as ArrayBuffer,
      "application/x-tar",
    );
  }

  return { json, raw, exec, putFile };
}

export type Docker = ReturnType<typeof dockerClient>;

/** Docker's multiplexed stream: 8-byte header (stream, 0, 0, 0, size BE32) + payload. */
export function demux(bytes: Uint8Array, stream: 1 | 2): string {
  const out: Uint8Array[] = [];
  let i = 0;
  while (i + 8 <= bytes.length) {
    const size = new DataView(
      bytes.buffer,
      bytes.byteOffset + i + 4,
      4,
    ).getUint32(0);
    if (bytes[i] === stream) out.push(bytes.subarray(i + 8, i + 8 + size));
    i += 8 + size;
  }
  return new TextDecoder().decode(Buffer.concat(out));
}

/** A one-file POSIX tar archive (ustar), enough for the Engine's archive endpoint. */
export function tarOne(
  name: string,
  content: string,
  mode: number,
): Uint8Array {
  const data = new TextEncoder().encode(content);
  const header = new Uint8Array(512);
  const put = (offset: number, value: string) =>
    header.set(new TextEncoder().encode(value), offset);
  const octal = (n: number, width: number) =>
    n.toString(8).padStart(width - 1, "0") + "\0";
  put(0, name);
  put(100, octal(mode, 8));
  put(108, octal(0, 8));
  put(116, octal(0, 8));
  put(124, octal(data.length, 12));
  put(136, octal(Math.floor(Date.now() / 1000), 12));
  put(148, "        ");
  put(156, "0");
  put(257, "ustar\0");
  put(263, "00");
  put(
    148,
    octal(
      header.reduce((a, b) => a + b, 0),
      7,
    ) + " ",
  );
  const padded = Math.ceil(data.length / 512) * 512;
  const archive = new Uint8Array(512 + padded + 1024);
  archive.set(header, 0);
  archive.set(data, 512);
  return archive;
}
