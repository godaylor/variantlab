import { describe, expect, test } from "bun:test";
import {
	CREATIVE_SLOT_IDS,
	creativeBundleAssignments,
	creativeSetCells,
	initialCreativeSets,
	standardCreativeSlots,
} from "../creative-assignment";

describe("M4 creative slot commands", () => {
	test("declares the finite typed slot model and three empty rows", () => {
		const slots = standardCreativeSlots();
		expect(slots.map((slot) => slot.kind)).toEqual([
			"hook",
			"hook",
			"product_shot",
			"headline",
			"cta",
			"logo",
		]);
		expect(new Set(slots.map((slot) => slot.master_entity_id)).size).toBe(6);
		expect(initialCreativeSets()).toHaveLength(3);
		expect(
			initialCreativeSets().every((set) => set.replacements.length === 0),
		).toBe(true);
	});

	test("drag and menu paths build the same bounded atomic payload", () => {
		const drag = creativeBundleAssignments({
			creativeSetId: "creative-hook-a",
			bundleIndex: 0,
		});
		const menu = creativeBundleAssignments({
			creativeSetId: "creative-hook-a",
			bundleIndex: 0,
		});
		expect(drag).toEqual(menu);
		expect(drag.map((assignment) => assignment.slot_id)).toEqual([
			CREATIVE_SLOT_IDS.hook,
			CREATIVE_SLOT_IDS.headline,
			CREATIVE_SLOT_IDS.cta,
		]);
		expect(drag[0]?.value).toEqual({
			kind: "media",
			asset_id: "sha256:hook-a-v1",
			duration_ticks: 96_000,
		});
	});

	test("creates one explicit cell per row and delivery profile", () => {
		const sets = initialCreativeSets();
		const cells = creativeSetCells({
			sets,
			profiles: [
				{
					id: "portrait",
					name: "Portrait",
					canvas: { width: 1080, height: 1920 },
					safe_area: {
						top_basis_points: 0,
						right_basis_points: 0,
						bottom_basis_points: 0,
						left_basis_points: 0,
					},
					locale: "en-US",
					layout_constraints: [],
					version: 1,
				},
			],
		});
		expect(cells).toHaveLength(3);
		expect(new Set(cells.map((cell) => cell.id)).size).toBe(3);
		expect(cells.every((cell) => cell.layout_override === null)).toBe(true);
	});
});
