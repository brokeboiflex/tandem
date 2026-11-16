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
    const res = await raw(
      "POST",
      `/exec/${Id}/start`,
      JSON.stringify({ Detach: false, Tty: false }),
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    const stdout = demux(bytes, 1);
    const info = await json<{ ExitCode: number | null }>(
      "GET",
      `/exec/${Id}/json`,
    );
    return { exitCode: info.ExitCode ?? -1, stdout };
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
