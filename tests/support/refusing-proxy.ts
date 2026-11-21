// An HTTP(S) proxy that refuses everything and remembers what was asked for: as HTTPS_PROXY it
// keeps a vendor CLI from reaching any real service and shows what it tried to reach.
export function startRefusingProxy(
  opts: { port?: number; unix?: string } = {},
) {
  const attempts: string[] = [];
  const handler = {
    data(socket: any, data: Buffer) {
      const line = data.toString("latin1").split("\r\n")[0] ?? "";
      const target = /^(\S+) (\S+)/.exec(line);
      if (target) attempts.push(`${target[1]} ${target[2]}`);
      socket.write(
        "HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
      );
      socket.end();
    },
  };
  const server = opts.unix
    ? Bun.listen({ unix: opts.unix, socket: handler })
    : Bun.listen({
        hostname: "127.0.0.1",
        port: opts.port ?? 0,
        socket: handler,
      });
  return {
    url: opts.unix ? null : `http://127.0.0.1:${(server as any).port}`,
    attempts,
    stop: () => server.stop(true),
  };
}
