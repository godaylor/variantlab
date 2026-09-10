"use client";

/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- The scroll surface is a composite timeline application widget with a documented keyboard model. */

import { useUiCopy } from "./ui-copy";
import type {
	Timeline,
	TimelineClip,
	TimelineEdit,
	TimelinePreviewResult,
	TimelineTrack,
} from "@variantlab/studio-contract";
import {
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type PointerEvent as ReactPointerEvent,
} from "react";
import {
	previewTimelineSession,
	queryTimelineSession,
	releaseTimelineSession,
	setTimelineSessionBase,
} from "./domain";
import type { PlaybackChannel } from "./playback-channel";
import {
	frameTicks,
	pixelsFromTicks,
	selectClipsInBox,
	ticksFromPixels,
	trackWindow,
} from "./timeline-math";

const LABEL_WIDTH = 132;
const MAX_TIMELINE_NODES = 260;

type Metrics = {
	pointerToPaintMs: number[];
	reactCommitMs: number[];
	rustApplyMs: number[];
};

declare global {
	interface Window {
		__variantlabM2Metrics?: Metrics;
	}
}

type TimelineProps = {
	timeline: Timeline;
	playback: PlaybackChannel;
	onCommit: (edit: TimelineEdit) => Promise<void>;
	onNotice: (notice: string) => void;
	onGestureState: (active: boolean) => void;
};

type DragGesture = {
	pointerId: number;
	startX: number;
	selectedIds: string[];
	lastEdit: TimelineEdit | null;
	pointerStartedAt: number;
};

type TrimGesture = {
	pointerId: number;
	clip: TimelineClip;
	edge: "start" | "end";
	lastEdit: TimelineEdit | null;
	pointerStartedAt: number;
};

type BoxGesture = {
	pointerId: number;
	startX: number;
	startY: number;
};

function clipMap(
	timeline: Timeline,
): Map<string, { clip: TimelineClip; track: TimelineTrack }> {
	const map = new Map<string, { clip: TimelineClip; track: TimelineTrack }>();
	for (const track of timeline.tracks) {
		for (const clip of track.clips) map.set(clip.id, { clip, track });
	}
	return map;
}

