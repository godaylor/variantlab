# Sites native render handoff

The Sites provider now has a D1 job/lease and private R2 artifact transport.
The existing Railway executor completed a fresh public native render on
2026-09-28. Local native tests are not used as evidence of cloud hosting.

## Current verification — 2026-09-28

- Repository `godaylor/variantlab`, branch `codex/free-connected`, existing PR #3.
  The initial tree was clean at `9c483c346e4f781fd2efffdbe3f86afe972caa31`.
  Changes are limited to this project; no adjacent processes, ports, Docker
  resources, credentials or accounts were modified.
- **Public:** the user completed official ChatGPT authentication. A new isolated
  campaign `f324f051-2553-4d47-8056-b807e907bedc` (revision 2) was saved, its new
  29,237-byte synthetic source uploaded, and the campaign reopened using the
  visible cloud action. Batch `050e1b83-0e3a-492f-b828-f7eb92a0d8a9` reached
  succeeded; the existing Railway deployment
  `c65f3a68-0922-4061-8c7a-09ca72345f7e` logged `Render artifact committed`.
- **Downloaded artifact:** 34,451 bytes, VP9 WebM, 1080×1920, 36 packets/frames,
  duration 1.201367 s. Chromium played the downloaded file to `ended`, decoded
  all 36 frames and reported 1.201 s. SHA-256:
  `8308af5a3d9e4fc829e4e8d680ad1219f43415ac03148a10d78e7f7d6fdfda92`.
  This is a real D1 → Railway Linux/FFmpeg → private artifact → download test.
- **Editor repair:** the failing regression reproduced a deleted imported clip
  returning after refresh. Only a live successful import now requests automatic
  insertion; recovered library entries never modify the timeline. Explicit
  library insertion, visible clip deletion, reopen and durable undo passed.
  Removing an unused source from the local library requires confirmation;
  originals and metadata remain recoverable, including after reopen. Rust's
  existing `campaignOriginalHashes` prevents removing sources referenced by any
  scene, disabled variant or slot replacement. This is not physical disk erasure
  or deletion of an existing cloud original. Backups retain recovery media.
- **UX:** a rerunnable optional RU/EN guide points to actual controls, explains
  an isolated practice campaign, never mutates the current campaign, handles
  absent controls, Escape and focus return. Files/Edit/Formats/Export navigation
  and short purpose text are visible. Technical crop, model and fingerprint
  details are collapsible; existing capabilities and attribution remain.
- **Local checks:** production build, typecheck, ESLint without errors, 245 unit
  tests, anonymous three-format video export/download/reopen, named first-run
  accessibility, removal/restore regression and render-binding scoped undo pass.
  Guide/reflow tests pass in Chromium, Firefox and WebKit, sequentially with one
  worker. Widths 320/360/390/430/640/768/1023/1024/1280/1440/1920/2560/3840/5120/7680
  are exercised; 640/320 CSS px cover 200%/400% equivalent reflow on a 1280px
  window. These are emulations, not physical 8K displays or native Safari devices.
  Reduced-motion and guide axe checks pass. The production build correctly omits
  `Fail next write`, so its fault-injection scenario is delegated to the existing
  CI build with test adapters, without exposing those adapters publicly.
