/**
 * The documentation's own links.
 *
 * The front page is now a landing page that delegates — the ABI argument, the evidence tables and
 * the packaging rationale all live under `docs/` and are reached by relative link. That is a new
 * class of defect for this repository: a moved heading or a renamed file breaks a reader's path
 * through the material, and **nothing else in the build can see it**. The typechecker does not read
 * Markdown, the test suite does not follow links, and the person most likely to notice is a stranger
 * on the package page.
 *
 * So: every relative link and image in the Markdown here must resolve to a file that exists, and
 * every `#anchor` must match a heading in the file it points at.
 *
 * External `http(s)` links are deliberately NOT checked. A test that reaches the network fails for
 * reasons that have nothing to do with this repository, and a gate that goes red when someone else's
 * site is down is a gate people learn to ignore.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS_DIR = path.join(PKG_ROOT, "docs");

/** Every Markdown file this repository publishes. */
const markdownFiles = [
  path.join(PKG_ROOT, "README.md"),
  ...(fs.existsSync(DOCS_DIR)
    ? fs
        .readdirSync(DOCS_DIR)
        .filter((f) => f.endsWith(".md"))
        .map((f) => path.join(DOCS_DIR, f))
    : []),
];

/**
 * GitHub's heading-anchor slug, closely enough for the headings this repository writes: lowercase,
 * formatting characters dropped, everything that is not a word character or a space removed, spaces
 * joined with hyphens.
 */
function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // a link in a heading contributes its text only
    .replace(/[^\w\- ]/g, "")
    // One hyphen per space, NOT one per run. GitHub drops the punctuation and then substitutes
    // each remaining space, so a heading containing " — " yields a DOUBLE hyphen in its anchor.
    // Collapsing here would make this test reject links that work and accept links that do not.
    .replace(/ /g, "-");
}

function anchorsOf(file: string): Set<string> {
  const text = fs.readFileSync(file, "utf-8");
  const anchors = new Set<string>();
  for (const m of text.matchAll(/^#{1,6} +(.+)$/gm)) anchors.add(slugify(m[1]!));
  return anchors;
}

/**
 * Blank out fenced blocks and inline code spans, preserving line structure.
 *
 * Markdown *about* links is not a link. `docs/RELEASE.md` quotes another project's required entry
 * format — ``[Title Case Name](link) - Description.`` — and a checker that cannot tell the
 * difference reports `link` as a broken path, which is a false failure in the one file whose job is
 * to be copied verbatim.
 */
function withoutCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/`[^`\n]*`/g, (m) => " ".repeat(m.length));
}

/** `[text](target)` and `![alt](target)`, plus the `src="…"` of an inline `<img>`. */
function linksOf(file: string): string[] {
  const text = withoutCode(fs.readFileSync(file, "utf-8"));
  const targets = [...text.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)].map((m) => m[1]!);
  targets.push(...[...text.matchAll(/<img[^>]+src="([^"]+)"/g)].map((m) => m[1]!));
  return targets.filter((t) => !/^(https?:|mailto:)/.test(t));
}

describe.each(markdownFiles.map((f) => path.relative(PKG_ROOT, f).split(path.sep).join("/")))(
  "%s",
  (rel) => {
    const file = path.join(PKG_ROOT, rel);

    test("every relative link and image resolves to a file that exists", () => {
      const broken = linksOf(file)
        .filter((t) => !t.startsWith("#"))
        .map((t) => t.split("#")[0]!)
        .filter((t) => !fs.existsSync(path.resolve(path.dirname(file), decodeURI(t))));
      expect(broken).toEqual([]);
    });

    test("every #anchor matches a heading in the file it points at", () => {
      const broken: string[] = [];
      for (const target of linksOf(file)) {
        const hash = target.indexOf("#");
        if (hash === -1) continue;
        const anchor = target.slice(hash + 1);
        const targetFile = hash === 0 ? file : path.resolve(path.dirname(file), target.slice(0, hash));
        if (!fs.existsSync(targetFile)) continue; // reported by the test above
        if (!anchorsOf(targetFile).has(anchor)) broken.push(target);
      }
      expect(broken).toEqual([]);
    });
  },
);

describe("the front page stays a front page", () => {
  // Not a style preference. The README is the npm package page and the first five seconds of a
  // GitHub visit, and this file exists because it had grown to ~800 lines of ABI argument before
  // the pitch. The deep material is not deleted — it is under `docs/`, linked from the bottom.
  const readme = fs.readFileSync(path.join(PKG_ROOT, "README.md"), "utf-8");

  test("is short enough to be read", () => {
    expect(readme.split("\n").length).toBeLessThan(220);
  });

  test("says what the package is, and shows code, before it explains anything", () => {
    const firstFence = readme.indexOf("```");
    expect(firstFence).toBeGreaterThan(0);
    expect(readme.slice(0, firstFence).split("\n").length).toBeLessThan(20);
  });

  test("links to every document under docs/", () => {
    const linked = new Set(linksOf(path.join(PKG_ROOT, "README.md")).map((t) => t.split("#")[0]!));
    const missing = fs
      .readdirSync(DOCS_DIR)
      .filter((f) => f.endsWith(".md"))
      .filter((f) => !linked.has(`docs/${f}`));
    expect(missing).toEqual([]);
  });
});