function TimelineBody({
	timeline,
	playback,
	onCommit,
	onNotice,
	onGestureState,
}: TimelineProps) {
	const copy = useUiCopy();
	const [pixelsPerSecond, setPixelsPerSecond] = useState(28);
	const [scrollState, setScrollState] = useState({
		left: 0,
		top: 0,
		width: 1_000,
		height: 310,
	});
	const [previewResult, setPreviewResult] =
		useState<TimelinePreviewResult | null>(null);
	const [sessionRevision, setSessionRevision] = useState(0);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
	const [focusedId, setFocusedId] = useState<string | null>(null);
	const [snapping, setSnapping] = useState(true);
	const [ripple, setRipple] = useState(false);
	const [box, setBox] = useState<{
		left: number;
		top: number;
		right: number;
		bottom: number;
	} | null>(null);
	const [snapLabel, setSnapLabel] = useState<string | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const playheadRef = useRef<HTMLDivElement>(null);
	const timecodeRef = useRef<HTMLOutputElement>(null);
	const dragRef = useRef<DragGesture | null>(null);
	const trimRef = useRef<TrimGesture | null>(null);
	const boxRef = useRef<BoxGesture | null>(null);
	const previewFrameRef = useRef<number | null>(null);
	const pendingPreviewRef = useRef<TimelineEdit | null>(null);
	const pendingPreviewStartedAtRef = useRef(0);
	const appliedPreviewStartedAtRef = useRef<number | null>(null);
	const commitRequestedAtRef = useRef<number | null>(null);
	const scrollFrameRef = useRef<number | null>(null);
	const pixelScaleRef = useRef(pixelsPerSecond);
	const timelineSessionId = useId();
	const clipsById = useMemo(() => clipMap(timeline), [timeline]);

	useLayoutEffect(() => {
		const requestedAt = commitRequestedAtRef.current;
		if (requestedAt === null) return;
		window.__variantlabM2Metrics?.reactCommitMs.push(
			performance.now() - requestedAt,
		);
		commitRequestedAtRef.current = null;
	});
	useEffect(() => {
		setTimelineSessionBase({ sessionId: timelineSessionId, timeline });
		const frame = requestAnimationFrame(() => {
			setSessionRevision((current) => current + 1);
			setPreviewResult(null);
		});
		return () => cancelAnimationFrame(frame);
	}, [timeline, timelineSessionId]);

	useEffect(
		() => () => releaseTimelineSession(timelineSessionId),
		[timelineSessionId],
	);

	useEffect(() => {
		pixelScaleRef.current = pixelsPerSecond;
	}, [pixelsPerSecond]);

	useEffect(() => {
		const element = scrollRef.current;
		if (!element) return;
		const observer = new ResizeObserver(([entry]) => {
			if (!entry) return;
			setScrollState((current) => ({
				...current,
				width: entry.contentRect.width,
				height: entry.contentRect.height,
			}));
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	const verticalWindow = useMemo(
		() =>
			trackWindow({
				tracks: timeline.tracks,
				scrollTop: scrollState.top,
				viewportHeight: scrollState.height,
				overscan: 80,
			}),
		[timeline.tracks, scrollState.height, scrollState.top],
	);
	const visibleStartTicks = Math.max(
		0,
		ticksFromPixels({
			pixels: Math.max(0, scrollState.left - LABEL_WIDTH),
			pixelsPerSecond,
		}),
	);
	const visibleEndTicks =
		visibleStartTicks +
		ticksFromPixels({ pixels: scrollState.width, pixelsPerSecond });
	const visible = useMemo(
		() =>
			sessionRevision === 0
				? { clips: [], total_matching: 0, truncated: false }
				: queryTimelineSession({
						sessionId: timelineSessionId,
						query: {
							start_ticks: visibleStartTicks,
							end_ticks: visibleEndTicks,
							first_track: verticalWindow.firstTrack,
							last_track: verticalWindow.lastTrack,
							overscan_ticks: 2 * 48_000,
							max_nodes: MAX_TIMELINE_NODES,
						},
					}),
		[
			sessionRevision,
			timelineSessionId,
			visibleEndTicks,
			visibleStartTicks,
			verticalWindow.firstTrack,
			verticalWindow.lastTrack,
		],
	);
	const trackTops = useMemo(() => {
		const map = new Map<number, number>();
		let top = 28;
		for (let index = 0; index < timeline.tracks.length; index += 1) {
			map.set(index, top);
			top += timeline.tracks[index]?.height ?? 0;
		}
		return map;
	}, [timeline.tracks]);
	const contentWidth = Math.max(
		scrollState.width,
		LABEL_WIDTH +
			pixelsFromTicks({
				ticks: Math.max(timeline.duration_ticks, 60 * 48_000),
				pixelsPerSecond,
			}) +
			160,
	);
	const renderedClips = useMemo(() => {
		const placements = new Map(
			previewResult?.placements.map((placement) => [
				placement.clip.id,
				placement,
			]),
		);
		const removed = new Set(previewResult?.removed_clip_ids ?? []);
		return visible.clips.flatMap((item) => {
			if (removed.has(item.clip.id)) return [];
			const placement = placements.get(item.clip.id);
			if (!placement) return [item];
			const trackIndex = timeline.tracks.findIndex(
				(track) => track.id === placement.track_id,
			);
			return trackIndex < 0
				? []
				: [
						{
							track_index: trackIndex,
							track_id: placement.track_id,
							clip: placement.clip,
						},
					];
		});
	}, [previewResult, timeline.tracks, visible.clips]);

	useEffect(() => {
		playback.setTimeline(timeline);
		playback.setFrameListener((ticks, label) => {
			if (playheadRef.current) {
				const x =
					LABEL_WIDTH +
					pixelsFromTicks({ ticks, pixelsPerSecond: pixelScaleRef.current });
				playheadRef.current.style.transform = `translate3d(${x}px,0,0)`;
			}
			if (timecodeRef.current) timecodeRef.current.value = label;
		});
	}, [playback, timeline]);

	const schedulePreview = useCallback(
		(edit: TimelineEdit, pointerStartedAt: number) => {
			pendingPreviewRef.current = edit;
			pendingPreviewStartedAtRef.current = pointerStartedAt;
			if (previewFrameRef.current !== null) return;
			const applyPending = () => {
				const pending = pendingPreviewRef.current;
				if (!pending) return;
				pendingPreviewRef.current = null;
				appliedPreviewStartedAtRef.current = pendingPreviewStartedAtRef.current;
				try {
					const applyStartedAt = performance.now();
					const preview = previewTimelineSession({
						sessionId: timelineSessionId,
						edit: pending,
					});
					const metrics = (window.__variantlabM2Metrics ??= {
						pointerToPaintMs: [],
						reactCommitMs: [],
						rustApplyMs: [],
					});
					metrics.rustApplyMs.push(performance.now() - applyStartedAt);
					commitRequestedAtRef.current = performance.now();
					setPreviewResult(preview);
				} catch {
					setPreviewResult(null);
				}
			};
			const flushFrame = () => {
				previewFrameRef.current = null;
				const appliedAt = appliedPreviewStartedAtRef.current;
				if (appliedAt !== null) {
					window.setTimeout(() => {
						window.__variantlabM2Metrics?.pointerToPaintMs.push(
							performance.now() - appliedAt,
						);
					}, 0);
					appliedPreviewStartedAtRef.current = null;
				}
				if (pendingPreviewRef.current) {
					applyPending();
					previewFrameRef.current = requestAnimationFrame(flushFrame);
				}
			};
			applyPending();
			previewFrameRef.current = requestAnimationFrame(flushFrame);
		},
		[timelineSessionId],
	);

	const cancelGesture = useCallback(() => {
		dragRef.current = null;
		trimRef.current = null;
		boxRef.current = null;
		pendingPreviewRef.current = null;
		if (previewFrameRef.current !== null)
			cancelAnimationFrame(previewFrameRef.current);
		previewFrameRef.current = null;
		setPreviewResult(null);
		setBox(null);
		setSnapLabel(null);
		onGestureState(false);
		onNotice(
			"Gesture cancelled. Canonical state and history were not changed.",
		);
	}, [onGestureState, onNotice]);

	useEffect(() => {
		const onWindowKeyDown = (event: KeyboardEvent) => {
			if (
				event.key === "Escape" &&
				(dragRef.current || trimRef.current || boxRef.current)
			) {
				event.preventDefault();
				cancelGesture();
			}
		};
		window.addEventListener("keydown", onWindowKeyDown);
		return () => window.removeEventListener("keydown", onWindowKeyDown);
	}, [cancelGesture]);

	const selectClip = useCallback(
		(
			clipId: string,
			event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean },
		) => {
			setFocusedId(clipId);
			setSelectedIds((current) => {
				if (event.ctrlKey || event.metaKey) {
					const next = new Set(current);
					if (next.has(clipId)) next.delete(clipId);
					else next.add(clipId);
					return next;
				}
				if (event.shiftKey && focusedId) {
					const ordered = [...clipsById.values()]
						.toSorted(
							(left, right) => left.clip.start_ticks - right.clip.start_ticks,
						)
						.map((item) => item.clip.id);
					const start = ordered.indexOf(focusedId);
					const end = ordered.indexOf(clipId);
					if (start >= 0 && end >= 0) {
						return new Set(
							ordered.slice(Math.min(start, end), Math.max(start, end) + 1),
						);
					}
				}
				return new Set([clipId]);
			});
		},
		[clipsById, focusedId],
	);

	const trackAtClientY = useCallback(
		(clientY: number): TimelineTrack | null => {
			const container = scrollRef.current;
			if (!container) return null;
			const y =
				clientY - container.getBoundingClientRect().top + container.scrollTop;
			let top = 28;
			for (const track of timeline.tracks) {
				if (y >= top && y < top + track.height) return track;
				top += track.height;
			}
			return timeline.tracks.at(-1) ?? null;
		},
		[timeline.tracks],
	);

	const beginMove = useCallback(
		(clipId: string, event: ReactPointerEvent<HTMLButtonElement>) => {
			if (event.button !== 0) return;
			event.stopPropagation();
			selectClip(clipId, event);
			const ids = selectedIds.has(clipId) ? [...selectedIds] : [clipId];
			event.currentTarget.setPointerCapture(event.pointerId);
			dragRef.current = {
				pointerId: event.pointerId,
				startX: event.clientX,
				selectedIds: ids,
				lastEdit: null,
				pointerStartedAt: performance.now(),
			};
			onGestureState(true);
		},
		[onGestureState, selectClip, selectedIds],
	);

	const updateMove = useCallback(
		(event: ReactPointerEvent<HTMLButtonElement>) => {
			const gesture = dragRef.current;
			if (!gesture || gesture.pointerId !== event.pointerId) return;
			const deltaTicks = ticksFromPixels({
				pixels: event.clientX - gesture.startX,
				pixelsPerSecond,
			});
			const targetTrack = trackAtClientY(event.clientY);
			const edit: TimelineEdit = {
				edit: "move_clips",
				clip_ids: gesture.selectedIds,
				delta_ticks: deltaTicks,
				target_track_id: targetTrack?.id ?? null,
				playhead_ticks: playback.getCurrentTicks(),
				snap_tolerance_ticks: ticksFromPixels({ pixels: 8, pixelsPerSecond }),
				disable_snapping: !snapping || event.shiftKey,
				ripple,
			};
			gesture.lastEdit = edit;
			gesture.pointerStartedAt = performance.now();
			setSnapLabel(
				event.shiftKey ? "Snap bypassed" : snapping ? "Snap active" : null,
			);
			schedulePreview(edit, gesture.pointerStartedAt);
		},
		[
			pixelsPerSecond,
			playback,
			ripple,
			schedulePreview,
			snapping,
			trackAtClientY,
		],
	);

	const finishPointerGesture = useCallback(
		async (pointerId: number) => {
			const edit =
				dragRef.current?.pointerId === pointerId
					? dragRef.current.lastEdit
					: trimRef.current?.pointerId === pointerId
						? trimRef.current.lastEdit
						: null;
			dragRef.current = null;
			trimRef.current = null;
			pendingPreviewRef.current = null;
			setPreviewResult(null);
			setSnapLabel(null);
			onGestureState(false);
			if (edit) await onCommit(edit);
		},
		[onCommit, onGestureState],
	);

	const beginTrim = useCallback(
		(
			clip: TimelineClip,
			edge: "start" | "end",
			event: ReactPointerEvent<HTMLButtonElement>,
		) => {
			event.stopPropagation();
			event.currentTarget.setPointerCapture(event.pointerId);
			trimRef.current = {
				pointerId: event.pointerId,
				clip,
				edge,
				lastEdit: null,
				pointerStartedAt: performance.now(),
			};
			onGestureState(true);
		},
		[onGestureState],
	);

	const updateTrim = useCallback(
		(event: ReactPointerEvent<HTMLButtonElement>) => {
			const gesture = trimRef.current;
			if (!gesture || gesture.pointerId !== event.pointerId) return;
			const container = scrollRef.current;
			if (!container) return;
			const x =
				event.clientX -
				container.getBoundingClientRect().left +
				container.scrollLeft -
				LABEL_WIDTH;
			const targetTicks = Math.max(
				0,
				ticksFromPixels({ pixels: x, pixelsPerSecond }),
			);
			const edit: TimelineEdit = {
				edit: "trim_clip",
				clip_id: gesture.clip.id,
				edge: gesture.edge,
				target_ticks: targetTicks,
				playhead_ticks: playback.getCurrentTicks(),
				snap_tolerance_ticks: ticksFromPixels({ pixels: 8, pixelsPerSecond }),
				disable_snapping: !snapping || event.shiftKey,
				ripple,
			};
			gesture.lastEdit = edit;
			gesture.pointerStartedAt = performance.now();
			schedulePreview(edit, gesture.pointerStartedAt);
		},
		[pixelsPerSecond, playback, ripple, schedulePreview, snapping],
	);

	const beginBox = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if (event.button !== 0 || event.target !== event.currentTarget) return;
			event.currentTarget.setPointerCapture(event.pointerId);
			const x = event.nativeEvent.offsetX;
			const y = event.nativeEvent.offsetY;
			boxRef.current = { pointerId: event.pointerId, startX: x, startY: y };
			setBox({ left: x, right: x, top: y, bottom: y });
			onGestureState(true);
		},
		[onGestureState],
	);

	const updateBox = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
		const gesture = boxRef.current;
		if (!gesture || gesture.pointerId !== event.pointerId) return;
		const rect = event.currentTarget.getBoundingClientRect();
		const x = event.clientX - rect.left;
		const y = event.clientY - rect.top;
		setBox({
			left: Math.min(gesture.startX, x),
			right: Math.max(gesture.startX, x),
			top: Math.min(gesture.startY, y),
			bottom: Math.max(gesture.startY, y),
		});
	}, []);

	const finishBox = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			const gesture = boxRef.current;
			if (!gesture || gesture.pointerId !== event.pointerId || !box) return;
			boxRef.current = null;
			setSelectedIds(
				new Set(
					selectClipsInBox({
						clips: renderedClips,
						trackTops,
						box: {
							left: Math.max(0, box.left - LABEL_WIDTH),
							right: Math.max(0, box.right - LABEL_WIDTH),
							top: box.top,
							bottom: box.bottom,
						},
						pixelsPerSecond,
					}),
				),
			);
			setBox(null);
			onGestureState(false);
			onNotice("Box selection updated without creating a history entry.");
		},
		[box, onGestureState, onNotice, pixelsPerSecond, renderedClips, trackTops],
	);

	const selectedItems = useCallback(
		() =>
			[...selectedIds].flatMap((id) => {
				const item = clipsById.get(id);
				return item ? [item] : [];
			}),
		[clipsById, selectedIds],
	);

	const splitAtPlayhead = useCallback(async () => {
		const at = playback.getCurrentTicks();
		const splits = selectedItems().flatMap(({ clip }) =>
			at > clip.start_ticks && at < clip.start_ticks + clip.duration_ticks
				? [{ clip_id: clip.id, right_clip_id: crypto.randomUUID() }]
				: [],
		);
		if (splits.length === 0) {
			onNotice("Move the playhead inside a selected clip before splitting.");
			return;
		}
		await onCommit({ edit: "split_clips", at_ticks: at, splits });
	}, [onCommit, onNotice, playback, selectedItems]);

	const keyboardMove = useCallback(
		async (direction: "left" | "right" | "up" | "down") => {
			const items = selectedItems();
			if (items.length === 0) return;
			let targetTrackId: string | null = null;
			if (direction === "up" || direction === "down") {
				const source = items[0]?.track;
				if (!source || items.some((item) => item.track.id !== source.id)) {
					onNotice("Cross-track keyboard move requires clips from one track.");
					return;
				}
				const sourceIndex = timeline.tracks.findIndex(
					(track) => track.id === source.id,
				);
				const step = direction === "up" ? -1 : 1;
				for (
					let index = sourceIndex + step;
					index >= 0 && index < timeline.tracks.length;
					index += step
				) {
					const candidate = timeline.tracks[index];
					if (candidate?.kind === source.kind) {
						targetTrackId = candidate.id;
						break;
					}
				}
				if (!targetTrackId) return;
			}
			await onCommit({
				edit: "move_clips",
				clip_ids: items.map((item) => item.clip.id),
				delta_ticks:
					direction === "left"
						? -frameTicks(timeline)
						: direction === "right"
							? frameTicks(timeline)
							: 0,
				target_track_id: targetTrackId,
				playhead_ticks: playback.getCurrentTicks(),
				snap_tolerance_ticks: 0,
				disable_snapping: true,
				ripple,
			});
		},
		[onCommit, onNotice, playback, ripple, selectedItems, timeline],
	);

	const keyboardTrim = useCallback(
		async (edge: "start" | "end") => {
			const item = selectedItems()[0];
			if (!item) return;
			await onCommit({
				edit: "trim_clip",
				clip_id: item.clip.id,
				edge,
				target_ticks: playback.getCurrentTicks(),
				playhead_ticks: playback.getCurrentTicks(),
				snap_tolerance_ticks: 0,
				disable_snapping: true,
				ripple,
			});
		},
		[onCommit, playback, ripple, selectedItems],
	);

	const handleKeyboard = useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>) => {
			const target = event.target;
			if (
				target instanceof HTMLInputElement ||
				target instanceof HTMLTextAreaElement ||
				(target instanceof HTMLElement && target.isContentEditable)
			)
				return;
			const key = event.key.toLowerCase();
			const arrowDirection =
				key === "arrowleft"
					? "left"
					: key === "arrowright"
						? "right"
						: key === "arrowup"
							? "up"
							: key === "arrowdown"
								? "down"
								: null;
			if (key === "j") playback.shuttle(-1);
			else if (key === "k") playback.shuttle(0);
			else if (key === "l") playback.shuttle(1);
			else if (key === " ") playback.toggle();
			else if (key === ",") playback.step(-1);
			else if (key === ".") playback.step(1);
			else if (key === "s") void splitAtPlayhead();
			else if (key === "n") setSnapping((value) => !value);
			else if (key === "r") setRipple((value) => !value);
			else if (key === "[") void keyboardTrim("start");
			else if (key === "]") void keyboardTrim("end");
			else if ((event.ctrlKey || event.metaKey) && key === "a") {
				setSelectedIds(new Set(clipsById.keys()));
			} else if (event.altKey && arrowDirection) {
				void keyboardMove(arrowDirection);
			} else if (key === "delete" || key === "backspace") {
				if (selectedIds.size > 0)
					void onCommit({
						edit: "delete_clips",
						clip_ids: [...selectedIds],
						ripple,
					});
			} else return;
			event.preventDefault();
		},
		[
			clipsById,
			keyboardMove,
			keyboardTrim,
			onCommit,
			playback,
			ripple,
			selectedIds,
			splitAtPlayhead,
		],
	);

	const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
		const element = event.currentTarget;
		if (scrollFrameRef.current !== null) return;
		scrollFrameRef.current = requestAnimationFrame(() => {
			scrollFrameRef.current = null;
			setScrollState((current) => ({
				...current,
				left: element.scrollLeft,
				top: element.scrollTop,
			}));
		});
	}, []);

	const rulerMarks = useMemo(() => {
		const startSecond = Math.floor(visibleStartTicks / 48_000);
		const interval = pixelsPerSecond < 10 ? 30 : pixelsPerSecond < 30 ? 10 : 5;
		const first = Math.floor(startSecond / interval) * interval;
		return Array.from(
			{ length: 24 },
			(_, index) => first + index * interval,
		).filter(
			(seconds) =>
				seconds >= 0 &&
				seconds * 48_000 <= timeline.duration_ticks + 60 * 48_000,
		);
	}, [pixelsPerSecond, timeline.duration_ticks, visibleStartTicks]);

	return (
		<section
			className="border-2 border-[#172128] bg-[#101419] text-[#e8eef2]"
			aria-label={copy("Master rough cut timeline")}
		>
			<div className="flex flex-wrap items-center gap-2 border-b border-[#66808d] bg-[#1b2430] p-2">
				<button
					type="button"
					onClick={() => playback.shuttle(-1)}
					className="min-h-9 min-w-9 border border-[#9eb0ba] px-2 font-mono font-bold focus-visible:outline-3 focus-visible:outline-[#f0b44d]"
					aria-label={copy("Shuttle reverse (J)")}
				>
					J
				</button>
				<button
					type="button"
					onClick={() => playback.shuttle(0)}
					className="min-h-9 min-w-9 border border-[#9eb0ba] px-2 font-mono font-bold focus-visible:outline-3 focus-visible:outline-[#f0b44d]"
					aria-label={copy("Stop playback (K)")}
				>
					K
				</button>
				<button
					type="button"
					onClick={() => playback.shuttle(1)}
					className="min-h-9 min-w-9 border border-[#9eb0ba] px-2 font-mono font-bold focus-visible:outline-3 focus-visible:outline-[#f0b44d]"
					aria-label={copy("Shuttle forward (L)")}
				>
					L
				</button>
				<button
					type="button"
					onClick={() => playback.step(-1)}
					className="min-h-9 border border-[#66808d] px-3 text-xs font-bold focus-visible:outline-3 focus-visible:outline-[#f0b44d]"
				>
					{copy("−1 frame")}
				</button>
				<button
					type="button"
					onClick={() => playback.step(1)}
					className="min-h-9 border border-[#66808d] px-3 text-xs font-bold focus-visible:outline-3 focus-visible:outline-[#f0b44d]"
				>
					{copy("+1 frame")}
				</button>
				<output
					ref={timecodeRef}
					className="min-w-28 border-l-2 border-[#d95c9e] pl-3 font-mono text-sm"
					aria-label={copy("Playhead timecode")}
				>
					00:00:00:00
				</output>
				<span
					className="mx-1 h-6 border-l border-[#66808d]"
					aria-hidden="true"
				/>
				<button
					type="button"
					onClick={() => void splitAtPlayhead()}
					className="min-h-9 border border-[#9eb0ba] px-3 text-xs font-bold focus-visible:outline-3 focus-visible:outline-[#f0b44d]"
				>
					{copy("Split selected (S)")}
				</button>
				<button
					type="button"
					onClick={() => void keyboardTrim("start")}
					className="min-h-9 border border-[#66808d] px-3 text-xs font-bold focus-visible:outline-3 focus-visible:outline-[#f0b44d]"
				>
					{copy("Trim start [")}
				</button>
				<button
					type="button"
					onClick={() => void keyboardTrim("end")}
					className="min-h-9 border border-[#66808d] px-3 text-xs font-bold focus-visible:outline-3 focus-visible:outline-[#f0b44d]"
				>
					{copy("Trim end ]")}
				</button>
				<button
					type="button"
					aria-pressed={snapping}
					onClick={() => setSnapping((value) => !value)}
					className="min-h-9 border border-[#66808d] px-3 text-xs font-bold aria-pressed:border-[#5b6cff] aria-pressed:bg-[#24335b] focus-visible:outline-3 focus-visible:outline-[#f0b44d]"
				>
					{copy("Snap (N)")}
				</button>
				<button
					type="button"
					aria-pressed={ripple}
					onClick={() => setRipple((value) => !value)}
					className="min-h-9 border border-[#66808d] px-3 text-xs font-bold aria-pressed:border-[#f0b44d] aria-pressed:bg-[#493a20] focus-visible:outline-3 focus-visible:outline-[#f0b44d]"
				>
					{copy("Ripple (R)")}
				</button>
				<label className="ml-auto flex items-center gap-2 font-mono text-[11px] uppercase">
					{copy("Zoom")}
					<input
						aria-label={copy("Timeline zoom")}
						type="range"
						min="4"
						max="120"
						step="2"
						value={pixelsPerSecond}
						onChange={(event) => setPixelsPerSecond(Number(event.target.value))}
						className="w-28 accent-[#5b6cff]"
					/>
				</label>
			</div>

			{/* This is a composite application widget with its own documented keyboard model. */}
			{/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
			<div
				ref={scrollRef}
				tabIndex={0}
				role="application"
				aria-label={copy(
					"Timeline tracks and clips. Use J K L for playback, Alt arrows to move, brackets to trim, S to split.",
				)}
				data-testid="m2-timeline"
				data-timeline-element-count={timeline.tracks.reduce(
					(total, track) => total + track.clips.length,
					0,
				)}
				className="relative h-[330px] overflow-auto outline-none focus-visible:ring-4 focus-visible:ring-inset focus-visible:ring-[#f0b44d]"
				onKeyDown={handleKeyboard}
				onScroll={handleScroll}
			>
				<div
					className="relative bg-[#101419]"
					role="group"
					aria-label={copy("Timeline clips")}
					style={{
						width: contentWidth,
						height: verticalWindow.totalHeight + 28,
					}}
					onPointerDown={beginBox}
					onPointerMove={updateBox}
					onPointerUp={finishBox}
					onPointerCancel={cancelGesture}
					onDoubleClick={(event) => {
						if (event.target !== event.currentTarget) return;
						playback.seek(
							ticksFromPixels({
								pixels: Math.max(0, event.nativeEvent.offsetX - LABEL_WIDTH),
								pixelsPerSecond,
							}),
						);
					}}
				>
					<div
						className="pointer-events-none sticky top-0 z-30 h-7 border-b border-[#66808d] bg-[#172128]"
						aria-hidden="true"
					>
						{rulerMarks.map((seconds) => (
							<div
								key={seconds}
								className="absolute top-0 h-7 border-l border-[#66808d] pl-1 font-mono text-[9px] text-[#aac0ca]"
								style={{ left: LABEL_WIDTH + seconds * pixelsPerSecond }}
							>
								{Math.floor(seconds / 60)}:
								{String(seconds % 60).padStart(2, "0")}
							</div>
						))}
					</div>

					{timeline.tracks
						.slice(verticalWindow.firstTrack, verticalWindow.lastTrack + 1)
						.map((track, relativeIndex) => {
							const trackIndex = verticalWindow.firstTrack + relativeIndex;
							return (
								<div
									key={track.id}
									role="presentation"
									className="pointer-events-none absolute left-0 border-b border-[#33414c]"
									style={{
										top: trackTops.get(trackIndex),
										width: contentWidth,
										height: track.height,
									}}
								>
									<div className="sticky left-0 z-20 flex h-full w-[132px] items-center border-r border-[#66808d] bg-[#1b2430] px-3">
										<span className="block min-w-0 truncate font-mono text-[10px] uppercase text-[#d6e0e5]">
											{track.name}
										</span>
									</div>
								</div>
							);
						})}

					{renderedClips.map((item) => {
						const selected = selectedIds.has(item.clip.id);
						const focused = focusedId === item.clip.id;
						const left =
							LABEL_WIDTH +
							pixelsFromTicks({
								ticks: item.clip.start_ticks,
								pixelsPerSecond,
							});
						const width = Math.max(
							18,
							pixelsFromTicks({
								ticks: item.clip.duration_ticks,
								pixelsPerSecond,
							}),
						);
						const top = (trackTops.get(item.track_index) ?? 28) + 6;
						const height = Math.max(
							28,
							(timeline.tracks[item.track_index]?.height ?? 48) - 12,
						);
						return (
							<div
								key={item.clip.id}
								data-timeline-node={item.clip.id}
								className="absolute"
								style={{ left, top, width, height }}
							>
								<button
									type="button"
									data-clip-id={item.clip.id}
									aria-pressed={selected}
									aria-label={`${item.clip.label}, starts ${Math.round(item.clip.start_ticks / 48) / 1000} seconds, duration ${Math.round(item.clip.duration_ticks / 48) / 1000} seconds`}
									tabIndex={
										focused ||
										(!focusedId && renderedClips[0]?.clip.id === item.clip.id)
											? 0
											: -1
									}
									onFocus={() => setFocusedId(item.clip.id)}
									onClick={(event) => selectClip(item.clip.id, event)}
									onPointerDown={(event) => beginMove(item.clip.id, event)}
									onPointerMove={updateMove}
									onPointerUp={(event) =>
										void finishPointerGesture(event.pointerId)
									}
									onPointerCancel={cancelGesture}
									className="h-full w-full overflow-hidden border border-[#8ea3ae] bg-[#27475a] px-3 text-left text-[11px] font-bold text-white shadow-[inset_0_3px_0_#5b6cff] aria-pressed:border-2 aria-pressed:border-[#f0b44d] aria-pressed:bg-[#3b4f65] focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[#f0b44d]"
								>
									<span className="block truncate">{item.clip.label}</span>
									<span className="block truncate font-mono text-[9px] font-normal text-[#c7d3d9]">
										{item.clip.has_audio ? "A/V" : "VIDEO"} ·{" "}
										{Math.round(item.clip.duration_ticks / 48) / 1000}
										{copy("s")}
									</span>
								</button>
								{selected && focused ? (
									<>
										<button
											type="button"
											aria-label={`Trim start of ${item.clip.label}`}
											onPointerDown={(event) =>
												beginTrim(item.clip, "start", event)
											}
											onPointerMove={updateTrim}
											onPointerUp={(event) =>
												void finishPointerGesture(event.pointerId)
											}
											onPointerCancel={cancelGesture}
											onKeyDown={(event) => {
												if (
													event.key === "ArrowLeft" ||
													event.key === "ArrowRight"
												) {
													event.preventDefault();
													const delta =
														event.key === "ArrowLeft"
															? -frameTicks(timeline)
															: frameTicks(timeline);
													void onCommit({
														edit: "trim_clip",
														clip_id: item.clip.id,
														edge: "start",
														target_ticks: item.clip.start_ticks + delta,
														playhead_ticks: playback.getCurrentTicks(),
														snap_tolerance_ticks: 0,
														disable_snapping: true,
														ripple,
													});
												}
											}}
											className="absolute inset-y-0 left-0 z-10 w-3 -translate-x-1/2 bg-[#f0b44d] focus-visible:outline-3 focus-visible:outline-white"
										/>
										<button
											type="button"
											aria-label={`Trim end of ${item.clip.label}`}
											onPointerDown={(event) =>
												beginTrim(item.clip, "end", event)
											}
											onPointerMove={updateTrim}
											onPointerUp={(event) =>
												void finishPointerGesture(event.pointerId)
											}
											onPointerCancel={cancelGesture}
											onKeyDown={(event) => {
												if (
													event.key === "ArrowLeft" ||
													event.key === "ArrowRight"
												) {
													event.preventDefault();
													const delta =
														event.key === "ArrowLeft"
															? -frameTicks(timeline)
															: frameTicks(timeline);
													void onCommit({
														edit: "trim_clip",
														clip_id: item.clip.id,
														edge: "end",
														target_ticks:
															item.clip.start_ticks +
															item.clip.duration_ticks +
															delta,
														playhead_ticks: playback.getCurrentTicks(),
														snap_tolerance_ticks: 0,
														disable_snapping: true,
														ripple,
													});
												}
											}}
											className="absolute inset-y-0 right-0 z-10 w-3 translate-x-1/2 bg-[#f0b44d] focus-visible:outline-3 focus-visible:outline-white"
										/>
									</>
								) : null}
							</div>
						);
					})}

					<div
						ref={playheadRef}
						className="pointer-events-none absolute top-0 z-40 h-full w-px bg-[#d95c9e] will-change-transform"
						aria-hidden="true"
					>
						<span className="absolute -left-1 top-0 block h-0 w-0 border-x-4 border-t-8 border-x-transparent border-t-[#d95c9e]" />
					</div>
					{box ? (
						<div
							className="pointer-events-none absolute z-50 border border-[#f0b44d] bg-[#f0b44d]/15"
							style={{
								left: box.left,
								top: box.top,
								width: box.right - box.left,
								height: box.bottom - box.top,
							}}
							aria-hidden="true"
						/>
					) : null}
				</div>
			</div>

			<div
				className="flex min-h-9 items-center justify-between gap-4 border-t border-[#66808d] bg-[#172128] px-3 font-mono text-[10px] text-[#c7d3d9]"
				role="status"
				aria-live="polite"
			>
				<span>
					{selectedIds.size} {copy("selected ·")} {renderedClips.length}/
					{visible.total_matching} {copy("logical clips mounted")}
					{visible.truncated ? " (bounded)" : ""}
				</span>
				<span>
					{snapLabel ?? "Shift bypasses snap · Escape cancels gesture"}
				</span>
			</div>
		</section>
	);
}

export function RoughCutTimeline(props: TimelineProps) {
	return <TimelineBody {...props} />;
}
