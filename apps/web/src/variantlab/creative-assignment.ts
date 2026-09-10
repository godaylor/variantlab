import type {
	CreativeSet,
	DeliveryProfile,
	Slot,
	SlotAssignment,
	VariantCell,
} from "@variantlab/studio-contract";

export const CREATIVE_SLOT_IDS = {
	hook: "slot-hook",
	hookFallback: "slot-hook-fallback",
	product: "slot-product",
	headline: "slot-headline",
	cta: "slot-cta",
	logo: "slot-logo",
} as const;

export const CREATIVE_SET_IDS = [
	"creative-hook-a",
	"creative-hook-b",
	"creative-hook-c",
] as const;

const HOOK_DURATION_TICKS = 96_000;

export function standardCreativeSlots(): Slot[] {
	return [
		{
			id: CREATIVE_SLOT_IDS.hook,
			name: "Opening hook",
			kind: "hook",
			master_entity_id: "master-entity-hook",
			master_value: {
				kind: "media",
				asset_id: "sha256:master-hook-v1",
				duration_ticks: HOOK_DURATION_TICKS,
			},
			duration_ticks: HOOK_DURATION_TICKS,
			fit_policy: "exact_duration",
			style_fingerprint: "style:master-hook-v1",
			version: 1,
		},
		{
			id: CREATIVE_SLOT_IDS.hookFallback,
			name: "Fallback hook",
			kind: "hook",
			master_entity_id: "master-entity-hook-fallback",
			master_value: {
				kind: "media",
				asset_id: "sha256:master-hook-fallback-v1",
				duration_ticks: HOOK_DURATION_TICKS,
			},
			duration_ticks: HOOK_DURATION_TICKS,
			fit_policy: "exact_duration",
			style_fingerprint: "style:master-hook-fallback-v1",
			version: 1,
		},
		{
			id: CREATIVE_SLOT_IDS.product,
			name: "Product shot",
			kind: "product_shot",
			master_entity_id: "master-entity-product",
			master_value: {
				kind: "media",
				asset_id: "sha256:master-product-v1",
				duration_ticks: HOOK_DURATION_TICKS,
			},
			duration_ticks: HOOK_DURATION_TICKS,
			fit_policy: "contain",
			style_fingerprint: "style:master-product-v1",
			version: 1,
		},
		{
			id: CREATIVE_SLOT_IDS.headline,
			name: "Headline",
			kind: "headline",
			master_entity_id: "master-entity-headline",
			master_value: { kind: "text", text: "Master headline" },
			duration_ticks: 0,
			fit_policy: "exact_duration",
			style_fingerprint: "style:master-headline-v1",
			version: 1,
		},
		{
			id: CREATIVE_SLOT_IDS.cta,
			name: "CTA",
			kind: "cta",
			master_entity_id: "master-entity-cta",
			master_value: { kind: "text", text: "Shop now" },
			duration_ticks: 0,
			fit_policy: "exact_duration",
			style_fingerprint: "style:master-cta-v1",
			version: 1,
		},
		{
			id: CREATIVE_SLOT_IDS.logo,
			name: "Logo",
			kind: "logo",
			master_entity_id: "master-entity-logo",
			master_value: { kind: "logo", asset_id: "sha256:master-logo-v1" },
			duration_ticks: 0,
			fit_policy: "contain",
			style_fingerprint: "style:master-logo-v1",
			version: 1,
		},
	];
}

export function initialCreativeSets(): CreativeSet[] {
	return CREATIVE_SET_IDS.map((id, index) => ({
		id,
		name: "Hook " + String.fromCharCode(65 + index),
		replacements: [],
		version: 1,
	}));
}

export function creativeSetCells({
	sets,
	profiles,
}: {
	sets: CreativeSet[];
	profiles: DeliveryProfile[];
}): VariantCell[] {
	return sets.flatMap((set) =>
		profiles.map((profile) => ({
			id: "cell-" + set.id + "-" + profile.id,
			creative_set_id: set.id,
			delivery_profile_id: profile.id,
			layout_override: null,
			version: 1,
		})),
	);
}

export function creativeBundleAssignments({
	creativeSetId,
	bundleIndex,
}: {
	creativeSetId: string;
	bundleIndex: number;
}): SlotAssignment[] {
	const suffix = String.fromCharCode(65 + bundleIndex);
	return [
		{
			creative_set_id: creativeSetId,
			slot_id: CREATIVE_SLOT_IDS.hook,
			value: {
				kind: "media",
				asset_id: "sha256:hook-" + suffix.toLowerCase() + "-v1",
				duration_ticks: HOOK_DURATION_TICKS,
			},
		},
		{
			creative_set_id: creativeSetId,
			slot_id: CREATIVE_SLOT_IDS.headline,
			value: { kind: "text", text: "Headline " + suffix },
		},
		{
			creative_set_id: creativeSetId,
			slot_id: CREATIVE_SLOT_IDS.cta,
			value: { kind: "text", text: "CTA " + suffix },
		},
	];
}
