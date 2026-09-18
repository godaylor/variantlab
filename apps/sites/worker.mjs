import { domain } from "./domain.mjs";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

const PART = 8 * 1024 * 1024;
const MAX_FILE = 1024 * 1024 * 1024;
const json = (value, status = 200) => Response.json(value, { status, headers: { "cache-control": "private, no-store" } });
const fail = (code, status = 400) => { throw Object.assign(new Error(code), { status }); };
const hash = value => bytesToHex(sha256(typeof value === "string" ? new TextEncoder().encode(value) : value));
const uuid = value => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const stmt = (db, sql, ...args) => db.prepare(sql).bind(...args);
const one = (db, sql, ...args) => stmt(db, sql, ...args).first();
const rows = async (db, sql, ...args) => (await stmt(db, sql, ...args).all()).results;
async function body(request, limit = 2 * 1024 * 1024) {
  if (!request.body) fail("body_required");
  const chunks = []; let size = 0;
  const reader = request.body.getReader();
  try { for (;;) { const { value, done } = await reader.read(); if (done) break;
    size += value.length; if (size > limit) { await reader.cancel(); fail("body_limit", 413); } chunks.push(value);
  } } finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
async function jsonBody(request) {
  if (!request.headers.get("content-type")?.startsWith("application/json")) fail("json_required", 415);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await body(request))); }
  catch (error) { if (error.status) throw error; fail("invalid_json"); }
}
const head = (db, owner, id) => one(db, "SELECT * FROM vl_heads WHERE owner=? AND id=?", owner, id);
async function requireCampaign(db, owner, id) { const value = await head(db, owner, id); if (!value) fail("campaign_missing", 404); return value; }

async function sync(db, owner, id, request) {
  if (!uuid(request.request_id) || !uuid(request.device_id)) fail("invalid_sync_identity");
  const requestJson = JSON.stringify(request); const requestHash = hash(requestJson);
  for (let attempt = 0; attempt < 3; attempt++) {
    const prior = await one(db, "SELECT sha,receipt FROM vl_receipts WHERE owner=? AND campaign=? AND id=?", owner, id, request.request_id);
    if (prior) { if (prior.sha !== requestHash) fail("idempotency_payload_mismatch", 409); return JSON.parse(prior.receipt); }
    const current = await head(db, owner, id);
    const base = current ? await one(db, "SELECT snapshot FROM vl_revisions WHERE owner=? AND campaign=? AND revision=?", owner, id, request.base_revision) : null;
    let plan;
    try { plan = JSON.parse(domain.studioPlanConnectedSync(id, requestJson, base?.snapshot ?? "null",
      JSON.stringify(current ? { revision: current.revision, snapshot_sha256: current.sha } : null),
      Boolean(current && current.lease > Date.now() && current.writer !== request.device_id))); }
    catch (error) { fail(String(error), 409); }
    const next = plan.snapshot; const snapshot = JSON.stringify(next); const now = Date.now();
    const branchId = plan.server_revision === null ? null : crypto.randomUUID();
    const receipt = branchId ? { status: "recovered_branch", branch_id: branchId, revision: next.campaign.revision, snapshot_sha256: plan.snapshot_sha256, server_revision: plan.server_revision }
      : { status: "synced", revision: next.campaign.revision, snapshot_sha256: plan.snapshot_sha256 };
    const operation = crypto.randomUUID();
    // D1 batch is a transaction. The CHECK aborts every write if the head changed
    // since the Rust decision (including leases and otherwise identical no-ops).
    const statements = [stmt(db, `INSERT INTO vl_guards(id,valid) VALUES(?,CASE WHEN
      COALESCE((SELECT generation FROM vl_heads WHERE owner=? AND id=?),-1)=?
      AND NOT EXISTS(SELECT 1 FROM vl_receipts WHERE owner=? AND campaign=? AND id=?)
      THEN 1 ELSE 0 END)`, operation, owner, id, current?.generation ?? -1, owner, id, request.request_id)];
    if (branchId) {
      statements.push(stmt(db, "INSERT INTO vl_branches(owner,campaign,id,base,server,sha,snapshot,created) VALUES(?,?,?,?,?,?,?,?)", owner, id, branchId, request.base_revision, plan.server_revision, plan.snapshot_sha256, snapshot, now));
    } else {
      statements.push(stmt(db, `INSERT INTO vl_guards(id,valid) VALUES(?,CASE WHEN NOT EXISTS(
        SELECT 1 FROM vl_revisions WHERE owner=? AND campaign=? AND revision=? AND sha<>?) THEN 1 ELSE 0 END)`, operation + ":revision", owner, id, next.campaign.revision, plan.snapshot_sha256));
      statements.push(stmt(db, "INSERT OR IGNORE INTO vl_revisions(owner,campaign,revision,sha,snapshot) VALUES(?,?,?,?,?)", owner, id, next.campaign.revision, plan.snapshot_sha256, snapshot));
      statements.push(stmt(db, `INSERT INTO vl_heads(owner,id,name,revision,sha,snapshot,writer,lease,generation,updated) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(owner,id) DO UPDATE SET name=excluded.name,revision=excluded.revision,sha=excluded.sha,snapshot=excluded.snapshot,writer=excluded.writer,lease=excluded.lease,generation=excluded.generation,updated=excluded.updated`, owner, id, next.campaign.name, next.campaign.revision, plan.snapshot_sha256, snapshot, request.device_id, now + 30000, (current?.generation ?? 0) + 1, now));
      statements.push(stmt(db, "DELETE FROM vl_guards WHERE id=?", operation + ":revision"));
    }
    statements.push(stmt(db, "INSERT INTO vl_receipts(owner,campaign,id,sha,receipt) VALUES(?,?,?,?,?)", owner, id, request.request_id, requestHash, JSON.stringify(receipt)));
    statements.push(stmt(db, "DELETE FROM vl_guards WHERE id=?", operation));
    try { await db.batch(statements); return receipt; }
    catch (error) { if (!String(error).includes("atomic_precondition") && !String(error).includes("UNIQUE constraint")) throw error; }
  }
  fail("concurrent_save_retry", 409);
}

