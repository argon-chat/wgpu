/**
 * Does every label in a committed diagram actually fit inside its box?
 *
 * This exists because eyeballing failed. The distribution map shipped twice with text running past
 * the rounded rectangle behind it — invisible while writing the markup, obvious the moment anyone
 * looked at the picture, and permanent once the file is in a README that npm mirrors.
 *
 * ── What it can and cannot promise ──────────────────────────────────────────────────────────────
 *
 * Text width in a browser depends on the font that machine resolved, its hinting and its kerning;
 * none of that is knowable here. So this estimates, with per-class average advance ratios measured
 * against the actual faces in the stylesheet, and applies a safety margin. It is a **smoke alarm,
 * not a ruler**: it catches "this line is 30% too long", which is every real occurrence, and it will
 * not catch a two-pixel overhang. A two-pixel overhang is also not what anyone complained about.
 *
 * Deliberately no XML library and no headless browser: the parse it needs is "rectangles and texts
 * with x/y", the diagram is authored by hand, and a dependency here would cost more than the check
 * is worth.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MEDIA = path.join(PKG_ROOT, "docs", "media");

/**
 * Average advance width as a fraction of font size.
 *
 * Sans figures are for the `ui-sans-serif` / Segoe UI / Roboto stack at weight 400 and 600; mono is
 * for a fixed-pitch face, where the ratio is exact rather than averaged. Rounded up: over-estimating
 * width makes this test conservative, which is the direction to be wrong in.
 */
const ADVANCE: Record<string, number> = {
  h: 0.56, // 600 weight sans
  t: 0.52, // 400 weight sans
  m: 0.61, // monospace
  ok: 0.56,
  wa: 0.56,
  lbl: 0.62, // 600 weight, plus 0.08em letter-spacing
};

/** Padding assumed between a box's edge and the text inside it, in user units. */
const PADDING = 16;

interface IRect {
  x: number;
  y: number;
  w: number;
  h: number;
  cls: string;
}
interface IText {
  x: number;
  y: number;
  cls: string;
  content: string;
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return m?.[1] ?? null;
}

function parse(svg: string): { rects: IRect[]; texts: IText[]; sizes: Record<string, number> } {
  const rects: IRect[] = [];
  for (const m of svg.matchAll(/<rect\b[^>]*>/g)) {
    const tag = m[0];
    rects.push({
      x: Number(attr(tag, "x") ?? 0),
      y: Number(attr(tag, "y") ?? 0),
      w: Number(attr(tag, "width") ?? 0),
      h: Number(attr(tag, "height") ?? 0),
      cls: attr(tag, "class") ?? "",
    });
  }
  const texts: IText[] = [];
  for (const m of svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)) {
    texts.push({
      x: Number(attr(m[1]!, "x") ?? 0),
      y: Number(attr(m[1]!, "y") ?? 0),
      cls: attr(m[1]!, "class") ?? "",
      // Entities count as one glyph, which is what they render as.
      content: m[2]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim(),
    });
  }
  const sizes: Record<string, number> = {};
  for (const m of svg.matchAll(/\.(\w+)\s*\{[^}]*font-size:\s*([\d.]+)px/g)) {
    sizes[m[1]!] = Number(m[2]!);
  }
  return { rects, texts, sizes };
}

/** The smallest box that contains this text's anchor — the one it is visually inside. */
function containing(rects: IRect[], t: IText): IRect | null {
  const boxes = rects.filter(
    (r) => r.cls !== "panel" && r.cls !== "lane" && t.x >= r.x && t.x <= r.x + r.w && t.y >= r.y && t.y <= r.y + r.h,
  );
  if (boxes.length === 0) return null;
  return boxes.reduce((a, b) => (a.w * a.h <= b.w * b.h ? a : b));
}

const diagrams = fs.existsSync(MEDIA)
  ? fs.readdirSync(MEDIA).filter((f) => f.endsWith(".svg"))
  : [];

describe.each(diagrams.length ? diagrams : ["(no diagrams)"])("%s", (name) => {
  test.skipIf(name === "(no diagrams)")("no label overflows the box it sits in", () => {
    const svg = fs.readFileSync(path.join(MEDIA, name), "utf-8");
    const { rects, texts, sizes } = parse(svg);
    expect(texts.length).toBeGreaterThan(0);

    const overflows: string[] = [];
    for (const t of texts) {
      const box = containing(rects, t);
      if (!box) continue; // a free-standing label, e.g. a column heading — nothing to overflow
      const size = sizes[t.cls];
      const ratio = ADVANCE[t.cls];
      if (size === undefined || ratio === undefined) {
        overflows.push(`${t.cls}: no font metrics for this class — add them rather than skipping`);
        continue;
      }
      const width = t.content.length * size * ratio;
      const available = box.w - (t.x - box.x) - PADDING;
      if (width > available) {
        overflows.push(
          `"${t.content}" needs ~${Math.round(width)}px, has ${Math.round(available)}px ` +
            `(${t.content.length} chars at ${size}px)`,
        );
      }
    }
    expect(overflows, `text running past its box in ${name}:\n\n${overflows.join("\n")}`).toEqual([]);
  });
});
