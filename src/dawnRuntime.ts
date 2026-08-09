/**
 * Dawn's runtime dependencies on Windows, and why this package ships none of them.
 *
 * ── The problem ─────────────────────────────────────────────────────────────────────────────────
 *
 * Dawn loads two things dynamically on Windows, at the moment they are first needed rather than at
 * library load:
 *
 *   **D3D12** compiles WGSL to DXIL through DXC — `dxcompiler.dll` and `dxil.dll`.
 *   **Vulkan** goes through the loader, `vulkan-1.dll`.
 *
 * Google's release archive contains no DLLs at all, so neither travels with the library. Worse, both
 * failures land at `requestDevice()` or `requestAdapter()` rather than at load, as a Win32 error
 * number attached to a file name:
 *
 *     requestDevice failed (status 3) DynamicLib.Open: dxil.dll Windows Error: 87
 *     Warning: Couldn't load Vulkan: DynamicLib.Open: vulkan-1.dll Windows Error: 87
 *
 * ⚠ **That error 87 is `ERROR_INVALID_PARAMETER`, not "file not found"** — and it appears even for
 * `vulkan-1.dll`, which is in `System32` on every machine with a GPU driver and which this very
 * process can `dlopen` by name. Measured: `bun:ffi` loads it fine and wgpu-native's Vulkan backend
 * gets a real adapter in the same process a moment before Dawn says it cannot. Dawn resolves these
 * by a search that does not include the standard directories; putting a copy next to
 * `webgpu_dawn.dll` makes it work, which is the shape of a per-module search path.
 *
 * ── The decision: redistribute nothing, copy nothing ────────────────────────────────────────────
 *
 * `dxil.dll` is closed-source Microsoft code — the shader-signing library, which only Microsoft can
 * produce. Putting it in an npm package would mean adopting someone else's redistribution terms and
 * adding a binary to the supply chain that this repository can neither build nor verify, in a
 * package whose entire pitch is that every binary is traceable to a pin. `vulkan-1.dll` belongs to
 * the user's driver installation. Neither is ours to ship.
 *
 * Copying them beside the library at install time was the other candidate and is worse: this package
 * has **no postinstall hook** on purpose (see docs/PACKAGING.md), and writing files into
 * `node_modules` at runtime is not a thing a GPU binding should do.
 *
 * So: **preload what is already on the machine, by absolute path, before Dawn asks.** Once a module
 * is resident, Dawn's own search finds it. Measured, both paths, on a real device:
 *
 *   - preload `System32\vulkan-1.dll` → Dawn's Vulkan backend reports NVIDIA RTX 5070, no copies;
 *   - preload the Windows SDK's `dxil.dll` + `dxcompiler.dll` → Dawn's D3D12 backend, same device.
 *
 * Nothing is installed, nothing is copied, and a machine that has neither gets an error naming both
 * options instead of a Win32 number.
 */

import { dlopen, FFIType } from "bun:ffi";
import * as fs from "node:fs";
import * as path from "node:path";

import { DAWN_WINDOWS_RUNTIME_FILES, DAWN_WINDOWS_VULKAN_LOADER } from "../dawn.manifest.ts";

/**
 * Handles kept for the life of the process.
 *
 * The point of the preload is that the module stays resident, so these must not be collected. A
 * module-level array is the whole mechanism.
 */
const resident: unknown[] = [];

/** A dependency, and one symbol it really exports — a probe needs a name that exists. */
interface IDependency {
  readonly file: string;
  readonly symbol: string;
}

// File names from the manifest, so the record of *what Dawn needs* and the code that finds it cannot
// drift — the same rule the rest of this package follows for pins.
const VULKAN: IDependency = { file: DAWN_WINDOWS_VULKAN_LOADER, symbol: "vkGetInstanceProcAddr" };
const DXC: readonly IDependency[] = DAWN_WINDOWS_RUNTIME_FILES.map((file) => ({
  file,
  symbol: "DxcCreateInstance",
}));

/** Load one DLL by absolute path and keep it resident. `false` when it is not there or will not load. */
function preload(absolutePath: string, symbol: string): boolean {
  if (!fs.existsSync(absolutePath)) return false;
  try {
    // A real exported symbol, not a placeholder: `dlopen` with an absent name throws, and a throw
    // here would be indistinguishable from "the file is not loadable".
    resident.push(dlopen(absolutePath, { [symbol]: { args: [], returns: FFIType.ptr } }));
    return true;
  } catch {
    return false;
  }
}

