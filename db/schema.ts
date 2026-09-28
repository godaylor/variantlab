import { sqliteTable, text, integer, primaryKey, check, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const heads = sqliteTable("vl_heads", {
  owner: text().notNull(), id: text().notNull(), name: text().notNull(), revision: integer().notNull(),
  sha: text().notNull(), snapshot: text().notNull(), writer: text(), lease: integer().notNull(),
  generation: integer().notNull(), updated: integer().notNull(),
}, t => [primaryKey({ columns: [t.owner, t.id] })]);
export const revisions = sqliteTable("vl_revisions", {
  owner: text().notNull(), campaign: text().notNull(), revision: integer().notNull(), sha: text().notNull(), snapshot: text().notNull(),
}, t => [primaryKey({ columns: [t.owner, t.campaign, t.revision] })]);
export const receipts = sqliteTable("vl_receipts", {
  owner: text().notNull(), campaign: text().notNull(), id: text().notNull(), sha: text().notNull(), receipt: text().notNull(),
}, t => [primaryKey({ columns: [t.owner, t.campaign, t.id] })]);
export const branches = sqliteTable("vl_branches", {
  owner: text().notNull(), campaign: text().notNull(), id: text().notNull(), base: integer().notNull(),
  server: integer().notNull(), sha: text().notNull(), snapshot: text().notNull(), created: integer().notNull(),
}, t => [primaryKey({ columns: [t.owner, t.id] })]);
export const guards = sqliteTable("vl_guards", {
  id: text().primaryKey(), valid: integer().notNull(),
}, t => [check("atomic_precondition", sql`${t.valid} = 1`)]);
export const uploads = sqliteTable("vl_uploads", {
  owner: text().notNull(), id: text().notNull(), campaign: text().notNull(), hash: text().notNull(),
  mime: text().notNull(), bytes: integer().notNull(), objectKey: text().notNull(), multipart: text().notNull(), created: integer().notNull(),
}, t => [primaryKey({ columns: [t.owner, t.id] })]);
export const parts = sqliteTable("vl_parts", {
  owner: text().notNull(), upload: text().notNull(), number: integer().notNull(), etag: text().notNull(), bytes: integer().notNull(), sha: text().notNull(),
}, t => [primaryKey({ columns: [t.owner, t.upload, t.number] })]);
export const assets = sqliteTable("vl_assets", {
  owner: text().notNull(), campaign: text().notNull(), hash: text().notNull(), mime: text().notNull(), bytes: integer().notNull(), objectKey: text().notNull(),
}, t => [primaryKey({ columns: [t.owner, t.campaign, t.hash] })]);
export const downloads = sqliteTable("vl_downloads", {
  token: text().primaryKey(), owner: text().notNull(), objectKey: text().notNull(), mime: text().notNull(), expires: integer().notNull(),
});

export const renderWorkers = sqliteTable("vl_render_workers", {
  id: text().primaryKey(), expires: integer().notNull(),
});
export const renderBatches = sqliteTable("vl_render_batches", {
  owner: text().notNull(), id: text().notNull(), campaign: text().notNull(), revision: integer().notNull(), requestHash: text().notNull(), created: integer().notNull(),
}, t => [primaryKey({columns:[t.owner,t.id]}),uniqueIndex("vl_render_request").on(t.owner,t.requestHash)]);
export const renderJobs = sqliteTable("vl_render_jobs", {
  owner:text().notNull(), id:text().notNull(), batch:text().notNull(), campaign:text().notNull(),
  idempotency:text().notNull(),
  job:text().notNull(), manifest:text().notNull(), state:text().notNull(), generation:integer().notNull(), lease:integer().notNull(), token:text().notNull(),
  artifact:text(), sha:text(), bytes:integer(), uploadId:text(), uploadKey:text(), parts:text(),
}, t => [primaryKey({columns:[t.owner,t.id]}),uniqueIndex("vl_render_idempotency").on(t.owner,t.idempotency),index("vl_render_dispatch").on(t.state,t.lease),index("vl_render_batch").on(t.owner,t.batch)]);
export const renderBatchJobs = sqliteTable("vl_render_batch_jobs", {
  owner:text().notNull(), batch:text().notNull(), job:text().notNull(),
}, t => [primaryKey({columns:[t.owner,t.batch,t.job]})]);
