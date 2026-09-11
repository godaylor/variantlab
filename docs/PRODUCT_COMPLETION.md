# Product completion — 2026-09-11

## Delivered

- Root opens the working editor. A first-run sequence explains import, versions
  and export; users can name campaigns before creating them.
- Creation is locked while initialization, another creation or a pending write
  is in progress. Failed creation is surfaced, not an unhandled promise.
- Workflow navigation links to edit, matrix, export and cloud. The timeline is
  directly below the preview; storage internals are behind a disclosure.
- The artificial failed-write control is restricted to the explicit test build.
- Cloud asset planning yields between Rust manifest calculations and invalidates
  immediately when its inputs change. Old async results cannot replace a newer
  plan. Cloud UI state resets when a different campaign opens.
- The local production launcher supplies a runtime trusted origin matching its
  chosen port; browser uploads no longer inherit a build-time CSRF origin.
- Separate production Compose profile, exclusive secret generator and HTTPS
  proxy example are documented in PRODUCTION_DEPLOY.md and ADR-0014.
- OpenCut attribution is explicit and the static publication includes the
  attribution route, LICENSE and third-party notices.
- Moved-checkout Bun junctions were repaired only inside this repository.
- Static packaging requests an explicit browser-local publication mode. Its
  first screen explains device-local storage and the backup path; unavailable
  account/sync controls are absent. The connected shell retains real auth.

## Verified in this session

- TypeScript: pass.
- Full web ESLint: 0 errors, 131 existing warnings.
- Relevant Bun suite: 52 tests, 87 assertions, 0 failures.
- Next.js production build: pass.
- Chromium production first-run: named campaign, durable reopen, workflow anchor,
  WCAG axe scan: pass. Screenshots are from this actual test, not mockups.
- Chromium authored export: imported generated WebM, real PNG and authored text
  are present in the downloaded video: pass.
- Production auth: registration/login/logout, session reopen, negative CSRF,
  distinct personal tenants, keyboard and 200% account accessibility: pass.
- Connected scale with test identity off: interrupted upload recovery, tab close,
  50 jobs and artifacts, bounded worker concurrency and no measured browser long
  tasks: pass (2.4 minutes for the complete test on this local shared machine).
  This is not a capacity claim for other hardware or a public deployment.
- Static publication package smoke: real campaign and adaptive format: pass.
- Public HTTPS first-run/reopen/accessibility and authored video export: pass.
  These were run against Sites version 3, not a localhost URL.
- Browser-local mode smoke and connected auth after the mode separation: pass.
- Production Compose config validation: pass, no production services started.
- Gitleaks working-tree publication scan: no leaks found.

Rust source/contracts were unchanged; native/WASM gates from previous receipts
were not relabelled as new test runs. The latest GitHub main run initially failed
on the browser long-task assertion; local scale now passes, but remote CI must
still validate the new commit. No performance threshold was relaxed.

## Remaining release boundary

The public Sites origin is browser-local. It is not connected hosting. An
authorized Linux host and two DNS names are required to publish and verify the
existing connected implementation. Production email verification/password reset,
off-host backups and final name clearance remain open. Upstream files retained
in the repository are not claimed as independently authored code.

## UX reference review

The import → scene/edit → export progression was compared with
[Descript scenes](https://help.descript.com/hc/en-us/articles/10119710379917-Working-with-scenes-and-layouts)
and [Creatomate's explicit template inputs](https://creatomate.com/docs/fundamentals/getting-started/automating-a-template).
The implementation keeps this project's finite Rust variant model and production
control-board language; it does not copy those products' code or visual assets.
