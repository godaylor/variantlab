import { describe, expect, test } from "bun:test";
import { MediaFileCache } from "../media-file-cache";

function mediaFile({ name, bytes }: { name: string; bytes: number }): File {
	return new File([new Uint8Array(bytes)], name, { type: "video/webm" });
}

describe("M2 byte-bounded media cache", () => {
	test("deduplicates parallel reads and evicts least-recently-used files", async () => {
		let reads = 0;
		const files = new Map([
			["a", mediaFile({ name: "a.webm", bytes: 6 })],
			["b", mediaFile({ name: "b.webm", bytes: 6 })],
		]);
		const cache = new MediaFileCache({ maxBytes: 10, loadFile: async (path) => {
			reads += 1;
			const file = files.get(path);
			if (!file) throw new Error(`Missing fixture ${path}`);
			return file;
		} });
		const [first, duplicate] = await Promise.all([cache.get({ path: "a" }), cache.get({ path: "a" })]);
		expect(first).toBe(duplicate);
		expect(reads).toBe(1);
		await cache.get({ path: "b" });
		expect(cache.stats()).toEqual({ bytes: 6, entries: 1, inflight: 0 });
	});

	test("a cancelled consumer stops waiting without poisoning the shared read", async () => {
		let release: ((file: File) => void) | undefined;
		const cache = new MediaFileCache({ maxBytes: 32, loadFile: () => new Promise<File>((resolve) => { release = resolve; }) });
		const controller = new AbortController();
		const cancelled = cache.get({ path: "slow", signal: controller.signal });
		const shared = cache.get({ path: "slow" });
		controller.abort();
		await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
		release?.(mediaFile({ name: "slow.webm", bytes: 8 }));
		expect((await shared).size).toBe(8);
	});
});
