import { build } from "esbuild";
import { cp, mkdir, readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const output = resolve(root, process.argv[2] ?? "dist/server");
if (!output.startsWith(root + "/") && !output.startsWith(root + "\\")) throw new Error("Output outside project");
await mkdir(output, { recursive: true });
const scriptHashes = new Set();
try {
  for (const file of await readdir(resolve(root, "dist/client"), { recursive: true })) {
    if (!file.endsWith(".html")) continue;
    const html = await readFile(resolve(root, "dist/client", file), "utf8");
    for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
      if (match[1]) scriptHashes.add(`'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`);
    }
  }
} catch (error) { if (error.code !== "ENOENT") throw error; }
await build({ entryPoints: [resolve(root, "apps/sites/worker.mjs")], outfile: resolve(output, "index.js"), bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true,
  define: { __SITES_SCRIPT_HASHES__: JSON.stringify([...scriptHashes].join(" ")) },
  nodePaths: [resolve(root, "apps/web/node_modules")],
  plugins: [{ name: "rust-module", setup(build) { build.onResolve({ filter: /\.wasm$/ }, () => ({ path: "./domain.wasm", external: true })); } }],
});
await cp(resolve(root, "rust/wasm/pkg/variantlab_wasm_bg.wasm"), resolve(output, "domain.wasm"));
console.log("Sites Worker and shared Rust module built");
