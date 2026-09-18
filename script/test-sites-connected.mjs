import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import net from "node:net";
import * as rust from "../rust/wasm/pkg/variantlab_wasm_bg.js";
const require = createRequire(import.meta.url);
const { Miniflare } = require(require.resolve("miniflare", { paths: [require.resolve("wrangler", { paths: [resolve("apps/web")] })] }));
const module = new WebAssembly.Module(await readFile("rust/wasm/pkg/variantlab_wasm_bg.wasm"));
const instance = new WebAssembly.Instance(module, { "./variantlab_wasm_bg.js": rust });
rust.__wbg_set_wasm(instance.exports); instance.exports.__wbindgen_start();
let testPort;
for (let candidate = 32290; candidate <= 32299; candidate++) {
  const available = await new Promise(resolve => { const server = net.createServer(); server.once("error", () => resolve(false)); server.listen(candidate, "127.0.0.1", () => server.close(() => resolve(true))); });
  if (available) { testPort = candidate; break; }
}
if (!testPort) throw new Error("No free VariantLab test port; no process was stopped");
const mf = new Miniflare({ modules: [
  { type: "ESModule", path: resolve(".release/sites/server/index.js") },
  { type: "CompiledWasm", path: resolve(".release/sites/server/domain.wasm") },
], compatibilityDate: "2026-04-01", d1Databases: ["DB"], r2Buckets: ["BUCKET"], host: "127.0.0.1", port: testPort });
const origin = "http://localhost";
async function api(path, input, owner = "owner-a", method = input ? "POST" : "GET", extra = {}) {
  const headers = { origin, ...(owner ? { "oai-authenticated-user-id": owner } : {}), ...(input ? { "content-type": "application/json" } : {}), ...extra };
  const response = await mf.dispatchFetch(origin + "/api/variantlab" + path, { method, headers, ...(input ? { body: typeof input === "string" ? input : JSON.stringify(input) } : {}) });
  const data = await response.json(); return { status: response.status, data };
}
try {
  const db = await mf.getD1Database("DB");
  for (const file of (await readdir("drizzle")).filter(f => f.endsWith(".sql")).sort()) {
    for (const sql of (await readFile("drizzle/" + file, "utf8")).split("--> statement-breakpoint").filter(s => s.trim())) await db.prepare(sql).run();
  }
  assert.equal((await api("/campaigns", null, null)).status, 401);
  assert.equal((await api("/campaigns/c/sync", {}, "owner-a", "POST", { origin: "https://evil.example" })).status, 403);
  const state = JSON.parse(rust.studioCreateCampaign(JSON.stringify({ campaign_id: "sites-test", campaign_name: "Public save test", master_sequence_id: "master", created_at: "2026-09-13T00:00:00Z", scenes: [{ id: "scene-a", name: "Scene A", created_at: "2026-09-13T00:00:00Z", updated_at: "2026-09-13T00:00:00Z", timeline: { fps_num: 30, fps_den: 1, duration_ticks: 0, tracks: [] } }], imported_from: null })));
  const request = { schema_version: 1, request_id: crypto.randomUUID(), device_id: crypto.randomUUID(), base_revision: 0, base_sha256: rust.studioSnapshotHash(JSON.stringify(state)), initial_snapshot: state, commands: [] };
  const saved = await api("/campaigns/sites-test/sync", request);
  assert.equal(saved.status, 200, JSON.stringify(saved)); assert.equal(saved.data.status, "synced");
  assert.deepEqual((await api("/campaigns/sites-test/sync", request)).data, saved.data);
  assert.equal((await api("/campaigns/sites-test/sync", { ...request, commands: [{}] })).status, 409);
  assert.equal((await api("/campaigns/sites-test/snapshot", null, "owner-b")).status, 404);
  assert.deepEqual((await api("/campaigns", null, "owner-b")).data.campaigns, []);
  assert.equal((await api("/campaigns/sites-test/snapshot")).data.snapshot_sha256, request.base_sha256);
  const missingState = structuredClone(state);
  missingState.campaign.id = "missing-original";
  missingState.campaign.master_sequence.scenes[0].timeline.tracks = [{ id: "track", name: "Video", kind: "video", height: 64, clips: [{ id: "clip", asset_id: "a".repeat(64), label: "Original", start_ticks: 0, duration_ticks: 48000, source_offset_ticks: 0, source_duration_ticks: 48000, has_audio: false }] }];
  const missingHash = rust.studioSnapshotHash(JSON.stringify(missingState));
  assert.equal((await api("/campaigns/missing-original/sync", { ...request, request_id: crypto.randomUUID(), base_sha256: missingHash, initial_snapshot: missingState })).status, 200);
  assert.equal((await api(`/campaigns/missing-original/assets?revision=0&snapshot_sha256=${missingHash}`)).status, 409, "Never restore a campaign with silently missing originals");
  const incremental = { ...request, request_id: crypto.randomUUID(), initial_snapshot: null };
  assert.equal((await api("/campaigns/sites-test/sync", { ...incremental, device_id: crypto.randomUUID() })).data.error.code, "writer_lease_held");
  const concurrent = await Promise.all([api("/campaigns/sites-test/sync", incremental), api("/campaigns/sites-test/sync", incremental)]);
  assert.ok(concurrent.every(r => r.status === 200)); assert.deepEqual(concurrent[0].data, concurrent[1].data);
  const receiptCount = await db.prepare("SELECT COUNT(*) AS n FROM vl_receipts WHERE campaign='sites-test'").first(); assert.equal(receiptCount.n, 2);
  assert.equal((await api("/campaigns/sites-test/release-writer", { device_id: request.device_id })).status, 200);
  assert.equal((await api("/campaigns/sites-test/sync", { ...incremental, request_id: crypto.randomUUID(), device_id: crypto.randomUUID() })).status, 200);
  const png = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=", "base64"));
  const checksum = Buffer.from(await crypto.subtle.digest("SHA-256", png)).toString("hex");
  const upload = await api("/uploads", { campaign_id: "sites-test", asset_hash: checksum, content_type: "image/png", total_bytes: png.length });
  assert.equal(upload.status, 200, JSON.stringify(upload));
  const uploadId = upload.data.upload_id;
  const part = await mf.dispatchFetch(`${origin}/api/variantlab/uploads/${uploadId}/parts/1`, { method: "PUT", headers: { origin, "oai-authenticated-user-id": "owner-a", "x-content-sha256": checksum }, body: png });
  assert.equal(part.status, 200, await part.text());
  assert.equal((await api(`/uploads/${uploadId}/complete`, {}, "owner-b")).status, 404);
  const complete = await api(`/uploads/${uploadId}/complete`, {}); assert.equal(complete.status, 200, JSON.stringify(complete));
  assert.equal((await api(`/uploads/${uploadId}/complete`, {})).status, 200);
  const assets = await api(`/campaigns/sites-test/assets?revision=0&snapshot_sha256=${request.base_sha256}`);
  assert.equal(assets.data.assets.length, 1);
  const download = await mf.dispatchFetch(assets.data.assets[0].url); assert.equal(download.status, 200); assert.deepEqual(new Uint8Array(await download.arrayBuffer()), png);
  assert.equal((await api("/download/not-a-token", null, null)).status, 403);
  assert.equal((await api("/batches", {})).data.error.code, "server_renderer_unavailable");
  await mkdir(".test-results", { recursive: true });
  await writeFile(".test-results/sites-connected.json", JSON.stringify({ passed: true, runtime: "Miniflare / workerd", assertions: ["auth", "CSRF", "Rust WASM sync", "idempotency", "concurrent save", "writer lease", "tenant isolation", "R2 multipart", "checksum", "signed download", "render unavailable explicit"] }, null, 2));
  console.log("Sites connected integration passed: auth, CSRF, concurrent persistence, tenant isolation, R2 upload/download.");
} finally { await mf.dispose(); }
