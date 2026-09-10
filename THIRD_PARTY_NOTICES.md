# Third-party notices

VariantLab is a working codename built from the OpenCut codebase. The root
`LICENSE` and its original OpenCut copyright notice remain authoritative for
the repository's MIT-licensed code.

## Milestone 2 runtime components

### @noble/hashes 2.2.0

- Purpose: incremental SHA-256 while streaming media into OPFS staging.
- License: MIT.
- Copyright: © 2022 Paul Miller.
- Source: https://github.com/paulmillr/noble-hashes
- Modification status: used as distributed; no vendored source changes.

The MIT permission and warranty text is distributed in the package's
`LICENSE` file. The copyright and permission notice must be retained in
substantial copies.

### Mediabunny 1.41.0

- Purpose: browser-side content probing, proxy conversion and audio sample
  decoding for the waveform pyramid.
- License: Mozilla Public License 2.0.
- Source: https://github.com/Vanilagy/mediabunny
- Modification status: used as distributed; no Mediabunny source files were
  modified.

Mediabunny remains an isolated provider dependency. Its MPL-2.0 covered source
is available from the source URL above, and the package's complete `LICENSE`
is retained in the installed distribution. VariantLab's Rust timeline and job
rules do not derive from or modify Mediabunny source.

## Media and codecs

The M2 browser tests generate their own 3840×2160 color-card fixture and
synthetic oscillator audio; no stock media, music or third-party test fixture is
redistributed. VP8/VP9 and Opus capability is supplied by the user's browser
through WebCodecs. VariantLab does not bundle FFmpeg or a GPL/non-free codec
build in M2.

## Milestone 5 model and font provenance manifests

M5 validates pinned model and font metadata before an immutable transcript or
locale profile can enter campaign state. These entries describe the tested
runtime contract; M5 does not vendor or redistribute model weights or font files.

- Xenova Whisper tiny ONNX model (`Xenova/whisper-tiny`), pinned Hugging Face
  revision `5332fcc35e32a33b86612b9a57a89be7906102b1`.
  License metadata: Apache-2.0. Source:
  https://huggingface.co/Xenova/whisper-tiny

- Inter family, application manifest revision `4.1`.
  License: SIL Open Font License 1.1.
  Source: https://github.com/rsms/inter

- Noto Sans family, application manifest revision `2.015`, used by the M5
  Cyrillic and Arabic fallback coverage fixture.
  License: SIL Open Font License 1.1.
  Source: https://github.com/notofonts

No M5 model weights, third-party audio, captions, stock media or font binaries
are committed by this milestone. A release resolver must retain the exact
revision, license and source receipt for every artifact it supplies; missing
provenance is a Rust validation error.
# M8 shared text renderer (2026-09-08)

- Inter Regular 4.1: Copyright (c) 2016 The Inter Project Authors, SIL OFL-1.1. Unmodified font and complete license at `assets/fonts/inter-4.1/`; exact SHA-256 and upstream artifact in `PROVENANCE.md`. No OS font installation or implicit legacy font replacement.
- cosmic-text 0.14.2: MIT OR Apache-2.0, existing Cargo.lock revision, used with `default-features = false` and `std,swash`. Rust native and WASM use an explicit font database, never OS-discovered fonts. Complete dependency SBOM/license bundle remains a release gate.

## Current lock inventory (2026-09-10)

`docs/SBOM.cdx.json` inventories the exact Bun/Cargo lock versions, including
development and optional platform dependencies; it does not claim every item
is shipped. `docs/SBOM-coverage.json` records lock checksums and unresolved
license metadata. Reproduce with `node script/bun.mjs script/sbom.mjs`.
Public npm license metadata for missing local packages is retained in
`docs/SBOM-npm-license-evidence.json`; no dependency was upgraded.

The installed @better-fetch/fetch 1.1.21 LICENSE explicitly grants MIT
(Copyright Bereket Engida). The unused botid 1.5.11 package and Next wrapper
were removed from the lock and application; no dependency versions were upgraded.
The lock inventory is not an OS/image SBOM, source offer, or legal clearance.
SoundTouchJS LGPL and Mediabunny MPL obligations remain applicable to their
existing upstream editor paths; their packages and attribution are preserved.


## M8/M9 local distribution preparation (2026-09-10)

Run `node script/release-source-bundle.mjs` after the pinned install and Rust
build. `.release/third-party/` contains verbatim installed npm/Rust notices,
Mediabunny 1.41.0 preferred source, the complete SoundTouchJS 0.3.0 source and
build scripts at npm gitHead 36b161bb7d69d801b6a81674ad0fc0c42082729f, and the
FFmpeg 7.1.1 source archive plus the exact provider Dockerfile. Archive hashes
and upstream URLs are pinned in `docs/RELEASE_SOURCE_PINS.json`.
`docs/RELEASE_SOURCE_RECEIPT.json` records the prepared material. This bundle
must accompany distribution, including the original copyright notices.

The native provider builds FFmpeg with GPL/nonfree disabled and only VP8/VP9
and Opus decoding and VP9/Opus encoding. Its FFmpeg libraries use LGPL terms;
libvpx/libopus and system library notices remain in the runtime image.
SoundTouchJS remains unmodified on the retained Classic editor path. The
source package includes its rebuilding scripts; the product's applicable
license terms must permit debugging modifications and reverse engineering
for those modifications as required by its LGPL license.

This preparation does not claim counsel's clearance, trademark clearance,
or rights to arbitrary imported media. Production must host the corresponding
source/notice material and publish the About/Open Source attribution surface.

The local infrastructure also includes unmodified MinIO
RELEASE.2025-07-23T15-54-02Z and Redis 8.2.1. Their exact upstream source
archives are included and SHA-256 pinned. MinIO's AGPL and Redis's available
license choices require an explicit distribution/service policy; do not
describe this stack as entirely MIT. The provider/build and original LICENSE
files in those archives are authoritative. Runtime inventory now scans all
seven service images with digest-pinned Syft, including infrastructure OS and
discoverable embedded libraries. The exact image digests and per-image
coverage are recorded in `docs/SBOM-runtime-coverage.json`.
