import { describe, expect, test } from "bun:test";
import { nextShuttleRate, reachedPlaybackBoundary } from "../playback-channel";

describe("M2 J/K/L shuttle", () => {
	test("repeated J and L accelerate in deterministic bounded steps", () => {
		expect(nextShuttleRate({ current: 0, direction: -1 })).toBe(-1);
		expect(nextShuttleRate({ current: -1, direction: -1 })).toBe(-2);
		expect(nextShuttleRate({ current: -8, direction: -1 })).toBe(-8);
		expect(nextShuttleRate({ current: -2, direction: 1 })).toBe(1);
		expect(nextShuttleRate({ current: 2, direction: 1 })).toBe(4);
	});

	test("forward playback may leave zero and only its directional end stops it", () => {
		expect(reachedPlaybackBoundary({ currentTicks: 0, durationTicks: 48_000, rate: 1 })).toBe(false);
		expect(reachedPlaybackBoundary({ currentTicks: 48_000, durationTicks: 48_000, rate: 1 })).toBe(true);
		expect(reachedPlaybackBoundary({ currentTicks: 0, durationTicks: 48_000, rate: -1 })).toBe(true);
	});
});
