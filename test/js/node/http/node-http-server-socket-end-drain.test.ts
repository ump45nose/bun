import { describe, expect, test } from "bun:test";
import { bunEnv, bunExe, tls as tlsCert } from "harness";
import { once } from "node:events";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import net from "node:net";
import type { Duplex } from "node:stream";
import tls from "node:tls";

// res.socket.end() half-closes the connection; the server must still release the
// socket (drain the unconsumed body on epoll, or take kqueue's EVFILT_WRITE
// EV_EOF from its own SHUT_WR) so server.close() resolves. On macOS that early
// close can RST the still-writing client, so the client's EPIPE is expected and
// the close wait must not be once(c, "close"), which would reject on it.
test("server.close() completes after res.socket.end() with a 2 MB upload in flight", async () => {
  await using proc = Bun.spawn({
    cmd: [
      bunExe(),
      "-e",
      `
        import { once } from "node:events";
        import http from "node:http";
        import net from "node:net";
        let sock;
        const handled = Promise.withResolvers();
        const server = http.createServer((req, res) => {
          res.writeHead(200, { Connection: "close" });
          sock = res.socket;
          res.socket.end();
          try { res.write("x"); } catch {}
          handled.resolve();
        });
        await once(server.listen(0, "127.0.0.1"), "listening");
        const port = server.address().port;
        const c = net.connect(port, "127.0.0.1");
        await once(c, "connect");
        const body = Buffer.alloc(2 * 1024 * 1024, 0x61);
        c.on("error", () => {});
        c.write("POST / HTTP/1.1\\r\\nHost: x\\r\\nContent-Length: " + body.length + "\\r\\nConnection: close\\r\\n\\r\\n");
        c.write(body);
        c.on("end", () => c.end());
        // Not once(c, "close"): that also registers an 'error' rejector, and on
        // macOS the 2 MB upload can hit EPIPE once the server's SHUT_WR +
        // resume drains the body. The write error is expected (and swallowed
        // above); rejecting socketClosed on it turned it into an uncaught
        // top-level rejection instead of exercising the drain/close path.
        const socketClosed = new Promise(r => c.once("close", r));
        await handled.promise;
        const serverClosed = new Promise(r => server.close(() => r()));
        const watchdog = setTimeout(() => {
          process.stdout.write("timeout destroyed=" + (sock?.destroyed ?? "none") + "\\n");
          process.exit(1);
        }, 10000);
        await Promise.all([socketClosed, serverClosed]);
        clearTimeout(watchdog);
        process.stdout.write("closed destroyed=" + sock.destroyed + "\\n");
      `,
    ],
    env: bunEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
  expect({ stdout, stderr, exitCode }).toEqual({ stdout: "closed destroyed=true\n", stderr: "", exitCode: 0 });
});

// In Node the response and the raw socket share one net.Socket Writable, so the
// FIN of socket.end() / destroySoon() follows every byte the response wrote.
describe.each(["http", "https"] as const)("%s: the raw socket's FIN follows the bytes the response wrote", protocol => {
  type Handler = (req: IncomingMessage, res: ServerResponse) => void;
  const cases: [string, Handler, string][] = [
    [
      "res.write() then req.socket.destroySoon()",
      (req, res) => {
        res.write("PART1");
        req.socket.destroySoon();
      },
      "5\r\nPART1\r\n",
    ],
    [
      "res.write() then res.socket.end()",
      (req, res) => {
        res.write("PART1");
        res.socket!.end();
      },
      "5\r\nPART1\r\n",
    ],
    [
      "res.write() then res.socket.end() from a microtask",
      (req, res) => {
        res.write("PART1");
        queueMicrotask(() => res.socket!.end());
      },
      "5\r\nPART1\r\n",
    ],
    [
      "res.flushHeaders() then res.socket.end()",
      (req, res) => {
        res.flushHeaders();
        res.socket!.end();
      },
      "",
    ],
  ];

  test.concurrent.each(cases)("%s", async (_name, respond, body) => {
    const onRequest: Handler = (req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      respond(req, res);
    };
    await using server = protocol === "https" ? https.createServer(tlsCert, onRequest) : http.createServer(onRequest);
    await once(server.listen(0, "127.0.0.1"), "listening");
    const { port } = server.address() as net.AddressInfo;

    const client =
      protocol === "https"
        ? tls.connect({ port, host: "127.0.0.1", rejectUnauthorized: false })
        : net.connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    client.on("data", chunk => chunks.push(chunk));
    // The server can close before the client's own FIN lands; only the bytes matter here.
    client.on("error", () => {});
    const closed = new Promise(resolve => client.once("close", resolve));
    client.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
    await closed;

    const received = Buffer.concat(chunks).toString("latin1");
    const headEnd = received.indexOf("\r\n\r\n");
    expect({
      statusLine: received.slice(0, received.indexOf("\r\n")),
      body: headEnd === -1 ? null : received.slice(headEnd + 4),
    }).toEqual({ statusLine: "HTTP/1.1 200 OK", body });
  });
});

// An http.Server socket has allowHalfOpen: end() sends the FIN and the socket still reads. The
// expectations are Node v26.3.0's, which passes the bytes behind a complete body as `head`.
describe.each(["http", "https"] as const)("%s: socket.end() ends only the write side", protocol => {
  const createServer = (onRequest?: http.RequestListener) =>
    protocol === "https" ? https.createServer(tlsCert, onRequest) : http.createServer(onRequest);

  async function connectTo(server: http.Server) {
    await once(server.listen(0, "127.0.0.1"), "listening");
    const to = { port: (server.address() as net.AddressInfo).port, host: "127.0.0.1", allowHalfOpen: true };
    const client = protocol === "https" ? tls.connect({ ...to, rejectUnauthorized: false }) : net.connect(to);
    client.on("error", () => {});
    client.resume();
    await once(client, protocol === "https" ? "secureConnect" : "connect");
    return client;
  }

  const upgradeHead = (framing: string) =>
    `POST /upgrade HTTP/1.1\r\nHost: a\r\nConnection: Upgrade\r\nUpgrade: raw\r\n${framing}\r\n\r\n`;
  const switchingProtocols = "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: raw\r\n\r\n";

  type Ending = (req: http.IncomingMessage, socket: Duplex) => void;
  const endings: [string, Ending][] = [
    ["in the 'upgrade' listener", (req, socket) => socket.end()],
    ["in a later tick", (req, socket) => setImmediate(() => socket.end())],
    ["in the request's first 'data' listener", (req, socket) => req.once("data", () => socket.end())],
  ];
  const bodies: [string, string, string][] = [
    ["Content-Length", "Content-Length: 4", "BODY"],
    ["chunked", "Transfer-Encoding: chunked", "4\r\nBODY\r\n0\r\n\r\n"],
  ];

  describe.each(endings)("an Upgrade request with a body, ended %s", (_when, end) => {
    describe.each(bodies)("%s", (_name, framing, encodedBody) => {
      test.each([
        ["in the read of the head", true],
        ["in later reads", false],
      ])("gets a body that arrives %s, and the socket gets the bytes behind it", async (_arrival, withHead) => {
        await using server = createServer();
        const { promise, resolve, reject } = Promise.withResolvers<{ body: string; tunnel: string }>();
        server.on("upgrade", (req, socket, head) => {
          let body = "";
          let tunnel = head.toString("latin1");
          req.on("data", chunk => (body += chunk.toString("latin1")));
          socket.on("data", chunk => (tunnel += chunk.toString("latin1")));
          socket.on("error", reject);
          Promise.all([once(req, "end"), once(socket, "end")]).then(() => resolve({ body, tunnel }), reject);
          socket.write(switchingProtocols);
          end(req, socket);
        });

        const client = await connectTo(server);
        try {
          // The server's FIN: its write side is down when the rest arrives.
          const serverEnded = once(client, "end");
          if (withHead) {
            client.write(upgradeHead(framing) + encodedBody + "FIRST-");
            await serverEnded;
          } else {
            client.write(upgradeHead(framing));
            // The request's 'data' listener ends the socket: it needs the first byte of the body.
            if (end === endings[2][1]) client.write(encodedBody.slice(0, 4));
            await serverEnded;
            client.write(end === endings[2][1] ? encodedBody.slice(4) : encodedBody);
            client.write("FIRST-");
          }
          client.end("SECOND");
          expect(await promise).toEqual({ body: "BODY", tunnel: "FIRST-SECOND" });
        } finally {
          client.destroy();
        }
      });
    });
  });

  test("a parse error in the body of an accepted Upgrade request emits no 'clientError'", async () => {
    await using server = createServer();
    const clientErrors: string[] = [];
    server.on("clientError", (err: NodeJS.ErrnoException, socket) => {
      clientErrors.push(String(err.code));
      socket.destroy();
    });
    const { promise, resolve, reject } = Promise.withResolvers<{ body: string; tunnel: string }>();
    server.on("upgrade", (req, socket, head) => {
      let body = "";
      let tunnel = head.toString("latin1");
      req.on("data", chunk => (body += chunk.toString("latin1")));
      socket.on("data", chunk => (tunnel += chunk.toString("latin1")));
      socket.on("error", reject);
      socket.on("close", () => resolve({ body, tunnel }));
      socket.write(switchingProtocols);
      socket.end();
    });

    const client = await connectTo(server);
    try {
      const serverEnded = once(client, "end");
      client.write(upgradeHead("Transfer-Encoding: chunked") + "4\r\nBODY\r\n");
      await serverEnded;
      client.end("zz\r\nBAD\r\nSECOND");
      expect({ ...(await promise), clientErrors }).toEqual({ body: "BODY", tunnel: "", clientErrors: [] });
    } finally {
      client.destroy();
    }
  });

  describe.each([
    ["req.socket", (req: http.IncomingMessage, res: http.ServerResponse) => req.socket],
    ["res.socket", (req: http.IncomingMessage, res: http.ServerResponse) => res.socket!],
  ])("%s.end() in a 'request' listener", (_name, socketOf) => {
    test.each([1000, 300_000])("delivers a body of %d bytes to a reader of the request", async size => {
      const { promise, resolve, reject } = Promise.withResolvers<number>();
      await using server = createServer((req, res) => {
        let received = 0;
        req.on("data", chunk => (received += chunk.length));
        req.on("end", () => resolve(received));
        req.on("error", reject);
        socketOf(req, res).end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      });

      const client = await connectTo(server);
      try {
        const serverEnded = once(client, "end");
        client.write(`POST / HTTP/1.1\r\nHost: a\r\nContent-Length: ${size}\r\n\r\n`);
        await serverEnded;
        client.end(Buffer.alloc(size, "x"));
        expect(await promise).toBe(size);
      } finally {
        client.destroy();
      }
    });
  });

  test("a request body that nothing reads is not buffered after req.socket.end()", async () => {
    const size = 2 * 1024 * 1024;
    const { promise, resolve } = Promise.withResolvers<http.IncomingMessage>();
    await using server = createServer(req => {
      req.on("error", () => {});
      req.socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      resolve(req);
    });

    const client = await connectTo(server);
    try {
      const serverEnded = once(client, "end");
      client.write(`POST / HTTP/1.1\r\nHost: a\r\nContent-Length: ${size}\r\n\r\n`);
      await serverEnded;
      const req = await promise;
      req.socket.on("error", () => {});
      const closed = new Promise(resolve => req.socket.once("close", resolve));
      client.end(Buffer.alloc(size, "x"));
      await closed;
      // Node.js stops reading when the buffer is full. Bun stops filling it there, reads the connection to its
      // end and drops the bytes. One read is at most 512 KB.
      expect(req.readableLength).toBeLessThanOrEqual(req.readableHighWaterMark + 512 * 1024);
    } finally {
      client.destroy();
    }
  });
});
