import { fileForPath } from "./media-store";

type CacheEntry = { file: File; touched: number };

export class MediaFileCache {
	private readonly entries = new Map<string, CacheEntry>();
	private readonly inflight = new Map<string, { controller: AbortController; promise: Promise<File> }>();
	private clock = 0;
	private bytes = 0;

	constructor(
		{
			maxBytes,
			loadFile = fileForPath,
		}: {
			maxBytes: number;
			loadFile?: (path: string) => Promise<File>;
		},
	) {
		this.maxBytes = maxBytes;
		this.loadFile = loadFile;
	}

	private readonly maxBytes: number;
	private readonly loadFile: (path: string) => Promise<File>;

	async get({ path, signal }: { path: string; signal?: AbortSignal }): Promise<File> {
		const cached = this.entries.get(path);
		if (cached) {
			cached.touched = ++this.clock;
			return cached.file;
		}
		let pending = this.inflight.get(path);
		if (!pending) {
			const controller = new AbortController();
			const promise = this.loadFile(path)
				.then((file) => {
					if (controller.signal.aborted) throw new DOMException("Media read cancelled", "AbortError");
					this.entries.set(path, { file, touched: ++this.clock });
					this.bytes += file.size;
					this.evict();
					return file;
				})
				.finally(() => this.inflight.delete(path));
			pending = { controller, promise };
			this.inflight.set(path, pending);
		}
		if (!signal) return pending.promise;
		if (signal.aborted) throw new DOMException("Media read cancelled", "AbortError");
		return Promise.race([
			pending.promise,
			new Promise<File>((_resolve, reject) => {
				signal.addEventListener("abort", () => reject(new DOMException("Media read cancelled", "AbortError")), { once: true });
			}),
		]);
	}

	cancel({ path }: { path: string }): void {
		this.inflight.get(path)?.controller.abort();
	}

	clear(): void {
		for (const pending of this.inflight.values()) pending.controller.abort();
		this.inflight.clear();
		this.entries.clear();
		this.bytes = 0;
	}

	stats(): { bytes: number; entries: number; inflight: number } {
		return { bytes: this.bytes, entries: this.entries.size, inflight: this.inflight.size };
	}

	private evict(): void {
		while (this.bytes > this.maxBytes && this.entries.size > 1) {
			const victim = [...this.entries.entries()].toSorted((left, right) => left[1].touched - right[1].touched)[0];
			if (!victim) break;
			this.entries.delete(victim[0]);
			this.bytes -= victim[1].file.size;
		}
	}
}

export const previewMediaCache = new MediaFileCache({ maxBytes: 128 * 1024 * 1024 });
