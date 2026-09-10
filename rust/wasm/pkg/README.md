# variantlab-wasm

Shared video editor logic compiled to WebAssembly and used by the [VariantLab](https://github.com/godaylor/variantlab) web app.

## Install

```bash
npm install variantlab-wasm
```

## Usage

```ts
import { formatTimecode, mediaTimeFromSeconds } from "variantlab-wasm";

const ticks = mediaTimeFromSeconds(1.5);
const label = formatTimecode({ ticks });
```

All exports are documented in the [TypeScript definitions](./variantlab_wasm.d.ts).

## Source

Functions are implemented in Rust under [`rust/crates/`](../crates/). This package is the compiled WebAssembly output — do not edit it directly.

## Local development

The web app depends on the published `variantlab-wasm` package by default. If you are editing the WASM source in this repo and want `apps/web` to use your local build instead:

```bash
# From the repo root
bun run build:wasm

cd rust/wasm/pkg
bun link

cd ../../../apps/web
bun link variantlab-wasm
```

While you work, rebuild on changes from the repo root:

```bash
bun dev:wasm
```
