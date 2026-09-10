"use client";
import type {
	CaptionTrack,
	CommandPayload,
	StudioState,
} from "@variantlab/studio-contract";
import { useState } from "react";
import { useVariantLabLocale } from "./locale";

export function CaptionPlacementEditor({
	state,
	track,
	onCommand,
}: {
	state: StudioState;
	track: CaptionTrack;
	onCommand: (payload: CommandPayload) => Promise<void>;
}) {
	const { t } = useVariantLabLocale();
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<"saved" | "failed" | null>(null);
	const artifact = (state.campaign.transcript_artifacts ?? []).find(
		(item) => item.id === track.source_artifact_id,
	);
	const sources = state.campaign.master_sequence.scenes.flatMap((scene) =>
		(scene.timeline?.tracks ?? []).flatMap((sourceTrack) =>
			sourceTrack.clips
				.filter((clip) => clip.asset_id === artifact?.asset_hash)
				.map((clip) => ({ scene, clip })),
		),
	);
	const control = "block w-full border border-[#172128] bg-white p-2";
	const save = async (data: FormData) => {
		setBusy(true);
		setMessage(null);
		try {
			const source = sources.find(
				(item) =>
					JSON.stringify([item.scene.id, item.clip.id]) === data.get("source"),
			);
			if (!source || data.get("font") !== "inter-regular-4.1")
				throw new Error("caption_inputs_required");
			const number = (name: string) => Number(data.get(name));
			const color = String(data.get("color"));
			const alignment = data.get("alignment");
			if (
				!/^#[0-9a-fA-F]{6}$/.test(color) ||
				(alignment !== "left" &&
					alignment !== "center" &&
					alignment !== "right")
			)
				throw new Error("caption_inputs_required");
			await onCommand({
				command: "set_caption_placement",
				track_id: track.id,
				placement: {
					scene_id: source.scene.id,
					clip_id: source.clip.id,
					rect: {
						x: number("x"),
						y: number("y"),
						width: number("width"),
						height: number("height"),
					},
					z_index: number("z"),
					text_style: {
						font_id: "inter-regular-4.1",
						font_sha256:
							"40d692fce188e4471e2b3cba937be967878f631ad3ebbbdcd587687c7ebe0c82",
						font_size_px: number("size"),
						line_height_px: number("line"),
						max_lines: number("lines"),
						color_rgba: [
							parseInt(color.slice(1, 3), 16),
							parseInt(color.slice(3, 5), 16),
							parseInt(color.slice(5, 7), 16),
							255,
						],
						alignment,
					},
				},
			});
			setMessage("saved");
		} catch {
			setMessage("failed");
		} finally {
			setBusy(false);
		}
	};
	const placement = track.placement;
	return (
		<form
			className="my-4 border-2 border-[#172128] p-3"
			aria-label={t({ ru: "Размещение субтитров", en: "Caption placement" })}
			onSubmit={(event) => {
				event.preventDefault();
				void save(new FormData(event.currentTarget));
			}}
		>
			<h5 className="font-bold">
				{t({
					ru: "Субтитры в предпросмотре и экспорте",
					en: "Captions in preview and export",
				})}
			</h5>
			<p className="my-2 text-xs">
				{t({
					ru: "Выберите исходный клип и задайте размещение. Время берётся из cue и учитывает обрезку клипа; 10000 — полный размер холста.",
					en: "Choose the source clip and explicit placement. Cue timing follows source trims; 10000 is the full canvas dimension.",
				})}
			</p>
			<label>
				{t({ ru: "Клип субтитров", en: "Caption source clip" })}
				<select
					className={control}
					name="source"
					required
					defaultValue={
						placement
							? JSON.stringify([placement.scene_id, placement.clip_id])
							: ""
					}
				>
					<option value="">
						{t({ ru: "Выберите клип", en: "Choose clip" })}
					</option>
					{sources.map((item) => (
						<option
							key={JSON.stringify([item.scene.id, item.clip.id])}
							value={JSON.stringify([item.scene.id, item.clip.id])}
						>
							{item.scene.name} · {item.clip.id}
						</option>
					))}
				</select>
			</label>
			<div className="grid grid-cols-2 gap-2">
				{(
					[
						["x", "X", placement?.rect.x],
						["y", "Y", placement?.rect.y],
						["width", t({ ru: "Ширина", en: "Width" }), placement?.rect.width],
						[
							"height",
							t({ ru: "Высота", en: "Height" }),
							placement?.rect.height,
						],
						[
							"z",
							t({ ru: "Порядок слоя", en: "Layer order" }),
							placement?.z_index,
						],
						[
							"size",
							t({ ru: "Размер шрифта", en: "Font size" }),
							placement?.text_style.font_size_px,
						],
						[
							"line",
							t({ ru: "Высота строки", en: "Line height" }),
							placement?.text_style.line_height_px,
						],
						[
							"lines",
							t({ ru: "Максимум строк", en: "Maximum lines" }),
							placement?.text_style.max_lines,
						],
					] as const
				).map(([name, label, value]) => (
					<label key={name}>
						{label}
						<input
							className={control}
							name={name}
							type="number"
							step="1"
							required
							defaultValue={value ?? ""}
						/>
					</label>
				))}
			</div>
			<label>
				{t({ ru: "Шрифт субтитров", en: "Caption font" })}
				<select
					className={control}
					name="font"
					required
					defaultValue={placement?.text_style.font_id ?? ""}
				>
					<option value="">
						{t({ ru: "Выберите шрифт", en: "Choose font" })}
					</option>
					<option value="inter-regular-4.1">Inter Regular 4.1 · OFL-1.1</option>
				</select>
			</label>
			<label>
				{t({ ru: "Цвет субтитров", en: "Caption color" })}
				<input
					className={control}
					name="color"
					required
					pattern="#[0-9a-fA-F]{6}"
					placeholder="#RRGGBB"
					defaultValue={
						placement
							? "#" +
								placement.text_style.color_rgba
									.slice(0, 3)
									.map((value) => value.toString(16).padStart(2, "0"))
									.join("")
							: ""
					}
				/>
			</label>
			<label>
				{t({ ru: "Выравнивание субтитров", en: "Caption alignment" })}
				<select
					className={control}
					name="alignment"
					required
					defaultValue={placement?.text_style.alignment ?? ""}
				>
					<option value="">
						{t({ ru: "Выберите выравнивание", en: "Choose alignment" })}
					</option>
					<option value="left">{t({ ru: "Слева", en: "Left" })}</option>
					<option value="center">{t({ ru: "По центру", en: "Center" })}</option>
					<option value="right">{t({ ru: "Справа", en: "Right" })}</option>
				</select>
			</label>
			<button
				type="submit"
				disabled={busy}
				className="mt-2 border-2 border-[#172128] px-3 py-2 font-bold"
			>
				{t({
					ru: "Сохранить размещение субтитров",
					en: "Save caption placement",
				})}
			</button>
			{message ? (
				<p role={message === "failed" ? "alert" : "status"}>
					{message === "failed"
						? t({
								ru: "Проверьте клип, координаты и параметры шрифта. Изменения не сохранены.",
								en: "Check the clip, coordinates and font parameters. Changes were not saved.",
							})
						: t({
								ru: "Размещение субтитров сохранено.",
								en: "Caption placement saved.",
							})}
				</p>
			) : null}
		</form>
	);
}
