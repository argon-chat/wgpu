/**
 * `GPUAdapter`, its info, its features and its limits.
 *
 * ── Reported limits are passed through unchanged ────────────────────────────────────────────────
 *
 * `maxStorageTexturesPerShaderStage` comes back as **4**. That is wgpu-native reading the
 * `U32_UNDEFINED` sentinel as *the spec default* rather than as the adapter maximum, and it is not
 * a bug to be helpful about. Substituting a larger number because 4 "looks too low" would make this
 * binding disagree with the implementation it wraps, in the direction where a pipeline validates
 * here and fails in the shipped runtime. Every limit is reported exactly as the driver reported it.
 *
 * ── `memoryHeaps` is deliberately absent ────────────────────────────────────────────────────────
 *
 * It is a proprietary extension of the *other* implementation. wgpu-native does not fill it the
 * same way and has been observed reporting 2 TiB of VRAM on a 12 GB card. Consumers already guard
 * on its absence (`if (info.memoryHeaps && …)`), so omitting it is strictly better than inventing a
 * confident wrong number for something downstream code budgets against.
 *
 * ── `wgpuDeviceGetAdapterInfo` aborts ───────────────────────────────────────────────────────────
 *
 * So a device cannot introspect its own adapter. {@link GPUDevice} keeps a reference to the adapter
 * it came from instead; that is why an adapter outlives `requestDevice`.
 */

import { read, toArrayBuffer } from "bun:ffi";

import { seam } from "../ffi/abiSeam.ts";
import { wgpu } from "../ffi/library.ts";
import { asAddress, type Ptr } from "../ffi/pointer.ts";
import { Arena } from "../desc/build.ts";
import { ADAPTER_TYPE_NAMES, BACKEND_NAMES, FEATURE_NAME, featureNameOf, toEnum } from "../enums.ts";
import { requestDevice } from "./device.ts";
import type { GPUDevice } from "./device.ts";
import type { GPU } from "./gpu.ts";

const UTF8 = new TextDecoder();

/** Read a `WGPUStringView` embedded at `offset` inside a struct at `basePtr`. */
function stringViewAt(basePtr: Ptr, offset: number): string {
  const data = read.ptr(basePtr, offset);
  if (data === 0) return "";
  const length = Number(read.u64(basePtr, offset + 8));
  if (length <= 0 || !Number.isSafeInteger(length)) return "";
  // An address C wrote into the struct for us, not a ticket. See src/ffi/pointer.ts.
  return UTF8.decode(new Uint8Array(toArrayBuffer(asAddress(data), 0, length)));
}

/** What `wgpuAdapterGetInfo` reports, plus two non-standard fields this package adds. */
export interface IAdapterInfoFields {
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
  readonly vendorID: number;
  readonly deviceID: number;
  readonly subgroupMinSize: number;
  readonly subgroupMaxSize: number;
  /** Non-standard, and the whole point: which backend this adapter was reached over. */
  readonly backend: string;
  /** Non-standard: `discrete-gpu` / `integrated-gpu` / `cpu` / `unknown`. */
  readonly type: string;
}

export class GPUAdapterInfo implements IAdapterInfoFields {
  readonly vendor: string;
  readonly architecture: string;
  readonly device: string;
  readonly description: string;
  readonly vendorID: number;
  readonly deviceID: number;
  readonly subgroupMinSize: number;
  readonly subgroupMaxSize: number;
  readonly backend: string;
  readonly type: string;

  constructor(f: IAdapterInfoFields) {
    this.vendor = f.vendor;
    this.architecture = f.architecture;
    this.device = f.device;
    this.description = f.description;
    this.vendorID = f.vendorID;
    this.deviceID = f.deviceID;
    this.subgroupMinSize = f.subgroupMinSize;
    this.subgroupMaxSize = f.subgroupMaxSize;
    this.backend = f.backend;
    this.type = f.type;
  }

  /** The one-line banner emitted at device creation. */
  describe(): string {
    return `${this.device || "(unnamed adapter)"} · ${this.backend} · ${this.type} · vendor 0x${this.vendorID.toString(16)}`;
  }
}

/** Every limit `WGPULimits` carries, reported verbatim. */
export type GPULimitsRecord = Record<string, number>;

/** Untyped accessors, for the two places a member name is genuinely dynamic (limits, defaults). */
interface IDynamicView {
  getU32(member: string): number;
  getU64(member: string): bigint;
}