- **Free infrastructure:** no deployment, card, trial or paid plan was created
  in this continuation. Existing Railway project usage was $0.05383965 for the
  reported 2026-09-20–28 period. Its idle/render budget is finite. Official
  [Railway documentation](https://docs.railway.com/pricing/free-trial) describes
  automatic Trial → Free with $1/month. The future transition and sustained
  arbitrary workloads are not yet observed; trial success is not an unlimited
  free-hosting guarantee. The executor is working, not an unresolved missing-VPS
  blocker. No paid resource is required for the verified small scenario.

Release evidence is retained under `.release/evidence-20260928/`; GitHub release
gates are attached to [PR #3](https://github.com/godaylor/variantlab/pull/3).
Sites version 12 deployed successfully from
`ab74197568cf6aa10eec71d48bf4c43dd2928a1b` (environment revision 2).
The first new CI run `36371563087` exposed withdrawn MinIO registry images:
Quay returned unauthorized for mc and no manifest for the server's pinned tag;
the official Docker Hub mirror also denied access. A CI-only Compose override
now builds the **same** release commits from upstream source. It does not change
the production R2 provider or restart any local container. Full source and AGPL
license notices are retained in these test images; no third-party mirror is used.
Public entry: https://variantlab-creative-ops-demo.maxeemzhuparov.chatgpt.site/variantlab/.
The dated sections below preserve earlier observations and are superseded where
they describe Railway as unavailable.

Sites version 10 (`dd1095aec4616aa95b79d69beb8bf14f71c9814b`) passed the public
three-format render flow on 2026-09-20. The temporary local Linux worker committed
three artifacts; all three private downloads returned 200. Reopening retained
the succeeded jobs after the worker was stopped, with offline availability shown.
Only the permanent remote executor remains external to this implementation.

## Run the existing executor image

Build `rust/services/connected/Dockerfile` from this repository. Override the
image entrypoint to `python3` and its argument to
`/usr/local/lib/variantlab/sites-native-worker.py`.

Configure only these server-side values:

- `VARIANTLAB_SITES_ORIGIN`: the public Sites origin, without a path.
- `RENDER_WORKER_SECRET`: one random secret of at least 32 characters, configured
  identically as a Sites secret and an executor secret. Never place it in a
  client bundle, repository, command history, browser URL or chat.

Use one replica initially, a non-root user, dropped capabilities, no privileged
mode and a writable bounded scratch directory. The worker requires outbound
HTTPS to the Sites origin and has no listening port. Existing configuration uses
2 CPU / 2 GiB; smaller resources require corpus-specific validation. Do not stop
other projects or reuse their ports, networks, credentials or volumes.

The one-second synthetic corpus also passed 1920x1080, 1080x1920 and 1080x1080
outputs under 512 MiB / 1 CPU (30 decoded VP9 frames and verified private
downloads). This establishes a small free-tier reference case, not capacity for
arbitrary campaigns.

## Validation

`node script/build-sites-worker.mjs .release/sites/server` then
`node script/test-sites-connected.mjs` verifies isolated D1/R2 auth, leases,
concurrency, cancellation, retry and artifact delivery.

With the image built as `variantlab-sites-worker:bridge`, set
`VARIANTLAB_NATIVE_TEST=1` for the test command. It generates repository-owned
synthetic media, runs the actual native worker with a 512 MiB / 1 CPU container
limit, downloads the artifact and checks VP9/geometry/frame count with FFprobe.
Results are written to `.test-results/sites-native/evidence.json`. This is a tiny
reference fixture, not a memory/performance guarantee for all campaign sizes.
The same gate is required in the existing CI parity job.

The public gateway requires the worker's explicit
`User-Agent: VariantLab-Native-Worker/1.0`; Python's default agent received HTTP
403/1010. The transport now sets its own identity. Browser-recovered campaigns
also receive a native/WASM regression: known empty optional fields normalize to
the same snapshot hash, while an unknown empty field is still rejected.

## Remote account boundary

The minimum next action is to sign in to an existing
[Railway account](https://railway.com/dashboard), then verify that its
[Free plan](https://docs.railway.com/pricing/plans) and outbound network access
are available. The dashboard showed Login on 2026-09-20; no account was connected
or created. Free provides $1 monthly usage credit and a 512 MiB / 1 CPU ceiling;
it is a bounded allocation, not unlimited always-on compute. Limited Trial
network restrictions must be cleared by the platform's account verification
before this HTTPS pull worker can run. Do not upgrade or add a paid resource.
For its Docker start-command override, use
`python3 /usr/local/lib/variantlab/sites-native-worker.py` and the two secrets
above. No inbound service port is required.

Connected Sites cannot spawn FFmpeg. Connected Neon probes failed for both
temporary and deployment-packaged application binaries (`EACCES`; `EROFS` on
chmod), while `/bin/true` succeeded. No restriction bypass was attempted.

[Northflank Sandbox](https://northflank.com/pricing) offers free always-on Docker
services and is a candidate for this pull worker. Its
[billing documentation](https://northflank.com/docs/v1/application/billing/pricing-on-northflank)
requires a payment method even on Sandbox. No account connection or payment method
has been provided; none was added. The minimal external action is a user-controlled
login to a resource-eligible Sandbox account, followed by explicit verification that
the selected service is free. This is an access blocker, not proof of technical
incompatibility or a claim that a paid server is mandatory.

Koyeb Free excludes Worker Services and requires a payment method. Render Free
excludes background workers and its web services sleep. Railway's free account is
not connected. Hugging Face now requires a paid plan to create Docker Spaces;
Fly.io has no ongoing free tier. GitHub Actions stays CI under its usage terms.
See `CONNECTED_SITES.md` for the dated source links and prior public evidence.

## CI continuation harness

The download recovery test retains one artifact route and toggles only its
injected failure. The previous trace stalled inside Chromium's
`setNetworkInterceptionPatterns` when removing a route after media inspection.
The injected failure, localized error, successful retry and fresh-session reopen
assertions remain required; no timeout or performance budget was relaxed.

## 2026-09-23 continuation

The existing editor remains available without registration. Russian guidance now
walks through campaign creation/opening, importing media, explicitly enabling
format variants, preflight and local video export. Cloud save/open explains the
normal personal-account sign-in boundary; no shared identity was introduced.
The production build and four focused Chromium scenarios passed, including
first-run accessibility and a new anonymous RU three-format export/download/reopen
scenario. Existing cloud save/upload/reopen evidence remains valid.

Railway is now connected in the browser and verified. The actual billing page
shows a $5 Trial balance, no payment method, and shutdown when credits run out.
Project `variantlab-native-render` and service `native-render` exist; no paid plan,
card, database, volume or public port was added. `railway.json` configures the
existing Dockerfile and Python native pull worker, one replica and three retries.
A remote deployment is NOT yet verified: CLI source upload failed at its network
request, and its subsequent authentication requires renewed OAuth. Account login
is therefore no longer the blocker described in the earlier dated section.

Official plan documentation still describes Free as $1 monthly credit and
512 MiB / 1 CPU, not unlimited free always-on capacity. Production acceptance
requires remote job/artifact proof and measured idle/render usage within that
budget. Trial success alone is not permanent free availability.

Northflank's current Sandbox billing documentation explicitly says it is not
intended for production, in addition to requiring a payment method. It cannot be
presented as a verified free production replacement. Other provider constraints
recorded above remain; no paid resource was created to bypass them.
