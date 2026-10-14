// src/utils.js

// canvas context for color normalization
let _ctx;
function getCtx() {
  if (!_ctx) _ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  return _ctx;
}

function getTableBorder(style, side, scale, node) {
  const widthStr = style[`border${side}Width`];
  const styleStr = style[`border${side}Style`];
  const colorStr = style[`border${side}Color`];

  const width = parseFloat(widthStr) || 0;
  if (width === 0 || styleStr === 'none' || styleStr === 'hidden') {
    return null;
  }

  let color = parseColor(colorStr, style);
  if (!color.hex || color.opacity === 0) return null;
  color = flattenColor(color, node, false);

  let dash = 'solid';
  if (styleStr === 'dashed') dash = 'dash';
  if (styleStr === 'dotted') dash = 'dot';

  return {
    pt: width * 0.75 * scale, // Convert px to pt
    color: color.hex,
    type: dash,
  };
}

const TABLE_BORDER_SIDES = [
  ['Top', 0],
  ['Right', 1],
  ['Bottom', 2],
  ['Left', 3],
];

const TABLE_BORDER_PRIORITY = {
  table: 0,
  colgroup: 1,
  col: 2,
  rowgroup: 3,
  row: 4,
  cell: 5,
};

function tableRows(table) {
  return Array.from(table.querySelectorAll('tr')).filter((row) => row.closest('table') === table && cellChildren(row).length > 0);
}

function cellChildren(row) {
  return Array.from(row.children).filter((cell) => ['td', 'th'].includes((cell?.tagName || '').toLowerCase()));
}

/**
 * Make the HTML table's rectangular grid explicit.  PptxGenJS keeps the
 * source row/cell structure for merged cells, while CSS borders operate on
 * the visual grid; retaining both lets us assign a visual edge back to the
 * one source cell that owns it in PPTX.
 */
function buildTableGrid(table) {
  const rows = tableRows(table);
  const grid = [];
  const entries = [];

  rows.forEach((row, rowIndex) => {
    if (!grid[rowIndex]) grid[rowIndex] = [];
    let columnIndex = 0;
    cellChildren(row).forEach((cell) => {
      while (grid[rowIndex][columnIndex]) columnIndex++;
      const colspan = Math.max(parseInt(cell.getAttribute('colspan')) || 1, 1);
      const rowspan = Math.max(parseInt(cell.getAttribute('rowspan')) || 1, 1);
      const entry = { cell, row, rowIndex, columnIndex, rowspan, colspan, outputCell: null };
      entries.push(entry);
      for (let y = rowIndex; y < rowIndex + rowspan; y++) {
        if (!grid[y]) grid[y] = [];
        for (let x = columnIndex; x < columnIndex + colspan; x++) grid[y][x] = entry;
      }
      columnIndex += colspan;
    });
  });

  const columnCount = grid.reduce((maximum, row) => Math.max(maximum, row?.length || 0), 0);
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    if (!grid[rowIndex]) grid[rowIndex] = [];
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
      if (!grid[rowIndex][columnIndex]) grid[rowIndex][columnIndex] = null;
    }
  }
  return { rows, grid, entries, entryByCell: new Map(entries.map((entry) => [entry.cell, entry])), rowCount: rows.length, columnCount };
}

function tableColumnLayers(table) {
  const columns = [];
  for (const child of Array.from(table.children || [])) {
    const tag = (child?.tagName || '').toLowerCase();
    if (tag === 'col') {
      const span = Math.max(parseInt(child.getAttribute('span')) || 1, 1);
      for (let index = 0; index < span; index++) columns.push({ col: child, colgroup: null });
    } else if (tag === 'colgroup') {
      const children = Array.from(child.children || []).filter((entry) => (entry?.tagName || '').toLowerCase() === 'col');
      if (children.length === 0) {
        const span = Math.max(parseInt(child.getAttribute('span')) || 1, 1);
        for (let index = 0; index < span; index++) columns.push({ col: null, colgroup: child });
      } else {
        for (const col of children) {
          const span = Math.max(parseInt(col.getAttribute('span')) || 1, 1);
          for (let index = 0; index < span; index++) columns.push({ col, colgroup: child });
        }
      }
    }
  }
  return columns;
}

function addBorderCandidate(segments, key, border, priority) {
  if (!border) return;
  const candidates = segments.get(key) || [];
  candidates.push({ border, priority });
  segments.set(key, candidates);
}

function addElementBorders(segments, keyForSide, element, scale, priority) {
  if (!element) return;
  const style = window.getComputedStyle(element);
  for (const [side] of TABLE_BORDER_SIDES) {
    const border = getTableBorder(style, side, scale, element);
    const keys = keyForSide(side);
    for (const key of keys) addBorderCandidate(segments, key, border, priority);
  }
}

function chooseTableBorder(candidates) {
  if (!candidates?.length) return null;
  // This is deliberately a compact subset of collapsed-border resolution.
  // The order mirrors CSS's element precedence; width makes the result stable
  // for the common "thin grid + thick subtotal separator" case.
  return candidates.reduce((winner, candidate) => {
    if (!winner) return candidate;
    if (candidate.priority !== winner.priority) return candidate.priority > winner.priority ? candidate : winner;
    if (candidate.border.pt !== winner.border.pt) return candidate.border.pt > winner.border.pt ? candidate : winner;
    return winner;
  }, null)?.border || null;
}

/**
 * Translate table-, row-, column- and cell-level CSS borders into a single
 * native edge on each PPT table cell. PptxGenJS' table-level `border` option
 * cannot be used here: it draws all four sides on every cell, including the
 * internal grid.
 */
function resolveTableBorders(table, scale, model) {
  const { rows, grid, entries, rowCount, columnCount } = model;
  if (!rowCount || !columnCount) return;

  const horizontal = new Map(); // H:<grid row>:<grid column>
  const vertical = new Map(); // V:<grid row>:<grid column>
  const horizontalKey = (row, column) => `H:${row}:${column}`;
  const verticalKey = (row, column) => `V:${row}:${column}`;
  const acrossColumns = (row) => Array.from({ length: columnCount }, (_, column) => horizontalKey(row, column));
  const acrossRows = (column) => Array.from({ length: rowCount }, (_, row) => verticalKey(row, column));

  // The table itself owns only its perimeter.
  addElementBorders(horizontal, (side) => side === 'Top' ? acrossColumns(0) : side === 'Bottom' ? acrossColumns(rowCount) : [], table, scale, TABLE_BORDER_PRIORITY.table);
  addElementBorders(vertical, (side) => side === 'Left' ? acrossRows(0) : side === 'Right' ? acrossRows(columnCount) : [], table, scale, TABLE_BORDER_PRIORITY.table);

  const columns = tableColumnLayers(table);
  columns.slice(0, columnCount).forEach(({ col, colgroup }, column) => {
    for (const [element, source] of [[colgroup, 'colgroup'], [col, 'col']]) {
      addElementBorders(horizontal, () => [], element, scale, TABLE_BORDER_PRIORITY[source]);
      addElementBorders(vertical, (side) => side === 'Left' ? acrossRows(column) : side === 'Right' ? acrossRows(column + 1) : [], element, scale, TABLE_BORDER_PRIORITY[source]);
    }
  });

  rows.forEach((rowElement, rowIndex) => {
    const rowGroup = rowElement.parentElement && rowElement.parentElement !== table ? rowElement.parentElement : null;
    for (const [element, source] of [[rowGroup, 'rowgroup'], [rowElement, 'row']]) {
      addElementBorders(horizontal, (side) => side === 'Top' ? acrossColumns(rowIndex) : side === 'Bottom' ? acrossColumns(rowIndex + 1) : [], element, scale, TABLE_BORDER_PRIORITY[source]);
      addElementBorders(vertical, () => [], element, scale, TABLE_BORDER_PRIORITY[source]);
    }
  });

  entries.forEach((entry) => {
    const { cell, rowIndex, columnIndex, rowspan, colspan } = entry;
    addElementBorders(horizontal, (side) => {
      if (side === 'Top') return Array.from({ length: colspan }, (_, index) => horizontalKey(rowIndex, columnIndex + index));
      if (side === 'Bottom') return Array.from({ length: colspan }, (_, index) => horizontalKey(rowIndex + rowspan, columnIndex + index));
      return [];
    }, cell, scale, TABLE_BORDER_PRIORITY.cell);
    addElementBorders(vertical, (side) => {
      if (side === 'Left') return Array.from({ length: rowspan }, (_, index) => verticalKey(rowIndex + index, columnIndex));
      if (side === 'Right') return Array.from({ length: rowspan }, (_, index) => verticalKey(rowIndex + index, columnIndex + colspan));
      return [];
    }, cell, scale, TABLE_BORDER_PRIORITY.cell);
  });

  const edgeBorders = new Map();
  const setOwnedEdge = (owner, side, border) => {
    if (!owner?.outputCell || !border) return;
    const key = `${owner.rowIndex}:${owner.columnIndex}:${side}`;
    const existing = edgeBorders.get(key);
    // A PPT cell edge cannot carry multiple styles along its length. Prefer
    // the stronger selected segment; ordinary grids always have one style.
    if (!existing || border.pt > existing.pt) edgeBorders.set(key, border);
  };

  for (let row = 0; row <= rowCount; row++) {
    for (let column = 0; column < columnCount; column++) {
      const top = row > 0 ? grid[row - 1][column] : null;
      const bottom = row < rowCount ? grid[row][column] : null;
      // Never create an artificial line through a rowspan cell.
      if (top && top === bottom) continue;
      const border = chooseTableBorder(horizontal.get(horizontalKey(row, column)));
      setOwnedEdge(row === 0 ? bottom : top, row === 0 ? 0 : 2, border);
    }
  }
  for (let row = 0; row < rowCount; row++) {
    for (let column = 0; column <= columnCount; column++) {
      const left = column > 0 ? grid[row][column - 1] : null;
      const right = column < columnCount ? grid[row][column] : null;
      // Never create an artificial line through a colspan cell.
      if (left && left === right) continue;
      const border = chooseTableBorder(vertical.get(verticalKey(row, column)));
      setOwnedEdge(column === 0 ? right : left, column === 0 ? 3 : 1, border);
    }
  }

  entries.forEach((entry) => {
    if (!entry.outputCell) return;
    const border = [0, 1, 2, 3].map((side) => edgeBorders.get(`${entry.rowIndex}:${entry.columnIndex}:${side}`) || null);
    entry.outputCell.options.border = border;
  });
}

/**
 * Extracts native table data for PptxGenJS.
 */
