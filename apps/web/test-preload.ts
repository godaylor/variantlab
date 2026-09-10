import { mock } from "bun:test";
import { createCanvas } from "@napi-rs/canvas";
import { readFileSync } from "node:fs";
import * as studioWasm from "../../rust/wasm/pkg/opencut_wasm_bg.js";

const { instance: studioInstance } = await WebAssembly.instantiate(
	readFileSync(new URL("../../rust/wasm/pkg/opencut_wasm_bg.wasm", import.meta.url)),
	{ "./opencut_wasm_bg.js": studioWasm },
);
studioWasm.__wbg_set_wasm(studioInstance.exports);

class TestOffscreenCanvas {
	private readonly canvas;

	constructor(width: number, height: number) {
		this.canvas = createCanvas(width, height);
	}

	getContext(contextId: "2d") {
		return contextId === "2d" ? this.canvas.getContext("2d") : null;
	}
}

Object.defineProperty(globalThis, "OffscreenCanvas", {
	value: TestOffscreenCanvas,
	configurable: true,
});

const ticksPerSecond = 1_000_000;

function frameTicks(rate: { numerator: number; denominator: number }): number {
	return (ticksPerSecond * rate.denominator) / rate.numerator;
}

mock.module("opencut-wasm", () => ({
	appendSyncOutbox: studioWasm.appendSyncOutbox,
	acknowledgeSyncOutbox: studioWasm.acknowledgeSyncOutbox,
	forkRecovered: studioWasm.forkRecovered,
	TICKS_PER_SECOND: () => ticksPerSecond,
	mediaTimeFromSeconds: ({ seconds }: { seconds: number }) =>
		Math.round(seconds * ticksPerSecond),
	mediaTimeToSeconds: ({ time }: { time: number }) => time / ticksPerSecond,
	roundToFrame: ({
		time,
		rate,
	}: {
		time: number;
		rate: { numerator: number; denominator: number };
	}) => Math.round(time / frameTicks(rate)) * frameTicks(rate),
	floorToFrame: ({
		time,
		rate,
	}: {
		time: number;
		rate: { numerator: number; denominator: number };
	}) => Math.floor(time / frameTicks(rate)) * frameTicks(rate),
	lastFrameTime: ({
		duration,
		rate,
	}: {
		duration: number;
		rate: { numerator: number; denominator: number };
	}) => Math.max(0, duration - frameTicks(rate)),
	snappedSeekTime: ({
		time,
		duration,
		rate,
	}: {
		time: number;
		duration: number;
		rate: { numerator: number; denominator: number };
	}) =>
		Math.min(
			duration,
			Math.max(0, Math.round(time / frameTicks(rate)) * frameTicks(rate)),
		),
	isFrameAligned: ({
		time,
		rate,
	}: {
		time: number;
		rate: { numerator: number; denominator: number };
	}) => time % frameTicks(rate) === 0,
	mediaTimeFromFrame: ({
		frame,
		rate,
	}: {
		frame: number;
		rate: { numerator: number; denominator: number };
	}) => Math.round(frame * frameTicks(rate)),
	mediaTimeToFrame: ({
		time,
		rate,
	}: {
		time: number;
		rate: { numerator: number; denominator: number };
	}) => BigInt(Math.round(time / frameTicks(rate))),
	mediaTimeAdd: ({ lhs, rhs }: { lhs: number; rhs: number }) => lhs + rhs,
	mediaTimeSub: ({ lhs, rhs }: { lhs: number; rhs: number }) => lhs - rhs,
	mediaTimeMax: ({ lhs, rhs }: { lhs: number; rhs: number }) =>
		Math.max(lhs, rhs),
	mediaTimeMin: ({ lhs, rhs }: { lhs: number; rhs: number }) =>
		Math.min(lhs, rhs),
	mediaTimeClamp: ({
		time,
		min,
		max,
	}: {
		time: number;
		min: number;
		max: number;
	}) => Math.min(max, Math.max(min, time)),
	formatTimecode: () => undefined,
	parseTimecode: () => undefined,
	guessTimecodeFormat: () => undefined,
	studioCreateCampaign: () => {
		throw new Error(
			"Studio domain contracts are verified in native/WASM gates",
		);
	},
	studioPrepareCommand: () => {
		throw new Error(
			"Studio domain contracts are verified in native/WASM gates",
		);
	},
	studioSnapshotHash: () => {
		throw new Error(
			"Studio domain contracts are verified in native/WASM gates",
		);
	},
	timelineDefault: () => {
		throw new Error("Timeline contracts are verified in native/WASM gates");
	},
	timelineCreateStressFixture: () => {
		throw new Error("Timeline contracts are verified in native/WASM gates");
	},
	timelineApplyEdit: () => {
		throw new Error("Timeline contracts are verified in native/WASM gates");
	},
	timelineVisibleClips: () => {
		throw new Error("Timeline contracts are verified in native/WASM gates");
	},
	timelineSessionSetBase: () => {
		throw new Error("Timeline contracts are verified in native/WASM gates");
	},
	timelineSessionVisibleClips: () => {
		throw new Error("Timeline contracts are verified in native/WASM gates");
	},
	timelineSessionPreviewEdit: () => {
		throw new Error("Timeline contracts are verified in native/WASM gates");
	},
	timelineSessionRelease: () => undefined,
	mediaPlanDerivatives: () => {
		throw new Error("Media contracts are verified in native/WASM gates");
	},
	jobBuildIdempotencyKey: () => {
		throw new Error("Job contracts are verified in native/WASM gates");
	},
	jobCreate: () => {
		throw new Error("Job contracts are verified in native/WASM gates");
	},
	jobApplyEvent: () => {
		throw new Error("Job contracts are verified in native/WASM gates");
	},
}));
