import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const root = resolve(import.meta.dirname, "..", "dist");
const port = Number(process.env.PORT ?? "32280");
if (port < 32200 || port > 32299) throw new Error("Demo server port is outside 32200-32299");

const contentTypes = new Map([
	[".css", "text/css; charset=utf-8"],
	[".html", "text/html; charset=utf-8"],
	[".js", "text/javascript; charset=utf-8"],
	[".json", "application/json; charset=utf-8"],
	[".svg", "image/svg+xml"],
	[".wasm", "application/wasm"],
	[".webmanifest", "application/manifest+json"],
]);

const server = createServer(async (request, response) => {
	try {
		const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
		let path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
		if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("Invalid path");
		const info = await stat(path);
		if (info.isDirectory()) {
			path = resolve(path, "index.html");
			await stat(path);
		}
		response.setHeader("Content-Type", contentTypes.get(extname(path)) ?? "application/octet-stream");
		response.setHeader("Cache-Control", path.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable");
		createReadStream(path).pipe(response);
	} catch {
		response.statusCode = 404;
		response.end("Not found");
	}
}).listen(port, "127.0.0.1", () => console.log(`Demo server listening on http://127.0.0.1:${port}`));

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => server.close(() => process.exit(0)));
}
