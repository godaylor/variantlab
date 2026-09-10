"use client";

import type {
	CommandPayload,
	SlotRenderTarget,
	StudioState,
	Slot,
} from "@variantlab/studio-contract";
import { useState } from "react";
import { useVariantLabLocale } from "./locale";
import { importLogo } from "./logo-import";

const control =
	"block w-full border border-[#172128] bg-white p-2 focus-visible:outline-3 focus-visible:outline-[#d26532]";
const action =
	"border-2 border-[#172128] px-3 py-2 font-bold focus-visible:outline-3 focus-visible:outline-[#d26532] disabled:opacity-40";

function NumericField({ name, label }: { name: string; label: string }) {
	return (
		<label>
			{label}
			<input className={control} name={name} type="number" step="1" required />
		</label>
	);
}

export function SlotBindingEditor({
	state,
	onCommand,
}: {
	state: StudioState;
	onCommand: (payload: CommandPayload) => Promise<void>;
}) {
	const { t } = useVariantLabLocale();
	const [slotId, setSlotId] = useState("");
	const [busy, setBusy] = useState(false);
	const [status, setStatus] = useState<{ ru: string; en: string } | null>(null);
	const [newKind, setNewKind] = useState("");
	const campaign = state.campaign;
	const slot = campaign.slots?.find((item) => item.id === slotId);
	const binding = campaign.render_bindings?.find(
		(item) => item.slot_id === slotId,
	);
	const createLogo = async (data: FormData) => {
		const file = data.get("logo");
		const sceneId = String(data.get("logo_scene") ?? "");
		if (
			!(file instanceof File) ||
			!campaign.master_sequence.scenes.some((scene) => scene.id === sceneId)
		)
			return;
		setBusy(true);
		setStatus(null);
		try {
			const id = crypto.randomUUID();
			const assetHash = await importLogo({
				file,
				campaignId: campaign.id,
				sceneId,
				assetId: crypto.randomUUID(),
				stagingId: crypto.randomUUID(),
				createdAt: new Date().toISOString(),
			});
			await onCommand({
				command: "create_slots",
				slots: [
					{
						id,
						name: String(data.get("name") ?? ""),
						kind: "logo",
						master_entity_id: id,
						master_value: { kind: "logo", asset_id: assetHash },
						duration_ticks: 0,
						fit_policy: "contain",
						style_fingerprint: "unbound:" + id,
						version: 1,
					},
				],
			});
			setSlotId(id);
			setStatus({
				ru: "PNG сохранён локально. Теперь явно задайте размещение; файл не загружался на сервер.",
				en: "PNG saved locally. Now explicitly set placement; the file was not uploaded.",
			});
		} catch {
			setStatus({
				ru: "Импорт или создание слота не завершены. Нужен статический PNG до 8 МиБ и 2048×2048. Повторите действие; существующие медиа сохранены.",
				en: "Import or slot creation did not complete. Use a static PNG up to 8 MiB and 2048×2048. Retry; existing media is preserved.",
			});
		} finally {
			setBusy(false);
		}
	};
	const run = async (payload: CommandPayload) => {
		setBusy(true);
		setStatus(null);
		try {
			await onCommand(payload);
			setStatus({
				ru: "Изменение сохранено командой master. Доступна отмена.",
				en: "Master command saved. Undo is available.",
			});
		} catch {
			setStatus({
				ru: "Привязка отклонена: проверьте asset и длительность клипа, границы времени, координаты и стиль. Исходные данные не изменены.",
				en: "Binding rejected: check the clip asset and duration, time bounds, coordinates and style. Original data is unchanged.",
			});
		} finally {
			setBusy(false);
		}
	};
	return (
		<section
			aria-label={t({
				ru: "Явные привязки master",
				en: "Explicit master bindings",
			})}
			className="m-4 border border-[#172128] bg-white p-4 text-sm"
		>
			<h5 className="font-black">
				{t({
					ru: "Привязка слотов и размещение",
					en: "Slot bindings and placement",
				})}
			</h5>
			<p className="my-2">
				{t({
					ru: "Старые слоты сохранены без выдуманных координат. Выберите реальный клип либо явно задайте размещение текста/логотипа. Демонстрационные assets не заменяются автоматически.",
					en: "Legacy slots are preserved without invented coordinates. Select a real clip or explicitly place text/logo. Demonstration assets are never replaced automatically.",
				})}
			</p>
			<details className="my-3 border border-[#172128] p-3">
				<summary className="cursor-pointer font-bold">
					{t({ ru: "Создать собственный слот", en: "Create your own slot" })}
				</summary>
				<form
					className="mt-3 grid gap-3"
					onSubmit={(event) => {
						event.preventDefault();
						const data = new FormData(event.currentTarget);
						if (newKind === "logo") {
							void createLogo(data);
							return;
						}
						const id = crypto.randomUUID();
						const name = String(data.get("name") ?? "");
						let created: Slot;
						if (newKind === "hook" || newKind === "product_shot") {
							const selection = String(data.get("source") ?? "");
							const selected = campaign.master_sequence.scenes
								.flatMap((scene) =>
									(scene.timeline?.tracks ?? [])
										.filter((track) => track.kind === "video")
										.flatMap((track) =>
											track.clips.map((clip) => ({ scene, clip })),
										),
								)
								.find(
									({ scene, clip }) =>
										JSON.stringify([scene.id, clip.id]) === selection,
								);
							if (!selected) return;
							created = {
								id,
								name,
								kind: newKind,
								master_entity_id: selected.clip.id,
								master_value: {
									kind: "media",
									asset_id: selected.clip.asset_id,
									duration_ticks: selected.clip.duration_ticks,
								},
								duration_ticks: selected.clip.duration_ticks,
								fit_policy: "exact_duration",
								style_fingerprint: "unbound:" + id,
								version: 1,
							};
						} else if (newKind === "headline" || newKind === "cta") {
							created = {
								id,
								name,
								kind: newKind,
								master_entity_id: id,
								master_value: {
									kind: "text",
									text: String(data.get("copy") ?? ""),
								},
								duration_ticks: 0,
								fit_policy: "exact_duration",
								style_fingerprint: "unbound:" + id,
								version: 1,
							};
						} else return;
						void run({ command: "create_slots", slots: [created] });
					}}
				>
					<label>
						{t({ ru: "Имя нового слота", en: "New slot name" })}
						<input className={control} name="name" required translate="no" />
					</label>
					<label>
						{t({ ru: "Тип нового слота", en: "New slot type" })}
						<select
							className={control}
							value={newKind}
							onChange={(event) => setNewKind(event.target.value)}
							required
						>
							<option value="">
								{t({ ru: "Выберите тип", en: "Choose a type" })}
							</option>
							<option value="hook">
								{t({ ru: "Вступление (клип)", en: "Hook (clip)" })}
							</option>
							<option value="product_shot">
								{t({ ru: "Товар (клип)", en: "Product shot (clip)" })}
							</option>
							<option value="headline">
								{t({ ru: "Заголовок", en: "Headline" })}
							</option>
							<option value="cta">
								{t({ ru: "Призыв к действию", en: "Call to action" })}
							</option>
							<option value="logo">
								{t({ ru: "Логотип (PNG)", en: "Logo (PNG)" })}
							</option>
						</select>
					</label>
					{newKind === "hook" || newKind === "product_shot" ? (
						<label>
							{t({ ru: "Исходный реальный клип", en: "Actual source clip" })}
							<select
								className={control}
								name="source"
								required
								defaultValue=""
							>
								<option value="">
									{t({ ru: "Выберите клип", en: "Choose a clip" })}
								</option>
								{campaign.master_sequence.scenes.flatMap((scene) =>
									(scene.timeline?.tracks ?? [])
										.filter((track) => track.kind === "video")
										.flatMap((track) =>
											track.clips.map((clip) => (
												<option
													key={scene.id + clip.id}
													value={JSON.stringify([scene.id, clip.id])}
													translate="no"
												>
													{scene.name} / {clip.label}
												</option>
											)),
										),
								)}
							</select>
						</label>
					) : newKind === "headline" || newKind === "cta" ? (
						<label>
							{t({
								ru: "Ваш текст (не переводится автоматически)",
								en: "Your text (not automatically translated)",
							})}
							<textarea
								className={control}
								name="copy"
								required
								translate="no"
							/>
						</label>
					) : newKind === "logo" ? (
						<>
							<label>
								{t({
									ru: "Файл логотипа — только локальное хранение",
									en: "Logo file — local storage only",
								})}
								<input
									className={control}
									name="logo"
									type="file"
									accept="image/png"
									required
								/>
							</label>
							<label>
								{t({
									ru: "Сцена для импорта логотипа",
									en: "Scene for logo import",
								})}
								<select
									className={control}
									name="logo_scene"
									required
									defaultValue=""
								>
									<option value="">
										{t({ ru: "Выберите сцену", en: "Choose a scene" })}
									</option>
									{campaign.master_sequence.scenes.map((scene) => (
										<option key={scene.id} value={scene.id} translate="no">
											{scene.name}
										</option>
									))}
								</select>
							</label>
						</>
					) : null}
					<button className={action} disabled={busy} type="submit">
						{t({
							ru: "Создать слот без размещения",
							en: "Create slot without placement",
						})}
					</button>
				</form>
			</details>
			<label>
				{t({ ru: "Слот", en: "Slot" })}
				<select
					className={control}
					value={slotId}
					onChange={(event) => {
						setSlotId(event.target.value);
						setStatus(null);
					}}
				>
					<option value="">
						{t({ ru: "Выберите слот", en: "Choose a slot" })}
					</option>
					{(campaign.slots ?? []).map((item) => (
						<option key={item.id} value={item.id} translate="no">
							{item.name}
						</option>
					))}
				</select>
			</label>
			{slot ? (
				<div key={slot.id + ":" + JSON.stringify(binding)}>
					<p className="my-2" role="status">
						{binding
							? t({
									ru: "Явная привязка задана. Повторное сохранение заменяет её только указанными значениями.",
									en: "Explicit binding exists. Saving replaces it only with the entered values.",
								})
							: t({
									ru: "Слот не привязан. Экспорт этого слота заблокирован до явной настройки.",
									en: "Unbound slot. Its export is blocked until explicitly configured.",
								})}
					</p>
					<form
						onSubmit={(event) => {
							event.preventDefault();
							const data = new FormData(event.currentTarget);
							const text = (name: string) => String(data.get(name) ?? "");
							const number = (name: string) => Number(data.get(name));
							const sceneId = text("scene");
							let target: SlotRenderTarget;
							if (slot.master_value.kind === "media") {
								const selected = campaign.master_sequence.scenes
									.flatMap((scene) =>
										(scene.timeline?.tracks ?? []).flatMap((track) =>
											track.clips.map((clip) => ({
												scene_id: scene.id,
												clip_id: clip.id,
											})),
										),
									)
									.find((entry) => JSON.stringify(entry) === text("clip"));
								if (!selected) return;
								target = { kind: "clip", ...selected };
							} else {
								const alignment = text("alignment");
								if (
									slot.master_value.kind === "text" &&
									alignment !== "left" &&
									alignment !== "center" &&
									alignment !== "right"
								)
									return;
								target = {
									kind: "overlay",
									scene_id: sceneId,
									start_ticks: number("start"),
									end_ticks: number("end"),
									z_index: number("z"),
									rect: {
										x: number("x"),
										y: number("y"),
										width: number("width"),
										height: number("height"),
									},
									text_style:
										slot.master_value.kind === "text"
											? {
													font_id: text("font"),
													font_sha256: text("hash"),
													font_size_px: number("size"),
													line_height_px: number("line"),
													max_lines: number("lines"),
													color_rgba: [
														number("red"),
														number("green"),
														number("blue"),
														number("alpha"),
													],
													alignment:
														alignment === "left" ||
														alignment === "center" ||
														alignment === "right"
															? alignment
															: "left",
												}
											: null,
								};
							}
							void run({
								command: "set_slot_binding",
								binding: { slot_id: slot.id, target },
							});
						}}
					>
						<fieldset disabled={busy} className="grid gap-3 md:grid-cols-3">
							<legend>
								{t({
									ru: "Новая явная настройка (пустые поля не заполняются автоматически)",
									en: "New explicit settings (empty fields are not filled automatically)",
								})}
							</legend>
							{slot.master_value.kind === "media" ? (
								<label className="md:col-span-3">
									{t({
										ru: "Клип на master-таймлинии",
										en: "Master timeline clip",
									})}
									<select
										className={control}
										name="clip"
										required
										defaultValue=""
									>
										<option value="">
											{t({ ru: "Выберите клип", en: "Choose a clip" })}
										</option>
										{campaign.master_sequence.scenes.flatMap((scene) =>
											(scene.timeline?.tracks ?? [])
												.filter((track) => track.kind === "video")
												.flatMap((track) =>
													track.clips.map((clip) => (
														<option
															key={scene.id + clip.id}
															value={JSON.stringify({
																scene_id: scene.id,
																clip_id: clip.id,
															})}
															translate="no"
														>
															{scene.name} / {clip.label}
														</option>
													)),
												),
										)}
									</select>
								</label>
							) : (
								<>
									<label>
										{t({ ru: "Сцена", en: "Scene" })}
										<select
											className={control}
											name="scene"
											required
											defaultValue=""
										>
											<option value="">
												{t({ ru: "Выберите сцену", en: "Choose a scene" })}
											</option>
											{campaign.master_sequence.scenes.map((scene) => (
												<option key={scene.id} value={scene.id} translate="no">
													{scene.name}
												</option>
											))}
										</select>
									</label>
									<NumericField
										name="start"
										label={t({
											ru: "Начало (тики, 48000/с)",
											en: "Start (ticks, 48000/s)",
										})}
									/>
									<NumericField
										name="end"
										label={t({ ru: "Конец (тики)", en: "End (ticks)" })}
									/>
									<NumericField name="x" label="X / 10000" />
									<NumericField name="y" label="Y / 10000" />
									<NumericField
										name="width"
										label={t({ ru: "Ширина / 10000", en: "Width / 10000" })}
									/>
									<NumericField
										name="height"
										label={t({ ru: "Высота / 10000", en: "Height / 10000" })}
									/>
									<NumericField
										name="z"
										label={t({ ru: "Порядок слоя", en: "Layer order" })}
									/>
									{slot.master_value.kind === "text" ? (
										<>
											<button
												type="button"
												className={action}
												onClick={(event) => {
													const form = event.currentTarget.form;
													const font = form?.elements.namedItem("font");
													const hash = form?.elements.namedItem("hash");
													if (
														font instanceof HTMLInputElement &&
														hash instanceof HTMLInputElement
													) {
														font.value = "inter-regular-4.1";
														hash.value =
															"40d692fce188e4471e2b3cba937be967878f631ad3ebbbdcd587687c7ebe0c82";
													}
												}}
											>
												{t({
													ru: "Выбрать Inter Regular 4.1 (OFL)",
													en: "Choose Inter Regular 4.1 (OFL)",
												})}
											</button>
											<label>
												{t({ ru: "ID шрифта", en: "Font ID" })}
												<input name="font" required className={control} />
											</label>
											<label>
												{t({
													ru: "SHA-256 файла шрифта",
													en: "Font file SHA-256",
												})}
												<input
													name="hash"
													required
													pattern="[a-f0-9]{64}"
													className={control}
												/>
											</label>
											<NumericField
												name="size"
												label={t({
													ru: "Размер шрифта (px)",
													en: "Font size (px)",
												})}
											/>
											<NumericField
												name="line"
												label={t({
													ru: "Высота строки (px)",
													en: "Line height (px)",
												})}
											/>
											<NumericField
												name="lines"
												label={t({ ru: "Максимум строк", en: "Maximum lines" })}
											/>
											<NumericField
												name="red"
												label={t({ ru: "Красный 0–255", en: "Red 0–255" })}
											/>
											<NumericField
												name="green"
												label={t({ ru: "Зелёный 0–255", en: "Green 0–255" })}
											/>
											<NumericField
												name="blue"
												label={t({ ru: "Синий 0–255", en: "Blue 0–255" })}
											/>
											<NumericField
												name="alpha"
												label={t({
													ru: "Непрозрачность 0–255",
													en: "Opacity 0–255",
												})}
											/>
											<label>
												{t({ ru: "Выравнивание", en: "Alignment" })}
												<select
													className={control}
													name="alignment"
													required
													defaultValue=""
												>
													<option value="">
														{t({ ru: "Выберите", en: "Choose" })}
													</option>
													<option value="left">
														{t({ ru: "Слева", en: "Left" })}
													</option>
													<option value="center">
														{t({ ru: "По центру", en: "Center" })}
													</option>
													<option value="right">
														{t({ ru: "Справа", en: "Right" })}
													</option>
												</select>
											</label>
										</>
									) : null}
								</>
							)}
							<button className={action} type="submit">
								{t({ ru: "Сохранить привязку", en: "Save binding" })}
							</button>
							<button
								className={action}
								type="button"
								onClick={() =>
									void run({ command: "clear_slot_binding", slot_id: slot.id })
								}
							>
								{t({ ru: "Снять привязку", en: "Clear binding" })}
							</button>
						</fieldset>
					</form>
				</div>
			) : null}
			<p role="status" className="mt-2">
				{status ? t(status) : ""}
			</p>
		</section>
	);
}
