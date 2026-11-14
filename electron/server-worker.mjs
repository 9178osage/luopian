import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const [bundle, requestedPort] = process.argv.slice(2);
const token = Buffer.from(process.env.LUOPIAN_DESKTOP_TOKEN ?? "", "utf8");
delete process.env.LUOPIAN_DESKTOP_TOKEN;
const shutdownDownloads = Symbol.for("luopian.shutdownDownloads");

let server;
let shuttingDown = false;

async function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  server?.close();
  server?.closeAllConnections();
  try {
    await globalThis[shutdownDownloads]?.();
  } catch (error) {
    console.error(error);
    exitCode = 1;
  }
  process.exit(exitCode);
}

process.on("message", (message) => {
  if (message?.type === "shutdown") void shutdown();
});
process.once("disconnect", () => {
  void shutdown();
});
process.once("SIGINT", () => {
  void shutdown();
});
process.once("SIGTERM", () => {
  void shutdown();
});

function listen(port) {
  return new Promise((resolve, reject) => {
    function onError(error) {
      server.off("listening", onListening);
      reject(error);
    }
    function onListening() {
      server.off("error", onError);
      resolve(server.address().port);
    }
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

async function serve() {
  if (!process.send || !bundle || token.length === 0)
    throw new Error("Missing desktop service configuration.");
  const port = Number(requestedPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid desktop port.");
  const { middleware } = await import(pathToFileURL(bundle).href);
  if (typeof middleware !== "function") throw new Error("The desktop bundle has no HTTP handler.");
  if (shuttingDown) return;
  server = createServer(async (request, response) => {
    const secret = Buffer.from(request.headers["x-luopian-desktop"] ?? "", "utf8");
    if (
      request.headers.host !== `127.0.0.1:${server.address()?.port}` ||
      secret.length !== token.length ||
      !timingSafeEqual(secret, token)
    ) {
      response.writeHead(403, { "cache-control": "no-store" });
      response.end("Forbidden");
      return;
    }
    delete request.headers["x-luopian-desktop"];
    // These deployment headers are unused on a local connection. Keep origin
    // and host checks tied to the actual loopback listener.
    for (const name of [
      "forwarded",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-port",
      "x-forwarded-proto",
    ]) {
      delete request.headers[name];
    }
    try {
      await middleware(request, response);
    } catch (error) {
      console.error(error);
      if (response.headersSent) response.destroy();
      else {
        response.writeHead(500, { "cache-control": "no-store" });
        response.end("Internal server error");
      }
    }
  });

  let actualPort;
  try {
    actualPort = await listen(port);
  } catch (error) {
    if (error.code !== "EADDRINUSE" || port === 0) throw error;
    actualPort = await listen(0);
  }
  server.on("error", (error) => {
    console.error(error);
    void shutdown(1);
  });
  if (!shuttingDown) process.send({ type: "ready", port: actualPort });
}

serve().catch((error) => {
  console.error(error);
  if (process.connected) {
    process.send({ type: "failed", message: error.message }, () => {
      void shutdown(1);
    });
  } else {
    void shutdown(1);
  }
});