function compositeColor(foreground, background) {
  if (!foreground?.hex || !(foreground.opacity > 0)) return background;
  if (!background?.hex || !(background.opacity > 0)) return foreground;

  const fgA = Math.max(0, Math.min(1, foreground.opacity));
  const bgA = Math.max(0, Math.min(1, background.opacity));
  const outA = fgA + bgA * (1 - fgA);
  if (!(outA > 0)) return { hex: null, opacity: 0 };

  const channel = (hex, offset) => parseInt(hex.slice(offset, offset + 2), 16);
  const blend = (offset) =>
    Math.round(
      (channel(foreground.hex, offset) * fgA + channel(background.hex, offset) * bgA * (1 - fgA)) / outA
    );
  const hex = [blend(0), blend(2), blend(4)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
  return { hex, opacity: outA };
}

function readElementBackground(element) {
  if (!element || element.nodeType !== 1) return { hex: null, opacity: 0 };
  const style = window.getComputedStyle(element);
  let color = parseColor(style.backgroundColor, style);
  if ((!color.hex || color.opacity === 0) && style.backgroundImage && style.backgroundImage !== 'none') {
    const fallback = getGradientFallbackColor(style.backgroundImage, style);
    if (fallback) color = parseColor(fallback, style);
  }
  return color;
}

function resolveColumnLayers(table, cell) {
  let columnIndex = 0;
  for (const sibling of Array.from(cell.parentElement?.children || [])) {
    if (sibling === cell) break;
    if (['td', 'th'].includes((sibling?.tagName || '').toLowerCase())) {
      columnIndex += parseInt(sibling.getAttribute('colspan')) || 1;
    }
  }

  const columns = [];
  for (const child of Array.from(table.children || [])) {
    const tag = (child?.tagName || '').toLowerCase();
    if (tag === 'col') {
      const span = parseInt(child.getAttribute('span')) || 1;
      for (let index = 0; index < span; index++) columns.push({ col: child, colgroup: null });
    } else if (tag === 'colgroup') {
      const colChildren = Array.from(child.children || []).filter(
        (entry) => (entry?.tagName || '').toLowerCase() === 'col'
      );
      if (colChildren.length === 0) {
        const span = parseInt(child.getAttribute('span')) || 1;
        for (let index = 0; index < span; index++) columns.push({ col: null, colgroup: child });
      } else {
        for (const col of colChildren) {
          const span = parseInt(col.getAttribute('span')) || 1;
          for (let index = 0; index < span; index++) columns.push({ col, colgroup: child });
        }
      }
    }
  }
  return columns[columnIndex] || { col: null, colgroup: null };
}

/**
 * Resolve the CSS table painting stack into the fill a PowerPoint cell needs.
 * PPT tables have no independently painted row/row-group layers, so a
 * transparent <th> cannot rely on its <tr> background surviving the export.
 *
 * Deliberately exclude ancestors of <table>: they are already exported as
 * shapes/images behind the table. Baking a glass-card ancestor into each cell
 * destroys the intended transparency and hides background gradients.
 */
export function resolveTableCellBackground(cell, table) {
  // Start transparent so outer container visuals remain visible through
  // transparent table cells in the PPTX.
  let result = { hex: null, opacity: 0 };
  const row = cell.parentElement;
  const rowGroup = row?.parentElement && row.parentElement !== table ? row.parentElement : null;
  const { col, colgroup } = resolveColumnLayers(table, cell);
  for (const layer of [table, colgroup, col, rowGroup, row, cell]) {
    result = compositeColor(readElementBackground(layer), result);
  }
  return result;
}

export function extractTableData(node, scale) {
  const rows = [];
  const colWidths = [];
  const rowHeights = [];
  const tableModel = buildTableGrid(node);

  // 1. Calculate Column Widths based on the first row of cells
  // We look at the first <tr>'s children to determine visual column widths.
  // Note: This assumes a fixed grid. Complex colspan/rowspan on the first row
  // might skew widths, but getBoundingClientRect captures the rendered result.
  const firstRow = node.querySelector('tr');
  if (firstRow) {
    const cells = Array.from(firstRow.children);
    cells.forEach((cell) => {
      const rect = cell.getBoundingClientRect();
      const colspan = parseInt(cell.getAttribute('colspan')) || 1;
      const wIn = (rect.width * (1 / 96) * scale) / colspan;
      for (let i = 0; i < colspan; i++) {
        colWidths.push(wIn);
      }
    });
  }

  const tableStyle = window.getComputedStyle(node);
  const borderSpacing = tableStyle.borderSpacing.split(' ');
  const hSpace = parseFloat(borderSpacing[0]) || 0;
  const vSpace = parseFloat(borderSpacing[1] || borderSpacing[0]) || 0;
  const hSpaceIn = (hSpace / 96) * scale;
  const vSpaceIn = (vSpace / 96) * scale;

  // 2. Iterate Rows
  const trList = tableModel.rows;
  trList.forEach((tr) => {
    const rowData = [];
    const cellList = Array.from(tr.children).filter((c) => ['td', 'th'].includes((c?.tagName || '').toLowerCase()));

    cellList.forEach((cell) => {
      const style = window.getComputedStyle(cell);
      const cellParts = collectTextParts(cell, style, scale);
      // Fallback to plain text if collectTextParts returns empty/invalid
      // A cell may deliberately contain only visual children (for example a
      // status dot or progress bar). `innerText` is also absent in JSDOM, so
      // use textContent as a portable fallback instead of throwing here.
      const plainText = cell.innerText ?? cell.textContent ?? '';
      const cellText = cellParts && cellParts.length > 0 ? cellParts : plainText.replace(/[\n\r\t]+/g, ' ').trim();

      // A. Text Style
      const textStyle = getTextStyle(style, scale);

      // B. Cell Background
      const bg = resolveTableCellBackground(cell, node);
      const fill = bg.hex && bg.opacity > 0
        ? {
            color: bg.hex,
            ...(bg.opacity < 1 ? { transparency: Math.round((1 - bg.opacity) * 100) } : {}),
          }
        : null;

      // C. Alignment
      let align = 'left';
      if (style.textAlign === 'center') align = 'center';
      if (style.textAlign === 'right' || style.textAlign === 'end') align = 'right';

      let valign = 'top';
      if (style.verticalAlign === 'middle') valign = 'middle';
      if (style.verticalAlign === 'bottom') valign = 'bottom';

      // D. Padding (Margins in PPTX)
      // CSS padding px -> slide inches. PptxGenJS table-cell margins use
      // inches when the first array entry is below 1. Passing points here is
      // especially destructive for common headers with padding-top: 0: the
      // library then interprets values such as 12pt as 12 inches.
      const padding = getPadding(style, scale);
      const margin = [
        padding[0] + vSpaceIn / 2, // top
        padding[1] + hSpaceIn / 2, // right
        padding[2] + vSpaceIn / 2, // bottom
        padding[3] + hSpaceIn / 2, // left
      ];

      // E. Text Direction
      const writingModeVert = getWritingModeVert(style.writingMode, style.textOrientation);
      const textDirection = mapVertToTextDirection(writingModeVert);

      // F. Construct Cell Object. Borders are filled after every source cell
      // has been associated with the visual grid, so table/row/column rules
      // can be written to one native PPT edge without duplicate grid lines.
      const outputCell = {
        text: cellText,
        options: {
          color: textStyle.color,
          fontFace: textStyle.fontFace,
          fontSize: textStyle.fontSize,
          bold: textStyle.bold,
          italic: textStyle.italic,
          underline: textStyle.underline,

          fill: fill,
          align: align,
          valign: valign,
          margin: margin,

          rowspan: parseInt(cell.getAttribute('rowspan')) || null,
          colspan: parseInt(cell.getAttribute('colspan')) || null,

          border: [null, null, null, null],

          ...(textDirection && { textDirection }),
        },
      };
      rowData.push(outputCell);
      const gridEntry = tableModel.entryByCell.get(cell);
      if (gridEntry) gridEntry.outputCell = outputCell;
    });

    if (rowData.length > 0) {
      rows.push(rowData);
      const rowRect = tr.getBoundingClientRect();
      rowHeights.push(rowRect.height * (1 / 96) * scale);
    }
  });

  resolveTableBorders(node, scale, tableModel);

  const hasMeasuredRowHeights = rowHeights.length === rows.length && rowHeights.every((height) => height > 0);
  return {
    rows,
    colWidths,
    rowHeights: hasMeasuredRowHeights ? rowHeights : undefined,
  };
}

// Checks if any parent element has overflow: hidden which would clip this element
export function isClippedByParent(node) {
  let parent = node.parentElement;
  while (parent && parent !== document.body) {
    const style = window.getComputedStyle(parent);
    const overflow = style.overflow;
    if (overflow === 'hidden' || overflow === 'clip') {
      return true;
    }
    parent = parent.parentElement;
  }
  return false;
}

// Helper to save gradient text
// Helper to save gradient text: extracts the first color from a gradient string
export function getGradientFallbackColor(bgImage, style) {
  if (!bgImage || bgImage === 'none') return null;

  let resolvedBgImage = bgImage;
  if (style) {
    resolvedBgImage = resolveCssVariables(bgImage, style);
  }

  // 1. Extract content inside function(...)
  // Handles linear-gradient(...), radial-gradient(...), repeating-linear-gradient(...)
  const match = resolvedBgImage.match(/gradient\((.*)\)/);
  if (!match) return null;

  const content = match[1];

  // 2. Split by comma, respecting parentheses (to avoid splitting inside rgb(), oklch(), etc.)
  const parts = [];
  let current = '';
  let parenDepth = 0;

  for (const char of content) {
    if (char === '(') parenDepth++;
    if (char === ')') parenDepth--;
    if (char === ',' && parenDepth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current) parts.push(current.trim());

  // 3. Find first part that is a color (skip angle/direction)
  for (const part of parts) {
    // Ignore directions (to right) or angles (90deg, 0.5turn)
    if (/^(to\s|[\d.]+(deg|rad|turn|grad))/.test(part)) continue;

    // Extract color: Remove trailing position (e.g. "red 50%" -> "red")
    // Regex matches whitespace + number + unit at end of string
    const colorPart = part.replace(/\s+(-?[\d.]+(%|px|em|rem|ch|vh|vw)?)$/, '');

    // Check if it's not just a number (some gradients might have bare numbers? unlikely in standard syntax)
    if (colorPart) return colorPart;
  }

  return null;
}

// A compact transport marker for a DrawingML run gradient. PptxGenJS exposes
// one fontFace string per run but no run-level gradFill API, so this data rides
// through its XML writer in the typeface attribute and is restored by
// pptx-normalizer before the package is returned to the caller.
export const GRADIENT_TYPEFACE_MARKER = '__grad_';

function splitCssTopLevel(value, separator = ',') {
  const parts = [];
  let current = '';
  let depth = 0;

  for (const char of value) {
    if (char === '(') depth++;
    else if (char === ')') depth--;

    if (char === separator && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function splitCssTopLevelWhitespace(value) {
  const parts = [];
  let current = '';
  let depth = 0;
  for (const char of value.trim()) {
    if (char === '(') depth++;
    else if (char === ')') depth--;

    if (/\s/.test(char) && depth === 0) {
      if (current) {
        parts.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function parseCssLinearGradientAngle(value) {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ');
  const keywordAngles = {
    'to top': 0,
    'to top right': 45,
    'to right top': 45,
    'to right': 90,
    'to bottom right': 135,
    'to right bottom': 135,
    'to bottom': 180,
    'to bottom left': 225,
    'to left bottom': 225,
    'to left': 270,
    'to top left': 315,
    'to left top': 315,
  };
  if (Object.hasOwn(keywordAngles, normalized)) return keywordAngles[normalized];

  const match = normalized.match(/^(-?(?:\d+(?:\.\d*)?|\.\d+))(deg|rad|turn|grad)$/);
  if (!match) return null;
  const valueNumber = Number(match[1]);
  if (!Number.isFinite(valueNumber)) return null;

  const unit = match[2];
  if (unit === 'deg') return valueNumber;
  if (unit === 'rad') return valueNumber * (180 / Math.PI);
  if (unit === 'turn') return valueNumber * 360;
  return valueNumber * 0.9;
}

/**
 * Maps a CSS linear-gradient angle to SVG object-bounding-box endpoints.
 * CSS uses 0deg for up and rotates clockwise; SVG's y axis points down.
 * Projecting all four rectangle corners gives CSS's "magic corner" gradient
 * line, including for non-square boxes and diagonal gradients.
 */
export function getCssLinearGradientEndpoints(width, height, cssAngleDeg) {
  const safeWidth = Number(width);
  const safeHeight = Number(height);
  if (!Number.isFinite(safeWidth) || !Number.isFinite(safeHeight) || safeWidth <= 0 || safeHeight <= 0) {
    return null;
  }

  const radians = cssAngleDeg * (Math.PI / 180);
  const dirX = Math.sin(radians);
  const dirY = -Math.cos(radians);
  const halfSpan = (safeWidth * Math.abs(dirX) + safeHeight * Math.abs(dirY)) / 2;
  const centerX = safeWidth / 2;
  const centerY = safeHeight / 2;
  const toPct = (value, size) => {
    const rounded = Math.round((value / size * 100) * 10) / 10;
    return `${(Object.is(rounded, -0) ? 0 : rounded).toFixed(1)}%`;
  };

  return {
    x1: toPct(centerX - dirX * halfSpan, safeWidth),
    y1: toPct(centerY - dirY * halfSpan, safeHeight),
    x2: toPct(centerX + dirX * halfSpan, safeWidth),
    y2: toPct(centerY + dirY * halfSpan, safeHeight),
  };
}

function normalizeCssGradientPositions(stops) {
  if (stops.length < 2) return null;
  const positions = stops.map((stop) => stop.posPct);

  // CSS places omitted edge stops at the gradient's endpoints, then spreads
  // each internal omitted run evenly between its neighbouring explicit stops.
  if (positions[0] === null) positions[0] = 0;
  if (positions[positions.length - 1] === null) positions[positions.length - 1] = 100;

  let previous = 0;
  while (previous < positions.length - 1) {
    if (positions[previous] === null) return null;
    let next = previous + 1;
    while (next < positions.length && positions[next] === null) next++;
    if (next >= positions.length) return null;

    const start = positions[previous];
    const end = positions[next];
    if (end < start) return null;
    for (let index = previous + 1; index < next; index++) {
      positions[index] = start + ((end - start) * (index - previous)) / (next - previous);
    }
    previous = next;
  }

  return stops.map((stop, index) => ({ ...stop, posPct: positions[index] }));
}

/**
 * Parses the deliberately small CSS gradient subset that can be represented
 * faithfully by a DrawingML run <a:gradFill>. Complex or layered backgrounds
 * deliberately return null so callers retain the existing solid-colour
 * fallback instead of approximating an unrelated visual.
 */
export function parseLinearGradientForText(backgroundImage, style) {
  if (!backgroundImage || backgroundImage === 'none') return null;
  const resolved = resolveCssVariables(backgroundImage, style).trim();
  const prefix = resolved.match(/^linear-gradient\(/i);
  if (!prefix) return null;
  let depth = 0;
  let closingIndex = -1;
  for (let index = prefix[0].length - 1; index < resolved.length; index++) {
    if (resolved[index] === '(') depth++;
    else if (resolved[index] === ')') {
      depth--;
      if (depth === 0) {
        closingIndex = index;
        break;
      }
    }
  }
  // A second background layer (or malformed parentheses) must not be parsed
  // as though it belonged to the first linear gradient.
  if (closingIndex !== resolved.length - 1) return null;
  const content = resolved.slice(prefix[0].length, closingIndex);

  const parts = splitCssTopLevel(content);
  if (parts.length < 2) return null;

  let cssAngleDeg = 180; // CSS's default direction is `to bottom`.
  let firstStop = 0;
  const possibleAngle = parseCssLinearGradientAngle(parts[0]);
  if (possibleAngle !== null) {
    cssAngleDeg = possibleAngle;
    firstStop = 1;
  } else if (/^(?:to\s|[-+.\d]+(?:deg|rad|turn|grad)$)/i.test(parts[0].trim())) {
    // It looked like a direction, but was malformed or unsupported.
    return null;
  }

  const stops = [];
  for (const rawStop of parts.slice(firstStop)) {
    const tokens = splitCssTopLevelWhitespace(rawStop);
    if (!tokens.length) return null;

    let posPct = null;
    const last = tokens[tokens.length - 1];
    if (/^-?(?:\d+(?:\.\d*)?|\.\d+)%$/.test(last)) {
      posPct = Number(last.slice(0, -1));
      if (!Number.isFinite(posPct) || posPct < 0 || posPct > 100) return null;
      tokens.pop();
    } else if (/^-?(?:\d+(?:\.\d*)?|\.\d+)[a-z]+$/i.test(last)) {
      // Pixel and other length stops need the rendered gradient-line length;
      // do not guess that geometry at run scope.
      return null;
    }

    const color = parseColor(tokens.join(' '), style);
    // CSS permits a fully transparent stop. Its RGB channels are immaterial
    // at alpha 0; transparent black is the interoperable DrawingML encoding
    // when the browser does not expose those channels.
    if (!color.hex && color.opacity > 0) return null;
    stops.push({ posPct, hex: color.hex || '000000', alpha: color.opacity });
  }

  const normalizedStops = normalizeCssGradientPositions(stops);
  if (!normalizedStops) return null;
  return {
    cssAngleDeg: ((cssAngleDeg % 360) + 360) % 360,
    stops: normalizedStops,
  };
}

function formatGradientMarkerNumber(value) {
  return String(Math.round(value * 100) / 100).replace(/\.0+$/, '');
}

function buildTextGradientMarker(gradient, runOpacity) {
  const stops = gradient.stops.map(({ posPct, hex, alpha }) => (
    `${Math.round(posPct)}:${hex}:${formatGradientMarkerNumber(Math.max(0, Math.min(1, alpha)) * 100)}`
  ));
  const payload = `lin;${formatGradientMarkerNumber(gradient.cssAngleDeg)};${stops.join(',')};${formatGradientMarkerNumber(runOpacity * 100)}`;
  return `${GRADIENT_TYPEFACE_MARKER}${payload}`;
}

function mapDashType(style) {
  if (style === 'dashed') return 'dash';
  if (style === 'dotted') return 'dot';
  return 'solid';
}

function hexToRgb(hex) {
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }) {
  return [r, g, b]
    .map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

function sampleLinearGradient(gradient, rect, x, y) {
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;

  // CSS 0deg points upward and rotates clockwise. Projecting the rectangle's
  // corners onto that vector gives a stable, layout-independent approximation
  // of CSS's gradient line for the small borders this code targets.
  const radians = gradient.cssAngleDeg * (Math.PI / 180);
  const dirX = Math.sin(radians);
  const dirY = -Math.cos(radians);
  const corners = [
    [rect.left, rect.top],
    [rect.left + rect.width, rect.top],
    [rect.left, rect.top + rect.height],
    [rect.left + rect.width, rect.top + rect.height],
  ];
  const projections = corners.map(([cornerX, cornerY]) => cornerX * dirX + cornerY * dirY);
  const minProjection = Math.min(...projections);
  const maxProjection = Math.max(...projections);
  const pointProjection = x * dirX + y * dirY;
  const position = maxProjection === minProjection
    ? 0
    : Math.max(0, Math.min(1, (pointProjection - minProjection) / (maxProjection - minProjection))) * 100;

  let before = gradient.stops[0];
  let after = gradient.stops[gradient.stops.length - 1];
  for (let index = 1; index < gradient.stops.length; index++) {
    if (position <= gradient.stops[index].posPct) {
      before = gradient.stops[index - 1];
      after = gradient.stops[index];
      break;
    }
  }
  const span = after.posPct - before.posPct;
  const ratio = span <= 0 ? 0 : (position - before.posPct) / span;
  const beforeRgb = hexToRgb(before.hex);
  const afterRgb = hexToRgb(after.hex);
  return {
    hex: rgbToHex({
      r: beforeRgb.r + (afterRgb.r - beforeRgb.r) * ratio,
      g: beforeRgb.g + (afterRgb.g - beforeRgb.g) * ratio,
      b: beforeRgb.b + (afterRgb.b - beforeRgb.b) * ratio,
    }),
    opacity: before.alpha + (after.alpha - before.alpha) * ratio,
  };
}

/**
 * Resolve the actual backdrop under a border point. PptxGenJS cannot write
 * line alpha, so a translucent border has to be pre-composited. The previous
 * solid-colour walk fell through a CSS gradient to white; this path samples a
 * supported ancestor linear gradient instead. Complex paint remains unknown
 * and deliberately returns `unsupported`, letting callers omit a misleading
 * border rather than exporting an opaque white one.
 */
function getGradientBackdropAtPoint(node, x, y, { ignoreUnsupportedNodeImage = false } = {}) {
  const layers = [];
  let hasGradient = false;
  for (let current = node; current && current.nodeType === 1; current = current.parentElement) {
    const style = window.getComputedStyle(current);
    const backgroundImage = style.backgroundImage;
    let gradient = null;
    if (backgroundImage && backgroundImage !== 'none') {
      gradient = parseLinearGradientForText(backgroundImage, style);
      // A circular decoration can carry a radial glow while its border sits
      // over an ancestor linear gradient. Its own unsupported image should
      // not force a white-border fallback; use the ancestor backdrop for the
      // native circle line instead.
      if (!gradient && ignoreUnsupportedNodeImage && current === node) {
        gradient = null;
      } else if (!gradient) {
        return { kind: 'unsupported' };
      }
      if (gradient) hasGradient = true;
    }
    layers.push({ current, style, gradient });
  }
  if (!hasGradient) return { kind: 'none' };

  let backdrop = { hex: 'FFFFFF', opacity: 1 };
  for (const { current, style, gradient } of layers.reverse()) {
    const backgroundColor = parseColor(style.backgroundColor, style);
    if (backgroundColor.hex && backgroundColor.opacity > 0) {
      backdrop = compositeColor(backgroundColor, backdrop);
    }
    if (gradient) {
      const sample = sampleLinearGradient(gradient, current.getBoundingClientRect(), x, y);
      if (!sample) return { kind: 'unsupported' };
      backdrop = compositeColor(sample, backdrop);
    }
  }
  return { kind: 'supported', color: backdrop };
}

function resolveBorderColor(value, style, node, point, options) {
  const color = parseColor(value, style);
  if (!color.hex || color.opacity === 0 || color.opacity >= 1 || !node || !point) {
    return flattenColor(color, node, false);
  }

  const backdrop = getGradientBackdropAtPoint(node, point.x, point.y, options);
  if (backdrop.kind === 'supported') {
    // The backdrop starts from the document's white default, so the resulting
    // colour is opaque and safe for PptxGenJS's line serializer.
    return compositeColor(color, backdrop.color);
  }
  if (backdrop.kind === 'unsupported') {
    return { hex: null, opacity: 0 };
  }
  return flattenColor(color, node, false);
}

/**
 * Analyzes computed border styles and determines the rendering strategy.
 */
export function getBorderInfo(style, scale, node = null) {
  // PptxGenJS does not serialize line transparency (its own type definition
  // marks that field as TODO). Sending an rgba() border through unchanged
  // therefore turns, for example, rgba(255,255,255,.05) into a solid white
  // outline. Flatten it against the element's painted background first; PPT
  // then receives the opaque colour that browsers actually display.
  const rect = node?.getBoundingClientRect?.();
  const topWidth = parseFloat(style.borderTopWidth) || 0;
  const rightWidth = parseFloat(style.borderRightWidth) || 0;
  const bottomWidth = parseFloat(style.borderBottomWidth) || 0;
  const leftWidth = parseFloat(style.borderLeftWidth) || 0;
  const points = rect && rect.width > 0 && rect.height > 0 ? {
    top: { x: rect.left + rect.width / 2, y: rect.top + topWidth / 2 },
    right: { x: rect.left + rect.width - rightWidth / 2, y: rect.top + rect.height / 2 },
    bottom: { x: rect.left + rect.width / 2, y: rect.top + rect.height - bottomWidth / 2 },
    left: { x: rect.left + leftWidth / 2, y: rect.top + rect.height / 2 },
  } : null;
  const borderStyles = [style.borderTopStyle, style.borderRightStyle, style.borderBottomStyle, style.borderLeftStyle];
  const borderColors = [style.borderTopColor, style.borderRightColor, style.borderBottomColor, style.borderLeftColor];
  const borderWidths = [topWidth, rightWidth, bottomWidth, leftWidth];
  const hasUniformSourceBorder = borderStyles.every((value) => value === borderStyles[0]) &&
    borderColors.every((value) => value === borderColors[0]) &&
    borderWidths.every((value) => value === borderWidths[0]);
  const rawRadius = parseFloat(style.borderRadius) || 0;
  const radiusPx = style.borderRadius?.includes('%') && rect
    ? (rawRadius / 100) * Math.min(rect.width, rect.height)
    : rawRadius;
  const isEllipse = rect && radiusPx >= Math.min(rect.width, rect.height) / 2;
  const preserveNativeOutline = hasUniformSourceBorder && points && (
    isEllipse || borderStyles[0] === 'dashed' || borderStyles[0] === 'dotted'
  );

  let topColorObj;
  let rightColorObj;
  let bottomColorObj;
  let leftColorObj;
  if (preserveNativeOutline) {
    // DrawingML can preserve a circle and dash pattern only with one native
    // line colour. Sampling the centre is visually stable for a thin ring;
    // sampling each side would require a rectangular SVG overlay.
    const centerPoint = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    const color = resolveBorderColor(style.borderTopColor, style, node, centerPoint, {
      ignoreUnsupportedNodeImage: true,
    });
    topColorObj = color;
    rightColorObj = color;
    bottomColorObj = color;
    leftColorObj = color;
  } else {
    topColorObj = resolveBorderColor(style.borderTopColor, style, node, points?.top);
    rightColorObj = resolveBorderColor(style.borderRightColor, style, node, points?.right);
    bottomColorObj = resolveBorderColor(style.borderBottomColor, style, node, points?.bottom);
    leftColorObj = resolveBorderColor(style.borderLeftColor, style, node, points?.left);
  }

  const top = {
    width: topWidth,
    style: style.borderTopStyle,
    color: topColorObj.hex,
    opacity: topColorObj.opacity,
  };
  const right = {
    width: rightWidth,
    style: style.borderRightStyle,
    color: rightColorObj.hex,
    opacity: rightColorObj.opacity,
  };
  const bottom = {
    width: bottomWidth,
    style: style.borderBottomStyle,
    color: bottomColorObj.hex,
    opacity: bottomColorObj.opacity,
  };
  const left = {
    width: leftWidth,
    style: style.borderLeftStyle,
    color: leftColorObj.hex,
    opacity: leftColorObj.opacity,
  };

  const hasAnyBorder = top.width > 0 || right.width > 0 || bottom.width > 0 || left.width > 0;
  if (!hasAnyBorder) return { type: 'none' };
  if (![top, right, bottom, left].some((side) => side.color && side.opacity > 0)) return { type: 'none' };

  // Check if all sides are uniform
  const isUniform =
    top.width === right.width &&
    top.width === bottom.width &&
    top.width === left.width &&
    top.style === right.style &&
    top.style === bottom.style &&
    top.style === left.style &&
    top.color === right.color &&
    top.color === bottom.color &&
    top.color === left.color;

  if (isUniform) {
    return {
      type: 'uniform',
      options: {
        width: top.width * 0.75 * scale,
        color: top.color,
        transparency: (1 - top.opacity) * 100,
        dashType: mapDashType(top.style),
      },
    };
  } else {
    return {
      type: 'composite',
      sides: { top, right, bottom, left },
    };
  }
}

/**
 * Generates an SVG image for composite borders that respects border-radius.
 */
export function generateCompositeBorderSVG(w, h, radius, sides) {
  radius = radius / 2; // Adjust for SVG rendering
  const clipId = 'clip_' + Math.random().toString(36).substr(2, 9);
  let borderRects = '';

  if (sides.top.width > 0 && sides.top.color) {
    borderRects += `<rect x="0" y="0" width="${w}" height="${sides.top.width}" fill="#${sides.top.color}" fill-opacity="${sides.top.opacity ?? 1}" />`;
  }
  if (sides.right.width > 0 && sides.right.color) {
    borderRects += `<rect x="${w - sides.right.width}" y="0" width="${sides.right.width}" height="${h}" fill="#${sides.right.color}" fill-opacity="${sides.right.opacity ?? 1}" />`;
  }
  if (sides.bottom.width > 0 && sides.bottom.color) {
    borderRects += `<rect x="0" y="${h - sides.bottom.width}" width="${w}" height="${sides.bottom.width}" fill="#${sides.bottom.color}" fill-opacity="${sides.bottom.opacity ?? 1}" />`;
  }
  if (sides.left.width > 0 && sides.left.color) {
    borderRects += `<rect x="0" y="0" width="${sides.left.width}" height="${h}" fill="#${sides.left.color}" fill-opacity="${sides.left.opacity ?? 1}" />`;
  }

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
        <defs>
            <clipPath id="${clipId}">
                <rect x="0" y="0" width="${w}" height="${h}" rx="${radius}" ry="${radius}" />
            </clipPath>
        </defs>
        <g clip-path="url(#${clipId})">
            ${borderRects}
        </g>
    </svg>`;

  return 'data:image/svg+xml;base64,' + btoa(svg.trim());
}

/**
 * Generates an SVG data URL for a solid shape with non-uniform corner radii.
 */
export function generateCustomShapeSVG(w, h, color, opacity, radii, border = null) {
  const clampRadii = (width, height, input) => {
    let { tl, tr, br, bl } = input;
    const factor = Math.min(
      width / (tl + tr) || Infinity,
      height / (tr + br) || Infinity,
      width / (br + bl) || Infinity,
      height / (bl + tl) || Infinity
    );
    if (factor < 1) {
      tl *= factor;
      tr *= factor;
      br *= factor;
      bl *= factor;
    }
    return { tl, tr, br, bl };
  };
  const buildPath = (offset, width, height, input) => {
    const { tl, tr, br, bl } = clampRadii(width, height, input);
    return `
      M ${offset + tl} ${offset}
      L ${offset + width - tr} ${offset}
      A ${tr} ${tr} 0 0 1 ${offset + width} ${offset + tr}
      L ${offset + width} ${offset + height - br}
      A ${br} ${br} 0 0 1 ${offset + width - br} ${offset + height}
      L ${offset + bl} ${offset + height}
      A ${bl} ${bl} 0 0 1 ${offset} ${offset + height - bl}
      L ${offset} ${offset + tl}
      A ${tl} ${tl} 0 0 1 ${offset + tl} ${offset}
      Z
    `;
  };

  const outerPath = buildPath(0, w, h, radii);
  const borderWidth = Math.max(0, Number(border?.width) || 0);
  const innerW = Math.max(0, w - borderWidth * 2);
  const innerH = Math.max(0, h - borderWidth * 2);
  const innerPath = borderWidth > 0
    ? buildPath(borderWidth, innerW, innerH, {
        tl: Math.max(0, radii.tl - borderWidth),
        tr: Math.max(0, radii.tr - borderWidth),
        br: Math.max(0, radii.br - borderWidth),
        bl: Math.max(0, radii.bl - borderWidth),
      })
    : outerPath;

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      ${borderWidth > 0 ? `<path d="${outerPath}" fill="#${border.color}" fill-opacity="${border.opacity ?? 1}" />` : ''}
      <path d="${innerPath}" fill="#${color}" fill-opacity="${opacity}" />
    </svg>`;

  return 'data:image/svg+xml;base64,' + btoa(svg.trim());
}

// --- REPLACE THE EXISTING parseColor FUNCTION ---
export function resolveCssVariables(value, style) {
  if (!value || typeof value !== 'string') return value;
  let resolved = value;
  let match;
  let iterations = 0;
  // Limit to 10 iterations to prevent infinite loop
  while ((match = resolved.match(/var\((--[a-zA-Z0-9_-]+)\)/)) && iterations < 10) {
    iterations++;
    const varName = match[1];
    const varValue = style.getPropertyValue(varName).trim();
    if (varValue) {
      resolved = resolved.replace(match[0], varValue);
    } else {
      break;
    }
  }
  return resolved;
}

export function parseColor(str, style) {
  if (!str) return { hex: null, opacity: 0 };
  let resolvedStr = str;
  if (style) {
    resolvedStr = resolveCssVariables(str, style);
  }
  if (resolvedStr === 'transparent' || resolvedStr.trim() === 'rgba(0, 0, 0, 0)') {
    return { hex: null, opacity: 0 };
  }

  const ctx = getCtx();
  ctx.fillStyle = str;
  const computed = ctx.fillStyle;

  // 1. Handle Hex Output (e.g. #ff0000) - Fast Path
  if (computed.startsWith('#')) {
    let hex = computed.slice(1);
    let opacity = 1;
    if (hex.length === 3)
      hex = hex
        .split('')
        .map((c) => c + c)
        .join('');
    if (hex.length === 4)
      hex = hex
        .split('')
        .map((c) => c + c)
        .join('');
    if (hex.length === 8) {
      opacity = parseInt(hex.slice(6), 16) / 255;
      hex = hex.slice(0, 6);
    }
    return { hex: hex.toUpperCase(), opacity };
  }

  // 2. Handle RGB/RGBA Output (standard) - Fast Path
  if (computed.startsWith('rgb')) {
    const match = computed.match(/[\d.]+/g);
    if (match && match.length >= 3) {
      const r = parseInt(match[0]);
      const g = parseInt(match[1]);
      const b = parseInt(match[2]);
      const a = match.length > 3 ? parseFloat(match[3]) : 1;
      const hex = ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
      return { hex, opacity: a };
    }
  }

  // 3. Fallback: Browser returned a format we don't parse (oklch, lab, color(srgb...), etc.)
  // Use Canvas API to convert to sRGB
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillRect(0, 0, 1, 1);
  const data = ctx.getImageData(0, 0, 1, 1).data;
  // data = [r, g, b, a]
  const r = data[0];
  const g = data[1];
  const b = data[2];
  const a = data[3] / 255;

  if (a === 0) return { hex: null, opacity: 0 };

  const hex = ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1).toUpperCase();
  return { hex, opacity: a };
}

export function flattenColor(color, node, startFromParent = true) {
  if (!color || !color.hex || color.opacity === 1 || color.opacity === 0) {
    return color;
  }

  let r = parseInt(color.hex.slice(0, 2), 16);
  let g = parseInt(color.hex.slice(2, 4), 16);
  let b = parseInt(color.hex.slice(4, 6), 16);
  let a = color.opacity;

  let current = node;
  if (startFromParent && node) {
    current = node.parentElement;
  }

  while (current && current !== document) {
    const style = window.getComputedStyle(current);
    const bgStr = style.backgroundColor;
    const bg = parseColor(bgStr, style);

    if (bg.hex && bg.opacity > 0) {
      const bgR = parseInt(bg.hex.slice(0, 2), 16);
      const bgG = parseInt(bg.hex.slice(2, 4), 16);
      const bgB = parseInt(bg.hex.slice(4, 6), 16);
      const bgA = bg.opacity;

      const aOut = a + bgA * (1 - a);
      if (aOut > 0) {
        r = (r * a + bgR * bgA * (1 - a)) / aOut;
        g = (g * a + bgG * bgA * (1 - a)) / aOut;
        b = (b * a + bgB * bgA * (1 - a)) / aOut;
        a = aOut;
      }

      if (a >= 1) {
        a = 1;
        break;
      }
    }
    current = current.parentElement;
  }

  if (a < 1) {
    const bgR = 255;
    const bgG = 255;
    const bgB = 255;
    const bgA = 1;

    const aOut = a + bgA * (1 - a);
    if (aOut > 0) {
      r = (r * a + bgR * bgA * (1 - a)) / aOut;
      g = (g * a + bgG * bgA * (1 - a)) / aOut;
      b = (b * a + bgB * bgA * (1 - a)) / aOut;
    }
  }

  const rHex = Math.round(r).toString(16).padStart(2, '0');
  const gHex = Math.round(g).toString(16).padStart(2, '0');
  const bHex = Math.round(b).toString(16).padStart(2, '0');
  const hex = (rHex + gHex + bHex).toUpperCase();

  return { hex, opacity: 1 };
}

export function getPadding(style, scale) {
  const pxToInch = 1 / 96;
  return [
    (parseFloat(style.paddingTop) || 0) * pxToInch * scale,
    (parseFloat(style.paddingRight) || 0) * pxToInch * scale,
    (parseFloat(style.paddingBottom) || 0) * pxToInch * scale,
    (parseFloat(style.paddingLeft) || 0) * pxToInch * scale,
  ];
}

export function getSoftEdges(filterStr, scale) {
  if (!filterStr || filterStr === 'none') return null;
  const match = filterStr.match(/blur\(([\d.]+)px\)/);
  if (match) return parseFloat(match[1]) * 0.75 * scale;
  return null;
}

// Transport marker for the East Asian typeface, mirroring the existing
// `__spc_` charSpacing marker: PptxGenJS writes one `fontFace` into
// <a:latin>, <a:ea> and <a:cs> alike and exposes no per-script option, so
// the second family rides along in the typeface string and the normalizer
// splits it back out.
export const EA_TYPEFACE_MARKER = '__ea_';

const CSS_GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
  // Vendor tokens: browser keywords, never real installed families.
  '-apple-system',
  'blinkmacsystemfont',
]);

const availabilityCache = new Map();
let availabilityProbeContext = null;
// Two Latin sentinels with contrasting stroke/width profiles; a real font
// differs from a fallback on at least one of them.
const AVAILABILITY_SENTINELS = ['MWil qB', 'BESbswy'];

/**
 * Is this family an actual font the browser can render with right now —
 * installed on the system or loaded from an @font-face?
 *
 * The deck's first stack member is routinely a font the author's platform
 * has but the export machine (or the deck's viewer) does not — 'PingFang SC'
 * on Windows, 'Impact' on macOS. Chromium then silently degrades to the
 * next stack entry, while the PPTX would still carry the missing name and
 * PowerPoint would pick its own, different, substitute.
 *
 * Measured with Latin text: a missing family measures exactly like the
 * generic fallback behind it; an installed one differs from at least one of
 * monospace/serif. Latin sentinels avoid the flaw that defeats the '永'
 * probe below: the system's CJK fallback font measures identically to
 * itself behind any candidate.
 */
export function familyIsAvailable(family) {
  if (!family) return false;
  const normalized = family.trim().replace(/^['"]|['"]$/g, '');
  if (!normalized || CSS_GENERIC_FAMILIES.has(normalized.toLowerCase())) return false;
  if (availabilityCache.has(normalized)) return availabilityCache.get(normalized);

  let available = false;
  try {
    if (!availabilityProbeContext) {
      availabilityProbeContext = document.createElement('canvas').getContext('2d');
    }
    const context = availabilityProbeContext;
    const quoted = `"${normalized.replace(/"/g, '\\"')}"`;
    outer: for (const fallback of ['monospace', 'serif']) {
      for (const sentinel of AVAILABILITY_SENTINELS) {
        context.font = `100px ${fallback}`;
        const baseline = context.measureText(sentinel).width;
        context.font = `100px ${quoted}, ${fallback}`;
        if (Math.abs(context.measureText(sentinel).width - baseline) > 0.01) {
          available = true;
          break outer;
        }
      }
    }
  } catch {
    // No canvas (jsdom, exotic host): "unknown" keeps the pre-existing
    // behavior of trusting the CSS-declared first family.
    available = false;
  }

  availabilityCache.set(normalized, available);
  return available;
}

// Families known to carry Han characters independent of measurement: the
// width probe can't recognize the machine's own CJK fallback (see
// familySupportsCjk). Membership answers "does it have CJK"; availability
// still decides whether this machine actually has it.
const KNOWN_CJK_FAMILIES = new Set([
  'pingfang sc', 'pingfang tc', 'pingfang hk', 'pingfang mo',
  'hiragino sans gb', 'hiragino kaku gothic pro', 'hiragino maru gothic pro',
  'heiti sc', 'heiti tc', 'songti sc', 'songti tc', 'stheiti', 'stheiti light', 'stsong', 'songti',
  'microsoft yahei', 'microsoft jhenghei', 'msyh', '微软雅黑', '新細明體', '微软正黑体',
  'simhei', '黑体', 'simsun', '宋体', 'nsimsun', 'kaiti', '楷体', 'fangsong', '仿宋',
  'dengxian', '等线', 'yu gothic', 'yu mincho', '游ゴシック', '游明朝', 'meiryo',
  'malgun gothic', '맑은 고딕',
  'noto sans cjk sc', 'noto sans cjk tc', 'noto sans cjk jp', 'noto sans cjk kr', 'noto sans cjk hk',
  'noto serif cjk sc', 'noto serif cjk tc', 'noto serif cjk jp', 'noto serif cjk kr', 'noto serif cjk hk',
  'noto sans sc', 'noto sans tc', 'noto sans jp', 'noto sans kr',
  'source han sans', 'source han serif', 'source han sans sc', 'source han serif sc',
  'sarasa gothic', 'sarasa ui', 'lxgw wenkai', 'wenquanyi micro hei', 'wenquanyi zen hei',
  'droid sans fallback',
]);

const cjkSupportCache = new Map();
let cjkProbeContext = null;

/**
 * Does this font family actually carry CJK glyphs?
 *
 * Two mechanisms, because each defeats the other's blind spot:
 *
 * - Known families (KNOWN_CJK_FAMILIES) are answered by availability alone.
 *   The width probe structurally cannot recognize the machine's CJK
 *   fallback font: 'Microsoft YaHei' IS what monospace and serif resolve
 *   '永' to on a Chinese Windows box, so candidate and baseline measure
 *   identically and the probe reports "no CJK" about the best CJK font on
 *   the machine. That false negative silenced the East Asian split.
 * - Everything else (web fonts, uploaded workspace fonts, other localized
 *   aliases) is measured rather than name-matched: the probe renders one
 *   Han character twice, each time with a different generic fallback behind
 *   the candidate. A family without the glyph falls through to the
 *   fallback and measures exactly the fallback's own width; a family with
 *   the glyph measures its own. Two different fallbacks make a false
 *   negative essentially impossible — a width can't coincide with both
 *   monospace and serif when those two differ from each other.
 */
export function familySupportsCjk(family) {
  if (!family) return false;
  const normalized = family.trim().replace(/^['"]|['"]$/g, '');
  if (!normalized || CSS_GENERIC_FAMILIES.has(normalized.toLowerCase())) return false;
  if (KNOWN_CJK_FAMILIES.has(normalized.toLowerCase())) {
    return familyIsAvailable(normalized);
  }
  if (cjkSupportCache.has(normalized)) return cjkSupportCache.get(normalized);

  let supported = false;
  try {
    if (!cjkProbeContext) {
      cjkProbeContext = document.createElement('canvas').getContext('2d');
    }
    const context = cjkProbeContext;
    const probe = '永';
    const measure = (fontSpec) => {
      context.font = fontSpec;
      return context.measureText(probe).width;
    };
    const quoted = `"${normalized.replace(/"/g, '\\"')}"`;
    for (const fallback of ['monospace', 'serif']) {
      const baseline = measure(`100px ${fallback}`);
      const candidate = measure(`100px ${quoted}, ${fallback}`);
      if (Math.abs(candidate - baseline) > 0.01) {
        supported = true;
        break;
      }
    }
  } catch {
    // No canvas (jsdom, exotic host): fall back to "unknown", which keeps
    // the pre-existing single-typeface behaviour rather than guessing.
    supported = false;
  }

  cjkSupportCache.set(normalized, supported);
  return supported;
}

/**
 * Pick the family that should land in PowerPoint's <a:ea> slot for a run.
 *
 * Mirrors what the browser does with a stack like
 * `Kalam, "PingFang SC", sans-serif`: Latin comes from Kalam, Han from
 * PingFang SC. Writing Kalam into <a:ea> instead hands PowerPoint a real
 * font with no Han glyphs and lets its own East Asian substitution table
 * choose the replacement, which need not be the family the page asked for.
 *
 * Returns null when the primary family already covers CJK (nothing to
 * split) or when the stack names no CJK-capable family at all — in the
 * latter case the browser itself resolved Han through an OS default
 * outside the declared stack, and inventing a typeface name here would be
 * a guess rather than a translation.
 */
export function resolveEastAsianFamily(fontFamily, supportsCjk = familySupportsCjk) {
  const stack = splitFontFamilyStack(fontFamily);
  if (stack.length < 2) return null;
  if (supportsCjk(stack[0])) return null;
  for (const family of stack.slice(1)) {
    if (supportsCjk(family)) return family;
  }
  return null;
}

/**
 * Which family will the browser ACTUALLY render with?
 *
 * Returns the first stack member that is present (installed or loaded via
 * @font-face), skipping generic keywords. Null when nothing in the stack
 * exists: the caller keeps the CSS-declared first family, which matches how
 * the browser itself resolves beyond the stack (through an OS default that
 * no name can honestly claim here).
 */
export function resolveRenderedFontFamily(fontFamily, isAvailable = familyIsAvailable) {
  for (const family of splitFontFamilyStack(fontFamily)) {
    if (CSS_GENERIC_FAMILIES.has(family.toLowerCase())) continue;
    if (isAvailable(family)) return family;
  }
  return null;
}

/**
 * Resolve a CSS font stack to the two typeface names the export writes:
 * the family that will actually render Latin, and (if the primary cannot
 * paint Han and an installed CJK family follows in the stack) the family
 * for PowerPoint's <a:ea> slot. getTextStyle writes these names and the
 * embed pipeline registers sources under them — one shared implementation
 * keeps the typeface attribute and <p:embeddedFont> in lockstep, which is
 * how PowerPoint matches an embedded face to a run.
 */
export function resolveStyleFontFamilies(fontFamily) {
  const stack = splitFontFamilyStack(fontFamily);
  const primaryFamily = resolveRenderedFontFamily(fontFamily) || stack[0] || '';
  const eastAsianFamily = resolveEastAsianFamily(
    fontFamily,
    (family) => familySupportsCjk(family) && familyIsAvailable(family)
  );
  return {
    primaryFamily,
    // A split into latin==ea is the same name twice, not a split; and an ea
    // name PowerPoint cannot find would just reintroduce viewer-side
    // substitution, so only a genuinely distinct installed family qualifies.
    eastAsianFamily: eastAsianFamily && eastAsianFamily !== primaryFamily ? eastAsianFamily : null,
  };
}

/**
 * Resolve a CSS `line-height` into PPTX exact line spacing (points).
 *
 * A unitless `line-height` inherits as a number, not as a length, so it
 * re-resolves against every element's own font-size. That makes this a
 * per-style value rather than one value per text frame.
 */
export function resolveLineSpacing(style, scale) {
  const lhStr = style.lineHeight;
  if (!lhStr || lhStr === 'normal') return null;

  let lhPx = parseFloat(lhStr);

  // Edge Case: If browser returns a raw multiplier (e.g. "1.5")
  // we must multiply by font size to get the height in pixels.
  // (Note: getComputedStyle usually returns 'px', but inline styles might differ)
  if (/^[0-9.]+$/.test(lhStr)) {
    lhPx = lhPx * parseFloat(style.fontSize);
  }

  if (isNaN(lhPx) || lhPx <= 0) return null;

  // Convert Pixel Height to Point Height (1px = 0.75pt)
  // And apply the global layout scale.
  return lhPx * 0.75 * scale;
}

/**
 * Give every run of a paragraph the paragraph's tallest line spacing.
 *
 * PptxGenJS emits one `<a:pPr>` per run and only one survives, so whichever
 * run happened to be kept dictated `<a:lnSpc>` for the whole paragraph. With
 * a unitless `line-height`, `1860<span style="font-size:32px">万</span>`
 * handed a 44pt number the unit span's 14.4pt exact line height, and viewers
 * lay exact spacing out from the line bottom, so the digits were pushed up
 * out of their frame. CSS sizes a line box from the tallest box on it, so the
 * maximum is both faithful and independent of which run wins.
 *
 * Paragraph boundaries are the parts carrying `breakLine` (the part ends its
 * paragraph), matching how PptxGenJS groups runs.
 */
export function unifyParagraphLineSpacing(parts) {
  if (!Array.isArray(parts)) return parts;

  let start = 0;
  const unify = (end) => {
    let tallest = 0;
    for (let i = start; i < end; i++) {
      const spacing = parts[i]?.options?.lineSpacing;
      if (typeof spacing === 'number' && spacing > tallest) tallest = spacing;
    }
    if (tallest > 0) {
      for (let i = start; i < end; i++) {
        if (parts[i]?.options) parts[i].options.lineSpacing = tallest;
      }
    }
    start = end;
  };

  parts.forEach((part, index) => {
    if (part?.options?.breakLine) unify(index + 1);
  });
  unify(parts.length);

  return parts;
}

export function getTextStyle(style, scale, includeMargins = true, inheritedOpacity = 1) {
  let colorObj = parseColor(style.color, style);
  let textGradient = null;

  // `background-clip: text` paints the visible colour through the element's
  // background and hides the fill either with a transparent `color` or with
  // `-webkit-text-fill-color`, which leaves `color` inherited and opaque.
  // DrawingML runs have no gradient fill, so flatten to the first colour stop;
  // the stop's own alpha must then replace the invisible original fill's.
  const bgClip = style.webkitBackgroundClip || style.backgroundClip;
  if (bgClip === 'text') {
    const textFillOpacity = style.webkitTextFillColor
      ? parseColor(style.webkitTextFillColor, style).opacity
      : 1;
    if (colorObj.opacity === 0 || textFillOpacity === 0) {
      // The knocked-out fill is painted by the clipped background: its first
      // gradient stop, or a solid colour when there is no gradient.
      for (const candidate of [getGradientFallbackColor(style.backgroundImage, style), style.backgroundColor]) {
        if (!candidate) continue;
        const fallback = parseColor(candidate, style);
        if (fallback.hex && fallback.opacity > 0) {
          colorObj = fallback;
          break;
        }
      }

      // Keep the existing first-stop solid fill as a safe fallback, but carry
      // the supported linear-gradient structure through the PptxGenJS run so
      // the normalizer can replace that fill with DrawingML gradFill later.
      textGradient = parseLinearGradientForText(style.backgroundImage, style);
    }
  }

  // Combine element and inherited opacity separately from the colour alpha:
  // a gradient applies this run opacity to every stop, whereas the solid
  // fallback below still needs the first stop's alpha included directly.
  let runOpacity = inheritedOpacity;
  const elOpacity = parseFloat(style.opacity);
  if (!isNaN(elOpacity)) {
    runOpacity *= elOpacity;
  }
  runOpacity = Math.max(0, Math.min(1, runOpacity));
  const opacity = colorObj.opacity * runOpacity;

  const fontSizePx = parseFloat(style.fontSize);
  const lineSpacing = resolveLineSpacing(style, scale);

  // --- Spacing (Margins) ---
  // Convert CSS margins (px) to PPTX Paragraph Spacing (pt).
  let paraSpaceBefore = 0;
  let paraSpaceAfter = 0;

  if (includeMargins) {
    const mt = parseFloat(style.marginTop) || 0;
    const mb = parseFloat(style.marginBottom) || 0;

    if (mt > 0) paraSpaceBefore = mt * 0.75 * scale;
    if (mb > 0) paraSpaceAfter = mb * 0.75 * scale;
  }

  const transparency = Math.round((1 - opacity) * 100);

  // Write the families that will actually render — PowerPoint can then find
  // (or embed) a font it knows, instead of substituting the missing first
  // stack entry with a face of its own choosing. Shared with the embed
  // pipeline so typeface attributes and <p:embeddedFont> names never drift.
  const { primaryFamily, eastAsianFamily } = resolveStyleFontFamilies(style.fontFamily);
  let fontFace = eastAsianFamily
    ? `${primaryFamily}${EA_TYPEFACE_MARKER}${eastAsianFamily}`
    : primaryFamily;
  if (textGradient) {
    const gradientMarker = buildTextGradientMarker(textGradient, runOpacity);
    // ST_TextFont accepts at most 255 characters. Leave headroom for the
    // existing char-spacing transport suffix appended by callers.
    if ((fontFace.length + gradientMarker.length) <= 250) {
      fontFace += gradientMarker;
    }
  }

  return {
    color: colorObj.hex || '000000',
    ...(transparency > 0 && { transparency }),
    fontFace,
    fontSize: fontSizePx * 0.75 * scale,
    bold: parseInt(style.fontWeight) >= 600,
    italic: style.fontStyle === 'italic',
    underline: style.textDecoration.includes('underline'),
    // Only add if we have a valid value
    ...(lineSpacing && { lineSpacing }),
    ...(paraSpaceBefore > 0 && { paraSpaceBefore }),
    ...(paraSpaceAfter > 0 && { paraSpaceAfter }),
    // Map background color to highlight if present; a text-clipped background
    // paints the glyphs themselves, never a band behind them.
    ...(bgClip !== 'text' && parseColor(style.backgroundColor, style).hex
      ? { highlight: parseColor(style.backgroundColor, style).hex }
      : {}),
    // Mapping letter-spacing to charSpacing
    ...(style.letterSpacing && style.letterSpacing !== 'normal'
      ? { charSpacing: parseFloat(style.letterSpacing) * 0.75 * scale }
      : {}),
  };
}

/**
 * Determines if a given DOM node is primarily a text container.
 * Updated to correctly reject Icon elements so they are rendered as images.
 */
export function isTextContainer(node) {
  const hasText = node.textContent.trim().length > 0;
  if (!hasText) return false;

  const children = Array.from(node.children);
  if (children.length === 0) return true;

  const isSafeInline = (el) => {
    const tag = (el?.tagName || '').toLowerCase();
    // 1. Reject Web Components / Custom Elements
    if (tag.includes('-')) return false;
    // 2. Reject Explicit Images/SVGs
    if (tag === 'img' || tag === 'svg') return false;

    if (tag === 'i' || tag === 'span') {
      const cls = el.getAttribute('class') || '';
      if (
        typeof cls === 'string' &&
        (cls.includes('fa-') ||
          cls.includes('fas') ||
          cls.includes('far') ||
          cls.includes('fab') ||
          cls.includes('material-icons') ||
          cls.includes('bi-') ||
          cls.includes('icon'))
      ) {
        // Double-check: Must have pseudo-element content to be a CSS icon
        const before = window.getComputedStyle(el, '::before').content;
        const after = window.getComputedStyle(el, '::after').content;
        const hasContent = (c) => c && c !== 'none' && c !== 'normal' && c !== '""';

        if (hasContent(before) || hasContent(after)) return false;
      }
    }

    const style = window.getComputedStyle(el);
    const display = style.display;

    // Reject block displays and flex/grid items
    const isBlockDisplay = display === 'block' || display === 'flex' || display === 'grid' || display === 'table';
    if (isBlockDisplay) return false;

    const parentStyle = el.parentElement ? window.getComputedStyle(el.parentElement) : null;
    const parentDisplay = parentStyle ? parentStyle.display : '';
    const isFlexOrGridItem = parentDisplay.includes('flex') || parentDisplay.includes('grid');
    if (isFlexOrGridItem) return false;

    // 4. Standard Inline Tag Check
    const isInlineTag = ['span', 'b', 'strong', 'em', 'i', 'a', 'small', 'mark'].includes(el.tagName.toLowerCase());
    const isInlineDisplay = display.includes('inline');

    if (!isInlineTag && !isInlineDisplay) return false;

    // 5. Structural Styling Check
    // If a child has a background or border, it's a layout block, not a simple text span.
    const bgColor = parseColor(style.backgroundColor, style);
    const hasVisibleBg = bgColor.hex && bgColor.opacity > 0;
    const hasBorder = parseFloat(style.borderWidth) > 0 && parseColor(style.borderColor, style).opacity > 0;

    if (hasVisibleBg || hasBorder) {
      // Relaxed check: Allow inline elements with background/border to be treated as text.
      // They will be rendered as highlighted text runs (no border support in text runs though).
      // This preserves text flow for "badges".
      // return false;
    }

    // 4. Check for empty shapes (visual objects without text, like dots)
    const hasContent = el.textContent.trim().length > 0;
    if (!hasContent && (hasVisibleBg || hasBorder)) {
      return false;
    }

    return true;
  };

  return children.every(isSafeInline);
}

export function getRotation(transformStr) {
  const transform = String(transformStr || '').trim().toLowerCase();
  if (!transform || transform === 'none') return 0;

  // Browsers normally expose a computed `matrix(...)`, but accepting the
  // author-facing syntax as well keeps this utility correct in lightweight
  // DOM implementations and in hosts that defer style normalization.
  const directRotation = transform.match(/(?:^|\s)rotate(?:z)?\(\s*([-+.\d]+)deg\s*\)/);
  if (directRotation) return Math.round(parseFloat(directRotation[1]) || 0);

  const matrix = transform.match(/^matrix\(\s*([^)]*)\)$/);
  const matrix3d = transform.match(/^matrix3d\(\s*([^)]*)\)$/);
  const values = (matrix?.[1] || matrix3d?.[1] || '')
    .split(',')
    .map((value) => parseFloat(value.trim()));
  if (values.length < (matrix3d ? 16 : 4) || values.some((value) => !Number.isFinite(value))) return 0;

  // In CSS's column-major matrix3d representation m11/m12 carry the same
  // Z-axis rotation components as a/b in a 2D matrix.
  const a = values[0];
  const b = values[1];
  return Math.round(Math.atan2(b, a) * (180 / Math.PI));
}

export function getWritingModeVert(writingMode, textOrientation) {
  const isUpright = textOrientation === 'upright';

  switch (writingMode) {
    case 'vertical-rl':
      return isUpright ? 'wordArtVertRtl' : 'eaVert';
    case 'vertical-lr':
      return isUpright ? 'wordArtVert' : 'mongolianVert';
    case 'sideways-rl':
      return 'vert';
    case 'sideways-lr':
      return 'vert270';
    default:
      return null;
  }
}

export function mapVertToTextDirection(vertVal) {
  if (!vertVal) return null;
  if (vertVal === 'eaVert' || vertVal === 'mongolianVert') return 'vert';
  if (vertVal === 'wordArtVertRtl') return 'wordArtVert';
  if (['vert', 'vert270', 'wordArtVert', 'horz'].includes(vertVal)) return vertVal;
  return null;
}

// CSS layout properties have no meaning for a standalone SVG document, but if
// they survive on the serialized root (e.g. `position:absolute; left:220px`),
// SVG-as-image renderers offset the root out of the image viewport and the
// rasterized result is a fully transparent PNG (element silently dropped).
const SVG_ROOT_LAYOUT_PROP = /^(position|left|right|top|bottom|z-index|float|clear|display|margin(-\w+)?|inset(-\w+)?)$/i;

function stripRootLayoutStyles(el) {
  for (let i = el.style.length - 1; i >= 0; i--) {
    const prop = el.style[i];
    if (prop && SVG_ROOT_LAYOUT_PROP.test(prop)) el.style.removeProperty(prop);
  }
}

function parseComputedRgbColor(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized === 'transparent' || normalized.includes('%')) return null;
  const matches = normalized.match(/[-+]?(?:\d+\.?\d*|\.\d+)/g);
  if (!matches || matches.length < 3) return null;
  const channels = matches.slice(0, 3).map(Number);
  const opacity = matches.length > 3 ? Number(matches[3]) : 1;
  if (
    channels.some((channel) => !Number.isFinite(channel) || channel < 0 || channel > 255) ||
    !Number.isFinite(opacity) || opacity <= 0 || opacity > 1
  ) return null;
  const hex = channels
    .map((channel) => Math.round(channel).toString(16).padStart(2, '0'))
    .join('');
  return { hex, opacity };
}

function parseSimpleSvgRootColor(value) {
  const normalized = String(value || '').trim();
  const hexMatch = normalized.match(/^#([\da-f]{3,8})$/i);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3 || hex.length === 4) hex = hex.split('').map((digit) => digit + digit).join('');
    if (hex.length !== 6 && hex.length !== 8) return null;
    const opacity = hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1;
    return { hex: hex.slice(0, 6).toLowerCase(), opacity };
  }
  return parseComputedRgbColor(normalized);
}

function readInlineSvgRootStyle(source, property) {
  const styleAttribute = String(source?.getAttribute?.('style') || '');
  return styleAttribute.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, 'i'))?.[1]?.trim() || '';
}

function parseSimpleInlineSvgBorder(source) {
  const raw = readInlineSvgRootStyle(source, 'border');
  const match = raw.match(/^(\d*\.?\d+)px\s+solid\s+(.+)$/i);
  if (!match) return null;
  const color = parseSimpleSvgRootColor(match[2]);
  return color ? { width: Number(match[1]), style: 'solid', color } : null;
}

function getSvgViewBox(node, fallbackWidth, fallbackHeight) {
  const values = String(node.getAttribute('viewBox') || '')
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (values.length === 4 && values.every(Number.isFinite) && values[2] > 0 && values[3] > 0) {
    return { x: values[0], y: values[1], width: values[2], height: values[3] };
  }
  return { x: 0, y: 0, width: fallbackWidth, height: fallbackHeight };
}

function getUniformSvgRootRadius(style, source) {
  const styleAttribute = String(source?.getAttribute?.('style') || '');
  const authorShorthand = String(
    source?.style?.borderRadius || styleAttribute.match(/(?:^|;)\s*border-radius\s*:\s*([^;]+)/i)?.[1] || ''
  ).trim();
  if (authorShorthand) {
    if (authorShorthand.includes('/')) return null;
    const tokens = authorShorthand.split(/\s+/);
    let expanded;
    if (tokens.length === 1) expanded = [tokens[0], tokens[0], tokens[0], tokens[0]];
    else if (tokens.length === 2) expanded = [tokens[0], tokens[1], tokens[0], tokens[1]];
    else if (tokens.length === 3) expanded = [tokens[0], tokens[1], tokens[2], tokens[1]];
    else if (tokens.length === 4) expanded = tokens;
    else return null;
    if (expanded.some((radius) => radius.includes('%'))) return null;
    const parsed = expanded.map((radius) => parseFloat(radius));
    if (parsed.some((radius) => !Number.isFinite(radius))) return null;
    return parsed.every((radius) => Math.abs(radius - parsed[0]) < 0.01) ? parsed[0] : null;
  }

  const values = [
    style.borderTopLeftRadius,
    style.borderTopRightRadius,
    style.borderBottomRightRadius,
    style.borderBottomLeftRadius,
  ];
  let radiusValues = values;
  // Some lightweight DOMs expose only the border-radius shorthand. Browsers
  // normally expand the corners, but accepting the one-value shorthand also
  // matches CSS's unambiguous "same radius on all corners" form.
  if (values.some((radius) => !String(radius || '').trim())) {
    const shorthand = String(style.borderRadius || '').trim();
    if (!shorthand) return 0;
    if (shorthand.includes('/')) return null;
    const tokens = shorthand.split(/\s+/);
    if (tokens.length === 1) radiusValues = [tokens[0], tokens[0], tokens[0], tokens[0]];
    else if (tokens.length === 2) radiusValues = [tokens[0], tokens[1], tokens[0], tokens[1]];
    else if (tokens.length === 3) radiusValues = [tokens[0], tokens[1], tokens[2], tokens[1]];
    else if (tokens.length === 4) radiusValues = tokens;
    else return null;
  }
  if (radiusValues.some((radius) => String(radius || '').includes('%'))) return null;
  const parsed = radiusValues.map((radius) => parseFloat(radius) || 0);
  return parsed.every((radius) => Math.abs(radius - parsed[0]) < 0.01) ? parsed[0] : null;
}

/**
 * CSS backgrounds and borders on an inline <svg> root disappear once the SVG
 * is serialized as a standalone image: ancestor CSS variables are unavailable
 * and SVG root CSS does not reliably paint a border. Materialize only the
 * small, lossless subset as a first child SVG rect. Everything complex is left
 * unchanged rather than approximated.
 */
function materializeSimpleSvgRootBox(source, target, fallbackWidth, fallbackHeight) {
  const style = window.getComputedStyle(source);
  const radius = getUniformSvgRootRadius(style, source);
  if (String(style.backgroundImage || 'none') !== 'none' || radius === null) return;

  const background =
    parseSimpleSvgRootColor(style.backgroundColor) ||
    parseSimpleSvgRootColor(readInlineSvgRootStyle(source, 'background-color')) ||
    parseSimpleSvgRootColor(readInlineSvgRootStyle(source, 'background'));
  const inlineBorder = parseSimpleInlineSvgBorder(source);
  const sideNames = ['Top', 'Right', 'Bottom', 'Left'];
  const borders = sideNames.map((side) => ({
    width: parseFloat(style[`border${side}Width`]) || inlineBorder?.width || 0,
    style: String(style[`border${side}Style`] || inlineBorder?.style || '').toLowerCase(),
    color: parseSimpleSvgRootColor(style[`border${side}Color`]) || inlineBorder?.color || null,
  }));
  const hasBorder = borders.some((border) => border.width > 0);
  if (!background && !hasBorder) return;

  let border = null;
  if (hasBorder) {
    const first = borders[0];
    const uniform = borders.every((candidate) => (
      candidate.width > 0 &&
      Math.abs(candidate.width - first.width) < 0.01 &&
      candidate.style === 'solid' &&
      candidate.color &&
      first.color &&
      candidate.color.hex === first.color.hex &&
      Math.abs(candidate.color.opacity - first.color.opacity) < 0.001
    ));
    if (!uniform) return;
    border = first;
  }

  const viewBox = getSvgViewBox(source, fallbackWidth, fallbackHeight);
  const cssWidth = parseFloat(style.width) || fallbackWidth;
  const cssHeight = parseFloat(style.height) || fallbackHeight;
  const scaleX = viewBox.width / cssWidth;
  const scaleY = viewBox.height / cssHeight;
  // A single SVG stroke/radius cannot faithfully model CSS under non-uniform
  // scaling. Preserve the old output in that rare case.
  if (!Number.isFinite(scaleX) || !Number.isFinite(scaleY) || Math.abs(scaleX - scaleY) > 0.001) return;
  let strokeWidth = 0;
  if (border) {
    strokeWidth = border.width * scaleX;
  }

  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  const inset = strokeWidth / 2;
  rect.setAttribute('x', String(viewBox.x + inset));
  rect.setAttribute('y', String(viewBox.y + inset));
  rect.setAttribute('width', String(Math.max(0, viewBox.width - strokeWidth)));
  rect.setAttribute('height', String(Math.max(0, viewBox.height - strokeWidth)));
  if (radius > 0) {
    const scaledRadius = radius * scaleX;
    rect.setAttribute('rx', String(scaledRadius));
    rect.setAttribute('ry', String(scaledRadius));
  }
  if (background) {
    rect.setAttribute('fill', `#${background.hex}`);
    if (background.opacity < 1) rect.setAttribute('fill-opacity', String(background.opacity));
  } else {
    rect.setAttribute('fill', 'none');
  }
  if (border) {
    rect.setAttribute('stroke', `#${border.color.hex}`);
    rect.setAttribute('stroke-width', String(strokeWidth));
    if (border.color.opacity < 1) rect.setAttribute('stroke-opacity', String(border.color.opacity));
  }
  rect.setAttribute('data-dom-to-pptx-root-box', 'true');

  const firstPaintedChild = Array.from(target.children).find((child) => ![
    'defs', 'style', 'title', 'desc', 'metadata',
  ].includes(child.nodeName.toLowerCase()));
  target.insertBefore(rect, firstPaintedChild || null);

  // The clone no longer has its ancestor CSS variables. Remove the CSS source
  // that we just materialized so a literal root style cannot paint a second,
  // differently sized border in the standalone SVG.
  if (background) {
    target.style.removeProperty('background');
    target.style.removeProperty('background-color');
  }
  if (border) {
    ['border', 'border-top', 'border-right', 'border-bottom', 'border-left'].forEach((property) => {
      target.style.removeProperty(property);
    });
  }
}

/**
 * Converts an SVG node to a PNG data URL (rasterized)
 */
export function svgToPng(node) {
  return new Promise((resolve) => {
    const clone = node.cloneNode(true);
    const rect = node.getBoundingClientRect();
    const width = rect.width || 300;
    const height = rect.height || 150;

    inlineSvgStyles(node, clone);
    stripRootLayoutStyles(clone);
    clone.setAttribute('width', width);
    clone.setAttribute('height', height);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    materializeSimpleSvgRootBox(node, clone, width, height);

    const xml = new XMLSerializer().serializeToString(clone);
    const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
    const img = new Image();
    img.crossOrigin = 'Anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const scale = 3;
      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = () => resolve(null);
    img.src = svgUrl;
  });
}

/**
 * Converts an SVG node to an SVG data URL (preserves vector format)
 * This allows "Convert to Shape" in PowerPoint
 */
export function svgToSvg(node) {
  return new Promise((resolve) => {
    try {
      const clone = node.cloneNode(true);
      const rect = node.getBoundingClientRect();
      const width = rect.width || 300;
      const height = rect.height || 150;

      inlineSvgStyles(node, clone);
      stripRootLayoutStyles(clone);
      clone.setAttribute('width', width);
      clone.setAttribute('height', height);
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      materializeSimpleSvgRootBox(node, clone, width, height);

      // Ensure xmlns:xlink is present for any xlink:href attributes
      if (clone.querySelector('[*|href]') || clone.innerHTML.includes('xlink:')) {
        clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
      }

      const xml = new XMLSerializer().serializeToString(clone);
      // Use base64 encoding for better compatibility with PowerPoint
      const svgUrl = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(xml)))}`;
      resolve(svgUrl);
    } catch (e) {
      console.warn('SVG serialization failed:', e);
      resolve(null);
    }
  });
}

/**
 * Helper to inline computed styles into an SVG clone
 */
function inlineSvgStyles(source, target) {
  const computed = window.getComputedStyle(source);
  const properties = [
    'fill',
    'stroke',
    'stroke-width',
    'stroke-linecap',
    'stroke-linejoin',
    'opacity',
    'font-family',
    'font-size',
    'font-weight',
  ];

  if (computed.fill === 'none') target.setAttribute('fill', 'none');
  else if (computed.fill) target.style.fill = computed.fill;

  if (computed.stroke === 'none') target.setAttribute('stroke', 'none');
  else if (computed.stroke) target.style.stroke = computed.stroke;

  properties.forEach((prop) => {
    if (prop !== 'fill' && prop !== 'stroke') {
      const val = computed[prop];
      if (val && val !== 'auto') target.style[prop] = val;
    }
  });

  for (let i = 0; i < source.children.length; i++) {
    if (target.children[i]) inlineSvgStyles(source.children[i], target.children[i]);
  }
}

export function getVisibleShadow(shadowStr, scale) {
  if (!shadowStr || shadowStr === 'none') return null;
  const shadows = shadowStr.split(/,(?![^()]*\))/);
  for (let s of shadows) {
    s = s.trim();
    if (s.startsWith('rgba(0, 0, 0, 0)')) continue;
    const match = s.match(/(rgba?\([^)]+\)|#[0-9a-fA-F]+)\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+([\d.]+)px/);
    if (match) {
      const colorStr = match[1];
      const x = parseFloat(match[2]);
      const y = parseFloat(match[3]);
      const blur = parseFloat(match[4]);
      const distance = Math.sqrt(x * x + y * y);
      let angle = Math.atan2(y, x) * (180 / Math.PI);
      if (angle < 0) angle += 360;
      const colorObj = parseColor(colorStr);
      return {
        type: 'outer',
        angle: angle,
        blur: blur * 0.75 * scale,
        offset: distance * 0.75 * scale,
        color: colorObj.hex || '000000',
        opacity: colorObj.opacity,
      };
    }
  }
  return null;
}

/**
 * Generates an SVG image for gradients, supporting degrees and keywords.
 */
export function generateGradientSVG(w, h, bgString, radius, border) {
  try {
    const match = bgString.match(/(linear|radial)-gradient\((.*)\)/i);
    if (!match) return null;
    const gradientType = match[1].toLowerCase();
    const content = match[2];

    // Split by comma, ignoring commas inside parentheses (e.g. rgba())
    const parts = content.split(/,(?![^()]*\))/).map((p) => p.trim());
    if (parts.length < 2) return null;

    let x1 = '0%',
      y1 = '0%',
      x2 = '0%',
      y2 = '100%';
    let stopsStartIndex = 0;
    const firstPart = parts[0].toLowerCase();
    let radialShape = 'ellipse';
    let radialX = 50;
    let radialY = 50;

    if (gradientType === 'radial') {
      const radialPrelude = /^(?:(circle|ellipse)\s*)?(?:at\s+(.+))?$/i.exec(firstPart);
      const looksLikePrelude = /^(?:circle|ellipse|at\s)/i.test(firstPart);
      if (looksLikePrelude && radialPrelude) {
        stopsStartIndex = 1;
        radialShape = (radialPrelude[1] || 'ellipse').toLowerCase();
        const position = (radialPrelude[2] || '50% 50%').trim().toLowerCase().split(/\s+/);
        const resolvePosition = (value, axis) => {
          const keywordMap = axis === 'x'
            ? { left: 0, center: 50, right: 100 }
            : { top: 0, center: 50, bottom: 100 };
          if (value in keywordMap) return keywordMap[value];
          const numeric = /^(-?[\d.]+)%$/.exec(value);
          return numeric ? Math.max(0, Math.min(100, Number(numeric[1]))) : 50;
        };
        if (position.length === 1) {
          if (position[0] === 'top' || position[0] === 'bottom') radialY = resolvePosition(position[0], 'y');
          else radialX = resolvePosition(position[0], 'x');
        } else {
          radialX = resolvePosition(position[0], 'x');
          radialY = resolvePosition(position[1], 'y');
        }
      }
    }

    // 1. Check for Keywords (to right, etc.)
    if (gradientType === 'linear' && firstPart.startsWith('to ')) {
      stopsStartIndex = 1;
      const direction = firstPart.replace('to ', '').trim();
      switch (direction) {
        case 'top':
          y1 = '100%';
          y2 = '0%';
          break;
        case 'bottom':
          y1 = '0%';
          y2 = '100%';
          break;
        case 'left':
          x1 = '100%';
          x2 = '0%';
          break;
        case 'right':
          x2 = '100%';
          break;
        case 'top right':
          x1 = '0%';
          y1 = '100%';
          x2 = '100%';
          y2 = '0%';
          break;
        case 'top left':
          x1 = '100%';
          y1 = '100%';
          x2 = '0%';
          y2 = '0%';
          break;
        case 'bottom right':
          x2 = '100%';
          y2 = '100%';
          break;
        case 'bottom left':
          x1 = '100%';
          y2 = '100%';
          break;
      }
    }
    // 2. Check for Degrees (45deg, 90deg, etc.)
    else if (gradientType === 'linear' && firstPart.match(/^[-+]?[\d.]+(deg|rad|turn|grad)$/)) {
      stopsStartIndex = 1;
      const cssAngleDeg = parseCssLinearGradientAngle(firstPart);
      const endpoints = cssAngleDeg === null ? null : getCssLinearGradientEndpoints(w, h, cssAngleDeg);
      if (!endpoints) return null;
      ({ x1, y1, x2, y2 } = endpoints);
    }

    // 3. Process Color Stops
    let stopsXML = '';
    const stopParts = parts.slice(stopsStartIndex);
    if (stopParts.length < 2) return null;

    stopParts.forEach((part, idx) => {
      // Parse "Color Position" (e.g., "red 50%")
      // Regex looks for optional space + number + unit at the end of the string
      let color = part;
      let offset = Math.round((idx / (stopParts.length - 1)) * 100) + '%';

      const posMatch = part.match(/^(.*?)\s+(-?[\d.]+(?:%|px)?)$/);
      if (posMatch) {
        color = posMatch[1];
        offset = posMatch[2];
      }

      // Handle RGBA/RGB for SVG compatibility
      let opacity = 1;
      if (color.includes('rgba')) {
        const rgbaMatch = color.match(/[\d.]+/g);
        if (rgbaMatch && rgbaMatch.length >= 4) {
          opacity = rgbaMatch[3];
          color = `rgb(${rgbaMatch[0]},${rgbaMatch[1]},${rgbaMatch[2]})`;
        }
      }

      stopsXML += `<stop offset="${offset}" stop-color="${color.trim()}" stop-opacity="${opacity}"/>`;
    });

    let strokeAttr = '';
    if (border && border.color && border.width > 0) {
      // The stroke is centered on the box edge; its outer half falls outside the
      // image bounds. Doubling the width leaves a visible band equal to the CSS
      // border.
      strokeAttr = `stroke="#${border.color}" stroke-width="${border.width * 2}"`;
    }

    let tl = 0,
      tr = 0,
      br = 0,
      bl = 0;
    if (typeof radius === 'object' && radius !== null) {
      tl = radius.tl || 0;
      tr = radius.tr || 0;
      br = radius.br || 0;
      bl = radius.bl || 0;
    } else {
      tl = tr = br = bl = radius || 0;
    }

    const factor = Math.min(
      w / (tl + tr) || Infinity,
      h / (tr + br) || Infinity,
      w / (br + bl) || Infinity,
      h / (bl + tl) || Infinity
    );

    if (factor < 1) {
      tl *= factor;
      tr *= factor;
      br *= factor;
      bl *= factor;
    }

    // Generate absolute path based on radius bounds
    const pathD = `M ${tl} 0 L ${w - tr} 0 A ${tr} ${tr} 0 0 1 ${w} ${tr} L ${w} ${h - br} A ${br} ${br} 0 0 1 ${w - br} ${h} L ${bl} ${h} A ${bl} ${bl} 0 0 1 0 ${h - bl} L 0 ${tl} A ${tl} ${tl} 0 0 1 ${tl} 0 Z`;

    const gradientDefinition = gradientType === 'radial'
      ? (() => {
          const cx = (w * radialX) / 100;
          const cy = (h * radialY) / 100;
          const rx = radialShape === 'circle'
            ? Math.max(w, h) / 2
            : Math.max(cx, w - cx);
          const ry = radialShape === 'circle'
            ? rx
            : Math.max(cy, h - cy);
          return `<radialGradient id="grad" gradientUnits="userSpaceOnUse" cx="0" cy="0" r="1" gradientTransform="translate(${cx} ${cy}) scale(${rx} ${ry})">${stopsXML}</radialGradient>`;
        })()
      : `<linearGradient id="grad" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}">${stopsXML}</linearGradient>`;

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
          <defs>
            ${gradientDefinition}
          </defs>
          <path d="${pathD}" fill="url(#grad)" ${strokeAttr} />
      </svg>`;

    return 'data:image/svg+xml;base64,' + btoa(svg.trim());
  } catch (e) {
    console.warn('Gradient generation failed:', e);
    return null;
  }
}

export function generateBlurredSVG(w, h, color, radius, blurPx) {
  const padding = blurPx * 3;
  const fullW = w + padding * 2;
  const fullH = h + padding * 2;
  const x = padding;
  const y = padding;
  let shapeTag;
  const isCircle = radius >= Math.min(w, h) / 2 - 1 && Math.abs(w - h) < 2;

  if (isCircle) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    const rx = w / 2;
    const ry = h / 2;
    shapeTag = `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="#${color}" filter="url(#f1)" />`;
  } else {
    shapeTag = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" ry="${radius}" fill="#${color}" filter="url(#f1)" />`;
  }

  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="${fullW}" height="${fullH}" viewBox="0 0 ${fullW} ${fullH}">
    <defs>
      <filter id="f1" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="${blurPx}" />
      </filter>
    </defs>
    ${shapeTag}
  </svg>`;

  return {
    data: 'data:image/svg+xml;base64,' + btoa(svg.trim()),
    padding: padding,
  };
}

// src/utils.js

// ... (keep all existing exports) ...

/**
 * Split a CSS font-family stack into its individual family names, stripped
 * of quotes and surrounding whitespace. Generic families (`serif`,
 * `sans-serif`, ...) stay in the list: they never match an @font-face
 * declaration, so they cost one Set entry and no lookup.
 *
 * Exported so both font discovery and East Asian slot resolution read the
 * stack the same way.
 */
export function splitFontFamilyStack(fontFamily) {
  if (!fontFamily) return [];
  return String(fontFamily)
    .split(',')
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, '').trim())
    .filter(Boolean);
}

/**
 * Traverses the target DOM and collects all unique font-family names used.
 *
 * Collects the *whole* stack per element, not just the primary family. A
 * stack like `"PingFang SC", "Microsoft YaHei", "Playfair Display", serif`
 * puts a system CJK font first and the web font that actually needs
 * embedding third; taking only the primary family silently dropped it from
 * the embed list. Only families with a matching @font-face declaration are
 * ever embedded, so widening discovery cannot pull in a system font.
 */
export function getUsedFontFamilies(root) {
  const families = new Set();

  function scan(node) {
    if (node.nodeType === 1) {
      // Element
      const style = window.getComputedStyle(node);
      for (const family of splitFontFamilyStack(style.fontFamily)) {
        families.add(family);
      }
    }
    for (const child of node.childNodes) {
      scan(child);
    }
  }

  // Handle array of roots or single root
  const elements = Array.isArray(root) ? root : [root];
  elements.forEach((el) => {
    const node = typeof el === 'string' ? document.querySelector(el) : el;
    if (node) scan(node);
  });

  return families;
}

/**
 * Collect, per resolved typeface name, the code points the deck actually
 * renders with it.
 *
 * Unlike getUsedFontFamilies (which gathers raw CSS stacks to match against
 * @font-face rules), this walks the text nodes through the exact same
 * resolveStyleFontFamilies that getTextStyle uses to write the typeface
 * attributes — so the names registered as embeddable sources here are
 * character-for-character the names PowerPoint will look up in
 * <p:embeddedFontLst>, and the code point sets let the host subset each
 * system font to what this deck needs instead of shipping it whole.
 *
 * @returns {Map<string, Set<number>>} family name -> rendered code points
 */
export function collectRenderedFonts(root) {
  const usage = new Map();

  const record = (family, text) => {
    if (!family) return;
    let codepoints = usage.get(family);
    if (!codepoints) {
      codepoints = new Set();
      usage.set(family, codepoints);
    }
    // Iterating a string yields code points, not UTF-16 units, so astral
    // characters (emoji, rare Han) are recorded correctly.
    for (const ch of text) codepoints.add(ch.codePointAt(0));
  };

  function scan(node) {
    if (node.nodeType === 3) {
      // Text: only rendered text constrains which fonts are needed.
      // (display:none also covers <style>/<script>/<template> content,
      // whose text nodes exist in the DOM but never paint.)
      if (node.nodeValue && node.nodeValue.trim()) {
        const parent = node.parentElement;
        if (parent) {
          const style = window.getComputedStyle(parent);
          if (style.display !== 'none') {
            const { primaryFamily, eastAsianFamily } =
              resolveStyleFontFamilies(style.fontFamily);
            record(primaryFamily, node.nodeValue);
            record(eastAsianFamily, node.nodeValue);
          }
        }
      }
      return;
    }
    for (const child of node.childNodes) scan(child);
  }

  const elements = Array.isArray(root) ? root : [root];
  elements.forEach((el) => {
    const node = typeof el === 'string' ? document.querySelector(el) : el;
    if (node) scan(node);
  });

  return usage;
}

// Helper to extract a clean URL from a CSS `src` string. Exported so
// getFontsFromStyleSheets can be unit-tested against synthetic CSSOM.
function extractFontUrl(srcStr) {
  // Look for url("..."), url('...'), or url(...).
  // Prefer woff/ttf/otf; fall back to whatever is available.
  const matches = srcStr.match(/url\((['"]?)(.*?)\1\)/g);
  if (!matches) return null;

  let chosenUrl = null;
  for (const match of matches) {
    const urlRaw = match.replace(/url\((['"]?)(.*?)\1\)/, '$2');
    // Skip data URIs for now (unless we want to support base64 embedding).
    if (urlRaw.startsWith('data:')) continue;

    if (urlRaw.includes('.ttf') || urlRaw.includes('.otf') || urlRaw.includes('.woff')) {
      chosenUrl = urlRaw;
      break;
    }
    if (!chosenUrl) chosenUrl = urlRaw;
  }
  return chosenUrl;
}

/**
 * Extract PowerPoint speaker-notes text from a slide root element.
 *
 * DOM convention: any descendant of the slide root carrying a
 * `data-pptx-notes` attribute contributes its text content to the
 * slide's speaker-notes pane. Elements without the attribute are
 * ignored; elements with the attribute but no text content are ignored
 * (so a stray empty `<template data-pptx-notes>` is harmless).
 *
 * Multiple annotated elements concatenate in document order, separated
 * by a blank line.
 *
 * Three usage patterns work interchangeably:
 *
 *   <template data-pptx-notes>
 *     Speaker notes here. `<template>` content is inert in the DOM so
 *     the notes never render on-slide.
 *   </template>
 *
 *   <div data-pptx-notes hidden>
 *     Also fine. `hidden` keeps the div off-slide visually.
 *   </div>
 *
 *   <p data-pptx-notes style="display: none">
 *     Any element, hidden however you prefer.
 *   </p>
 *
 * If the annotated element is visible (no `hidden`, no CSS `display:
 * none`), its text will appear both on the slide and in the notes pane.
 * That is user error, not a defect of this extractor.
 *
 * @param {Element} root
 * @returns {string} Notes text, trimmed. Empty string if no notes.
 */
export function extractSpeakerNotesFromElement(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return '';
  const nodes = root.querySelectorAll('[data-pptx-notes]');
  const parts = [];
  for (const node of Array.from(nodes)) {
    // <template> stores its markup in a DocumentFragment on `.content`;
    // its own `.textContent` is empty. Fall back to `.textContent` for
    // every other element type.
    const isTemplate = (node?.tagName || '').toLowerCase() === 'template';
    const raw = isTemplate && node.content ? node.content.textContent : node.textContent;
    if (!raw) continue;
    const trimmed = raw.trim();
    if (trimmed) parts.push(trimmed);
  }
  return parts.join('\n\n');
}

/**
 * Scans document.styleSheets to find @font-face URLs for the requested families.
 * Returns an array of { name, url } objects.
 * Walk a list of CSSStyleSheet-like objects and collect @font-face
 * declarations whose family matches usedFamilies.
 *
 * Recurses into @import rules so that a `theme.css` containing
 * `@import url('./fonts.css');` still surfaces the @font-face
 * declarations inside `fonts.css`. Without this, a common CSS
 * organisation (imports for shared type stacks) silently produces an
 * empty embedded-font list.
 *
 * Extracted from getAutoDetectedFonts so it can be exercised in unit
 * tests without depending on document.styleSheets.
 *
 * Deduplication is keyed by (family, PowerPoint slot, url) rather than by
 * url alone. Google Fonts serves one variable-font file for several
 * weights of the same family, so `Caveat` at weight 600 and weight 700
 * share a URL. Global url dedup let whichever declaration came first claim
 * that file and dropped the rest, which is how a family could end up with
 * a `bold` slot and no `regular` slot at all — every non-bold run in that
 * family then fell back to a viewer substitute.
 *
 * @param {Set<string>} usedFamilies
 * @param {ArrayLike<CSSStyleSheet>} styleSheets
 * @returns {Array<{name: string, url: string, weight: string, style: string}>}
 */
export function getFontsFromStyleSheets(usedFamilies, styleSheets) {
  const foundFonts = [];
  const processedSlotUrls = new Set();
  const visitedSheets = new Set(); // Guard against cyclic @import graphs.

  const walk = (sheet) => {
    if (!sheet || visitedSheets.has(sheet)) return;
    visitedSheets.add(sheet);

    let rules;
    try {
      rules = sheet.cssRules || sheet.rules;
    } catch (e) {
      // SecurityError is common for cross-origin sheets (Google Fonts etc.);
      // we cannot scan those via CSSOM.
      console.warn('Cannot scan stylesheet for fonts (CORS restriction):', sheet.href, e && e.message);
      return;
    }
    if (!rules) return;

    for (const rule of Array.from(rules)) {
      // CSSImportRule (type === 3): recurse into the imported sheet so
      // that `@import url('./fonts.css')` in a top-level stylesheet
      // still surfaces its @font-face rules.
      if (rule.constructor.name === 'CSSImportRule' || rule.type === 3) {
        walk(rule.styleSheet);
        continue;
      }

      if (rule.constructor.name === 'CSSFontFaceRule' || rule.type === 5) {
        const familyName = rule.style.getPropertyValue('font-family').replace(/['"]/g, '').trim();

        if (!usedFamilies.has(familyName)) continue;

        const src = rule.style.getPropertyValue('src');
        const url = extractFontUrl(src);
        if (!url) continue;

        // Preserve font-weight and font-style so downstream grouping can
        // classify each @font-face declaration into one of PowerPoint's
        // four embedded-font slots (regular / bold / italic / boldItalic).
        const weight = rule.style.getPropertyValue('font-weight').trim() || '400';
        const fontStyle = (rule.style.getPropertyValue('font-style').trim() || 'normal').toLowerCase();
        const slotKey = `${familyName} ${classifyFontVariant(weight, fontStyle)} ${url}`;

        if (!processedSlotUrls.has(slotKey)) {
          processedSlotUrls.add(slotKey);
          foundFonts.push({ name: familyName, url: url, weight: weight, style: fontStyle });
        }
      }
    }
  };

  for (const sheet of Array.from(styleSheets)) {
    walk(sheet);
  }

  return foundFonts;
}

/**
 * Scans document.styleSheets to find @font-face URLs for the requested
 * families. Returns an array of { name, url, weight, style } objects.
 *
 * Thin wrapper around getFontsFromStyleSheets that reads the ambient
 * document.styleSheets. Kept async for backward compatibility with the
 * previous signature, though the body is now synchronous.
 */
export async function getAutoDetectedFonts(usedFamilies) {
  return getFontsFromStyleSheets(usedFamilies, document.styleSheets);
}

/**
 * Map a CSS font-weight / font-style pair into one of the four slots
 * that PowerPoint's embedded-font list supports: regular, bold, italic,
 * boldItalic. Anything at weight >= 600 counts as bold; italic/oblique
 * counts as italic.
 *
 * Exported so callers can classify a family's variants ahead of grouping,
 * and so the classification is unit-testable.
 */
export function classifyFontVariant(weight, style) {
  const wRaw = String(weight || '400').toLowerCase().trim();
  let w = parseInt(wRaw, 10);
  if (isNaN(w)) {
    if (wRaw === 'bold' || wRaw === 'bolder') w = 700;
    else if (wRaw === 'lighter') w = 300;
    else w = 400;
  }
  const isBold = w >= 600;
  const sRaw = String(style || 'normal').toLowerCase();
  const isItalic = sRaw === 'italic' || sRaw === 'oblique';
  if (isBold && isItalic) return 'boldItalic';
  if (isBold) return 'bold';
  if (isItalic) return 'italic';
  return 'regular';
}

/**
 * Detect when multiple @font-face declarations for the same family map
 * into the same PowerPoint slot with materially different weights.
 *
 * PowerPoint's embedded-font model only exposes four slots per family
 * (regular / bold / italic / boldItalic). CSS weight 700 (Bold) and
 * weight 900 (Black) both classify as `bold`; the second one silently
 * loses glyphs during embed. This is a real workflow surprise for anyone
 * declaring `font-family: 'Inter'; font-weight: 900` alongside 700.
 *
 * Returns an array of { family, variant, weights } collision descriptors
 * so callers can emit an actionable warning.
 *
 * @param {Array<{name: string, weight?: string|number, style?: string}>} fontEntries
 */
export function detectVariantSlotCollisions(fontEntries) {
  const seen = new Map(); // key = "family::variant" -> Set of weight strings
  for (const f of fontEntries) {
    const variant = classifyFontVariant(f.weight, f.style);
    const key = f.name + '::' + variant;
    if (!seen.has(key)) seen.set(key, new Set());
    seen.get(key).add(String(f.weight ?? '400').trim());
  }
  const collisions = [];
  for (const [key, weights] of seen) {
    if (weights.size < 2) continue;
    const [family, variant] = key.split('::');
    collisions.push({ family, variant, weights: Array.from(weights).sort() });
  }
  return collisions;
}

/**
 * Return whether a font buffer still contains OpenType variation tables.
 *
 * The embedding path converts WOFF/WOFF2 into EOT through fonteditor-core.
 * That conversion currently writes a static font and discards these tables,
 * so this deliberately small parser is used to make the fidelity loss
 * visible to callers before the conversion happens. It is not a validator:
 * an unreadable buffer simply returns false and the normal embed error path
 * remains responsible for reporting it.
 *
 * WOFF2 stores common table tags as indexes rather than literal ASCII. The
 * directory parser below handles that encoding (including transformed glyf
 * entries) so Google Fonts variable files are detected without inflating
 * the whole font in the browser.
 *
 * @param {ArrayBuffer|ArrayBufferView} value
 * @returns {boolean}
 */
export function hasVariableFontTables(value) {
  let bytes;
  if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
  else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  else return false;

  const variableTags = new Set(['fvar', 'gvar', 'HVAR', 'MVAR', 'STAT', 'avar']);
  const textAt = (offset, size) => {
    if (offset < 0 || size < 0 || offset + size > bytes.length) return '';
    let value = '';
    for (let index = offset; index < offset + size; index++) value += String.fromCharCode(bytes[index]);
    return value;
  };
  const u16 = (offset) => (offset + 2 <= bytes.length ? (bytes[offset] << 8) | bytes[offset + 1] : -1);

  // sfnt (TTF/OTF) and WOFF 1 both contain a conventional 16-byte table
  // directory. Their headers differ, but the count/directory offsets do not.
  const signature = textAt(0, 4);
  const directoryAt = signature === 'wOFF' ? 44 : 12;
  const tableCountAt = signature === 'wOFF' ? 12 : 4;
  if (signature !== 'wOF2') {
    const count = u16(tableCountAt);
    if (count < 0 || count > 4096 || directoryAt + count * 16 > bytes.length) return false;
    for (let index = 0; index < count; index++) {
      if (variableTags.has(textAt(directoryAt + index * 16, 4))) return true;
    }
    return false;
  }

  // WOFF2 header is 48 bytes. Its known-tag index table is defined by the
  // WOFF2 spec; uncommon tags (including HVAR/MVAR) appear as explicit tags.
  const knownTags = [
    'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep',
    'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE',
    'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt',
    'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar',
    'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Sill',
  ];
  const readBase128 = (start) => {
    let result = 0;
    for (let offset = 0; offset < 5; offset++) {
      const byte = bytes[start + offset];
      if (byte === undefined || (offset === 0 && byte === 0)) return null;
      if (result > 0x01ffffff) return null;
      result = (result << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) return { value: result, next: start + offset + 1 };
    }
    return null;
  };
  const tableCount = u16(12);
  if (tableCount < 0 || tableCount > 4096 || bytes.length < 48) return false;
  let cursor = 48;
  for (let index = 0; index < tableCount; index++) {
    const flags = bytes[cursor++];
    if (flags === undefined) return false;
    const tagIndex = flags & 0x3f;
    const transformVersion = flags >>> 6;
    let tag = tagIndex === 0x3f ? textAt(cursor, 4) : knownTags[tagIndex];
    if (tagIndex === 0x3f) cursor += 4;
    if (!tag) return false;
    if (variableTags.has(tag)) return true;
    const originalLength = readBase128(cursor);
    if (!originalLength) return false;
    cursor = originalLength.next;
    // glyf/loca use transform version 0 for their transformed payload; its
    // extra transformedLength is what keeps the next directory entry aligned.
    if ((tag === 'glyf' || tag === 'loca') && transformVersion === 0) {
      const transformedLength = readBase128(cursor);
      if (!transformedLength) return false;
      cursor = transformedLength.next;
    }
  }
  return false;
}

/**
 * Give every embedded family a `regular` slot.
 *
 * CSS font matching falls back across styles within a family: a page that
 * only declares `Playfair Display` at `700 italic` still renders an
 * upright bold request with that italic face, because the browser picks
 * the nearest available face. PowerPoint does not — it looks up the
 * `regular` (or `bold`) slot of the embedded family, finds it empty, and
 * substitutes a completely different system font for the whole family.
 *
 * So when a family has faces but no `regular` one, reuse the closest
 * available face for that slot. The result is not always typographically
 * identical to the browser (an italic face standing in for upright), but
 * it keeps the family resolvable instead of losing it entirely. Slots that
 * were declared explicitly are never overwritten, and `bold` is left empty
 * on purpose when only `regular` exists so PowerPoint synthesises bold the
 * same way the browser does.
 *
 * @param {Array<{name: string, variant: string, urls: string[]}>} fontsToEmbed
 * @returns {{fonts: Array<{name: string, variant: string, urls: string[], backfilledFrom?: string}>, backfilled: Array<{family: string, from: string}>}}
 */
export function backfillRegularFontSlot(fontsToEmbed) {
  const byFamily = new Map();
  for (const font of fontsToEmbed) {
    if (!byFamily.has(font.name)) byFamily.set(font.name, []);
    byFamily.get(font.name).push(font);
  }

  const fonts = fontsToEmbed.slice();
  const backfilled = [];
  const donorOrder = ['bold', 'italic', 'boldItalic'];

  for (const [family, variants] of byFamily) {
    if (variants.some((entry) => (entry.variant || 'regular') === 'regular')) continue;
    const donor = donorOrder
      .map((variant) => variants.find((entry) => (entry.variant || 'regular') === variant))
      .find(Boolean);
    if (!donor || donor.urls.length === 0) continue;
    fonts.push({
      name: family,
      variant: 'regular',
      urls: donor.urls.slice(),
      backfilledFrom: donor.variant,
    });
    backfilled.push({ family, from: donor.variant });
  }

  return { fonts, backfilled };
}

/**
 * Split a text node's value into line segments for an element whose effective
 * CSS `white-space` preserves author line breaks (`pre`, `pre-wrap`, `pre-line`).
 *
 * Returns `[{ text, breakLine }]` where `breakLine` marks a hard line break after
 * that segment (PptxGenJS `breakLine`). Pure string logic — no DOM/canvas — so it
 * is unit-testable in isolation.
 *
 * Rules (per CSS Text spec):
 *  - `pre` / `pre-wrap`: keep newlines AND runs of spaces; tabs become spaces
 *    (PPTX text runs have no tab stops).
 *  - `pre-line`: keep newlines but collapse runs of spaces/tabs.
 *  - A single newline right after a `<pre>` start tag is ignored (HTML parsing).
 *  - A single trailing newline on the last text node is the line terminator and
 *    is dropped, so `<pre>a\n</pre>` is one line, not one line + a blank one.
 */
export function splitPreformattedText(value, whiteSpace, options = {}) {
  const { isFirstChild = false, isLastChild = false, isPre = false, textTransform = 'none' } = options;

  let raw = String(value).replace(/\r\n?/g, '\n');
  if (isFirstChild && isPre && raw[0] === '\n') raw = raw.slice(1);
  raw = whiteSpace === 'pre-line' ? raw.replace(/[ \t]+/g, ' ') : raw.replace(/\t/g, '    ');
  if (isLastChild) raw = raw.replace(/\n$/, '');
  if (!raw.length) return [];

  const transform = (s) => {
    if (textTransform === 'uppercase') return s.toUpperCase();
    if (textTransform === 'lowercase') return s.toLowerCase();
    if (textTransform === 'capitalize') return s.replace(/\b\w/g, (c) => c.toUpperCase());
    return s;
  };

  const lines = raw.split('\n');
  return lines.map((line, i) => ({ text: transform(line), breakLine: i < lines.length - 1 }));
}

/**
 * Resolve the `highlight` a text run should carry for the element its style came from.
 *
 * PptxGenJS takes `highlight` as a bare hex and writes
 * `<a:highlight><a:srgbClr val="…"/></a:highlight>`, which has no alpha channel,
 * so a translucent CSS background cannot survive the trip as a highlight.
 *
 * Returns null when the element's own background is already painted as a shape
 * fill, which is the case for the shape root (`isRoot`) and for block-level
 * elements. There the fill keeps both the CSS alpha and the border radius, and
 * repeating the colour as a highlight paints it a second time at full opacity:
 * an 8% tint becomes an opaque slab that hides same-coloured text, and the run's
 * line-box rectangle squares off the fill's rounded corners.
 *
 * A nested, non-layout inline badge owns no shape, so there the highlight is
 * the only carrier left; a translucent colour is flattened against the
 * ancestor backgrounds first so a tint stays a tint instead of flooding the
 * run. Inline flex/grid containers are different: their background is emitted
 * as a separate shape before their child text nodes, so a run highlight would
 * paint the same colour a second time at full opacity.
 */
export function resolveRunHighlight(style, node, isRoot) {
  const display = String(style.display || '').toLowerCase();
  const paintsOwnBackgroundShape = [
    'block',
    'flex',
    'inline-flex',
    'grid',
    'inline-grid',
    'table',
    'list-item',
  ].includes(display);
  if (isRoot || paintsOwnBackgroundShape) return null;

  const bg = parseColor(style.backgroundColor, style);
  if (!bg.hex || bg.opacity <= 0) return null;
  if (bg.opacity >= 1) return bg.hex;

  return flattenColor(bg, node && node.nodeType === 1 ? node : null, true).hex;
}

// Displays that lay out their own line boxes, and therefore contribute their
// own strut rather than joining the parent's line.
const STRUT_DISPLAYS = [
  'block',
  'flow-root',
  'flex',
  'inline-flex',
  'grid',
  'inline-grid',
  'inline-block',
  'table',
  'table-cell',
  'list-item',
];

export function collectTextParts(
  node,
  parentStyle,
  scale,
  activeHyperlink = null,
  isRoot = true,
  inheritedOpacity = 1,
  blockLineSpacing = null
) {
  const parts = [];
  let hyperlink = activeHyperlink;
  const ownStyle = node.nodeType === 1 ? window.getComputedStyle(node) : null;

  // Every line box also contains the strut of the block that owns it, so a
  // block whose line-height outgrows its inline children still sets the floor
  // for the line. Inline elements join the parent's line instead of starting
  // one, so they carry the inherited strut through to their runs.
  const ownsLineBox =
    ownStyle && (isRoot || STRUT_DISPLAYS.includes(String(ownStyle.display || '').toLowerCase()));
  const strutLineSpacing = ownsLineBox ? resolveLineSpacing(ownStyle, scale) : blockLineSpacing;
  const applyStrut = (options) => {
    if (strutLineSpacing > 0 && !(options.lineSpacing >= strutLineSpacing)) {
      options.lineSpacing = strutLineSpacing;
    }
    return options;
  };

  // Hyperlink inheritance: If no hyperlink is active, check if this node is an <a> or inside one.
  if (!hyperlink && node.nodeType === 1) {
    const aNode = node.closest('a');
    if (aNode) {
      const href = aNode.getAttribute('href');
      if (href) {
        hyperlink = { url: href, tooltip: aNode.getAttribute('title') || undefined };
      }
    }
  }

  // Check for CSS Content (::before) - often used for icons
  if (node.nodeType === 1) {
    const beforeStyle = window.getComputedStyle(node, '::before');
    const content = beforeStyle.content;
    if (content && content !== 'none' && content !== 'normal' && content !== '""') {
      // Strip quotes
      const cleanContent = content.replace(/^['"]|['"]$/g, '');
      if (cleanContent.trim()) {
        const textOpts = applyStrut(getTextStyle(beforeStyle, scale, false, inheritedOpacity));
        if (hyperlink) textOpts.hyperlink = hyperlink;

        // Apply __spc_ suffix if charSpacing is defined
        if (textOpts.charSpacing !== undefined) {
          const spcVal = Math.round(textOpts.charSpacing * 100);
          if (textOpts.fontFace) {
            textOpts.fontFace = `${textOpts.fontFace}__spc_${spcVal}`;
          }
        }

        const trailSpace = cleanContent.endsWith(' ') || cleanContent.endsWith('\xa0') ? '' : ' ';
        parts.push({
          text: cleanContent + trailSpace, // Add space after icon
          options: textOpts,
        });
      }
    }
  }

  let trimNextLeading = false;

  node.childNodes.forEach((child, index) => {
    if (child.nodeType === 3) {
      // Honor CSS white-space: pre / pre-wrap / pre-line preserve author line
      // breaks (and, except pre-line, runs of spaces). Without this, every newline
      // and indent inside a <pre> / white-space:pre(-wrap) block is collapsed to a
      // single space and multi-line content renders as one run.
      const wsStyle = ownStyle || parentStyle;
      const whiteSpace = wsStyle.whiteSpace || 'normal';
      if (whiteSpace === 'pre' || whiteSpace === 'pre-wrap' || whiteSpace === 'pre-line') {
        const segs = splitPreformattedText(child.nodeValue, whiteSpace, {
          isFirstChild: index === 0,
          isLastChild: index === node.childNodes.length - 1,
          isPre: node.nodeType === 1 && (node.tagName || '').toLowerCase() === 'pre',
          textTransform: wsStyle.textTransform,
        });
        if (segs.length) {
          const baseOpts = applyStrut(getTextStyle(wsStyle, scale, !isRoot, inheritedOpacity));
          if (hyperlink) baseOpts.hyperlink = hyperlink;
          if (baseOpts.charSpacing !== undefined && baseOpts.fontFace) {
            baseOpts.fontFace = `${baseOpts.fontFace}__spc_${Math.round(baseOpts.charSpacing * 100)}`;
          }
          // Naked text node: only a nested inline badge carries its background as
          // a run highlight; every other case already has it as a shape fill.
          const highlight = resolveRunHighlight(wsStyle, node, isRoot);
          if (highlight) baseOpts.highlight = highlight;
          else delete baseOpts.highlight;
          segs.forEach((seg) => {
            parts.push({
              text: seg.text,
              options: seg.breakLine ? { ...baseOpts, breakLine: true } : { ...baseOpts },
            });
          });
        }
        trimNextLeading = false;
        return;
      }

      // Text (white-space: normal / nowrap — collapse runs of whitespace).
      // PowerPoint determines visual line boundaries from the exported box.
      let val = child.nodeValue.replace(/[\n\r\t]+/g, ' ').replace(/\s{2,}/g, ' ');

      if (index === 0) val = val.trimStart();
      if (trimNextLeading) val = val.trimStart();
      if (index === node.childNodes.length - 1) val = val.trimEnd();
      trimNextLeading = false;

      if (val) {
        // Use parent style if child is text node, otherwise current style
        const styleToUse = ownStyle || parentStyle;
        const transform = styleToUse.textTransform;
        if (transform === 'uppercase') val = val.toUpperCase();
        else if (transform === 'lowercase') val = val.toLowerCase();
        else if (transform === 'capitalize') val = val.replace(/\b\w/g, (c) => c.toUpperCase());

        const textOpts = applyStrut(getTextStyle(styleToUse, scale, !isRoot, inheritedOpacity));
        if (hyperlink) textOpts.hyperlink = hyperlink;

        // Apply __spc_ suffix if charSpacing is defined
        if (textOpts.charSpacing !== undefined) {
          const spcVal = Math.round(textOpts.charSpacing * 100);
          if (textOpts.fontFace) {
            textOpts.fontFace = `${textOpts.fontFace}__spc_${spcVal}`;
          }
        }

        // Naked text node: only a nested inline badge carries its background as
        // a run highlight; every other case already has it as a shape fill.
        if (textOpts.highlight) {
          const highlight = resolveRunHighlight(styleToUse, node, isRoot);
          if (highlight) textOpts.highlight = highlight;
          else delete textOpts.highlight;
        }

          parts.push({
            text: val,
            options: textOpts,
          });
      }
    } else if (child.nodeType === 1) {
      if ((child?.tagName || '').toLowerCase() === 'br') {
        if (parts.length > 0) {
          const lastPart = parts[parts.length - 1];
          if (lastPart.text && typeof lastPart.text === 'string') {
            lastPart.text = lastPart.text.trimEnd();
          }
        }
        parts.push({ text: '', options: { breakLine: true } });
        trimNextLeading = true;
      } else {
        const isBlock = ['div', 'p', 'li'].includes((child?.tagName || '').toLowerCase());
        if (isBlock && parts.length > 0 && !parts[parts.length - 1].options?.breakLine) {
          parts.push({ text: '', options: { breakLine: true } });
        }

        const childParts = collectTextParts(
          child,
          parentStyle,
          scale,
          hyperlink,
          false,
          inheritedOpacity,
          strutLineSpacing
        );
        if (childParts.length > 0) parts.push(...childParts);

        if (isBlock) {
          parts.push({ text: '', options: { breakLine: true } });
          trimNextLeading = true;
        }
      }
    }
  });

  // Check for CSS Content (::after) - often used for icons
  if (node.nodeType === 1) {
    const afterStyle = window.getComputedStyle(node, '::after');
    const content = afterStyle.content;
    if (content && content !== 'none' && content !== 'normal' && content !== '""') {
      // Strip quotes
      const cleanContent = content.replace(/^['"]|['"]$/g, '');
      if (cleanContent.trim()) {
        const textOpts = applyStrut(getTextStyle(afterStyle, scale, false, inheritedOpacity));
        if (hyperlink) textOpts.hyperlink = hyperlink;

        // Apply __spc_ suffix if charSpacing is defined
        if (textOpts.charSpacing !== undefined) {
          const spcVal = Math.round(textOpts.charSpacing * 100);
          if (textOpts.fontFace) {
            textOpts.fontFace = `${textOpts.fontFace}__spc_${spcVal}`;
          }
        }

        const leadSpace = cleanContent.startsWith(' ') || cleanContent.startsWith('\xa0') ? '' : ' ';
        parts.push({
          text: leadSpace + cleanContent, // Add space before icon/content
          options: textOpts,
        });
      }
    }
  }

  // Cleanup potential trailing empty breakLines
  while (parts.length > 0 && parts[parts.length - 1].options?.breakLine && parts[parts.length - 1].text === '') {
    parts.pop();
  }

  // Only the outermost call sees whole paragraphs, so line spacing is settled
  // here rather than per nesting level.
  if (isRoot) unifyParagraphLineSpacing(parts);

  return parts;
}
