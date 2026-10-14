import { describe, it, expect, beforeAll, vi } from 'vitest';
import { extractTableData, getBorderInfo } from '../utils.js';
import { exportToPptx } from '../index.js';

// Mock pptxgenjs
const mockAddText = vi.fn();
const mockAddTable = vi.fn();
const mockAddShape = vi.fn();
const mockAddSlide = vi.fn(() => ({
  addText: mockAddText,
  addShape: mockAddShape,
  addImage: vi.fn(),
  addTable: mockAddTable,
}));

vi.mock('pptxgenjs', () => {
  return {
    default: vi.fn().mockImplementation(function () {
      return {
        defineLayout: vi.fn(),
        addSlide: mockAddSlide,
        write: vi.fn(() => Promise.resolve('')),
      };
    }),
  };
});

describe('extractTableData', () => {
  beforeAll(() => {
    // Mock HTMLCanvasElement.prototype.getContext for JSDOM env
    let fillStyle = '';
    HTMLCanvasElement.prototype.getContext = () => ({
      get fillStyle() {
        return fillStyle;
      },
      set fillStyle(val) {
        fillStyle = val;
      },
      clearRect: () => {},
      fillRect: () => {},
      getImageData: () => ({ data: [0, 0, 0, 0] }),
    });
  });

  it('extracts table rows and columns correctly', () => {
    const table = document.createElement('table');
    table.innerHTML = `
      <tr>
        <td>Cell 1</td>
        <td>Cell 2</td>
      </tr>
    `;
    document.body.appendChild(table);

    const data = extractTableData(table, 1);
    expect(data.rows.length).toBe(1);
    expect(data.rows[0].length).toBe(2);
    expect(data.rows[0][0].text[0].text).toBe('Cell 1');

    document.body.removeChild(table);
  });

  it('maps writing-mode to textDirection in table cells', () => {
    const table = document.createElement('table');
    table.innerHTML = `
      <tr>
        <td style="writing-mode: vertical-rl;">Vertical Cell</td>
        <td style="writing-mode: vertical-lr; text-orientation: upright;">Upright Cell</td>
        <td>Normal Cell</td>
      </tr>
    `;
    document.body.appendChild(table);

    const data = extractTableData(table, 1);
    expect(data.rows[0][0].options.textDirection).toBe('vert');
    expect(data.rows[0][1].options.textDirection).toBe('wordArtVert');
    expect(data.rows[0][2].options.textDirection).toBeUndefined();

    document.body.removeChild(table);
  });

  it('preserves translucent cell fill so an outer card remains visible', () => {
    // This card is exported separately as the PPT object behind the table.
    const container = document.createElement('div');
    container.style.backgroundColor = '#101018';
    document.body.appendChild(container);

    const table = document.createElement('table');
    table.innerHTML = `
      <tr>
        <td style="background-color: rgba(255, 255, 255, 0.04); border-top-style: solid; border-top-width: 1px; border-top-color: rgba(255, 255, 255, 0.08); color: #fff;">
          Translucent Cell
        </td>
      </tr>
    `;
    container.appendChild(table);

    const data = extractTableData(table, 1);
    expect(data.rows.length).toBe(1);
    expect(data.rows[0].length).toBe(1);

    const cellOptions = data.rows[0][0].options;
    // Do not pre-composite against the card. PptxGenJS can preserve alpha,
    // allowing the exported card/slide background to remain visible.
    expect(cellOptions.fill).toEqual({ color: 'FFFFFF', transparency: 96 });

    // Expected top border: rgba(255,255,255,0.08) blended over its own cell background.
    // r = 255 * 0.08 + 26 * 0.92 = 20.4 + 23.92 = 44.32 => 44 (0x2c)
    // g = 255 * 0.08 + 26 * 0.92 = 44 (0x2c)
    // b = 255 * 0.08 + 33 * 0.92 = 20.4 + 30.36 = 50.76 => 51 (0x33)
    // => Hex: '2C2C33'
    expect(cellOptions.border[0].color).toBe('2C2C33');

    document.body.removeChild(container);
  });

  it('uses a row background when a header cell is transparent', () => {
    const table = document.createElement('table');
    table.style.backgroundColor = '#ffffff';
    table.innerHTML = `
      <thead>
        <tr style="background-color:#15181b">
          <th>Header</th>
        </tr>
      </thead>
    `;
    document.body.appendChild(table);

    const data = extractTableData(table, 1);
    expect(data.rows[0][0].options.fill).toEqual({ color: '15181B' });

    document.body.removeChild(table);
  });

  it('flattens translucent shape borders instead of emitting opaque white outlines', () => {
    const card = document.createElement('div');
    card.style.backgroundColor = '#071A42';
    const row = document.createElement('div');
    row.style.backgroundColor = 'rgba(255, 255, 255, 0.015)';
    row.style.border = '1px solid rgba(255, 255, 255, 0.05)';
    card.appendChild(row);
    document.body.appendChild(card);

    const border = getBorderInfo(window.getComputedStyle(row), 1, row);
    expect(border.type).toBe('uniform');
    expect(border.options.transparency).toBe(0);
    expect(border.options.color).not.toBe('FFFFFF');

    document.body.removeChild(card);
  });

  it('samples a linear-gradient backdrop per edge before flattening translucent borders', () => {
    const slide = document.createElement('div');
    slide.style.backgroundImage = 'linear-gradient(160deg, #1A4463 0%, #12314A 100%)';
    const card = document.createElement('div');
    card.style.backgroundColor = 'rgba(255, 255, 255, 0.02)';
    card.style.border = '1px solid rgba(255, 255, 255, 0.08)';
    slide.appendChild(card);
    document.body.appendChild(slide);
    slide.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 240, right: 400, bottom: 240 });
    card.getBoundingClientRect = () => ({ left: 100, top: 60, width: 200, height: 100, right: 300, bottom: 160 });

    const border = getBorderInfo(window.getComputedStyle(card), 1, card);
    expect(border.type).toBe('composite');
    for (const side of Object.values(border.sides)) {
      expect(side.color).toMatch(/^[0-9A-F]{6}$/);
      expect(side.color).not.toBe('FFFFFF');
      expect(side.opacity).toBe(1);
    }
    expect(border.sides.top.color).not.toBe(border.sides.bottom.color);

    document.body.removeChild(slide);
  });

  it('keeps a translucent dashed circle as one native dashed outline on a gradient', () => {
    const slide = document.createElement('div');
    slide.style.backgroundImage = 'linear-gradient(160deg, #1A4463 0%, #12314A 100%)';
    const circle = document.createElement('div');
    circle.style.border = '2px dashed rgba(27, 166, 166, 0.25)';
    circle.style.borderRadius = '50%';
    slide.appendChild(circle);
    document.body.appendChild(slide);
    slide.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 });
    circle.getBoundingClientRect = () => ({ left: 500, top: 80, width: 300, height: 300, right: 800, bottom: 380 });

    const border = getBorderInfo(window.getComputedStyle(circle), 1, circle);
    expect(border.type).toBe('uniform');
    expect(border.options.dashType).toBe('dash');
    expect(border.options.color).toMatch(/^[0-9A-F]{6}$/);
    expect(border.options.color).not.toBe('FFFFFF');
    expect(border.options.transparency).toBe(0);

    document.body.removeChild(slide);
  });

  it('extracts browser row heights in slide inches', () => {
    const table = document.createElement('table');
    table.innerHTML = '<tr><td>A</td></tr><tr><td>B</td></tr>';
    document.body.appendChild(table);
    const rows = table.querySelectorAll('tr');
    rows[0].getBoundingClientRect = () => ({ width: 200, height: 48, left: 0, top: 0, right: 200, bottom: 48 });
    rows[1].getBoundingClientRect = () => ({ width: 200, height: 72, left: 0, top: 48, right: 200, bottom: 120 });

    const data = extractTableData(table, 2 / 3);
    expect(data.rowHeights).toEqual([48 / 96 * (2 / 3), 72 / 96 * (2 / 3)]);

    document.body.removeChild(table);
  });

  it('passes table cell padding as inches without inflating zero-top headers', () => {
    const table = document.createElement('table');
    table.style.borderSpacing = '0';
    table.innerHTML = `
      <tr>
        <th style="padding: 0 20px 16px 20px">Header</th>
      </tr>
    `;
    document.body.appendChild(table);

    const data = extractTableData(table, 1);
    const margin = data.rows[0][0].options.margin;
    expect(margin[0]).toBe(0);
    expect(margin[1]).toBeCloseTo(20 / 96, 8);
    expect(margin[2]).toBeCloseTo(16 / 96, 8);
    expect(margin[3]).toBeCloseTo(20 / 96, 8);
    expect(Math.max(...margin)).toBeLessThan(1);

    document.body.removeChild(table);
  });

  it('maps table, row and column borders onto native perimeter cell edges', () => {
    const table = document.createElement('table');
    table.style.border = '2px solid #112233';
    table.innerHTML = `
      <colgroup span="1" style="border-left: 3px solid #AABBCC"></colgroup>
      <col style="border-left: 3px solid #445566">
      <tr><td>A</td><td>B</td></tr>
      <tr style="border-top: 4px solid #778899"><td>C</td><td>D</td></tr>
    `;
    document.body.appendChild(table);

    const data = extractTableData(table, 1);
    const [topLeft, topRight] = data.rows[0];
    const [bottomLeft, bottomRight] = data.rows[1];

    // Table borders are distributed to only the outside cells, never passed
    // through PptxGenJS' table-wide border option.
    expect(topLeft.options.border[0]).toMatchObject({ color: '112233', pt: 1.5 });
    expect(topRight.options.border[1]).toMatchObject({ color: '112233', pt: 1.5 });
    expect(bottomLeft.options.border[2]).toMatchObject({ color: '112233', pt: 1.5 });
    expect(bottomLeft.options.border[3]).toMatchObject({ color: 'AABBCC', pt: 2.25 });
    expect(topLeft.options.border[1]).toMatchObject({ color: '445566', pt: 2.25 });
    // The second row's top edge has one canonical PPT owner: the first row's
    // bottom edge. This prevents duplicate line drawing at an internal edge.
    expect(topLeft.options.border[2]).toMatchObject({ color: '778899', pt: 3 });
    expect(bottomLeft.options.border[0]).toBeNull();
    expect(bottomRight.options.border[0]).toBeNull();

    document.body.removeChild(table);
  });

  it('resolves competing cell borders and preserves merged-cell outer edges', () => {
    const table = document.createElement('table');
    table.style.border = '1px solid #111111';
    table.innerHTML = `
      <tr>
        <td rowspan="2">A</td>
        <td style="border-bottom: 1px solid #0000ff">B</td>
      </tr>
      <tr><td style="border-top: 3px solid #ff0000">C</td></tr>
    `;
    document.body.appendChild(table);

    const data = extractTableData(table, 1);
    const merged = data.rows[0][0];
    const upperRight = data.rows[0][1];
    const lowerRight = data.rows[1][0];

    // No row-boundary line is invented through the rowspan cell.
    expect(merged.options.border[2]).toMatchObject({ color: '111111', pt: 0.75 });
    // Between normal cells, the thicker competing border wins and is stored
    // on the upper cell's bottom edge only.
    expect(upperRight.options.border[2]).toMatchObject({ color: 'FF0000', pt: 2.25 });
    expect(lowerRight.options.border[0]).toBeNull();

    document.body.removeChild(table);
  });

  it('passes the measured table height and row heights to PptxGenJS', async () => {
    mockAddTable.mockClear();
    mockAddShape.mockClear();
    const slide = document.createElement('div');
    slide.className = 'slide';
    const table = document.createElement('table');
    table.innerHTML = '<tr><td>A</td></tr><tr><td>B</td></tr>';
    slide.appendChild(table);
    document.body.appendChild(slide);

    slide.getBoundingClientRect = () => ({ width: 960, height: 540, left: 0, top: 0, right: 960, bottom: 540 });
    table.getBoundingClientRect = () => ({ width: 300, height: 120, left: 20, top: 20, right: 320, bottom: 140 });
    const rows = table.querySelectorAll('tr');
    rows[0].getBoundingClientRect = () => ({ width: 300, height: 48, left: 20, top: 20, right: 320, bottom: 68 });
    rows[1].getBoundingClientRect = () => ({ width: 300, height: 72, left: 20, top: 68, right: 320, bottom: 140 });
    table.querySelectorAll('td').forEach((cell) => {
      cell.getBoundingClientRect = () => ({ width: 300, height: 48, left: 20, top: 20, right: 320, bottom: 68 });
    });

    await exportToPptx(slide, { skipDownload: true, skipNormalize: true });

    expect(mockAddTable).toHaveBeenCalledTimes(1);
    const options = mockAddTable.mock.calls[0][1];
    expect(options.h).toBeCloseTo(120 / 96, 5);
    expect(options.rowH).toEqual([48 / 96, 72 / 96]);
    // Borders stay inside the native PPT table. Do not add slide-level
    // rectangles over a row just to join the cell borders.
    expect(mockAddShape).not.toHaveBeenCalled();

    document.body.removeChild(slide);
  });

  it('correctly calculates and sets bullet.indent for list items with padding-left', async () => {
    mockAddText.mockClear();

    // Create list in the DOM
    const container = document.createElement('div');
    container.className = 'slide';
    container.style.width = '960px';
    container.style.height = '540px';

    const ul = document.createElement('ul');
    ul.style.paddingLeft = '20px';

    const li = document.createElement('li');
    li.style.paddingLeft = '100px';
    li.textContent = 'Indented text';

    ul.appendChild(li);
    container.appendChild(ul);
    document.body.appendChild(container);

    // Mock getBoundingClientRect for JSDOM layout engine
    container.getBoundingClientRect = () => ({ width: 960, height: 540, left: 0, top: 0, right: 960, bottom: 540 });
    ul.getBoundingClientRect = () => ({ width: 900, height: 400, left: 20, top: 20, right: 920, bottom: 420 });
    li.getBoundingClientRect = () => ({ width: 800, height: 50, left: 20, top: 20, right: 820, bottom: 70 });

    // Call exportToPptx
    await exportToPptx(container, { skipDownload: true, skipNormalize: true });

    // Assert mockAddText was called with the correct bullet.indent
    expect(mockAddText).toHaveBeenCalled();

    let foundRun = null;
    for (const call of mockAddText.mock.calls) {
      const [textParts] = call;
      if (Array.isArray(textParts)) {
        const run = textParts.find((part) => part.text === 'Indented text');
        if (run) {
          foundRun = run;
          break;
        }
      }
    }

    expect(foundRun).not.toBeNull();
    expect(foundRun.options.bullet).not.toBeNull();
    // visualIndentPx should be computed from DOM getBoundingClientRect
    // Since in JSDOM getBoundingClientRect defaults to all 0s, visualIndentPx = liRect.left - parentRect.left = 0
    // bullet.indent = 20 * scale + (visualIndentOffset + liPaddingLeft) * 0.75 * scale = 20 + 75 = 95
    expect(foundRun.options.bullet.indent).toBe(95);

    document.body.removeChild(container);
  });

  it('falls back to default 20pt bullet.indent when calculated indent is 0', async () => {
    mockAddText.mockClear();

    // Create list in the DOM with no padding-left overrides
    const container = document.createElement('div');
    container.className = 'slide';
    container.style.width = '960px';
    container.style.height = '540px';

    const ul = document.createElement('ul');

    const li = document.createElement('li');
    li.textContent = 'Normal text';

    ul.appendChild(li);
    container.appendChild(ul);
    document.body.appendChild(container);

    // Mock getBoundingClientRect for JSDOM layout engine
    container.getBoundingClientRect = () => ({ width: 960, height: 540, left: 0, top: 0, right: 960, bottom: 540 });
    ul.getBoundingClientRect = () => ({ width: 900, height: 400, left: 0, top: 0, right: 900, bottom: 400 });
    li.getBoundingClientRect = () => ({ width: 900, height: 50, left: 0, top: 0, right: 900, bottom: 50 });

    // Call exportToPptx
    await exportToPptx(container, { skipDownload: true, skipNormalize: true });

    // Assert mockAddText was called with the default bullet.indent
    expect(mockAddText).toHaveBeenCalled();

    let foundRun = null;
    for (const call of mockAddText.mock.calls) {
      const [textParts] = call;
      if (Array.isArray(textParts)) {
        const run = textParts.find((part) => part.text === 'Normal text');
        if (run) {
          foundRun = run;
          break;
        }
      }
    }

    expect(foundRun).not.toBeNull();
    expect(foundRun.options.bullet).not.toBeNull();
    expect(foundRun.options.bullet.indent).toBe(20); // Default fallback

    document.body.removeChild(container);
  });
});