async function upload(db, bucket, owner, request) {
  const input = await jsonBody(request);
  await requireCampaign(db, owner, input.campaign_id);
  if (!digest(input.asset_hash) || !Number.isSafeInteger(input.total_bytes) || input.total_bytes <= 0 || input.total_bytes > MAX_FILE
    || !["video/webm", "audio/webm", "image/png"].includes(input.content_type)) fail("upload_limits");
  const existing = await one(db, "SELECT * FROM vl_uploads WHERE owner=? AND campaign=? AND hash=? AND bytes=? AND mime=? ORDER BY created DESC LIMIT 1", owner, input.campaign_id, input.asset_hash, input.total_bytes, input.content_type);
  if (existing) return { upload_id: existing.id, part_size_bytes: PART, completed_parts: await rows(db, "SELECT number AS part_number,bytes AS byte_length FROM vl_parts WHERE owner=? AND upload=? ORDER BY number", owner, existing.id) };
  const usage = await one(db, "SELECT COALESCE(SUM(bytes),0) AS bytes,COUNT(*) AS count FROM vl_uploads WHERE owner=?", owner);
  if (usage.bytes + input.total_bytes > 2 * MAX_FILE || usage.count >= 200) fail("storage_quota", 413);
  const id = crypto.randomUUID(); const key = `originals/${owner}/${input.asset_hash}/${id}`;
  const multipart = await bucket.createMultipartUpload(key, { httpMetadata: { contentType: input.content_type } });
  try { await db.batch([
    stmt(db, `INSERT INTO vl_guards(id,valid) VALUES(?,CASE WHEN (SELECT COALESCE(SUM(bytes),0) FROM vl_uploads WHERE owner=?) + ? <= ? AND (SELECT COUNT(*) FROM vl_uploads WHERE owner=?) < 200 THEN 1 ELSE 0 END)`, id, owner, input.total_bytes, 2 * MAX_FILE, owner),
    stmt(db, "INSERT INTO vl_uploads(owner,id,campaign,hash,mime,bytes,objectKey,multipart,created) VALUES(?,?,?,?,?,?,?,?,?)", owner, id, input.campaign_id, input.asset_hash, input.content_type, input.total_bytes, key, multipart.uploadId, Date.now()),
    stmt(db, "DELETE FROM vl_guards WHERE id=?", id),
  ]); }
  catch (error) { await multipart.abort(); throw error; }
  return { upload_id: id, part_size_bytes: PART, completed_parts: [] };
}

async function uploadPart(db, bucket, owner, id, number, request) {
  const session = await one(db, "SELECT * FROM vl_uploads WHERE owner=? AND id=?", owner, id);
  if (!session) fail("upload_missing", 404);
  const expected = Math.min(PART, session.bytes - (number - 1) * PART);
  if (!Number.isSafeInteger(number) || number < 1 || expected <= 0) fail("part_number");
  const bytes = await body(request, PART);
  if (bytes.length !== expected || hash(bytes) !== request.headers.get("x-content-sha256")) fail("part_checksum");
  const prior = await one(db, "SELECT sha FROM vl_parts WHERE owner=? AND upload=? AND number=?", owner, id, number);
  if (prior) { if (prior.sha !== hash(bytes)) fail("immutable_part", 409); return { uploaded: true }; }
  const part = await bucket.resumeMultipartUpload(session.objectKey, session.multipart).uploadPart(number, bytes);
  await stmt(db, "INSERT INTO vl_parts(owner,upload,number,etag,bytes,sha) VALUES(?,?,?,?,?,?) ON CONFLICT(owner,upload,number) DO NOTHING", owner, id, number, part.etag, bytes.length, hash(bytes)).run();
  return { uploaded: true };
}

