import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const app = path.join(root, "apps", "web");
const standalone = path.join(app, ".next", "standalone", "apps", "web");

for (const [source, destination] of [
	[path.join(app, "public"), path.join(standalone, "public")],
	[path.join(app, ".next", "static"), path.join(standalone, ".next", "static")],
]) {
	if (!existsSync(source)) continue;
	rmSync(destination, { recursive: true, force: true });
	mkdirSync(path.dirname(destination), { recursive: true });
	cpSync(source, destination, { recursive: true });
}
