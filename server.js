const http = require("http");
const https = require("https");
const { URL } = require("url");
const net = require("net");
const tls = require("tls");

const PORT = process.env.PORT || 3000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, HEAD",
};

// Headers to strip from upstream responses
const STRIP_HEADERS = new Set([
  "content-security-policy",
  "content-security-policy-report-only",
  "x-frame-options",
  "x-content-type-options",
  "strict-transport-security",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
]);

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const reqUrl = new URL(req.url, "http://localhost");

  if (reqUrl.pathname === "/" || reqUrl.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain", ...CORS });
    res.end("ok");
    return;
  }

  if (reqUrl.pathname !== "/fetch") {
    res.writeHead(404, CORS);
    res.end("not found");
    return;
  }

  const target = reqUrl.searchParams.get("url");
  if (!target) {
    res.writeHead(400, CORS);
    res.end("missing url");
    return;
  }

  let parsed;
  try { parsed = new URL(target); }
  catch { res.writeHead(400, CORS); res.end("invalid url"); return; }

  const chunks = [];
  req.on("data", c => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);

    const fwdHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      "Accept": req.headers["accept"] || "*/*",
      "Accept-Language": "en-GB,en;q=0.9",
      "Accept-Encoding": "identity",
      "Host": parsed.host,
    };
    if (req.headers["content-type"]) fwdHeaders["content-type"] = req.headers["content-type"];
    if (req.headers["range"]) fwdHeaders["range"] = req.headers["range"];

    const options = {
      method: req.method,
      headers: fwdHeaders,
      timeout: 20000,
    };

    const lib = parsed.protocol === "https:" ? https : http;
    const proxyReq = lib.request(target, options, proxyRes => {
      const outHeaders = { ...CORS };
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        if (!STRIP_HEADERS.has(k.toLowerCase())) outHeaders[k] = v;
      }
      res.writeHead(proxyRes.statusCode, outHeaders);
      proxyRes.pipe(res);
    });

    proxyReq.on("error", err => {
      if (!res.headersSent) { res.writeHead(502, CORS); res.end(err.message); }
    });
    proxyReq.on("timeout", () => {
      proxyReq.destroy();
      if (!res.headersSent) { res.writeHead(504, CORS); res.end("timeout"); }
    });

    if (body.length && !["GET","HEAD"].includes(req.method)) proxyReq.write(body);
    proxyReq.end();
  });
});

// WebSocket tunnelling
server.on("upgrade", (req, socket, head) => {
  const reqUrl = new URL(req.url, "http://localhost");
  let target = reqUrl.searchParams.get("url");
  if (!target) { socket.destroy(); return; }

  let parsed;
  try { parsed = new URL(target); }
  catch { socket.destroy(); return; }

  const isSecure = parsed.protocol === "wss:" || parsed.protocol === "https:";
  const port = parseInt(parsed.port) || (isSecure ? 443 : 80);
  const host = parsed.hostname;
  const path = parsed.pathname + parsed.search;

  const upstream = (isSecure ? tls : net).connect(
    { host, port, servername: host, rejectUnauthorized: false },
    () => {
      const reqLines = [
        `GET ${path} HTTP/1.1`,
        `Host: ${parsed.host}`,
        `Upgrade: websocket`,
        `Connection: Upgrade`,
        `Sec-WebSocket-Key: ${req.headers["sec-websocket-key"] || "dGhlIHNhbXBsZSBub25jZQ=="}`,
        `Sec-WebSocket-Version: ${req.headers["sec-websocket-version"] || "13"}`,
        `\r\n`,
      ].join("\r\n");

      upstream.write(reqLines);
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    }
  );

  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