async function completeUpload(db, bucket, owner, id) {
  const session = await one(db, "SELECT * FROM vl_uploads WHERE owner=? AND id=?", owner, id);
  if (!session) fail("upload_missing", 404);
  const existing = await one(db, "SELECT hash FROM vl_assets WHERE owner=? AND campaign=? AND hash=?", owner, session.campaign, session.hash);
  if (existing) return { asset_hash: existing.hash, committed: true };
  let object = await bucket.get(session.objectKey);
  if (!object) {
    const parts = await rows(db, "SELECT number,etag,bytes FROM vl_parts WHERE owner=? AND upload=? ORDER BY number", owner, id);
    if (parts.length !== Math.ceil(session.bytes / PART) || parts.some((p, i) => p.number !== i + 1) || parts.reduce((n, p) => n + p.bytes, 0) !== session.bytes) fail("upload_incomplete", 409);
    await bucket.resumeMultipartUpload(session.objectKey, session.multipart).complete(parts.map(p => ({ partNumber: p.number, etag: p.etag })));
    object = await bucket.get(session.objectKey);
  }
  if (!object || object.size !== session.bytes) fail("upload_size");
  const checksum = sha256.create(); const reader = object.body.getReader(); let prefix = new Uint8Array(); let count = 0;
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; checksum.update(value); count += value.length;
    if (prefix.length < 32) { const combined = new Uint8Array(Math.min(32, prefix.length + value.length)); combined.set(prefix); combined.set(value.subarray(0, combined.length - prefix.length), prefix.length); prefix = combined; }
  } } finally { reader.releaseLock(); }
  const png = [137,80,78,71,13,10,26,10].every((v,i) => prefix[i] === v);
  const webm = [26,69,223,163].every((v,i) => prefix[i] === v);
  if (count !== session.bytes || bytesToHex(checksum.digest()) !== session.hash || (session.mime === "image/png" ? !png : !webm)) fail("original_verification_failed");
  // A byte-verified original is storage, not a claim of FFmpeg probe/render readiness.
  await stmt(db, "INSERT OR IGNORE INTO vl_assets(owner,campaign,hash,mime,bytes,objectKey) VALUES(?,?,?,?,?,?)", owner, session.campaign, session.hash, session.mime, session.bytes, session.objectKey).run();
  return { asset_hash: session.hash, committed: true };
}

