type SnapshotRequest = {
	stateJson: string;
	expectedHash: string;
};

type SnapshotResponse =
	| {
			ok: true;
			hash: string;
			bytes: number;
	  }
	| {
			ok: false;
			error: string;
	  };

function toHex(bytes: Uint8Array): string {
	let result = "";
	for (const byte of bytes) {
		result += byte.toString(16).padStart(2, "0");
	}
	return result;
}

self.addEventListener("message", (event: MessageEvent<SnapshotRequest>) => {
	const run = async () => {
		const encoded = new TextEncoder().encode(event.data.stateJson);
		const digest = await crypto.subtle.digest("SHA-256", encoded);
		const hash = toHex(new Uint8Array(digest));
		const response: SnapshotResponse =
			hash === event.data.expectedHash
				? { ok: true, hash, bytes: encoded.byteLength }
				: {
						ok: false,
						error: "Worker checksum did not match the Rust snapshot hash",
					};
		self.postMessage(response);
	};
	void run();
});
