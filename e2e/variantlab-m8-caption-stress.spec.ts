import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

test("M8 1000 captions over 41 minutes keep native and browser active pixels bounded", async ({ page }, testInfo) => {
	test.setTimeout(120000);
	const root = process.cwd();
	const fixture = JSON.parse(execFileSync("docker", ["run","--rm","-e","CARGO_BUILD_JOBS=1","-v",`${root}:/workspace`,"-v",`${root}/.cargo-tools/registry:/usr/local/cargo/registry`,"-w","/workspace","variantlab-rust:1.91.1-wasm-pack-0.13.1-v3","cargo","run","--locked","--quiet","-p","render-plan","--example","text_parity"], { encoding:"utf8", maxBuffer: 16*1024*1024 }));
	const output = testInfo.outputPath("overlay-harness.js");
	execFileSync(process.execPath,["script/bun.mjs","build","e2e/overlay-harness.ts","--target=browser","--format=esm",`--outfile=${output}`],{stdio:"pipe"});
	await page.route("**/__overlay-harness.js",route=>route.fulfill({contentType:"text/javascript",body:readFileSync(output)}));
	await page.route("**/__overlay.wasm",route=>route.fulfill({contentType:"application/wasm",body:readFileSync(path.join(root,"rust/wasm/pkg/opencut_wasm_bg.wasm"))}));
	await page.goto("/variantlab");
	const result = await page.evaluate(async ({manifest,samples}) => {
		const harness = await import(/* webpackIgnore: true */ "/__overlay-harness.js");
		return harness.stressOverlay(manifest,samples);
	}, fixture.stress);
	expect(result.cues).toBe(1000); expect(result.durationSeconds).toBe(2500); expect(result.released).toBe(true);
	for (const [index,item] of result.results.entries()) { expect(item.sha256).toBe(fixture.stress.samples[index].sha256); expect(item.cached_bytes).toBe(fixture.stress.samples[index].cached_bytes); expect(item.cached_bytes).toBeLessThan(1024*1024); expect(item.active).toHaveLength(1); }
	await testInfo.attach("caption-stress.json",{body:JSON.stringify(result),contentType:"application/json"});
});
