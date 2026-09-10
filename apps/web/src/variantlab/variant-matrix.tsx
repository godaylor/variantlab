"use client";

/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- the labelled virtualized scroll region must be keyboard-focusable in Safari. */

import { useUiCopy } from "./ui-copy";
import type {
	BrandKit,
	CommandPayload,
	CreativeSet,
	DeliveryProfile,
	SceneScope,
	StudioState,
	VariantCell,
	VariantProjectionItem,
	VariantScope,
} from "@variantlab/studio-contract";
import {
	type ChangeEvent,
	type KeyboardEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { planVariantThumbnails, queryVariantProjectionPage } from "./domain";
import { VariantMatrixCorpusAdapter } from "./variant-matrix-corpus";
import { matrixWindow, moveMatrixFocus } from "./variant-matrix-ui";
import { ManifestPreviewWall } from "./manifest-preview-wall";
import { MatrixCreateControls } from "./matrix-create-controls";

type ScopedCommand = {
	payload: CommandPayload;
	sceneScope: SceneScope;
	variantScope: VariantScope;
};

type VariantMatrixProps = {
	state: StudioState;
	previewUrl: string | null;
	onCommand: (command: ScopedCommand) => Promise<void>;
	onNotice: (notice: string) => void;
};

type M6Metrics = {
	renders: number;
	projectionSamplesMs: number[];
};

function recordM6Metric(durationMs?: number) {
	if (typeof window === "undefined") return;
	const target = window as Window & { __variantlabM6Metrics?: M6Metrics };
	const metrics = target.__variantlabM6Metrics ?? {
		renders: 0,
		projectionSamplesMs: [],
	};
	if (durationMs === undefined) metrics.renders += 1;
	if (durationMs !== undefined) {
		metrics.projectionSamplesMs.push(durationMs);
		if (metrics.projectionSamplesMs.length > 100) {
			metrics.projectionSamplesMs.shift();
		}
	}
	target.__variantlabM6Metrics = metrics;
}
const ROW_HEIGHT = 64;
const VIEWPORT_HEIGHT = 320;
const REVIEW_SET_IDS = [
	"creative-hook-a",
	"creative-hook-b",
	"creative-hook-c",
	"creative-hook-d",
	"creative-hook-e",
	"creative-hook-f",
	"creative-hook-g",
] as const;

const REVIEW_PROFILES: DeliveryProfile[] = [
	{
		id: "delivery-landscape-16x9",
		name: "Landscape 16:9",
		canvas: { width: 1920, height: 1080 },
		safe_area: {
			top_basis_points: 500,
			right_basis_points: 500,
			bottom_basis_points: 500,
			left_basis_points: 500,
		},
		locale: "source",
		layout_constraints: ["safe_area", "text_size_px:18"],
		version: 1,
		locale_profile_id: null,
	},
	{
		id: "delivery-square-1x1",
		name: "Square 1:1",
		canvas: { width: 1080, height: 1080 },
		safe_area: {
			top_basis_points: 700,
			right_basis_points: 700,
			bottom_basis_points: 700,
			left_basis_points: 700,
		},
		locale: "source",
		layout_constraints: ["safe_area", "text_size_px:18"],
		version: 1,
		locale_profile_id: null,
	},
];

function candidateKey({
	rowId,
	profileId,
}: {
	rowId: string;
	profileId: string;
}): string {
	return `${rowId}::${profileId}`;
}

function candidateCellId({
	rowId,
	profileId,
}: {
	rowId: string;
	profileId: string;
}): string {
	return `cell-${rowId}-${profileId}`;
}

function statusClass(status: VariantProjectionItem["status"] | "disabled") {
	if (status === "error") return "border-[#a63824] bg-[#f3d5c8]";
	if (status === "warning") return "border-[#b66a10] bg-[#fff0c9]";
	if (status === "stale") return "border-[#4656ce] bg-[#eef0ff]";
	if (status === "detached") return "border-[#7a5270] bg-[#f0e1eb]";
	if (status === "ready") return "border-[#35704b] bg-[#e3f0e7]";
	return "border-[#8a9690] bg-[#eef0ed]";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function brandKitIsValid(value: unknown): value is BrandKit {
	if (!isRecord(value)) return false;
	const record = value;
	return (
		typeof record.id === "string" &&
		typeof record.name === "string" &&
		typeof record.version === "number" &&
		typeof record.fingerprint === "string" &&
		typeof record.logo_required === "boolean" &&
		Array.isArray(record.allowed_color_tokens) &&
		Array.isArray(record.allowed_font_ids) &&
		Array.isArray(record.custom_safe_regions)
	);
}

export function VariantMatrix({
	state,
	onCommand,
	onNotice,
}: VariantMatrixProps) {
	const copy = useUiCopy();

	const campaign = state.campaign;
	const creativeSets = useMemo(
		() => campaign.creative_sets ?? [],
		[campaign.creative_sets],
	);
	const rows = useMemo(
		() => [
			{ id: "master", name: "Master" },
			...creativeSets.map((set) => ({ id: set.id, name: set.name })),
		],
		[creativeSets],
	);
	const profiles = campaign.delivery_profiles;
	const projections = useMemo(
		() => {
			// eslint-disable-next-line react-hooks/purity -- timing is diagnostic only and never influences rendered state or domain output.
			const startedAt = performance.now();
			const result = queryVariantProjectionPage({ state, page: 0, pageSize: 100 });
			// eslint-disable-next-line react-hooks/purity -- observe this actual computation; do not rerun domain work to populate metrics.
			recordM6Metric(performance.now() - startedAt);
			return result;
		},
		[state],
	);
	const projectionByCell = useMemo(
		() => new Map(projections.items.map((item) => [item.cell_id, item])),
		[projections.items],
	);
	const cellByKey = useMemo(
		() =>
			new Map(
				campaign.variant_cells.map((cell) => [
					candidateKey({
						rowId: cell.creative_set_id,
						profileId: cell.delivery_profile_id,
					}),
					cell,
				]),
			),
		[campaign.variant_cells],
	);
	const [selected, setSelected] = useState<Set<string>>(() => new Set());
	const [focused, setFocused] = useState({ row: 0, column: 0 });
	const [scrollTop, setScrollTop] = useState(0);
	const [busy, setBusy] = useState(false);
	const viewportRef = useRef<HTMLDivElement>(null);
	const cellRefs = useRef(new Map<string, HTMLButtonElement>());
	const window = matrixWindow({
		scrollTop,
		rowHeight: ROW_HEIGHT,
		viewportHeight: VIEWPORT_HEIGHT,
		rowCount: rows.length,
		columnCount: Math.max(1, profiles.length),
	});
	const visibleRows =
		window.lastRow < window.firstRow
			? []
			: rows.slice(window.firstRow, window.lastRow + 1);
	const focusedRow = rows[focused.row];
	const focusedProfile = profiles[focused.column];
	const focusedKey =
		focusedRow && focusedProfile
			? candidateKey({ rowId: focusedRow.id, profileId: focusedProfile.id })
			: null;
	const focusedCell = focusedKey ? (cellByKey.get(focusedKey) ?? null) : null;
	const focusedProjection = focusedCell
		? (projectionByCell.get(focusedCell.id) ?? null)
		: null;
	// The comparison wall follows selection/focus, not the matrix scroll offset.
	// Its own IntersectionObserver controls decode visibility. Scrolling the grid
	// must not rebuild 24 manifests or restart the wall's worker on every row.
	const wallCellIds = useMemo(() => {
		const chosen = campaign.variant_cells.filter(cell => selected.has(candidateKey({ rowId: cell.creative_set_id, profileId: cell.delivery_profile_id })));
		const candidates = (chosen.length ? chosen : campaign.variant_cells).map(cell => cell.id);
		const wallCandidates = focusedCell ? [focusedCell.id, ...candidates.filter(id => id !== focusedCell.id)] : candidates;
		return planVariantThumbnails({ visibleCellIds: wallCandidates.slice(0, 24), focusedCellId: focusedCell?.id ?? null, priorActiveIds: [], maxJobs: 24 }).queued.map(item => item.cell_id);
	}, [campaign.variant_cells, selected, focusedCell]);
	const diagnostics = projections.items.flatMap((item) =>
		item.diagnostics.map((diagnostic) => ({ item, diagnostic })),
	);

	useEffect(() => {
		recordM6Metric();
	});

	useEffect(() => {
		if (!focusedKey) return;
		const frame = requestAnimationFrame(() => {
			cellRefs.current.get(focusedKey)?.focus({ preventScroll: true });
		});
		return () => cancelAnimationFrame(frame);
	}, [focusedKey, window.firstRow, window.lastRow]);

	const run = useCallback(
		async (payload: CommandPayload, variantScope: VariantScope) => {
			setBusy(true);
			try {
				await onCommand({
					payload,
					sceneScope: { kind: "sequence" },
					variantScope,
				});
			} catch (error: unknown) {
				onNotice(error instanceof Error ? error.message : String(error));
				throw error;
			} finally {
				setBusy(false);
			}
		},
		[onCommand, onNotice],
	);

	function addReviewProfiles() {
		const existing = new Set(profiles.map((profile) => profile.id));
		const missing = REVIEW_PROFILES.filter(
			(profile) => !existing.has(profile.id),
		);
		if (missing.length === 0) {
			onNotice("16:9, 1:1 and 9:16 review profiles are already explicit.");
			return;
		}
		void run(
			{ command: "add_delivery_profiles", profiles: missing },
			{ kind: "master" },
		);
	}

	function addReviewRows() {
		const existing = new Set(creativeSets.map((set) => set.id));
		const sets: CreativeSet[] = REVIEW_SET_IDS.filter(
			(id) => !existing.has(id),
		).map((id, index) => ({
			id,
			name: `Hook ${String.fromCharCode(65 + index)}`,
			replacements: [],
			version: 1,
		}));
		if (sets.length === 0) {
			onNotice("Eight review rows are already explicit.");
			return;
		}
		void run(
			{ command: "create_creative_sets", sets, cells: [] },
			{ kind: "master" },
		);
	}

	function selectFirst(count: number) {
		const keys: string[] = [];
		for (const row of rows) {
			for (const profile of profiles) {
				keys.push(candidateKey({ rowId: row.id, profileId: profile.id }));
				if (keys.length === count) break;
			}
			if (keys.length === count) break;
		}
		setSelected(new Set(keys));
		onNotice(
			`${keys.length} explicit matrix candidates selected; review cost before enable.`,
		);
	}

	function enableSelected() {
		const cells: VariantCell[] = [];
		for (const key of selected) {
			if (cellByKey.has(key)) continue;
			const [creativeSetId, deliveryProfileId] = key.split("::");
			if (!creativeSetId || !deliveryProfileId) continue;
			cells.push({
				id: candidateCellId({
					rowId: creativeSetId,
					profileId: deliveryProfileId,
				}),
				creative_set_id: creativeSetId,
				delivery_profile_id: deliveryProfileId,
				layout_override: null,
				version: 1,
			});
		}
		if (cells.length === 0) {
			onNotice(
				"Selected cells are already enabled; no history entry was created.",
			);
			return;
		}
		void run(
			{ command: "enable_variant_cells", cells },
			{ kind: "master" },
		).then(() => setSelected(new Set()));
	}

	function detachSelected() {
		const cellIds = [...selected]
			.map((key) => cellByKey.get(key)?.id)
			.filter((cellId): cellId is string => Boolean(cellId));
		if (cellIds.length === 0) {
			onNotice("Select enabled cells before detaching layout exceptions.");
			return;
		}
		void run(
			{ command: "detach_variant_cells", cell_ids: cellIds },
			{ kind: "master" },
		).then(() => setSelected(new Set()));
	}
	function focusPosition({ row, column }: { row: number; column: number }) {
		setFocused({ row, column });
		const targetTop = row * ROW_HEIGHT;
		const viewport = viewportRef.current;
		if (viewport) {
			const bottom = viewport.scrollTop + VIEWPORT_HEIGHT;
			if (targetTop < viewport.scrollTop) viewport.scrollTop = targetTop;
			if (targetTop + ROW_HEIGHT > bottom) {
				viewport.scrollTop = targetTop - VIEWPORT_HEIGHT + ROW_HEIGHT;
			}
		}
		requestAnimationFrame(() =>
			cellRefs.current
				.get(
					candidateKey({
						rowId: rows[row]?.id ?? "",
						profileId: profiles[column]?.id ?? "",
					}),
				)
				?.focus(),
		);
	}

	function handleGridKey({
		event,
		row,
		column,
		key,
	}: {
		event: KeyboardEvent<HTMLButtonElement>;
		row: number;
		column: number;
		key: string;
	}) {
		if (event.key === " " || event.key === "Spacebar") {
			event.preventDefault();
			if (event.shiftKey) {
				setSelected((current) => {
					const next = new Set(current);
					for (const profile of profiles)
						next.add(
							candidateKey({ rowId: rows[row].id, profileId: profile.id }),
						);
					return next;
				});
				return;
			}
			if (event.ctrlKey || event.metaKey) {
				setSelected((current) => {
					const next = new Set(current);
					for (const candidate of rows)
						next.add(
							candidateKey({
								rowId: candidate.id,
								profileId: profiles[column].id,
							}),
						);
					return next;
				});
				return;
			}
			setSelected((current) => {
				const next = new Set(current);
				if (next.has(key)) next.delete(key);
				else next.add(key);
				return next;
			});
			return;
		}
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
			event.preventDefault();
			selectFirst(Math.min(100, rows.length * profiles.length));
			return;
		}
		if (event.key === "Enter") {
			event.preventDefault();
			if (event.ctrlKey || event.metaKey) enableSelected();
			else setFocused({ row, column });
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			setSelected(new Set());
			return;
		}
		if (
			![
				"ArrowUp",
				"ArrowDown",
				"ArrowLeft",
				"ArrowRight",
				"Home",
				"End",
			].includes(event.key)
		)
			return;
		event.preventDefault();
		const next = moveMatrixFocus({
			position: { row, column },
			key: event.key,
			rowCount: rows.length,
			columnCount: profiles.length,
			ctrlOrMeta: event.ctrlKey || event.metaKey,
		});
		focusPosition({ row: next.row, column: next.column });
	}

	async function importBrandKit(event: ChangeEvent<HTMLInputElement>) {
		const file = event.target.files?.[0];
		event.target.value = "";
		if (!file) return;
		if (file.size > 256 * 1024) {
			onNotice("BrandKit JSON exceeds the 256 KiB import limit.");
			return;
		}
		try {
			const parsed: unknown = JSON.parse(await file.text());
			if (!brandKitIsValid(parsed))
				throw new Error("BrandKit JSON does not match the versioned contract");
			await run(
				{ command: "set_brand_kit", brand_kit: parsed },
				{ kind: "master" },
			);
		} catch (error: unknown) {
			onNotice(error instanceof Error ? error.message : String(error));
		}
	}

	function applyBrandProfileFixes() {
		const kit = campaign.brand_kit;
		if (!kit) return;
		const safeArea = kit.custom_safe_regions[0]?.safe_area;
		const updated = profiles.map((profile) => ({
			...profile,
			safe_area: safeArea ?? profile.safe_area,
			layout_constraints: [
				...profile.layout_constraints.filter(
					(rule) => !rule.startsWith("text_size_px:"),
				),
				"text_size_px:" + kit.minimum_text_size_px,
			],
			version: profile.version + 1,
		}));
		void run(
			{ command: "add_delivery_profiles", profiles: updated },
			{ kind: "master" },
		);
	}

	function jumpToDiagnostic({
		item,
		slotId,
	}: {
		item: VariantProjectionItem;
		slotId: string | null;
	}) {
		const cell = campaign.variant_cells.find(
			(candidate) => candidate.id === item.cell_id,
		);
		if (!cell) return;
		const row = rows.findIndex(
			(candidate) => candidate.id === cell.creative_set_id,
		);
		const column = profiles.findIndex(
			(candidate) => candidate.id === cell.delivery_profile_id,
		);
		if (row >= 0 && column >= 0) focusPosition({ row, column });
		if (slotId) {
			requestAnimationFrame(() => {
				const target = document.querySelector<HTMLElement>(
					`[data-testid="creative-row-${CSS.escape(cell.creative_set_id)}"] [data-slot-id="${CSS.escape(slotId)}"]`,
				);
				target?.focus();
			});
		}
	}

	return (
		<section
			className="mt-5 border-2 border-[#172128] bg-[#f6f7f4]"
			aria-labelledby="variant-matrix-heading"
			data-testid="variant-matrix"
		>
			<header className="grid gap-3 border-b-2 border-[#172128] bg-[#cad7df] p-4 lg:grid-cols-[1fr_auto]">
				<div>
					<p className="font-mono text-[10px] font-bold tracking-[0.18em] uppercase text-[#394e59]">
						{copy("M6 / production QA")}
					</p>
					<h4 id="variant-matrix-heading" className="mt-1 text-xl font-black">
						{copy("Variant Matrix + Prism")}
					</h4>
					<p className="mt-1 text-xs text-[#394e59]">
						{copy(
							"Only explicit cells are persisted. Matrix readiness is local preflight, not reviewer approval.",
						)}
					</p>
				</div>
				<div className="grid grid-cols-3 gap-2 font-mono text-[10px] text-center">
					<p className="border border-[#172128] bg-white p-2">
						<span className="block text-[#48606d]">{copy("PROFILES")}</span>
						{profiles.length} / 24
					</p>
					<p
						className="border border-[#172128] bg-white p-2"
						data-testid="matrix-cell-count"
					>
						<span className="block text-[#48606d]">{copy("CELLS")}</span>
						{campaign.variant_cells.length} / 100
					</p>
					<p className="border border-[#172128] bg-white p-2">
						<span className="block text-[#48606d]">{copy("DETACHED")}</span>
						{
							projections.items.filter((item) => item.status === "detached")
								.length
						}{" "}
						/ 20
					</p>
				</div>
			</header>

			<div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_290px]">
				<div className="min-w-0">
					<MatrixCreateControls
						profiles={profiles}
						disabled={busy}
						onCommand={(payload) => run(payload, { kind: "master" })}
					/>
					<button
						type="button"
						disabled={busy}
						onClick={() => selectFirst(50)}
						className="mb-3 border-2 border-[#172128] bg-white px-3 py-2 text-xs font-bold focus-visible:outline-3 focus-visible:outline-[#d26532]"
					>
						{copy("Select first 50")}
					</button>
					<div className="mb-3 flex flex-wrap items-center gap-2">
						<button
							type="button"
							disabled={busy}
							onClick={addReviewProfiles}
							className="border-2 border-[#172128] bg-white px-3 py-2 text-xs font-bold focus-visible:outline-3 focus-visible:outline-[#d26532]"
						>
							{copy("Add 16:9 + 1:1 profiles")}
						</button>
						<button
							type="button"
							disabled={busy}
							onClick={addReviewRows}
							className="border-2 border-[#172128] bg-white px-3 py-2 text-xs font-bold focus-visible:outline-3 focus-visible:outline-[#d26532]"
						>
							{copy("Add review rows to 8")}
						</button>
						<button
							type="button"
							disabled={busy || rows.length * profiles.length < 24}
							onClick={() => selectFirst(24)}
							className="border-2 border-[#4656ce] bg-[#eef0ff] px-3 py-2 text-xs font-bold focus-visible:outline-3 focus-visible:outline-[#d26532]"
						>
							{copy("Select first 24")}
						</button>
						<VariantMatrixCorpusAdapter
							state={state}
							disabled={busy}
							onCommand={({ payload, variantScope }) =>
								run(payload, variantScope)
							}
							onNotice={onNotice}
							onReady={() => selectFirst(100)}
						/>
						<button
							type="button"
							disabled={busy || selected.size === 0}
							onClick={enableSelected}
							className="border-2 border-[#172128] bg-[#4656ce] px-3 py-2 text-xs font-bold text-white focus-visible:outline-3 focus-visible:outline-[#ffd277]"
						>
							{copy("Enable")} {selected.size} {copy("selected")}
						</button>{" "}
						<button
							type="button"
							disabled={busy || selected.size === 0}
							onClick={detachSelected}
							className="border-2 border-[#7a5270] bg-[#f0e1eb] px-3 py-2 text-xs font-bold focus-visible:outline-3 focus-visible:outline-[#d26532]"
						>
							{copy("Detach selected")}
						</button>
						<button
							type="button"
							disabled={busy}
							onClick={() => void run({ command: "undo" }, { kind: "master" })}
							className="border-2 border-[#172128] bg-white px-3 py-2 text-xs font-bold focus-visible:outline-3 focus-visible:outline-[#d26532]"
						>
							{copy("Undo Matrix Change")}
						</button>
					</div>
					<p
						className="mb-2 font-mono text-[10px] text-[#48606d]"
						data-testid="matrix-cost-preview"
					>
						{copy("PRE-COMMIT ·")} {selected.size} {copy("cells ·")}{" "}
						{selected.size}{" "}
						{copy("bounded thumbnail jobs · no Cartesian materialization")}
					</p>

					{/* Safari needs the labelled scroll region itself in the keyboard order. */}
					<div
						role="region"
						ref={viewportRef}
						onScroll={(event) => {
							// Pixel scrolling stays native. React only updates at row boundaries.
							const rowOffset = Math.floor(event.currentTarget.scrollTop / ROW_HEIGHT) * ROW_HEIGHT;
							setScrollTop(previous => previous === rowOffset ? previous : rowOffset);
						}}
						style={{ height: VIEWPORT_HEIGHT }}
						className="overflow-auto border-2 border-[#172128] bg-white focus-visible:outline-4 focus-visible:outline-[#d26532]"
						data-testid="matrix-viewport"
						tabIndex={0}
						aria-label="Scrollable virtualized variant matrix"
					>
						<div
							role="grid"
							aria-label="Creative sets by delivery profiles"
							aria-rowcount={rows.length}
							aria-colcount={profiles.length}
							aria-multiselectable="true"
							style={{
								minWidth: Math.max(720, profiles.length * 150),
								paddingTop: window.firstRow * ROW_HEIGHT,
								paddingBottom:
									Math.max(0, rows.length - window.lastRow - 1) * ROW_HEIGHT,
							}}
						>
							<div
								role="row"
								className="sticky top-0 z-10 grid bg-[#172128] text-white forced-colors:bg-[Canvas] forced-colors:text-[CanvasText]"
								style={{
									gridTemplateColumns: `150px repeat(${Math.max(1, profiles.length)}, minmax(140px,1fr))`,
								}}
							>
								<span role="columnheader" className="p-2 font-mono text-[10px]">
									{copy("CREATIVE / DELIVERY")}
								</span>
								{profiles.map((profile) => (
									<span
										key={profile.id}
										role="columnheader"
										className="border-l border-[#66808d] p-2 text-xs"
									>
										<b>{profile.name}</b>
										<span className="block font-mono text-[9px] text-[#aac0ca] forced-colors:text-[CanvasText]">
											{profile.canvas.width}×{profile.canvas.height}
										</span>
									</span>
								))}
							</div>
							{visibleRows.map((row, visibleIndex) => {
								const rowIndex = window.firstRow + visibleIndex;
								return (
									<div
										role="row"
										aria-rowindex={rowIndex + 1}
										key={row.id}
										className="grid"
										style={{
											height: ROW_HEIGHT,
											gridTemplateColumns: `150px repeat(${Math.max(1, profiles.length)}, minmax(140px,1fr))`,
										}}
									>
										<span
											role="rowheader"
											className="border-t border-[#a9b1ad] bg-[#dfe5e2] p-2 text-xs font-bold"
										>
											{row.name}
											<span className="block truncate font-mono text-[9px] font-normal text-[#48606d]">
												{row.id}
											</span>
										</span>
										{profiles.map((profile, columnIndex) => {
											const key = candidateKey({
												rowId: row.id,
												profileId: profile.id,
											});
											const cell = cellByKey.get(key);
											const projection = cell
												? projectionByCell.get(cell.id)
												: undefined;
											const status = projection?.status ?? "disabled";
											return (
												<button
													key={key}
													ref={(node) => {
														if (node) cellRefs.current.set(key, node);
														else cellRefs.current.delete(key);
													}}
													type="button"
													role="gridcell"
													aria-rowindex={rowIndex + 1}
													aria-colindex={columnIndex + 1}
													aria-selected={selected.has(key)}
													aria-label={`${row.name}, ${profile.name}, ${copy(status)}${selected.has(key) ? ", " + copy("selected") : ""}`}
													tabIndex={
														focused.row === rowIndex &&
														focused.column === columnIndex
															? 0
															: -1
													}
													data-cell-key={key}
													data-cell-status={status}
													onFocus={() =>
														setFocused({ row: rowIndex, column: columnIndex })
													}
													onClick={() =>
														setSelected((current) => {
															const next = new Set(current);
															if (next.has(key)) next.delete(key);
															else next.add(key);
															return next;
														})
													}
													onKeyDown={(event) =>
														handleGridKey({
															event,
															row: rowIndex,
															column: columnIndex,
															key,
														})
													}
													className={`border-t border-l p-2 text-left text-[11px] focus-visible:z-10 focus-visible:outline-4 focus-visible:outline-[#d26532] ${statusClass(status)} ${selected.has(key) ? "ring-2 ring-inset ring-[#4656ce]" : ""}`}
												>
													<b className="uppercase">{copy(status)}</b>
													<span className="block font-mono text-[9px]">
														{cell ? cell.id : "not enabled"}
													</span>
												</button>
											);
										})}
									</div>
								);
							})}
						</div>
					</div>
					<p
						className="mt-2 font-mono text-[10px]"
						data-testid="matrix-dom-count"
					>
						{copy("DOM GRIDCELLS")} {window.visibleCellCount}{" "}
						{copy("/ 80 · PAGE")} {projections.items.length} /{" "}
						{projections.total}
					</p>

					<ManifestPreviewWall
						state={state}
						cellIds={wallCellIds}
						focusedCellId={focusedCell?.id ?? null}
					/>
				</div>

				<aside
					className="border-2 border-[#172128] bg-white"
					aria-labelledby="m6-diagnostics-heading"
				>
					<div className="border-b-2 border-[#172128] bg-[#fff0c9] p-3">
						<h5 id="m6-diagnostics-heading" className="font-black">
							{copy("Production diagnostics")}
						</h5>
						<p className="mt-1 text-xs">
							{copy(
								"Action, exact cell/slot, and BrandKit source are always textual.",
							)}
						</p>
					</div>
					<label className="m-3 block cursor-pointer border-2 border-[#172128] bg-[#f6f7f4] p-3 text-xs font-bold focus-within:outline-3 focus-within:outline-[#d26532]">
						{copy("Import versioned BrandKit JSON")}
						<input
							type="file"
							name="brand-kit"
							accept="application/json,.json"
							className="sr-only"
							onChange={(event) => void importBrandKit(event)}
						/>
					</label>
					{campaign.brand_kit ? (
						<div
							className="mx-3 border-l-4 border-[#4656ce] bg-[#eef0ff] p-3 text-xs"
							data-testid="brand-kit-receipt"
						>
							<b>{campaign.brand_kit.name}</b>
							<p className="font-mono text-[9px]">
								{copy("KIT v")}
								{campaign.brand_kit.version} ·{" "}
								{campaign.brand_kit.provenance.source}@
								{campaign.brand_kit.provenance.revision}
							</p>
							<p className="mt-1 break-all font-mono text-[9px]">
								{campaign.brand_kit.fingerprint}
							</p>
							<button
								type="button"
								disabled={busy}
								onClick={applyBrandProfileFixes}
								className="mt-2 border border-[#172128] bg-white px-2 py-1 font-bold focus-visible:outline-3 focus-visible:outline-[#d26532]"
							>
								{copy("Apply BrandKit text + safe-area fixes")}
							</button>
						</div>
					) : null}
					<ul
						className="mt-3 max-h-[520px] divide-y divide-[#a9b1ad] overflow-auto"
						data-testid="m6-diagnostics"
					>
						{diagnostics.map(({ item, diagnostic }) => (
							<li
								key={`${item.cell_id}:${diagnostic.rule_id}`}
								className="p-3 text-xs"
							>
								<p className="font-bold">
									{copy(diagnostic.severity)} · {diagnostic.rule_id}
								</p>
								<p className="mt-1">{copy(diagnostic.message)}</p>
								<p className="mt-1 font-mono text-[9px]">
									{copy("SOURCE")} {diagnostic.rule_source} {copy("· REV")}{" "}
									{diagnostic.rule_revision}
								</p>
								<p className="mt-1">
									<b>{copy("Fix:")}</b> {copy(diagnostic.action)}
								</p>
								<button
									type="button"
									onClick={() =>
										jumpToDiagnostic({
											item,
											slotId: diagnostic.affected_slot_id,
										})
									}
									className="mt-2 border border-[#172128] px-2 py-1 font-bold focus-visible:outline-3 focus-visible:outline-[#d26532]"
								>
									{copy("Focus exact cell")}
									{diagnostic.affected_slot_id ? " / slot" : ""}
								</button>
							</li>
						))}
					</ul>
					{diagnostics.length === 0 ? (
						<p className="p-4 text-sm text-[#48606d]">
							{copy("No blockers in the current projection page.")}
						</p>
					) : null}
					<div
						className="border-t border-[#a9b1ad] p-3 font-mono text-[9px]"
						aria-live="polite"
					>
						{copy("FOCUS ·")}{" "}
						{focusedProjection?.cell_id ?? focusedKey ?? "none"} ·{" "}
						{focusedProjection?.status ?? "not enabled"}
					</div>
				</aside>
			</div>
		</section>
	);
}
