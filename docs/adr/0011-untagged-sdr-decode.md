# ADR-0011: deterministic interpretation of untagged SDR video

- Status: Accepted within the authorized M8 correctness repair
- Date: 2026-09-10

Untagged VP8/VP9 inputs use limited-range BT.601 (SMPTE 170M), the existing
native decoder interpretation. Rust render-plan publishes this fallback to
WASM. Browser adapters apply it before decoder creation only when source color
metadata is absent. Explicit source metadata is retained unchanged.

The failing moving-video corpus contains MediaRecorder VP8 without color
metadata and with alpha side data. Browser decoding/alpha composition with
implicit defaults returns RGB 218/110/46; explicit BT.601 and the native output
return 208/103/46 on the same source. Tagging the output does not fix this.
No gamma correction, arbitrary matrix override, threshold increase or static
replacement corpus is used. The decoded-video gate remains MAE <5.

This is a fix for unspecified decoder initialization in render-v2. It does not
reinterpret campaign state, rewrite originals, migrate storage or introduce a
new codec/dependency. Previously created exports remain intact.