async function api(request, env) {
  const url = new URL(request.url); const path = url.pathname.slice("/api/variantlab".length).split("/").filter(Boolean);
  const db = env.DB; const bucket = env.BUCKET;
  if (!db || !bucket) fail("connected_storage_unavailable", 503);
  if (request.method !== "GET" && request.method !== "HEAD" && (request.headers.get("origin") !== url.origin || request.headers.get("sec-fetch-site") === "cross-site")) fail("csrf_origin", 403);
  if (request.method === "GET" && path[0] === "download" && path.length === 2) {
    const link = await one(db, "SELECT * FROM vl_downloads WHERE token=? AND expires>?", hash(path[1]), Date.now());
    if (!link) fail("download_expired", 403);
    const object = await bucket.get(link.objectKey); if (!object) fail("original_missing", 404);
    return new Response(object.body, { headers: { "content-type": link.mime, "content-length": String(object.size), "cache-control": "private, no-store", "content-disposition": "attachment", "referrer-policy": "no-referrer" } });
  }
  // Set/stripped by the Sites dispatch, never accepted from a client by our local adapter.
  const identity = request.headers.get("oai-authenticated-user-id");
  if (path[0] === "session" && request.method === "GET") return json({ authenticated: Boolean(identity), provider: "sites", render_available: false });
  if (!identity) fail("sign_in_required", 401);
  const owner = hash(identity);
  if (path[0] === "workspace" && request.method === "GET") return json({ tenant_id: owner, render_available: false });
  if (path[0] === "campaigns" && path.length === 1 && request.method === "GET") return json({ campaigns: await rows(db, "SELECT id,name,revision,sha AS snapshot_sha256 FROM vl_heads WHERE owner=? ORDER BY updated DESC,id LIMIT 100", owner) });
  if (path[0] === "campaigns" && path.length === 3) {
    const [, id, action] = path;
    if (action === "sync" && request.method === "POST") return json(await sync(db, owner, id, await jsonBody(request)));
    const current = await requireCampaign(db, owner, id);
    if (action === "snapshot" && request.method === "GET") {
      if (domain.studioSnapshotHash(current.snapshot) !== current.sha) fail("remote_snapshot_corrupt", 409);
      return json({ snapshot: JSON.parse(current.snapshot), snapshot_sha256: current.sha, revision: current.revision });
    }
    if (action === "release-writer" && request.method === "POST") { const input = await jsonBody(request);
      await stmt(db, "UPDATE vl_heads SET writer=NULL,lease=0,generation=generation+1 WHERE owner=? AND id=? AND writer=?", owner, id, input.device_id).run(); return json({ released: true }); }
    if (action === "branches" && request.method === "GET") {
      const branches = await rows(db, "SELECT id,base AS base_revision,server AS server_revision,sha AS snapshot_sha256,created AS created_at,snapshot FROM vl_branches WHERE owner=? AND campaign=? ORDER BY created DESC LIMIT 50", owner, id);
      return json({ branches: branches.map(({ snapshot, ...b }) => ({ ...b, name: JSON.parse(snapshot).campaign.name, scene_names: JSON.parse(snapshot).campaign.master_sequence.scenes.map(scene => scene.name), created_at: new Date(b.created_at).toISOString() })) });
    }
    if (action === "assets" && request.method === "GET") {
      const revision = await one(db, "SELECT sha,snapshot FROM vl_revisions WHERE owner=? AND campaign=? AND revision=?", owner, id, Number(url.searchParams.get("revision")));
      if (!revision || revision.sha !== url.searchParams.get("snapshot_sha256")) fail("revision_mismatch", 409);
      const assets = await rows(db, "SELECT hash AS asset_hash,bytes AS byte_length,mime AS content_type,objectKey FROM vl_assets WHERE owner=? AND campaign=? ORDER BY hash", owner, id);
      const required = JSON.parse(domain.campaignOriginalHashes(revision.snapshot));
      if (required.some(asset => !assets.some(item => item.asset_hash === asset))) fail("cloud_originals_missing", 409);
      await stmt(db, "DELETE FROM vl_downloads WHERE owner=? AND expires<?", owner, Date.now()).run();
      const result = [];
      for (const { objectKey, ...asset } of assets) { const token = crypto.randomUUID() + crypto.randomUUID();
        await stmt(db, "INSERT INTO vl_downloads(token,owner,objectKey,mime,expires) VALUES(?,?,?,?,?)", hash(token), owner, objectKey, asset.content_type, Date.now() + 300000).run();
        result.push({ ...asset, url: `${url.origin}/api/variantlab/download/${token}` }); }
      return json({ assets: result });
    }
  }
  if (path[0] === "branches" && path[2] === "continue" && path.length === 3 && request.method === "POST") {
    const branch = await one(db, "SELECT snapshot,sha FROM vl_branches WHERE owner=? AND id=?", owner, path[1]);
    if (!branch) fail("branch_missing", 404);
    if (domain.studioSnapshotHash(branch.snapshot) !== branch.sha) fail("remote_snapshot_corrupt", 409);
    const snapshot = domain.forkRecovered(branch.snapshot, crypto.randomUUID(), "Recovered branch", new Date().toISOString());
    return json({ snapshot: JSON.parse(snapshot), snapshot_sha256: domain.studioSnapshotHash(snapshot) });
  }
  if (path[0] === "uploads") {
    if (path.length === 1 && request.method === "POST") return json(await upload(db, bucket, owner, request));
    if (path.length === 4 && path[2] === "parts" && request.method === "PUT") return json(await uploadPart(db, bucket, owner, path[1], Number(path[3]), request));
    if (path.length === 3 && path[2] === "complete" && request.method === "POST") return json(await completeUpload(db, bucket, owner, path[1]));
  }
  if (["batches", "jobs", "reviews"].includes(path[0]) || path[2] === "reviews") fail("server_renderer_unavailable", 503);
  fail("route_missing", 404);
}

export default { async fetch(request, env) {
  const url = new URL(request.url); let response;
  try {
    if (url.pathname.startsWith("/api/variantlab/")) response = await api(request, env);
    else response = await env.ASSETS.fetch(request);
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 503;
    const code = error.status ? error.message : "connected_storage_unavailable";
    response = json({ error: { code, message: code } }, status);
  }
  const headers = new Headers(response.headers);
  headers.set("x-content-type-options", "nosniff"); headers.set("referrer-policy", "no-referrer");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  headers.set("strict-transport-security", "max-age=31536000; includeSubDomains");
  headers.set("content-security-policy", `default-src 'self'; script-src 'self' 'wasm-unsafe-eval' ${__SITES_SCRIPT_HASHES__}; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self' https://chatgpt.com`);
  return new Response(response.body, { status: response.status, headers });
} };
