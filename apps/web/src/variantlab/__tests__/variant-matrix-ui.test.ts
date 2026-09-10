import { describe, expect, test } from "bun:test";
import {
	MATRIX_DOM_CELL_LIMIT,
	matrixWindow,
	moveMatrixFocus,
} from "../variant-matrix-ui";

describe("M6 matrix-owned interaction state", () => {
	test("virtualization never publishes more than 80 matrix cells", () => {
		const window = matrixWindow({
			scrollTop: 9_900,
			rowHeight: 44,
			viewportHeight: 440,
			rowCount: 500,
			columnCount: 6,
		});
		expect(window.firstRow).toBeGreaterThan(0);
		expect(window.visibleCellCount).toBeLessThanOrEqual(MATRIX_DOM_CELL_LIMIT);
	});

	test("roving focus implements arrows, Home/End and row/column jumps", () => {
		expect(
			moveMatrixFocus({
				position: { row: 4, column: 2 },
				key: "Home",
				rowCount: 12,
				columnCount: 6,
				ctrlOrMeta: false,
			}),
		).toEqual({ row: 4, column: 0 });
		expect(
			moveMatrixFocus({
				position: { row: 4, column: 2 },
				key: "End",
				rowCount: 12,
				columnCount: 6,
				ctrlOrMeta: true,
			}),
		).toEqual({ row: 11, column: 5 });
		expect(
			moveMatrixFocus({
				position: { row: 4, column: 2 },
				key: "ArrowUp",
				rowCount: 12,
				columnCount: 6,
				ctrlOrMeta: true,
			}),
		).toEqual({ row: 0, column: 2 });
	});
});
