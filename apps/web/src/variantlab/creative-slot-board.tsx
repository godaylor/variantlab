"use client";

import { useUiCopy } from "./ui-copy";
import type {
	BulkAssignmentPreview,
	CommandPayload,
	SceneScope,
	SlotAssignment,
	StudioState,
	VariantScope,
} from "@variantlab/studio-contract";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	CREATIVE_SET_IDS,
	CREATIVE_SLOT_IDS,
	creativeBundleAssignments,
	creativeSetCells,
	initialCreativeSets,
	standardCreativeSlots,
} from "./creative-assignment";
import { previewCreativeAssignments, resolveVariant } from "./domain";
import { SlotBindingEditor } from "./slot-binding-editor";

type AssignmentPath = "drag" | "menu";
type PendingAssignment = {
	path: AssignmentPath;
	creativeSetId: string;
	assignments: SlotAssignment[];
};
type CreativeSlotBoardProps = {
	state: StudioState;
	onCommand: (command: {
		payload: CommandPayload;
		sceneScope: SceneScope;
		variantScope: VariantScope;
	}) => Promise<void>;
	onNotice: (notice: string) => void;
};

const sequenceScope: SceneScope = { kind: "sequence" };
const masterScope: VariantScope = { kind: "master" };
const buttonClass =
	"border-2 border-[#172128] px-3 py-2 text-left text-xs font-bold disabled:opacity-40 focus-visible:outline-3 focus-visible:outline-[#d26532]";

function message(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string" && error.trim() !== "") return error;
	const rendered = String(error);
	return rendered === "[object Object]" ? "Creative command failed" : rendered;
}

function valueLabel(value: SlotAssignment["value"]): string {
	return value.kind === "text" ? value.text : value.asset_id;
}

