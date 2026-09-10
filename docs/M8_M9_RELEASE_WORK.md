# M8/M9 release closure — 2026-09-10

Status: **GREEN release candidate**. This document closes only the findings recorded by the 2026-09-09 final audit; it is not a repeated full audit.

## Delivered

- Rust-owned untagged SDR decode policy restores strict moving-video native/WASM/cloud parity without changing the `<5` MAE threshold (ADR-0011).
- Production same-origin BFF uses a runtime trusted origin, nonce CSP, no-store, frame and permissions policy; real auth, CSRF and tenant isolation run with test identity disabled.
- Connected batch supports 50 explicit cells, durable Postgres state, outbox/Redis recovery, bounded native workers, resumable multipart upload, cancel, failed-only retry and idempotent artifact commit.
- Long captions use a bounded lazy OverlayStream rather than eagerly retained RGBA frames (ADR-0012).
- M9 adds Rust-owned bounded sync envelopes/outbox, atomic local journal integration, writer leases, explicit conflict branches, continuation on another device and immutable scoped review links (ADR-0013).
- Release CI now reproduces web/Rust/browser/database/performance/security/supply-chain gates. Root MIT license, mandatory notices and provenance history remain intact.

## Closing receipts

| Gate | Result |
|---|---|
| Strict decoded video parity | 3 sampled MAEs 1.9479 / 2.3322 / 1.6595; duration delta 0.005 s; dimensions 1080×1920 |
| Hardened 50-cell run | 50 jobs, 50 artifacts, dispatch p95 216.298 ms, RTF p95 1.4457, max concurrency 1, no browser long tasks |
| Worker SIGKILL recovery | attempt 1 expired, attempt 2 succeeded, exactly one final artifact |
| Redis/object-store/cancel/retry/idempotency | Full failure scenario PASS, including Redis service outage and terminal duplicate delivery |
| Caption stress | 1000 cues / 2500 s, sampled native/WASM hashes equal, active cache below 1 MiB |
| M6 reference corpus | 100 cells, DOM 63, scroll 58.14 FPS, p95 36.5 ms, warm open 1914 ms |
| M2 10k clips | 60 FPS; pointer paint p95 1.2 ms; Rust apply p95 0.4 ms; React commit p95 0.5 ms |
| M9 continuation/review | Lost ACK, corrupt retry, two-device conflict, preserved branch, expiry/revoke/stale/idempotent review decision PASS |
| Production auth/locale/security | 5/5 PASS on exact deploy-candidate image |
| Web | Typecheck/build PASS; 220 tests, 544 assertions, 0 failures; lint 0 errors |
| Rust/contracts/WASM | Workspace tests, fmt, clippy, generated contract diff and native/WASM parity PASS |
| Database | Migrations 0001–0006 fresh/upgrade, RLS negatives, backup/restore PASS |
| Supply chain | 2051 lock components / 0 missing license metadata; 4946 runtime components / 7 images; 3603 notices / 4 verified source archives; 0 gitleaks findings |

Primary local receipts are under `.test-results/`, including `m8-scale-hardened-final-20260910`, `m8-worker-crash-hardened-final-20260910`, `m9-deploy-candidate-final3-20260910`, `m8-security-deploy-candidate-final-20260910`, `caption-stress-20260910`, `m6-lazy-cloud-plan-20260910`, `m2-production-final-20260910`, and the final build/SBOM/source/secret logs. Private database dumps remain ignored under `.variantlab-backups/`; only their verified receipt is cited.

## GitHub CI follow-up — 2026-09-10

Run 34516865372 on PR #1 passed web and all eight production connected gates. The remaining local-browser and supply-chain failures were traced to test-only hooks absent from production fixtures, duplicate preview animation scheduling, instrumentation overhead and an isolated-Bun-only notice collector. Fixes preserve performance thresholds, enable explicit build-time test adapters only in the local CI fixture, coalesce preview draws, and traverse both hoisted and isolated dependency layouts. Local typecheck, production build, lint (zero errors) and source bundle preparation pass. Final merge remains conditional on all jobs passing for the latest PR HEAD; PR/Actions retain the immutable publication receipts.

## Publication boundary

The repository is publishable. The browser-local demo is live at <https://variantlab-creative-ops-demo.maxeemzhuparov.chatgpt.site> as Sites version 1 from release SHA `190c6ae93022b1e64918f2ddcb30b93d019a3884`; a clean external browser confirmed app load, a durable local campaign receipt, and a ready `Portrait 9:16` (`1080×1920`) profile. General production Connected beta still depends on external managed Postgres/Redis/object storage, secrets, HTTPS/observability/retention configuration, trademark clearance, legal clearance for the dependency/codec distribution chain, and independent assistive-technology/user acceptance. Technical inventories and source offers are complete evidence inputs, not legal advice.
