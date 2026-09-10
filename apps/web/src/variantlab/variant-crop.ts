import type { CropOverride } from "@variantlab/studio-contract";

export function clampCrop(crop: CropOverride): CropOverride {
	return {
		x_basis_points: Math.max(-5_000, Math.min(5_000, Math.round(crop.x_basis_points))),
		y_basis_points: Math.max(-5_000, Math.min(5_000, Math.round(crop.y_basis_points))),
		scale_basis_points: Math.max(
			10_000,
			Math.min(30_000, Math.round(crop.scale_basis_points)),
		),
	};
}

export function nudgeCrop({
	crop,
	key,
	coarse,
}: {
	crop: CropOverride;
	key: string;
	coarse: boolean;
}): CropOverride {
	const step = coarse ? 500 : 100;
	const delta = {
		ArrowLeft: [-step, 0],
		ArrowRight: [step, 0],
		ArrowUp: [0, -step],
		ArrowDown: [0, step],
	}[key];
	if (!delta) return crop;
	return clampCrop({
		...crop,
		x_basis_points: crop.x_basis_points + delta[0],
		y_basis_points: crop.y_basis_points + delta[1],
	});
}
