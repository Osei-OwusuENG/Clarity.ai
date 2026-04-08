const fs = require("fs");
const path = require("path");
const http = require("http");

const DEFAULT_PORT = 3000;
const INDEX_FILE_PATH = path.join(__dirname, "index.html");

loadEnvFile(path.join(__dirname, ".env"));

const explainHandler = require("./api/explain");
const healthHandler = require("./api/health");

const port = normalizePort(process.env.PORT) || DEFAULT_PORT;

const server = http.createServer(async (req, res) => {
  enhanceResponse(res);

  try {
    const pathname = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).pathname;

    if (pathname === "/api/explain") {
      req.body = await readRequestBody(req);
      await explainHandler(req, res);
      return;
    }

    if (pathname === "/api/health") {
      await healthHandler(req, res);
      return;
    }

    if (pathname === "/favicon.ico") {
      res.status(204).end();
      return;
    }

    if (pathname === "/" && req.method === "GET") {
      const html = fs.readFileSync(INDEX_FILE_PATH, "utf8");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).end(html);
      return;
    }

    res.status(404).json({
      ok: false,
      error: {
        code: "not_found",
        message: "Route not found.",
      },
    });
  } catch (error) {
    console.error("Clarity.AI local server error:", error);

    if (res.writableEnded) {
      return;
    }

    res.status(500).json({
      ok: false,
      error: {
        code: "server_error",
        message: "Internal server error.",
      },
    });
  }
});

server.listen(port, () => {
  console.log(`Clarity.AI backend listening on http://localhost:${port}`);
});

function enhanceResponse(res) {
  res.status = (statusCode) => {
    res.statusCode = statusCode;
    return res;
  };

  res.json = (payload) => {
    if (!res.hasHeader("Content-Type")) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
    }

    res.end(JSON.stringify(payload));
    return res;
  };

  return res;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const contents = fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, "");

  for (const line of contents.split(/\r?\n/)) {
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue;
    }

    const match = trimmedLine.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);

    if (!match) {
      continue;
    }

    const [, key, rawValue] = match;

    if (hasMeaningfulEnvValue(process.env[key])) {
      continue;
    }

    process.env[key] = stripWrappingQuotes(rawValue.trim());
  }
}

function stripWrappingQuotes(value) {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function hasMeaningfulEnvValue(value) {
  return value !== undefined && String(value).trim() !== "";
}

function normalizePort(value) {
  const numericValue = Number(value);
  return Number.isInteger(numericValue) && numericValue > 0 ? numericValue : 0;
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", reject);
  });
}
