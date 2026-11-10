// Serves the development page: the viewer in a plain browser tab, without VS Code.
//   node dev/serve.mjs [--port 5177] [--decks <folder>]
// The page is http://127.0.0.1:<port>/dev/ and it shows presentations from <folder>
// (default: dev/samples, which `npm run sample` fills).
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const port = Number(option("port", process.env.PORT ?? "5177"));
const decksDir = path.resolve(option("decks", path.join(root, "dev", "samples")));

/** The only parts of the project the page needs. */
const PUBLIC_FOLDERS = ["dev", "dist", "media", "l10n"];
const DECK_FILE = /\.(pptx|pptm|ppsx|ppsm|potx|potm)$/i;
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

/** Resolves a request path inside a folder, or returns undefined when it would leave the folder. */
function inside(folder, relative) {
  const file = path.resolve(folder, relative);
  return file === folder || file.startsWith(folder + path.sep) ? file : undefined;
}

function locate(pathname) {
  if (pathname === "/dev/") return path.join(root, "dev", "index.html");
  const [, first, ...rest] = pathname.split("/");
  if (first === "decks") return inside(decksDir, rest.join("/"));
  if (PUBLIC_FOLDERS.includes(first)) return inside(path.join(root, first), rest.join("/"));
  return undefined;
}

async function listDecks() {
  const names = await readdir(decksDir).catch(() => []);
  const decks = [];
  for (const name of names.filter((entry) => DECK_FILE.test(entry) && !entry.startsWith("~$")).sort()) {
    const info = await stat(path.join(decksDir, name));
    if (info.isFile()) decks.push({ name, size: info.size, modified: info.mtimeMs });
  }
  return decks;
}

const server = createServer(async (request, response) => {
  const send = (status, body, headers = {}) => {
    response.writeHead(status, { "Cache-Control": "no-store", ...headers });
    response.end(request.method === "HEAD" ? undefined : body);
  };
  try {
    if (request.method !== "GET" && request.method !== "HEAD") return send(405, "Method not allowed");
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
    if (pathname === "/") return send(302, "", { Location: "/dev/" });
    if (pathname === "/favicon.ico") return send(204, "");
    if (pathname === "/api/decks") {
      return send(200, JSON.stringify(await listDecks()), { "Content-Type": CONTENT_TYPES[".json"] });
    }

    const file = pathname.includes("\0") ? undefined : locate(pathname);
    const info = file ? await stat(file).catch(() => undefined) : undefined;
    if (!file || !info?.isFile()) return send(404, "Not found");

    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": info.size,
      // The page compares this value to notice that a presentation was rewritten.
      ETag: `"${Math.round(info.mtimeMs)}-${info.size}"`,
    });
    if (request.method === "HEAD") return response.end();
    createReadStream(file)
      .on("error", () => response.destroy())
      .pipe(response);
  } catch (error) {
    send(400, error instanceof Error ? error.message : String(error));
  }
});

// Local only: the page is a development aid, not something to expose on the network.
server.listen(port, "127.0.0.1", () => {
  console.log(`Development page:  http://127.0.0.1:${port}/dev/`);
  console.log(`Presentations from ${decksDir}`);
});
