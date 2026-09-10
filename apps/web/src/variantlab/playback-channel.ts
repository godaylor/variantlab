import type { Timeline } from "@variantlab/studio-contract";
import {
	formatTimecode,
	frameTicks,
	ticksFromMediaSeconds,
	TICKS_PER_SECOND,
} from "./timeline-math";

export type PlaybackSemanticState = {
	rate: number;
	isPlaying: boolean;
	direction: "reverse" | "stopped" | "forward";
};

export function nextShuttleRate({
	current,
	direction,
}: {
	current: number;
	direction: -1 | 1;
}): number {
	if (Math.sign(current) !== direction) return direction;
	return direction * Math.min(8, Math.max(1, Math.abs(current) * 2));
}

export function reachedPlaybackBoundary({
	currentTicks,
	durationTicks,
	rate,
}: {
	currentTicks: number;
	durationTicks: number;
	rate: number;
}): boolean {
	return (rate < 0 && currentTicks === 0) || (rate > 0 && currentTicks >= durationTicks);
}

export class PlaybackChannel {
	private timeline: Timeline;
	private currentTicks = 0;
	private rate = 0;
	private frameRequest: number | null = null;
	private previousTimestamp = 0;
	private video: HTMLVideoElement | null = null;
	private onFrame: (ticks: number, label: string) => void;
	private onSemanticState: (state: PlaybackSemanticState) => void;

	constructor({
		timeline,
		onFrame,
		onSemanticState,
	}: {
		timeline: Timeline;
		onFrame: (ticks: number, label: string) => void;
		onSemanticState: (state: PlaybackSemanticState) => void;
	}) {
		this.timeline = timeline;
		this.onFrame = onFrame;
		this.onSemanticState = onSemanticState;
		this.publishFrame();
	}

	setTimeline(timeline: Timeline): void {
		this.timeline = timeline;
		this.currentTicks = Math.min(this.currentTicks, timeline.duration_ticks);
		this.publishFrame();
	}

	attachVideo(video: HTMLVideoElement | null): void {
		this.video = video;
		if (video) video.currentTime = this.currentTicks / TICKS_PER_SECOND;
	}

	setFrameListener(listener: (ticks: number, label: string) => void): void {
		this.onFrame = listener;
		this.publishFrame();
	}

	setSemanticListener(
		listener: (state: PlaybackSemanticState) => void,
	): void {
		this.onSemanticState = listener;
		this.publishSemanticState();
	}

	getCurrentTicks(): number {
		return this.currentTicks;
	}

	seek(ticks: number): void {
		this.currentTicks = Math.max(0, Math.min(ticks, this.timeline.duration_ticks));
		if (this.video) this.video.currentTime = this.currentTicks / TICKS_PER_SECOND;
		this.publishFrame();
	}

	step(frames: number): void {
		this.stop();
		this.seek(this.currentTicks + frameTicks(this.timeline) * frames);
	}

	shuttle(direction: -1 | 0 | 1): void {
		if (direction === 0) {
			this.stop();
			return;
		}
		this.rate = nextShuttleRate({ current: this.rate, direction });
		this.start();
	}

	toggle(): void {
		if (this.rate === 0) {
			this.rate = 1;
			this.start();
		} else {
			this.stop();
		}
	}

	stop(): void {
		this.rate = 0;
		this.video?.pause();
		if (this.frameRequest !== null) cancelAnimationFrame(this.frameRequest);
		this.frameRequest = null;
		this.previousTimestamp = 0;
		this.publishSemanticState();
	}

	dispose(): void {
		this.stop();
		this.video = null;
	}

	private start(): void {
		if (this.rate > 0 && this.video) {
			this.video.playbackRate = this.rate;
			void this.video.play().catch(() => undefined);
		} else {
			this.video?.pause();
		}
		if (this.frameRequest === null) {
			this.frameRequest = requestAnimationFrame((timestamp) => this.tick(timestamp));
		}
		this.publishSemanticState();
	}

	private tick(timestamp: number): void {
		if (this.rate === 0) {
			this.frameRequest = null;
			return;
		}
		const deltaSeconds =
			this.previousTimestamp === 0 ? 0 : (timestamp - this.previousTimestamp) / 1_000;
		this.previousTimestamp = timestamp;
		if (this.rate > 0 && this.video && !this.video.paused) {
			this.currentTicks = ticksFromMediaSeconds({ seconds: this.video.currentTime });
		} else {
			this.currentTicks += Math.round(deltaSeconds * this.rate * TICKS_PER_SECOND);
		}
		this.currentTicks = Math.max(
			0,
			Math.min(this.currentTicks, this.timeline.duration_ticks),
		);
		this.publishFrame();
		if (reachedPlaybackBoundary({
			currentTicks: this.currentTicks,
			durationTicks: this.timeline.duration_ticks,
			rate: this.rate,
		})) {
			this.stop();
			return;
		}
		this.frameRequest = requestAnimationFrame((nextTimestamp) =>
			this.tick(nextTimestamp),
		);
	}

	private publishFrame(): void {
		this.onFrame(this.currentTicks, formatTimecode({ ticks: this.currentTicks, timeline: this.timeline }));
	}

	private publishSemanticState(): void {
		this.onSemanticState({
			rate: this.rate,
			isPlaying: this.rate !== 0,
			direction:
				this.rate < 0 ? "reverse" : this.rate > 0 ? "forward" : "stopped",
		});
	}
}
