import { describe, expect, test } from "bun:test";
import type { TimelineTrack, VisibleTimelineClip } from "@variantlab/studio-contract";
import {
	frameTicks,
	selectClipsInBox,
	ticksFromMediaSeconds,
	trackWindow,
	waveformLevelForZoom,
} from "../timeline-math";

describe("M2 timeline shell math", () => {
	const tracks: TimelineTrack[] = Array.from({ length: 20 }, (_, index) => ({
		id: `track-${index}`,
		name: `Track ${index}`,
		kind: index % 4 === 3 ? "audio" : "video",
		height: index % 4 === 3 ? 48 : 60,
		clips: [],
	}));

	test("variable-height track virtualization returns bounded window", () => {
		const result = trackWindow({
			tracks,
			scrollTop: 400,
			viewportHeight: 240,
			overscan: 60,
		});
		expect(result.firstTrack).toBeGreaterThan(0);
		expect(result.lastTrack - result.firstTrack).toBeLessThan(10);
		expect(result.totalHeight).toBe(1_140);
	});

	test("logical box selection does not depend on mounted DOM nodes", () => {
		const clips: VisibleTimelineClip[] = [
			{
				track_index: 0,
				track_id: "track-0",
				clip: {
					id: "clip-a",
					asset_id: "asset",
					label: "A",
					start_ticks: 48_000,
					duration_ticks: 48_000,
					source_offset_ticks: 0,
					source_duration_ticks: 480_000,
					has_audio: false,
				},
			},
		];
		expect(
			selectClipsInBox({
				clips,
				trackTops: new Map([[0, 0]]),
				box: { left: 45, right: 110, top: 0, bottom: 60 },
				pixelsPerSecond: 50,
			}),
		).toEqual(["clip-a"]);
	});

	test("rational frame and waveform level selection stay deterministic", () => {
		expect(frameTicks({ fps_num: 30_000, fps_den: 1_001 })).toBe(1_602);
		expect(
			waveformLevelForZoom({
				levels: [
					{ level: 0, samplesPerBucket: 4_096 },
					{ level: 1, samplesPerBucket: 8_192 },
				],
				pixelsPerSecond: 10,
				sampleRate: 48_000,
			}),
		).toBe(0);
	});

	test("two-hour media clock mapping has no cumulative audio/video drift", () => {
		const twoHoursInTicks = ticksFromMediaSeconds({ seconds: 2 * 60 * 60 });
		expect(twoHoursInTicks).toBe(345_600_000);
		expect(twoHoursInTicks / 48_000).toBe(7_200);
		expect(ticksFromMediaSeconds({ seconds: 7_200 + 1 / 48_000 })).toBe(
			twoHoursInTicks + 1,
		);
	});
});
