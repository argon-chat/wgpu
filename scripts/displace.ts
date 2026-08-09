/**
 * Replacing a shared library that something might have mapped.
 *
 * On Windows a loaded DLL cannot be unlinked or overwritten — the copy fails with `EBUSY`, and a
 * recursive delete that has already removed a sibling directory fails **part way through**, leaving
 * a half-installed tree. That is not a rare state on this project: the editor, a test run, or a
 * background task can be holding `wgpu_native.dll` or the ABI shim at the moment someone re-fetches.
 *
 * A rename, unlike an unlink, is permitted while the image is mapped. So the sequence is: try to
 * delete; if that fails, move the old file aside under a `.stale-*` name and let the next run sweep
 * it once whatever had it open has exited.
 *
 * Shared by `fetch-wgpu-native.ts` and `shim.ts` rather than written twice — the two install into
 * the *same* `vendor/<rid>/lib/` directory, and two subtly different answers to "how do we replace a
 * locked library" is how one of them ends up being the one that corrupts the directory.
 */
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Make `libPath` writable: delete it, or move it aside if it is mapped.
 *
 * Also sweeps any `.stale-*` copies left by earlier runs, best-effort — they are unlinkable once the
 * process that had them open is gone, and leaving them forever would turn a workaround into litter.
 */
export function displace(libPath: string): void {
  if (!fs.existsSync(libPath)) return;

  const dir = path.dirname(libPath);
  const base = path.basename(libPath);
  for (const entry of fs.readdirSync(dir)) {
    if (entry.startsWith(`${base}.stale-`)) {
      try {
        fs.unlinkSync(path.join(dir, entry));
      } catch {
        // Still mapped by something. It will be swept next time.
      }
    }
  }

  try {
    fs.unlinkSync(libPath);
    return;
  } catch {
    // Loaded somewhere. Rename it instead — permitted even while mapped.
  }
  fs.renameSync(libPath, path.join(dir, `${base}.stale-${Date.now().toString(36)}`));
}
