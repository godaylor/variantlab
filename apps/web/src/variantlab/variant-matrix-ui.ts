export const MATRIX_DOM_CELL_LIMIT = 80;

export type MatrixPosition = {
	row: number;
	column: number;
};

export type MatrixWindow = {
	firstRow: number;
	lastRow: number;
	visibleCellCount: number;
};

export function matrixWindow({
	scrollTop,
	rowHeight,
	viewportHeight,
	rowCount,
	columnCount,
	overscan = 1,
}: {
	scrollTop: number;
	rowHeight: number;
	viewportHeight: number;
	rowCount: number;
	columnCount: number;
	overscan?: number;
}): MatrixWindow {
	if (rowCount <= 0 || columnCount <= 0) {
		return { firstRow: 0, lastRow: -1, visibleCellCount: 0 };
	}
	const visibleRows = Math.max(1, Math.ceil(viewportHeight / rowHeight));
	const maxRows = Math.max(1, Math.floor(MATRIX_DOM_CELL_LIMIT / columnCount));
	const firstVisible = Math.floor(Math.max(0, scrollTop) / rowHeight);
	const firstRow = Math.max(0, firstVisible - overscan);
	const wantedRows = Math.min(maxRows, visibleRows + overscan * 2);
	const lastRow = Math.min(rowCount - 1, firstRow + wantedRows - 1);
	return {
		firstRow,
		lastRow,
		visibleCellCount: (lastRow - firstRow + 1) * columnCount,
	};
}

export function moveMatrixFocus({
	position,
	key,
	rowCount,
	columnCount,
	ctrlOrMeta,
}: {
	position: MatrixPosition;
	key: string;
	rowCount: number;
	columnCount: number;
	ctrlOrMeta: boolean;
}): MatrixPosition {
	const lastRow = Math.max(0, rowCount - 1);
	const lastColumn = Math.max(0, columnCount - 1);
	if (key === "Home") {
		return ctrlOrMeta ? { row: 0, column: 0 } : { ...position, column: 0 };
	}
	if (key === "End") {
		return ctrlOrMeta
			? { row: lastRow, column: lastColumn }
			: { ...position, column: lastColumn };
	}
	if (key === "ArrowUp") {
		return { ...position, row: ctrlOrMeta ? 0 : Math.max(0, position.row - 1) };
	}
	if (key === "ArrowDown") {
		return {
			...position,
			row: ctrlOrMeta ? lastRow : Math.min(lastRow, position.row + 1),
		};
	}
	if (key === "ArrowLeft") {
		return {
			...position,
			column: ctrlOrMeta ? 0 : Math.max(0, position.column - 1),
		};
	}
	if (key === "ArrowRight") {
		return {
			...position,
			column: ctrlOrMeta
				? lastColumn
				: Math.min(lastColumn, position.column + 1),
		};
	}
	return position;
}
