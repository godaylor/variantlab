"use client";

import type { TimelineEdit } from "@variantlab/studio-contract";
import { useEffect, useState } from "react";
import { applyTimelineEdit, createStressTimeline } from "./domain";
import { PlaybackChannel } from "./playback-channel";
import { RoughCutTimeline } from "./rough-cut-timeline";

const TWO_HOURS_TICKS = 2 * 60 * 60 * 48_000;

export function M2PerformanceHarness() {
	const [timeline, setTimeline] = useState(() =>
		createStressTimeline({
			duration_ticks: TWO_HOURS_TICKS,
			track_count: 20,
			clip_count: 10_000,
			fps_num: 30_000,
			fps_den: 1_001,
		}),
	);
	const [notice, setNotice] = useState("Reference corpus ready.");
	const [playback] = useState(
		() =>
			new PlaybackChannel({
				timeline,
				onFrame: () => undefined,
				onSemanticState: () => undefined,
			}),
	);

	useEffect(() => {
		playback.setTimeline(timeline);
	}, [playback, timeline]);

	useEffect(
		() => () => {
			playback.dispose();
		},
		[playback],
	);

	const apply = (edit: TimelineEdit) => applyTimelineEdit({ timeline, edit }).timeline;

	return (
		<main className="min-h-screen bg-[#dfe3df] p-6 text-[#172128]">
			<header className="mx-auto max-w-[1500px] border-2 border-[#172128] bg-[#f6f7f4] p-5 shadow-[5px_5px_0_#172128]">
				<p className="font-mono text-xs font-bold tracking-[0.18em] uppercase text-[#48606d]">VariantLab / M2 evidence harness</p>
				<h1 className="mt-1 text-3xl font-black">2h · 20 tracks · 10,000 clips</h1>
				<p className="mt-2 max-w-3xl text-sm text-[#48606d]">Deterministic Rust fixture. The mounted UI uses the same virtualized timeline, Rust commands, pointer previews and keyboard paths as the product workspace.</p>
			</header>
			<section className="mx-auto mt-6 max-w-[1500px]" aria-label="M2 performance corpus">
				<RoughCutTimeline
					timeline={timeline}
					playback={playback}
					onCommit={async (edit) => {
						const next = apply(edit);
						setTimeline(next);
						setNotice("Rust command committed to the reference corpus.");
					}}
					onNotice={setNotice}
					onGestureState={(active) => setNotice(active ? "Transient gesture preview." : "Canonical corpus state.")}
				/>
				<p className="mt-3 border-l-4 border-[#5b6cff] bg-[#f6f7f4] p-3 font-mono text-xs" role="status" aria-live="polite">{notice}</p>
			</section>
		</main>
	);
}
