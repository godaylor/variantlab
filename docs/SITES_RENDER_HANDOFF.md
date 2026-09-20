# Sites native render handoff

The Sites provider now has a D1 job/lease and private R2 artifact transport.
Production availability still depends on a remote executor; local native tests
must not be represented as cloud hosting.

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
