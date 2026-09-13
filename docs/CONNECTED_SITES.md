# Public connected deployment — Sites

The existing editor is published at
[the public site](https://variantlab-creative-ops-demo.maxeemzhuparov.chatgpt.site).
Sites version 5 deployed successfully on 2026-09-13 from commit
`90c7a49d115b9381e2c17e8b718733ab6191bb62`.

## Available infrastructure

- Sites dispatch-owned Sign in with ChatGPT; no app password database.
- D1 canonical campaign heads, immutable revisions, idempotency receipts, writer
  leases and recovered branches. Decisions run in the same Rust/WASM engine used
  by the native connected service.
- Private R2 originals, explicit resumable uploads, streaming SHA-256 verification
  and five-minute scoped download capabilities.
- Existing on-device editing and export. The public UI has not been redesigned.

No paid resource, billing account, unrelated process, Docker network or volume was
created or changed. These are the bindings supplied by the existing Sites project.
The provider decision and storage limits are in [ADR 0015](adr/0015-free-connected-sites.md).

## User flow

1. Create a campaign, import media and create explicit variants as before.
2. In Cloud workspace, sign in with ChatGPT.
3. Use Sync campaign to save its structure and text to your account.
4. Use Upload originals to cloud to explicitly back up its media.
5. On another device, sign in, find cloud campaigns and open the saved campaign.
6. Export using Render package. Keep the browser open during on-device rendering.

Saving structure and uploading originals are separate explicit actions. A cloud
structure receipt does not claim that local originals have been uploaded.
Failed operations retain the local journal and files and can be retried.

## Validation boundaries

Passed: production build, web TypeScript, changed React ESLint, 10 edit-engine
tests and 7 connected-service tests. Local Miniflare/workerd integration covers
auth rejection, CSRF, concurrent/idempotent saves, writer leases, missing-original
restoration rejection, negative tenant
isolation, multipart R2 upload, checksums and private download bytes.

Public verification: deployment succeeded; live D1 contains all nine expected
tables; API session returns anonymous status; forged identity headers do not
authorize campaign access (401). Browser created a separate test campaign and a
9:16 variant, imported a repository-generated one-second VP9 clip, rendered 30
frames to WebM with `succeeded · verified` and checksum prefix `2477fe19e0f6`,
recovered existing local campaigns, and opened the real OpenAI
sign-in flow. One initial WASM network download was interrupted; reload succeeded.

Authenticated public save/upload/reopen is **pending a normal user sign-in** in
the verification browser. Do not call this complete end-to-end verification until
those steps have been observed. No test auth bypass is deployed.

## Remaining server-render requirement

Sites Workers cannot execute the existing native FFmpeg binary. This deployment
does not fake queued jobs or claim browser work continues after the tab closes.
Server render and render-backed review links explicitly report unavailable.

The existing complete native server deployment is described in
[PRODUCTION_DEPLOY.md](PRODUCTION_DEPLOY.md). It needs a Linux server/container
host able to run the Rust API/dispatcher/FFmpeg worker and its Postgres/Redis/object
storage services; no such account was provided. Connecting native rendering to
the new D1 provider also requires a worker dispatch/artifact bridge or an explicit
verified provider migration. Merely setting a URL does not make it work.

## Rebuild

Use the pinned repository toolchain and frozen lockfile. Build WASM and web, start
this project's production web server on a free port in its allocated range, then
run `script/build-demo-site.mjs` with `VARIANTLAB_SITES_CONNECTED=1`,
`VARIANTLAB_DEMO_LOCAL_BUILD=1`, and `VARIANTLAB_DEMO_SOURCE_URL` set to that server.
The script packages the unchanged Next editor in `dist/client` and the Worker in
`dist/server`; it copies generated migrations into `dist/.openai/drizzle`.
`script/test-sites-connected.mjs` runs against a separately built
`.release/sites/server` with isolated local D1/R2. It selects a free port in 32290–32299 and never terminates an occupant.

Generate future D1 migrations with `drizzle.sites.config.ts`. Version 5's migration
has been applied in production; never edit it or its matching metadata. Deployment
must package the exact committed source pushed to this existing Sites project.
