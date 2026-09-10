import { describe, expect, test } from "bun:test";
import { clampCrop, nudgeCrop } from "../variant-crop";

describe("M3 adaptive crop interaction", () => {
	test("keyboard nudge is deterministic and preserves the allowlisted scale", () => {
		const crop = { x_basis_points: 0, y_basis_points: 0, scale_basis_points: 12_500 };
		expect(nudgeCrop({ crop, key: "ArrowRight", coarse: false })).toEqual({
			x_basis_points: 100,
			y_basis_points: 0,
			scale_basis_points: 12_500,
		});
		expect(nudgeCrop({ crop, key: "ArrowUp", coarse: true })).toEqual({
			x_basis_points: 0,
			y_basis_points: -500,
			scale_basis_points: 12_500,
		});
	});

	test("preview input is bounded by the Rust crop contract", () => {
		expect(
			clampCrop({
				x_basis_points: 90_000,
				y_basis_points: -90_000,
				scale_basis_points: 1,
			}),
		).toEqual({
			x_basis_points: 5_000,
			y_basis_points: -5_000,
			scale_basis_points: 10_000,
		});
	});
});
