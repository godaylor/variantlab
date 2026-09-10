"use client";

import type {
	CommandPayload,
	CreativeSet,
	DeliveryProfile,
	FontManifest,
	LocaleProfile,
	SceneScope,
	StudioState,
	VariantScope,
} from "@variantlab/studio-contract";

type ScopedCommand = {
	payload: CommandPayload;
	sceneScope: SceneScope;
	variantScope: VariantScope;
};

type Props = {
	state: StudioState;
	disabled: boolean;
	onCommand: (command: ScopedCommand) => Promise<void>;
	onNotice: (notice: string) => void;
	onReady: () => void;
};

const ENABLED = process.env.NEXT_PUBLIC_VARIANTLAB_M6_TEST_ADAPTER === "1";

const FONT_MANIFEST: FontManifest = {
	version: 1,
	fonts: [
		{
			id: "inter-latin",
			family: "Inter",
			revision: "4.1",
			license: "OFL-1.1",
			unicode_ranges: [{ start: 0x20, end: 0x024f }],
		},
		{
			id: "noto-cyrillic-arabic",
			family: "Noto Sans",
			revision: "2.015",
			license: "OFL-1.1",
			unicode_ranges: [
				{ start: 0x0400, end: 0x052f },
				{ start: 0x0600, end: 0x06ff },
			],
		},
	],
};

const CONVERTIBLE_PROFILES: DeliveryProfile[] = [
	profile({
		id: "delivery-stress-format-a",
		name: "Capacity landscape A",
		width: 1920,
		height: 1080,
	}),
	profile({
		id: "delivery-stress-format-b",
		name: "Capacity square A",
		width: 1080,
		height: 1080,
	}),
	profile({
		id: "delivery-stress-format-c",
		name: "Capacity portrait A",
		width: 1080,
		height: 1920,
	}),
];

const FINAL_FORMAT_PROFILES: DeliveryProfile[] = [
	profile({
		id: "delivery-stress-format-d",
		name: "Capacity landscape B",
		width: 1920,
		height: 1080,
	}),
	profile({
		id: "delivery-stress-format-e",
		name: "Capacity square B",
		width: 1080,
		height: 1080,
	}),
	profile({
		id: "delivery-stress-format-f",
		name: "Capacity portrait B",
		width: 1080,
		height: 1920,
	}),
];

function profile({
	id,
	name,
	width,
	height,
}: {
	id: string;
	name: string;
	width: number;
	height: number;
}): DeliveryProfile {
	return {
		id,
		name,
		canvas: { width, height },
		safe_area: {
			top_basis_points: 600,
			right_basis_points: 600,
			bottom_basis_points: 600,
			left_basis_points: 600,
		},
		locale: "source",
		layout_constraints: [
			"safe_area",
			"text_size_px:24",
			"font:inter-latin",
			"color:brand-primary",
		],
		version: 1,
		locale_profile_id: null,
	};
}

function stressLocale(index: number): LocaleProfile {
	const locales = ["de-DE", "ru-RU", "ar-SA"];
	const locale = locales[index] ?? "en-US";
	return {
		id: `locale-stress-${index + 1}`,
		name: `Capacity locale ${locale}`,
		locale,
		text_values: [],
		font_fallback_ids: ["inter-latin", "noto-cyrillic-arabic"],
		caption_style: {
			font_size_px: 48,
			max_lines: 2,
			max_chars_per_second: 18,
		},
		version: 1,
	};
}

export function VariantMatrixCorpusAdapter({
	state,
	disabled,
	onCommand,
	onNotice,
	onReady,
}: Props) {
	if (!ENABLED) return null;
	const campaign = state.campaign;
	const creativeSets = campaign.creative_sets ?? [];
	const localeProfiles = campaign.locale_profiles ?? [];
	const existingSets = new Set(creativeSets.map((set) => set.id));
	const missingSets: CreativeSet[] = Array.from({ length: 11 }, (_, index) => {
		const suffix = String.fromCharCode(65 + index).toLowerCase();
		return {
			id: `creative-hook-${suffix}`,
			name: `Hook ${suffix.toUpperCase()}`,
			replacements: [],
			version: 1,
		};
	}).filter((set) => !existingSets.has(set.id));
	const existingProfiles = new Set(
		campaign.delivery_profiles.map((profile) => profile.id),
	);
	const missingConvertible = CONVERTIBLE_PROFILES.filter(
		(profile) => !existingProfiles.has(profile.id),
	);
	const stressLocaleIds = new Set(
		localeProfiles
			.filter((locale) => locale.id.startsWith("locale-stress-"))
			.map((locale) => locale.id),
	);
	const nextLocaleIndex = [0, 1, 2].find(
		(index) => !stressLocaleIds.has(`locale-stress-${index + 1}`),
	);
	const missingFinal = FINAL_FORMAT_PROFILES.filter(
		(profile) => !existingProfiles.has(profile.id),
	);

	let label = "Select first 100 explicit cells";
	if (missingSets.length > 0) label = "Corpus step: add rows to 12";
	else if (missingConvertible.length > 0)
		label = "Corpus step: add 3 convertible profiles";
	else if (nextLocaleIndex !== undefined)
		label = `Corpus step: bind locale ${nextLocaleIndex + 1} / 3`;
	else if (missingFinal.length > 0)
		label = "Corpus step: add final 3 format profiles";

	async function advance() {
		if (missingSets.length > 0) {
			await onCommand({
				payload: {
					command: "create_creative_sets",
					sets: missingSets,
					cells: [],
				},
				sceneScope: { kind: "sequence" },
				variantScope: { kind: "master" },
			});
			return;
		}
		if (missingConvertible.length > 0) {
			await onCommand({
				payload: {
					command: "add_delivery_profiles",
					profiles: missingConvertible,
				},
				sceneScope: { kind: "sequence" },
				variantScope: { kind: "master" },
			});
			return;
		}
		if (nextLocaleIndex !== undefined) {
			const delivery = CONVERTIBLE_PROFILES[nextLocaleIndex];
			await onCommand({
				payload: {
					command: "create_locale_profile",
					profile: stressLocale(nextLocaleIndex),
					delivery_profile_id: delivery.id,
					font_manifest: FONT_MANIFEST,
				},
				sceneScope: { kind: "sequence" },
				variantScope: { kind: "master" },
			});
			return;
		}
		if (missingFinal.length > 0) {
			await onCommand({
				payload: {
					command: "add_delivery_profiles",
					profiles: missingFinal,
				},
				sceneScope: { kind: "sequence" },
				variantScope: { kind: "master" },
			});
			return;
		}
		onReady();
		onNotice(
			"100 explicit candidates selected from the env-gated reference corpus.",
		);
	}

	return (
		<button
			type="button"
			disabled={disabled}
			onClick={() => void advance()}
			className="border border-dashed border-[#7a5270] bg-[#f0e1eb] px-3 py-2 text-xs font-bold focus-visible:outline-3 focus-visible:outline-[#d26532]"
			data-testid="m6-corpus-step"
		>
			{label}
		</button>
	);
}
