import type {
	Timeline,
	TimelineTrack,
	VisibleTimelineClip,
} from "@variantlab/studio-contract";

export const TICKS_PER_SECOND = 48_000;

export type TrackWindow = {
	firstTrack: number;
	lastTrack: number;
	topOffset: number;
	totalHeight: number;
};

export function frameTicks(timeline: Pick<Timeline, "fps_num" | "fps_den">): number {
	if (timeline.fps_num <= 0 || timeline.fps_den <= 0) return 1;
	return Math.max(
		1,
		Math.round((TICKS_PER_SECOND * timeline.fps_den) / timeline.fps_num),
	);
}

export function trackWindow({
	tracks,
	scrollTop,
	viewportHeight,
	overscan,
}: {
	tracks: TimelineTrack[];
	scrollTop: number;
	viewportHeight: number;
	overscan: number;
}): TrackWindow {
	const start = Math.max(0, scrollTop - overscan);
	const end = scrollTop + viewportHeight + overscan;
	let top = 0;
	let firstTrack = 0;
	let lastTrack = Math.max(0, tracks.length - 1);
	let foundFirst = false;
	let topOffset = 0;
	for (let index = 0; index < tracks.length; index += 1) {
		const height = tracks[index]?.height ?? 0;
		const bottom = top + height;
		if (!foundFirst && bottom >= start) {
			firstTrack = index;
			topOffset = top;
			foundFirst = true;
		}
		if (top <= end) lastTrack = index;
		if (top > end && foundFirst) break;
		top = bottom;
	}
	return {
		firstTrack,
		lastTrack,
		topOffset,
		totalHeight: tracks.reduce((total, track) => total + track.height, 0),
	};
}

export function ticksFromPixels({
	pixels,
	pixelsPerSecond,
}: {
	pixels: number;
	pixelsPerSecond: number;
}): number {
	return Math.round((pixels / Math.max(0.001, pixelsPerSecond)) * TICKS_PER_SECOND);
}

export function pixelsFromTicks({
	ticks,
	pixelsPerSecond,
}: {
	ticks: number;
	pixelsPerSecond: number;
}): number {
	return (ticks / TICKS_PER_SECOND) * pixelsPerSecond;
}

export function ticksFromMediaSeconds({ seconds }: { seconds: number }): number {
	if (!Number.isFinite(seconds)) return 0;
	return Math.max(0, Math.round(seconds * TICKS_PER_SECOND));
}

export function selectClipsInBox({
	clips,
	trackTops,
	box,
	pixelsPerSecond,
}: {
	clips: VisibleTimelineClip[];
	trackTops: Map<number, number>;
	box: { left: number; right: number; top: number; bottom: number };
	pixelsPerSecond: number;
}): string[] {
	return clips.flatMap((item) => {
		const clipLeft = pixelsFromTicks({
			ticks: item.clip.start_ticks,
			pixelsPerSecond,
		});
		const clipRight = pixelsFromTicks({
			ticks: item.clip.start_ticks + item.clip.duration_ticks,
			pixelsPerSecond,
		});
		const clipTop = trackTops.get(item.track_index) ?? 0;
		const intersects =
			clipLeft < box.right &&
			clipRight > box.left &&
			clipTop < box.bottom &&
			clipTop + 44 > box.top;
		return intersects ? [item.clip.id] : [];
	});
}

export function waveformLevelForZoom({
	levels,
	pixelsPerSecond,
	sampleRate,
}: {
	levels: Array<{ level: number; samplesPerBucket: number }>;
	pixelsPerSecond: number;
	sampleRate: number;
}): number | null {
	if (levels.length === 0 || sampleRate <= 0) return null;
	const selected = levels.find(
		(level) =>
			(level.samplesPerBucket / sampleRate) * pixelsPerSecond >= 0.75,
	);
	return (selected ?? levels.at(-1))?.level ?? null;
}

export function formatTimecode({ ticks, timeline }: { ticks: number; timeline: Timeline }): string {
	const totalSeconds = Math.max(0, ticks) / TICKS_PER_SECOND;
	const hours = Math.floor(totalSeconds / 3_600);
	const minutes = Math.floor((totalSeconds % 3_600) / 60);
	const seconds = Math.floor(totalSeconds % 60);
	const frame = Math.floor((totalSeconds - Math.floor(totalSeconds)) * (timeline.fps_num / timeline.fps_den));
	return [hours, minutes, seconds]
		.map((value) => String(value).padStart(2, "0"))
		.join(":") + `:${String(frame).padStart(2, "0")}`;
}
