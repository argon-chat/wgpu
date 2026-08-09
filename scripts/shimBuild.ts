/**
 * Building the shim crate — one `cargo` invocation, two consumers.
 *
 * `shim/` emits both artefacts from a single build:
 *
 *   **cdylib** — the standalone library that ships beside wgpu-native and is `dlopen`ed by the seam.
 *   **staticlib** — the same objects, fused into the Dawn library at link time so that a Dawn
 *   install is one file carrying both the C API and these trampolines.
 *
 * They come out of the same compilation, so the fused copy cannot drift from the standalone one:
 * there is no second build with its own flags to keep in sync.
 *
 * ── Why this is a module and not a line in each caller ──────────────────────────────────────────
 *
 * `scripts/shim.ts` and `scripts/dawn-link.ts` both need it, and the invocation carries decisions
 * that must not be re-made independently — the release profile, the target triple mapping, and, on
 * Linux, the fact that it has to run **inside the same container as the C++ link**. A shim built on
 * a bare `ubuntu-latest` and fused into a library linked in `manylinux_2_28` silently raises the
 * glibc floor of the result: Rust's std pulls in whatever the build host's glibc offers, so the
 * fused library then requires that glibc, and the container that exists to hold the floor holds
 * nothing. It works in CI, works on the maintainer's machine, and fails on the distribution the
 * floor was for.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { rustTargetFor, shimFileNameFor, shimRids } from "../shim.manifest.ts";
import { currentRid, platformOf, type Rid } from "../wgpu-native.manifest.ts";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHIM_CRATE = path.join(PKG_ROOT, "shim");

/** Both artefacts of one build. */
export interface IShimArtifacts {
  /** The Rust target triple they were built for. */
  readonly target: string;
  /** Loadable library — `wgpu_bun_shim.dll` / `libwgpu_bun_shim.so` / `.dylib`. */
  readonly cdylib: string;
  /** Static archive for fusing — `wgpu_bun_shim.lib` / `libwgpu_bun_shim.a`. */
  readonly staticlib: string;
}

/** What cargo names the static archive on this platform. */
export function shimStaticFileNameFor(rid: Rid): string {
  return platformOf(rid) === "win32" ? "wgpu_bun_shim.lib" : "libwgpu_bun_shim.a";
}

export interface IBuildOptions {
  /**
   * Docker image to run `cargo` inside, or `""` for the host.
   *
   * Set on the Linux leg to the same image the C++ link uses. Rust is installed into the workspace
   * on first use — `CARGO_HOME` and `RUSTUP_HOME` point at `shim/.container-rust` so the container
   * needs no writable `$HOME` and a rebuild does not re-download the toolchain.
   */
  readonly container?: string;
  /** Called with each command before it runs, for the caller's own logging. */
  readonly onCommand?: (command: string) => void;
}

/**
 * Build the crate for `rid` and return both artefacts.
 *
 * Throws — with the reason, not just a status — rather than returning a partial result. Every caller
 * treats a failed shim build as fatal, so a `null` return would only be unwrapped at each site.
 */
export function buildShimCrate(rid: Rid, opts: IBuildOptions = {}): IShimArtifacts {
  const target = rustTargetFor(rid);
  if (!target) {
    throw new Error(
      `no Rust target is mapped for RID "${rid}". Known: ${shimRids().join(", ")}. ` +
        `Add one to rustTargetFor() in shim.manifest.ts if this is a platform worth supporting.`,
    );
  }

  const container = opts.container ?? "";
  if (container) buildInContainer(container, target, opts);
  else buildOnHost(target, opts);

  const dir = path.join(SHIM_CRATE, "target", target, "release");
  const artifacts: IShimArtifacts = {
    target,
    cdylib: path.join(dir, shimFileNameFor(rid)),
    staticlib: path.join(dir, shimStaticFileNameFor(rid)),
  };

  for (const [kind, file] of [
    ["cdylib", artifacts.cdylib],
    ["staticlib", artifacts.staticlib],
  ] as const) {
    if (!fs.existsSync(file)) {
      throw new Error(
        `cargo reported success but the ${kind} ${path.relative(PKG_ROOT, file)} does not exist.\n` +
          `That usually means shim/Cargo.toml no longer lists "${kind}" in crate-type.`,
      );
    }
  }
  return artifacts;
}

function buildOnHost(target: string, opts: IBuildOptions): void {
  const args = ["build", "--release", "--target", target];
  opts.onCommand?.(`cargo ${args.join(" ")}`);
  if (target !== rustTargetFor(currentRid())) {
    // Cross-compiling needs a linker for the target, which cargo does not supply. Saying so before
    // the failure is cheaper than a linker error nobody reads.
    console.warn(
      `\x1b[33mwarn\x1b[0m   cross-building for ${target} from ${currentRid()}: this needs ` +
        `\`rustup target add ${target}\` and a linker for that target.`,
    );
  }
  const r = spawnSync("cargo", args, { cwd: SHIM_CRATE, stdio: "inherit" });
  if (r.error) throw new Error(`cargo: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`cargo build exited ${r.status}`);
}

/**
 * Run the build inside a container, installing Rust into the workspace on first use.
 *
 * `rustup` rather than a distribution package: the images that hold an old glibc floor hold an old
 * everything else too, and this crate needs 1.82 for `unsafe extern` blocks. The install is
 * idempotent and lands in the mounted workspace, so it survives between steps of the same job.
 */
function buildInContainer(image: string, target: string, opts: IBuildOptions): void {
  // Mounted at its own path, exactly as `dawn-link.ts` does for the compiler, so that every path in
  // cargo's output means the same thing inside and outside the container.
  const rustDir = `${PKG_ROOT}/shim/.container-rust`;
  const script = [
    "set -e",
    `export CARGO_HOME=${rustDir}/cargo RUSTUP_HOME=${rustDir}/rustup`,
    `export PATH=$CARGO_HOME/bin:$PATH`,
    // ⚠ The test is whether cargo **runs**, not whether it is on PATH. `dockcross/manylinux_2_28-x64`
    // already ships rustup's shims, so `command -v cargo` succeeds — and then the shim exits with
    // "could not choose a version of cargo to run, because one wasn't specified explicitly", because
    // the image configures no default toolchain (and this build points RUSTUP_HOME at an empty
    // workspace directory anyway). A presence check answered the wrong question and skipped the
    // install that would have fixed it.
    `if ! cargo --version >/dev/null 2>&1; then`,
    `  if command -v rustup >/dev/null 2>&1; then`,
    // rustup is already there — it just has nothing selected. Installing over it would be a second
    // toolchain in the same image; selecting one is the actual repair.
    `    rustup default stable`,
    `  else`,
    `    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable --no-modify-path`,
    `  fi`,
    `fi`,
    // Printed, so the log records which toolchain actually produced the fused objects rather than
    // leaving it to be inferred from the image tag.
    `cargo --version && rustc --version`,
    `cd ${PKG_ROOT}/shim && cargo build --release --target ${target}`,
  ].join("\n");

  opts.onCommand?.(`docker run ${image} — cargo build --release --target ${target}`);
  const r = spawnSync(
    "docker",
    ["run", "--rm", "-v", `${PKG_ROOT}:${PKG_ROOT}`, "-w", PKG_ROOT, image, "sh", "-c", script],
    { stdio: "inherit" },
  );
  if (r.error) throw new Error(`docker: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`cargo build in ${image} exited ${r.status}`);
}