/** Windows SDK `bin/<version>/x64` directories, newest first. */
function sdkBinDirs(): string[] {
  const roots = [
    process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
    process.env["ProgramFiles"] ?? "C:\\Program Files",
  ];
  const found: string[] = [];
  for (const root of roots) {
    const bin = path.join(root, "Windows Kits", "10", "bin");
    let versions: string[];
    try {
      versions = fs.readdirSync(bin);
    } catch {
      continue;
    }
    for (const v of versions.sort().reverse()) found.push(path.join(bin, v, "x64"));
  }
  return found;
}

/** What Dawn can actually use on this host, after the preload. */
export interface IDawnWindowsDeps {
  /** The Vulkan loader is resident — Dawn's Vulkan backend will work. */
  readonly vulkan: boolean;
  /** Both DXC libraries are resident — Dawn's D3D12 backend will work. */
  readonly dxc: boolean;
  /** Absolute paths that were looked at, for an error message worth reading. */
  readonly searched: readonly string[];
}

/**
 * Keyed by the directory searched, not a single slot.
 *
 * The preload must happen once per process — that is the whole mechanism — but *what was found* is a
 * function of where it looked. A single cached answer makes the first caller's directory the answer
 * for every later one, which is wrong the moment two libraries are involved and was wrong
 * immediately in the test that asks what a different directory would yield.
 */
const cache = new Map<string, IDawnWindowsDeps>();

/**
 * Make Dawn's Windows dependencies resident, from wherever they already are on this machine.
 *
 * Called once, before the instance is created. On any other platform, or under wgpu-native, this is
 * not reached: wgpu-native links its D3D12 path without DXC and loads Vulkan through the normal
 * search, so neither problem exists there.
 */
export function preloadDawnWindowsDeps(libDir: string): IDawnWindowsDeps {
  const hit = cache.get(libDir);
  if (hit) return hit;

  const searched: string[] = [];
  const system32 = path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32");

  // Beside the library first: someone who put a specific build there meant it.
  const vulkanCandidates = [path.join(libDir, VULKAN.file), path.join(system32, VULKAN.file)];
  let vulkan = false;
  for (const candidate of vulkanCandidates) {
    searched.push(candidate);
    if (preload(candidate, VULKAN.symbol)) {
      vulkan = true;
      break;
    }
  }

  // DXC is two files and needs both; a directory that has only one of them is not a hit.
  let dxc = false;
  for (const dir of [libDir, ...sdkBinDirs()]) {
    const paths = DXC.map((d) => path.join(dir, d.file));
    searched.push(...paths);
    if (!paths.every((p) => fs.existsSync(p))) continue;
    if (DXC.every((d, i) => preload(paths[i]!, d.symbol))) {
      dxc = true;
      break;
    }
  }

  const deps: IDawnWindowsDeps = { vulkan, dxc, searched };
  cache.set(libDir, deps);
  return deps;
}

/**
 * What to tell someone whose machine has neither.
 *
 * Both options, both actionable, and an explicit statement that this package does not ship them —
 * otherwise the obvious reading of a missing DLL is that the install is broken.
 */
export function dawnWindowsDepsMessage(deps: IDawnWindowsDeps): string {
  return (
    `wgpu-bun: Dawn on Windows needs one of its runtime dependencies, and neither is on this machine.\n` +
    `  Vulkan  — vulkan-1.dll, installed with any GPU driver (and by the Vulkan SDK)\n` +
    `  D3D12   — dxcompiler.dll + dxil.dll, from the Windows SDK or Microsoft's\n` +
    `            DirectXShaderCompiler releases\n` +
    `  This package deliberately ships neither: dxil.dll is closed-source Microsoft code and\n` +
    `  vulkan-1.dll belongs to your driver installation. Either install one, or drop the DLLs next\n` +
    `  to the Dawn library — both are found automatically once present.\n` +
    `  Looked at:\n` +
    deps.searched.map((s) => `    ${s}`).join("\n")
  );
}
