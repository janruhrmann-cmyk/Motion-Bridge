/** Finds and loads the fonts a document needs before any text node is created. */
import type { BridgeDoc, Content, TextContent } from '../../../shared/format.ts';

export const FALLBACK_FONT: FontName = { family: 'Inter', style: 'Regular' };

export function fontKey(family: string, style: string): string {
  return `${family}\n${style}`;
}

function collectText(content: Content, out: TextContent[]): void {
  if (content.type === 'text') out.push(content);
  else if (content.type === 'group') for (const child of content.children) collectText(child.content, out);
}

async function tryLoad(font: FontName): Promise<boolean> {
  try {
    await figma.loadFontAsync(font);
    return true;
  } catch {
    return false;
  }
}

const squash = (s: string): string => s.toLowerCase().replace(/[\s_-]+/g, '');

export async function loadFonts(doc: BridgeDoc, warn: (message: string) => void): Promise<Map<string, FontName>> {
  const texts: TextContent[] = [];
  for (const comp of Object.values(doc.comps)) {
    for (const layer of comp.layers) collectText(layer.content, texts);
  }
  const resolved = new Map<string, FontName>();
  if (!texts.length) return resolved;

  let available: Font[] | null = null;
  for (const t of texts) {
    const key = fontKey(t.fontFamily, t.fontStyle);
    if (resolved.has(key)) continue;

    const wanted: FontName = { family: t.fontFamily, style: t.fontStyle };
    if (await tryLoad(wanted)) {
      resolved.set(key, wanted);
      continue;
    }
    if (!available) available = await figma.listAvailableFontsAsync();
    const family = available.filter((f) => squash(f.fontName.family) === squash(t.fontFamily));
    const pick =
      family.find((f) => squash(f.fontName.style) === squash(t.fontStyle)) ??
      family.find((f) => squash(f.fontName.style) === 'regular') ??
      family[0];
    if (pick && (await tryLoad(pick.fontName))) {
      resolved.set(key, pick.fontName);
      if (squash(pick.fontName.style) !== squash(t.fontStyle)) {
        warn(`Font "${t.fontFamily} ${t.fontStyle}" is not available in Figma; "${pick.fontName.family} ${pick.fontName.style}" is used.`);
      }
      continue;
    }
    await tryLoad(FALLBACK_FONT);
    resolved.set(key, FALLBACK_FONT);
    warn(`Font "${t.fontFamily} ${t.fontStyle}" is not available in Figma; Inter Regular is used.`);
  }
  return resolved;
}
