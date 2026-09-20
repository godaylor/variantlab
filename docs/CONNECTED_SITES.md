# Public connected deployment — Sites

The existing editor is published at
[the public site](https://variantlab-creative-ops-demo.maxeemzhuparov.chatgpt.site).
Sites version 6 deployed successfully on 2026-09-13 from commit
`730ec830b806b02090f93683c2821b62eaf326a9`.

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

Authenticated public save/upload/reopen passed on 2026-09-20 after the user's
normal sign-in. Campaign `Connected production check`, revision 4, received
`Cloud revision 4 saved`, then `Originals saved in the cloud; checksums verified.`
Find cloud campaigns returned that revision. Download and continue completed with
`Campaign and verified originals saved locally`; recovery replayed zero journal
entries after installing the cloud snapshot. No test auth bypass was used.

This was the same browser with an existing original: the restore path verified
its local bytes against the cloud asset metadata rather than downloading them
again. A fresh-device production download is not claimed. The signed download
and missing-original paths are covered by the existing integration tests.
All three explicit formats (16:9, 9:16, 1:1) passed preflight after cloud reopen.
Their previously rendered 30-frame artifacts remained verified (checksum prefixes
`021ac6d7d8c1`, `2477fe19e0f6`, `002806a0cb12`). Enqueue correctly reported
`Skipped 3 already verified artifact(s).`; this was reuse, not a new render.
All 12 CI gates passed at runtime-compatible commit `56299386` in
[run 35478938966](https://github.com/godaylor/variantlab/actions/runs/35478938966).

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

### Free native executor checks (2026-09-20)

The connected Neon Free account was tested on an isolated VariantLab branch in
`aws-us-east-2`. A system `/bin/true` process succeeds. The project's pinned
FFmpeg downloaded into temporary storage fails with `EACCES` despite mode 0755.
A bundled native executable also fails with `EACCES`: Neon deploys it as 0644,
including when the ZIP explicitly specifies Unix 0755 attributes. Attempting a
normal chmod returns `EROFS`. No loader, mount or sandbox restriction was bypassed.
These results rule out the tested deployment paths, not every possible future
provider-supported native packaging method.

| Candidate | Result / access boundary |
| --- | --- |
| Existing Sites Worker | No native FFmpeg process execution; D1/R2 remain the working backend. |
| Connected Neon Functions | Actual native probes above fail for application binaries; no working executor established. |
| [Render Free](https://render.com/docs/free) | Free background-worker service is unavailable. Free web services sleep after 15 minutes without inbound traffic and may be suspended for substantial outbound storage traffic. No connected account; not production-validated. |
| [Hugging Face Spaces](https://huggingface.co/docs/hub/spaces-overview) | Creating Docker compute Spaces now requires a paid plan, even though CPU Basic has no hourly fee. Not created. |
| [Railway Free](https://docs.railway.com/pricing/plans) | Limited monthly usage credit and 0.5 GB RAM; current worker allocation is 2 GiB. No connected account or compatibility measurement; not ruled out by measurement. |
| [Fly.io](https://fly.io/docs/about/cost-management/) | No ongoing free tier; not created. |
| [GitHub Actions](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features) | Terms prohibit use as part of a serverless application. Kept for CI, not production render jobs. |

No compatible free executor has been demonstrated with the currently connected
services. This is not proof that free native hosting is universally impossible.
The external requirement is access to a supported Linux native/container executor
that can run the pinned worker, retain a job for its bounded execution period,
and access private originals/artifacts. The existing 2 CPU / 2 GiB allocation is
a starting configuration, not a measured minimum. D1 dispatch, durable leases and
artifact callback integration remain implementation work; they must be completed
and tested with the selected executor before enabling server render or reviews.

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