export class GPUAdapter {
  readonly #handle: Ptr;
  readonly #gpu: GPU;
  readonly #info: GPUAdapterInfo;
  readonly #features: Set<string>;
  readonly #limits: GPULimitsRecord;

  constructor(handle: Ptr, gpu: GPU) {
    this.#handle = handle;
    this.#gpu = gpu;
    this.#info = GPUAdapter.#readInfo(handle);
    this.#features = GPUAdapter.#readFeatures(handle);
    this.#limits = GPUAdapter.#readLimits(handle);
  }

  static #readInfo(handle: Ptr): GPUAdapterInfo {
    const arena = new Arena();
    const info = arena.struct("WGPUAdapterInfo");
    const infoPtr = arena.hold(info);
    wgpu().wgpuAdapterGetInfo(handle, infoPtr);
    const off = (member: string): number => info.layout.byName.get(member)!.offset;

    const result = new GPUAdapterInfo({
      vendor: stringViewAt(infoPtr, off("vendor")),
      architecture: stringViewAt(infoPtr, off("architecture")),
      device: stringViewAt(infoPtr, off("device")),
      description: stringViewAt(infoPtr, off("description")),
      vendorID: info.getU32("vendorID"),
      deviceID: info.getU32("deviceID"),
      subgroupMinSize: info.getU32("subgroupMinSize"),
      subgroupMaxSize: info.getU32("subgroupMaxSize"),
      backend: BACKEND_NAMES[info.getEnum("backendType")] ?? "unknown",
      type: ADAPTER_TYPE_NAMES[info.getEnum("adapterType")] ?? "unknown",
    });

    // The strings were allocated by wgpu-native; hand them back. This entry point takes the whole
    // 88-byte struct BY VALUE, which is why it lives behind the ABI seam.
    seam().wgpuAdapterInfoFreeMembers(infoPtr);
    return result;
  }

  static #readFeatures(handle: Ptr): Set<string> {
    const arena = new Arena();
    const supported = arena.struct("WGPUSupportedFeatures");
    const structPtr = arena.hold(supported);
    wgpu().wgpuAdapterGetFeatures(handle, structPtr);

    const count = supported.getCount("featureCount");
    const values = asAddress(supported.getPtr("features"));
    const out = new Set<string>();
    for (let i = 0; i < count; i++) {
      const name = featureNameOf(read.u32(values, i * 4));
      // A native-only feature with no WebGPU spec name is omitted rather than surfaced under an
      // invented string: `features.has(x)` must only be true for names a caller could also write.
      if (name) out.add(name);
    }
    seam().wgpuSupportedFeaturesFreeMembers(structPtr);
    return out;
  }

  static #readLimits(handle: Ptr): GPULimitsRecord {
    const arena = new Arena();
    const limits = arena.struct("WGPULimits");
    const status = wgpu().wgpuAdapterGetLimits(handle, arena.hold(limits));
    const out: GPULimitsRecord = {};
    if (status === 0) return out;
    const dynamic = limits as unknown as IDynamicView;
    for (const field of limits.layout.fields) {
      if (field.tag === "u32") out[field.name] = dynamic.getU32(field.name);
      else if (field.tag === "u64") out[field.name] = Number(dynamic.getU64(field.name));
    }
    return out;
  }

  get handle(): Ptr { return this.#handle; }
  get gpu(): GPU { return this.#gpu; }
  get info(): GPUAdapterInfo { return this.#info; }

  /** A real `Set`, because callers do `adapter.features.has(name)` and iterate it. */
  get features(): ReadonlySet<string> { return this.#features; }

  get limits(): GPULimitsRecord { return this.#limits; }

  /** wgpu-native has no software fallback adapter, so this is honestly always `false`. */
  readonly isFallbackAdapter = false;

  /** Feature probe on the *adapter* — the instance-level probes are aborting stubs. */
  hasFeature(name: string): boolean {
    if (!(name in FEATURE_NAME)) return false;
    return wgpu().wgpuAdapterHasFeature(this.#handle, toEnum(FEATURE_NAME, name, "GPUFeatureName")) !== 0;
  }

  requestDevice(descriptor?: GPUDeviceDescriptor): Promise<GPUDevice> {
    return requestDevice(this, descriptor);
  }

  release(): void {
    wgpu().wgpuAdapterRelease(this.#handle);
  }
}
