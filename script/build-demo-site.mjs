import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "dist");
if (output !== `${root}${sep}dist`) throw new Error("Unexpected demo output path");

const sourceUrl = new URL(process.env.VARIANTLAB_DEMO_SOURCE_URL ?? "http://127.0.0.1:32270/variantlab");
const connected = process.env.VARIANTLAB_SITES_CONNECTED === "1";
sourceUrl.searchParams.set("publication", connected ? "sites-connected" : "browser-local");
if (sourceUrl.hostname === "127.0.0.1") {
	const port = Number(sourceUrl.port);
	if (port < 32200 || port > 32299) throw new Error("Local demo source port is outside 32200-32299");
}

const response = await fetch(sourceUrl, { redirect: "error" });
if (!response.ok) throw new Error(`Demo source returned ${response.status}`);
const html = await response.text();
if (!html.includes("VariantLab") || !html.includes('data-testid="save-status"')) {
	throw new Error("Demo source is not the validated VariantLab workspace");
}

await rm(output, { recursive: true, force: true });
await mkdir(resolve(output, "variantlab"), { recursive: true });
await mkdir(resolve(output, "_next"), { recursive: true });
await cp(resolve(root, "apps/web/public"), output, { recursive: true });
const sourceContainer = process.env.VARIANTLAB_DEMO_CONTAINER ?? "variantlab-m8-web-release-check";
if (process.env.VARIANTLAB_DEMO_LOCAL_BUILD === "1") {
	await cp(resolve(root, "apps/web/.next/static"), resolve(output, "_next/static"), { recursive: true });
} else {
execFileSync("docker", ["cp", `${sourceContainer}:/app/apps/web/.next/static`, resolve(output, "_next/static")], {
	stdio: ["ignore", "ignore", "pipe"],
});
}
await writeFile(resolve(output, "variantlab/index.html"), html, "utf8");
const attribution = await fetch(new URL("/about/open-source", sourceUrl), { redirect: "error" });
if (!attribution.ok) throw new Error("Attribution page could not be packaged");
await mkdir(resolve(output, "about/open-source"), { recursive: true });
await writeFile(resolve(output, "about/open-source/index.html"), await attribution.text(), "utf8");
await cp(resolve(root, "LICENSE"), resolve(output, "LICENSE.txt"));
await cp(resolve(root, "THIRD_PARTY_NOTICES.md"), resolve(output, "THIRD_PARTY_NOTICES.txt"));
await writeFile(
	resolve(output, "index.html"),
	"<!doctype html><html lang=\"ru\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>VariantLab demo</title><meta http-equiv=\"refresh\" content=\"0;url=/variantlab/\"><a href=\"/variantlab/\">Открыть VariantLab demo</a></html>\n",
	"utf8",
);

const files = await readdir(output, { recursive: true });
const sourceBuildId = html.match(/\"buildId\":\"([^\"]+)\"/)?.[1] ?? "production-container";
await writeFile(
	resolve(output, "demo-receipt.json"),
	`${JSON.stringify({ mode: "browser-local", sourceBuildId, files: files.length + 1 }, null, 2)}\n`,
	"utf8",
);
if (connected) {
	const client = resolve(root, ".release/sites-client");
	await mkdir(resolve(root, ".release"), { recursive: true });
	await rm(client, { recursive: true, force: true });
	await cp(output, client, { recursive: true });
	await rm(output, { recursive: true, force: true });
	await mkdir(output, { recursive: true });
	await cp(client, resolve(output, "client"), { recursive: true });
	await mkdir(resolve(output, ".openai"), { recursive: true });
	await cp(resolve(root, ".openai/hosting.json"), resolve(output, ".openai/hosting.json"));
	await cp(resolve(root, "drizzle"), resolve(output, ".openai/drizzle"), { recursive: true });
	execFileSync(process.execPath, [resolve(root, "script/build-sites-worker.mjs")], { cwd: root, stdio: "inherit" });
}
console.log(`${connected ? "Connected Sites editor" : "Static browser-local editor"} prepared: ${files.length + 1} files from ${sourceUrl.origin}`);
