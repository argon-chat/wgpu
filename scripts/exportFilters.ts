/**
 * What the linker is told to export, in the three dialects the platforms speak.
 *
 * The fused library carries **two** surfaces: Dawn's 277 `wgpu*` entry points, and the 15
 * `wgpu_bun_shim_*` trampolines linked in from the Rust staticlib. Each platform expresses "export
 * exactly these" differently — a `.def` file, a Mach-O symbol list, an ELF version script — and each
 * one is a separate opportunity to remember one surface and forget the other on one platform.
 *
 * They live here, as pure functions over a name list, so the "both surfaces, everywhere" property is
 * a test rather than three code reviews. That is not hypothetical caution: the export filter is
 * already the component that shipped a silently empty list once, and an ELF version script does not
 * fail when a pattern matches nothing.
 *
 * @see test/export-filters.test.ts
 * @see scripts/dawn-link.ts, the only caller
 */

/**
 * Windows: a module-definition file.
 *
 * Needed because Dawn's `WGPU_EXPORT` expands to nothing in a static configuration — the objects
 * carry no `dllexport` at all, so without this the DLL exports nothing. Naming the exports also
 * makes the link *fail* on a name the archives do not define, which is the check that the header and
 * the binaries came from the same release.
 */
export function windowsDefFile(names: readonly string[]): string {
  return `EXPORTS\n${names.map((n) => `    ${n}`).join("\n")}\n`;
}

/**
 * macOS: an exported-symbols list, in Mach-O's underscore-prefixed spelling.
 *
 * ⚠ An **empty** list here is not an error — it is a valid instruction to export nothing, which `ld`
 * carries out without a word. The caller therefore validates the name list before writing it; this
 * function only translates.
 */
export function machOExportsList(names: readonly string[]): string {
  return `${names.map((n) => `_${n}`).join("\n")}\n`;
}

/**
 * Linux: a version script, by pattern rather than by name.
 *
 * `wgpu*` covers both surfaces, and it is worth being explicit that this is a fact and not a
 * convenience: the shim's exports are named `wgpu_bun_shim_*` precisely so that one pattern holds
 * for everything this library is supposed to expose, while Rust's std symbols — which the staticlib
 * drags in and nobody should link against — fall to `local: *`.
 *
 * {@link coveredByElfScript} exists so a test can check that claim against the real name lists
 * instead of trusting the glob.
 */
export const ELF_GLOBAL_PATTERNS: readonly string[] = ["wgpu*"];

export function elfVersionScript(): string {
  return `{ global: ${ELF_GLOBAL_PATTERNS.join("; ")}; local: *; };\n`;
}

/** Does the version script export this name? Same glob semantics `ld` applies. */
export function coveredByElfScript(name: string): boolean {
  return ELF_GLOBAL_PATTERNS.some((pattern) => {
    const rx = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
    return rx.test(name);
  });
}
