export interface EditorHsvColor {
  hue: number;
  saturation: number;
  brightness: number;
}

export function normalizeEditorHex(value: string): string | null {
  const hex = value.trim().replace(/^#/, "");
  if (/^[\da-f]{3}$/i.test(hex)) return `#${hex.split("").map((digit) => digit + digit).join("").toLowerCase()}`;
  return /^[\da-f]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : null;
}

export function editorHexToHsv(value: string): EditorHsvColor {
  const hex = normalizeEditorHex(value) ?? "#000000";
  const [red, green, blue] = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const brightness = Math.max(red, green, blue);
  const delta = brightness - Math.min(red, green, blue);
  let hue = 0;
  if (delta > 0) {
    hue = brightness === red ? (green - blue) / delta : brightness === green ? (blue - red) / delta + 2 : (red - green) / delta + 4;
    hue = (hue * 60 + 360) % 360;
  }
  return { hue, saturation: brightness > 0 ? delta / brightness : 0, brightness };
}

export function editorHsvToHex({ hue, saturation, brightness }: EditorHsvColor): string {
  const h = (hue % 360 + 360) % 360;
  const v = Math.max(0, Math.min(1, brightness));
  const c = v * Math.max(0, Math.min(1, saturation));
  const x = c * (1 - Math.abs(h / 60 % 2 - 1));
  const channels = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][Math.floor(h / 60)];
  return `#${channels.map((channel) => Math.round((channel + v - c) * 255).toString(16).padStart(2, "0")).join("")}`;
}
