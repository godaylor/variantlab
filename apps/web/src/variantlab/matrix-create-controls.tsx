"use client";

import type {
	CommandPayload,
	DeliveryProfile,
} from "@variantlab/studio-contract";
import { useState } from "react";
import { useVariantLabLocale } from "./locale";

const controlClass =
	"border-2 border-[#172128] bg-white px-3 py-2 text-xs focus-visible:outline-3 focus-visible:outline-[#d26532]";

/** User-entered command inputs only; Rust validates cardinality and profile rules. */
export function MatrixCreateControls({
	profiles,
	disabled,
	onCommand,
}: {
	profiles: DeliveryProfile[];
	disabled: boolean;
	onCommand: (payload: CommandPayload) => Promise<void>;
}) {
	const { t } = useVariantLabLocale();
	const [error, setError] = useState("");
	async function submit({ form, kind }: { form: HTMLFormElement; kind: "creative" | "profile" }) {
		const values = new FormData(form);
		const name = String(values.get("name") ?? "").trim();
		try {
			if (kind === "creative") {
				await onCommand({
					command: "create_creative_sets",
					sets: [
						{ id: crypto.randomUUID(), name, replacements: [], version: 1 },
					],
					cells: [],
				});
			} else {
				const base = profiles.find(
					(profile) => profile.id === values.get("base"),
				);
				if (!base) return;
				await onCommand({
					command: "add_delivery_profiles",
					profiles: [{ ...base, id: crypto.randomUUID(), name, version: 1 }],
				});
			}
			setError("");
			form.reset();
		} catch {
			setError(
				t({
					ru: "Не удалось добавить: проверьте имя и лимиты кампании.",
					en: "Could not add: check the name and campaign limits.",
				}),
			);
		}
	}
	return (
		<details className="mb-3 border border-[#172128] p-3">
			<summary className="cursor-pointer text-sm font-bold focus-visible:outline-3">
				{t({ ru: "Добавить строку или профиль", en: "Add a row or profile" })}
			</summary>
			<form
				className="mt-3 flex flex-wrap gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					void submit({ form: event.currentTarget, kind: "creative" });
				}}
			>
				<label className="text-xs">
					{t({ ru: "Имя креативного набора", en: "Creative set name" })}
					<input
						name="name"
						required
						maxLength={120}
						className={controlClass}
					/>
				</label>
				<button disabled={disabled} className={controlClass}>
					{t({ ru: "Добавить набор", en: "Add creative set" })}
				</button>
			</form>
			<form
				className="mt-3 flex flex-wrap gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					void submit({ form: event.currentTarget, kind: "profile" });
				}}
			>
				<label className="text-xs">
					{t({ ru: "Имя профиля", en: "Delivery profile name" })}
					<input
						name="name"
						required
						maxLength={120}
						className={controlClass}
					/>
				</label>
				<label className="text-xs">
					{t({
						ru: "Скопировать настройки профиля",
						en: "Copy profile settings",
					})}
					<select name="base" className={controlClass}>
						{profiles.map((profile) => (
							<option key={profile.id} value={profile.id}>
								{profile.name}
							</option>
						))}
					</select>
				</label>
				<button
					disabled={disabled || profiles.length === 0}
					className={controlClass}
				>
					{t({ ru: "Добавить профиль", en: "Add delivery profile" })}
				</button>
			</form>
			{error && <p role="alert">{error}</p>}
		</details>
	);
}