export function CreativeSlotBoard({
	state,
	onCommand,
	onNotice,
}: CreativeSlotBoardProps) {
	const copy = useUiCopy();

	const [pending, setPending] = useState<PendingAssignment | null>(null);
	const [preview, setPreview] = useState<BulkAssignmentPreview | null>(null);
	const [diagnostic, setDiagnostic] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [dragPayload, setDragPayload] = useState("");
	const [menuPayload, setMenuPayload] = useState("");
	const campaign = state.campaign;
	const slots = campaign.slots ?? [];
	const creativeSets = useMemo(
		() => campaign.creative_sets ?? [],
		[campaign.creative_sets],
	);
	const slotAuditEvents = campaign.slot_audit_events ?? [];
	const profile = campaign.delivery_profiles[0] ?? null;
	const hookExists = slots.some((slot) => slot.id === CREATIVE_SLOT_IDS.hook);
	const fallbackExists = slots.some(
		(slot) => slot.id === CREATIVE_SLOT_IDS.hookFallback,
	);

	const rows = useMemo(() => {
		if (!profile) return [];
		return ["master", ...creativeSets.map((set) => set.id)].flatMap(
			(creativeSetId) => {
				const cell = campaign.variant_cells.find(
					(candidate) =>
						candidate.creative_set_id === creativeSetId &&
						candidate.delivery_profile_id === profile.id,
				);
				return cell
					? [
							{
								creativeSetId,
								resolved: resolveVariant({ state, cellId: cell.id }),
							},
						]
					: [];
			},
		);
	}, [campaign.variant_cells, creativeSets, profile, state]);

	useEffect(() => {
		if (!pending) return;
		const controller = new AbortController();
		const timer = window.setTimeout(() => {
			if (controller.signal.aborted) return;
			try {
				setPreview(
					previewCreativeAssignments({
						state,
						assignments: pending.assignments,
					}),
				);
			} catch (error: unknown) {
				setDiagnostic(message(error));
			}
		}, 0);
		return () => {
			controller.abort();
			window.clearTimeout(timer);
		};
	}, [pending, state]);

	const run = useCallback(
		async (
			payload: CommandPayload,
			variantScope: VariantScope = masterScope,
		) => {
			if (busy) return;
			setBusy(true);
			setDiagnostic(null);
			try {
				await onCommand({ payload, sceneScope: sequenceScope, variantScope });
			} catch (error: unknown) {
				const next = message(error);
				setDiagnostic(next);
				onNotice(next);
				throw error;
			} finally {
				setBusy(false);
			}
		},
		[busy, onCommand, onNotice],
	);

	const stageBundle = useCallback(
		(creativeSetId: string, path: AssignmentPath) => {
			const index = Math.max(
				0,
				CREATIVE_SET_IDS.findIndex((id) => id === creativeSetId),
			);
			const assignments = creativeBundleAssignments({
				creativeSetId,
				bundleIndex: index,
			});
			const serialized = JSON.stringify(assignments);
			if (path === "drag") setDragPayload(serialized);
			else setMenuPayload(serialized);
			setDiagnostic(null);
			setPending({ path, creativeSetId, assignments });
			setPreview(null);
		},
		[],
	);

	const applyPending = async () => {
		if (!pending || !preview) return;
		await run(
			{ command: "assign_slot_values", assignments: pending.assignments },
			{ kind: "creative_set", creative_set_id: pending.creativeSetId },
		);
		onNotice(
			"Applied one atomic transaction to " +
				preview.affected_cell_ids.length +
				" affected cell.",
		);
		setPending(null);
	};

	const auditEvent = ({
		kind,
		targetSlotId,
	}: {
		kind: "remap" | "drop_references";
		targetSlotId: string | null;
	}) => ({
		id: crypto.randomUUID(),
		kind,
		source_slot_id: CREATIVE_SLOT_IDS.hook,
		target_slot_id: targetSlotId,
		actor_id: "local-user",
		occurred_at: new Date().toISOString(),
	});

	return (
		<section
			className="mt-5 border-2 border-[#172128] bg-[#f6f7f4]"
			aria-labelledby="creative-slots-heading"
			data-testid="creative-slot-board"
			data-drag-payload={dragPayload}
			data-menu-payload={menuPayload}
		>
			<header className="grid gap-4 border-b-2 border-[#172128] bg-[#dfc86f] p-4 md:grid-cols-[1fr_auto] md:items-end">
				<div>
					<p className="font-mono text-[10px] font-bold tracking-[0.18em] uppercase">
						{copy("M4 / controlled creative rows")}
					</p>
					<h4 id="creative-slots-heading" className="mt-1 text-xl font-black">
						{copy("Creative slot board")}
					</h4>
					<p className="mt-1 max-w-2xl text-xs text-[#394e59]">
						{copy(
							"Typed values inherit master timing and style; assignments never copy the timeline.",
						)}
					</p>
				</div>
				<div className="font-mono text-[10px] font-bold uppercase md:text-right">
					<p data-testid="creative-row-limit">
						{copy("Rows")} {1 + creativeSets.length} / 12
					</p>
					<p data-testid="creative-slot-limit">
						{copy("Slots")} {slots.length} {copy("/ 32 · cells")}{" "}
						{campaign.variant_cells.length} / 100
					</p>
				</div>
			</header>

			<div className="grid gap-4 p-4 xl:grid-cols-[250px_minmax(0,1fr)]">
				<aside className="border border-[#172128] bg-white p-4">
					<h5 className="font-black">{copy("Setup and source bundle")}</h5>
					<div className="mt-3 grid gap-2">
						<button
							type="button"
							disabled={busy || slots.length > 0}
							onClick={() =>
								void run({
									command: "create_slots",
									slots: standardCreativeSlots(),
								}).catch(() => undefined)
							}
							className={buttonClass + " bg-[#194f78] text-white"}
						>
							{copy("Declare standard creative slots")}
						</button>
						<button
							type="button"
							disabled={
								busy ||
								creativeSets.length > 0 ||
								slots.length === 0 ||
								campaign.delivery_profiles.length === 0
							}
							onClick={() => {
								const sets = initialCreativeSets();
								void run({
									command: "create_creative_sets",
									sets,
									cells: creativeSetCells({
										sets,
										profiles: campaign.delivery_profiles,
									}),
								}).catch(() => undefined);
							}}
							className={buttonClass}
						>
							{copy("Create 3 hook sets")}
						</button>
					</div>

					<div
						draggable={creativeSets.length > 0}
						onDragStart={(event) => {
							event.dataTransfer.effectAllowed = "copy";
							event.dataTransfer.setData(
								"text/variantlab-bundle",
								"hook-bundle",
							);
						}}
						className="mt-4 w-full cursor-grab border-2 border-dashed border-[#4656ce] bg-[#eef0ff] p-3 text-left focus-visible:outline-3 focus-visible:outline-[#d26532]"
						data-testid="creative-bundle-source"
					>
						<span className="block font-mono text-[10px] font-bold uppercase">
							{copy("Draggable source")}
						</span>
						<span className="mt-1 block text-sm font-black">
							{copy("Hook + headline + CTA")}
						</span>
						<span className="mt-1 block text-xs text-[#48606d]">
							{copy("3 typed assignments · fixed duration")}
						</span>
					</div>

					{pending ? (
						<div
							className="mt-4 border-l-4 border-[#4656ce] bg-[#eef0ff] p-3"
							data-testid="assignment-preview"
						>
							<p className="font-mono text-[10px] font-bold uppercase">
								{copy("Staged via")} {pending.path}
							</p>
							<p className="mt-1 text-xs">
								{preview
									? preview.affected_cell_ids.length +
										" affected cell · " +
										preview.reused_asset_ids.length +
										" reused asset"
									: "Resolving dependencies…"}
							</p>
							<div className="mt-3 flex gap-2">
								<button
									type="button"
									disabled={!preview || busy}
									onClick={() => void applyPending().catch(() => undefined)}
									className={buttonClass + " bg-[#4656ce] text-white"}
								>
									{copy("Apply staged assignment")}
								</button>
								<button
									type="button"
									onClick={() => setPending(null)}
									className={buttonClass}
								>
									{copy("Cancel")}
								</button>
							</div>
						</div>
					) : null}
				</aside>

				<div className="min-w-0">
					{profile ? (
						<div className="grid gap-2">
							{rows.map((row) => {
								const set = creativeSets.find(
									(candidate) => candidate.id === row.creativeSetId,
								);
								const isMaster = row.creativeSetId === "master";
								return (
									<article
										key={row.creativeSetId}
										data-testid={"creative-row-" + row.creativeSetId}
										onDragOver={(event) => {
											if (!isMaster) event.preventDefault();
										}}
										onDrop={(event) => {
											if (isMaster) return;
											event.preventDefault();
											if (
												event.dataTransfer.getData("text/variantlab-bundle") ===
												"hook-bundle"
											) {
												stageBundle(row.creativeSetId, "drag");
											}
										}}
										className={
											"grid gap-3 border border-[#172128] p-3 md:grid-cols-[150px_minmax(0,1fr)_165px] " +
											(isMaster ? "bg-[#dfe5e2]" : "bg-white")
										}
									>
										<div>
											<h5 className="font-black">
												{isMaster ? "Master" : set?.name}
											</h5>
											<p className="font-mono text-[9px] text-[#48606d]">
												{row.creativeSetId}
											</p>
											<p
												className="mt-2 break-all font-mono text-[9px]"
												data-testid={
													"creative-fingerprint-" + row.creativeSetId
												}
											>
												{row.resolved.fingerprint}
											</p>
										</div>
										<ul className="grid gap-1 text-xs">
											{row.resolved.resolved_slots.map((slot) => (
												<li
													key={slot.slot_id}
													data-slot-id={slot.slot_id}
													tabIndex={-1}
												>
													<span className="font-bold">{slot.slot_name}</span>
													{" · "}
													{valueLabel(slot.value)}
													{" · "}
													<span className="font-mono text-[9px] uppercase">
														{slot.value_source}
													</span>
												</li>
											))}
										</ul>
										{isMaster ? (
											<p className="font-mono text-[10px] uppercase">
												{copy("Source of truth")}
											</p>
										) : (
											<div className="grid content-start gap-2">
												<p className="border border-dashed border-[#4656ce] p-2 font-mono text-[9px]">
													{copy("Drop bundle here")}
												</p>
												<button
													type="button"
													onClick={() => stageBundle(row.creativeSetId, "menu")}
													className={buttonClass}
												>
													{copy("Assign bundle via menu")}
												</button>
												<button
													type="button"
													onClick={() =>
														void run(
															{ command: "undo" },
															{
																kind: "creative_set",
																creative_set_id: row.creativeSetId,
															},
														).catch(() => undefined)
													}
													className={buttonClass}
												>
													{copy("Undo this row")}
												</button>
											</div>
										)}
									</article>
								);
							})}
						</div>
					) : (
						<p className="border border-[#a63824] bg-[#f3d5c8] p-4 text-sm">
							{copy("Create the M3 delivery profile before CreativeSet rows.")}
						</p>
					)}

					{slots.length > 0 ? (
						<div className="mt-4 border border-[#172128] bg-white p-4">
							<h5 className="font-black">
								{copy("Master inheritance and safe deletion")}
							</h5>
							<div className="mt-3 flex flex-wrap gap-2">
								<button
									type="button"
									onClick={() =>
										void run({
											command: "update_master_slot_style",
											slot_id: CREATIVE_SLOT_IDS.headline,
											style_fingerprint:
												"style:master-headline-rev-" +
												String(campaign.revision + 1),
										}).catch(() => undefined)
									}
									className={buttonClass + " bg-[#dfc86f]"}
								>
									{copy("Update master headline style")}
								</button>
								<button
									type="button"
									disabled={!hookExists}
									onClick={() =>
										void run({
											command: "delete_slot",
											slot_id: CREATIVE_SLOT_IDS.hook,
										}).catch(() => undefined)
									}
									className={buttonClass + " text-[#702514]"}
								>
									{copy("Delete live Hook slot")}
								</button>
								<button
									type="button"
									disabled={!hookExists || !fallbackExists}
									onClick={() =>
										void run({
											command: "remap_and_delete_slot",
											source_slot_id: CREATIVE_SLOT_IDS.hook,
											target_slot_id: CREATIVE_SLOT_IDS.hookFallback,
											audit_event: auditEvent({
												kind: "remap",
												targetSlotId: CREATIVE_SLOT_IDS.hookFallback,
											}),
										}).catch(() => undefined)
									}
									className={buttonClass}
								>
									{copy("Remap Hook to fallback + delete")}
								</button>
								<button
									type="button"
									disabled={!hookExists}
									onClick={() =>
										void run({
											command: "drop_and_delete_slot",
											slot_id: CREATIVE_SLOT_IDS.hook,
											audit_event: auditEvent({
												kind: "drop_references",
												targetSlotId: null,
											}),
										}).catch(() => undefined)
									}
									className={buttonClass}
								>
									{copy("Drop references + delete")}
								</button>
								<button
									type="button"
									onClick={() =>
										void run({ command: "undo" }).catch(() => undefined)
									}
									className={buttonClass}
								>
									{copy("Undo master slot change")}
								</button>
							</div>
							{slotAuditEvents.length > 0 ? (
								<ul
									className="mt-3 border-l-4 border-[#4656ce] bg-[#eef0ff] p-3 text-xs"
									data-testid="slot-audit"
								>
									{slotAuditEvents.map((event) => (
										<li key={event.id}>
											{copy("Audit ·")} {event.kind} · {event.source_slot_id}
											{event.target_slot_id
												? " to " + event.target_slot_id
												: ""}
										</li>
									))}
								</ul>
							) : null}
						</div>
					) : null}
				</div>
			</div>

			<SlotBindingEditor
				key={campaign.id}
				state={state}
				onCommand={(payload) => run(payload)}
			/>
			{diagnostic ? (
				<div
					className="border-t-2 border-[#a63824] bg-[#f3d5c8] p-4 text-sm"
					role="alert"
				>
					<p className="font-black">{copy("Creative command blocked")}</p>
					<p className="mt-1">{diagnostic}</p>
				</div>
			) : null}
		</section>
	);
}
