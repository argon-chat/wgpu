/**
 * WebGPU spec strings ↔ wgpu-native enum values.
 *
 * ── How these tables were built ─────────────────────────────────────────────────────────────────
 *
 * Not by hand. Every C enumerator in the pinned `webgpu.h` was matched against the string union of
 * the corresponding `@webgpu/types` alias after normalising both sides (lowercase, strip every
 * non-alphanumeric character). `WGPUTextureFormat_ASTC10x10UnormSrgb` and `"astc-10x10-unorm-srgb"`
 * both normalise to `astc10x10unormsrgb`, so they pair without anyone deciding where the hyphens
 * go. All 101 texture formats and all 41 vertex formats matched; nothing was left over on either
 * side.
 *
 * That matters because these tables are otherwise a large surface of plausible-looking typos, and a
 * wrong format number is not a crash — it is a texture that renders as something else.
 *
 * ── Enumerator numbering is not what a reader expects ───────────────────────────────────────────
 *
 * In v29 the binding-layout enums start at `BindingNotUsed = 0`, then `Undefined = 1`, and only
 * then the real values. So `"uniform"` is **2**, not 0. An off-by-one here is the difference
 * between a uniform buffer and a storage buffer, and — worse — a zeroed sub-layout reads as
 * `BindingNotUsed`, which is exactly the state that makes wgpu-native **panic** in `conv.rs`
 * instead of reporting a validation error. See {@link ./api/bindings.ts}, which refuses to emit
 * such an entry.
 *
 * ── On unknown values ───────────────────────────────────────────────────────────────────────────
 *
 * {@link toEnum} throws on a string it does not know. It never falls back to 0. A zero written for
 * an unmapped format or binding kind is precisely how "the whole 3D stack could not boot natively"
 * happens: the descriptor looks structurally fine, and the process aborts inside Rust with no JS
 * stack to attribute it to.
 */

/** A spec-string → C-value table. */
export type EnumTable = Readonly<Record<string, number>>;

/* eslint-disable @typescript-eslint/naming-convention -- keys are WebGPU spec strings. */

export const TEXTURE_FORMAT: EnumTable = {"r8unorm":1,"r8snorm":2,"r8uint":3,"r8sint":4,"r16unorm":5,"r16snorm":6,"r16uint":7,"r16sint":8,"r16float":9,"rg8unorm":10,"rg8snorm":11,"rg8uint":12,"rg8sint":13,"r32float":14,"r32uint":15,"r32sint":16,"rg16unorm":17,"rg16snorm":18,"rg16uint":19,"rg16sint":20,"rg16float":21,"rgba8unorm":22,"rgba8unorm-srgb":23,"rgba8snorm":24,"rgba8uint":25,"rgba8sint":26,"bgra8unorm":27,"bgra8unorm-srgb":28,"rgb10a2uint":29,"rgb10a2unorm":30,"rg11b10ufloat":31,"rgb9e5ufloat":32,"rg32float":33,"rg32uint":34,"rg32sint":35,"rgba16unorm":36,"rgba16snorm":37,"rgba16uint":38,"rgba16sint":39,"rgba16float":40,"rgba32float":41,"rgba32uint":42,"rgba32sint":43,"stencil8":44,"depth16unorm":45,"depth24plus":46,"depth24plus-stencil8":47,"depth32float":48,"depth32float-stencil8":49,"bc1-rgba-unorm":50,"bc1-rgba-unorm-srgb":51,"bc2-rgba-unorm":52,"bc2-rgba-unorm-srgb":53,"bc3-rgba-unorm":54,"bc3-rgba-unorm-srgb":55,"bc4-r-unorm":56,"bc4-r-snorm":57,"bc5-rg-unorm":58,"bc5-rg-snorm":59,"bc6h-rgb-ufloat":60,"bc6h-rgb-float":61,"bc7-rgba-unorm":62,"bc7-rgba-unorm-srgb":63,"etc2-rgb8unorm":64,"etc2-rgb8unorm-srgb":65,"etc2-rgb8a1unorm":66,"etc2-rgb8a1unorm-srgb":67,"etc2-rgba8unorm":68,"etc2-rgba8unorm-srgb":69,"eac-r11unorm":70,"eac-r11snorm":71,"eac-rg11unorm":72,"eac-rg11snorm":73,"astc-4x4-unorm":74,"astc-4x4-unorm-srgb":75,"astc-5x4-unorm":76,"astc-5x4-unorm-srgb":77,"astc-5x5-unorm":78,"astc-5x5-unorm-srgb":79,"astc-6x5-unorm":80,"astc-6x5-unorm-srgb":81,"astc-6x6-unorm":82,"astc-6x6-unorm-srgb":83,"astc-8x5-unorm":84,"astc-8x5-unorm-srgb":85,"astc-8x6-unorm":86,"astc-8x6-unorm-srgb":87,"astc-8x8-unorm":88,"astc-8x8-unorm-srgb":89,"astc-10x5-unorm":90,"astc-10x5-unorm-srgb":91,"astc-10x6-unorm":92,"astc-10x6-unorm-srgb":93,"astc-10x8-unorm":94,"astc-10x8-unorm-srgb":95,"astc-10x10-unorm":96,"astc-10x10-unorm-srgb":97,"astc-12x10-unorm":98,"astc-12x10-unorm-srgb":99,"astc-12x12-unorm":100,"astc-12x12-unorm-srgb":101};

export const VERTEX_FORMAT: EnumTable = {"uint8":1,"uint8x2":2,"uint8x4":3,"sint8":4,"sint8x2":5,"sint8x4":6,"unorm8":7,"unorm8x2":8,"unorm8x4":9,"snorm8":10,"snorm8x2":11,"snorm8x4":12,"uint16":13,"uint16x2":14,"uint16x4":15,"sint16":16,"sint16x2":17,"sint16x4":18,"unorm16":19,"unorm16x2":20,"unorm16x4":21,"snorm16":22,"snorm16x2":23,"snorm16x4":24,"float16":25,"float16x2":26,"float16x4":27,"float32":28,"float32x2":29,"float32x3":30,"float32x4":31,"uint32":32,"uint32x2":33,"uint32x3":34,"uint32x4":35,"sint32":36,"sint32x2":37,"sint32x3":38,"sint32x4":39,"unorm10-10-10-2":40,"unorm8x4-bgra":41};

export const FEATURE_NAME: EnumTable = {"core-features-and-limits":1,"depth-clip-control":2,"depth32float-stencil8":3,"texture-compression-bc":4,"texture-compression-bc-sliced-3d":5,"texture-compression-etc2":6,"texture-compression-astc":7,"texture-compression-astc-sliced-3d":8,"timestamp-query":9,"indirect-first-instance":10,"shader-f16":11,"rg11b10ufloat-renderable":12,"bgra8unorm-storage":13,"float32-filterable":14,"float32-blendable":15,"clip-distances":16,"dual-source-blending":17,"subgroups":18,"texture-formats-tier1":19,"texture-formats-tier2":20,"primitive-index":21,"texture-component-swizzle":22};

export const COMPARE_FUNCTION: EnumTable = {"never":1,"less":2,"equal":3,"less-equal":4,"greater":5,"not-equal":6,"greater-equal":7,"always":8};
export const ADDRESS_MODE: EnumTable = {"clamp-to-edge":1,"repeat":2,"mirror-repeat":3};
export const FILTER_MODE: EnumTable = {"nearest":1,"linear":2};
export const MIPMAP_FILTER_MODE: EnumTable = {"nearest":1,"linear":2};
export const BLEND_FACTOR: EnumTable = {"zero":1,"one":2,"src":3,"one-minus-src":4,"src-alpha":5,"one-minus-src-alpha":6,"dst":7,"one-minus-dst":8,"dst-alpha":9,"one-minus-dst-alpha":10,"src-alpha-saturated":11,"constant":12,"one-minus-constant":13,"src1":14,"one-minus-src1":15,"src1-alpha":16,"one-minus-src1-alpha":17};
export const BLEND_OPERATION: EnumTable = {"add":1,"subtract":2,"reverse-subtract":3,"min":4,"max":5};
export const STENCIL_OPERATION: EnumTable = {"keep":1,"zero":2,"replace":3,"invert":4,"increment-clamp":5,"decrement-clamp":6,"increment-wrap":7,"decrement-wrap":8};
export const PRIMITIVE_TOPOLOGY: EnumTable = {"point-list":1,"line-list":2,"line-strip":3,"triangle-list":4,"triangle-strip":5};
export const INDEX_FORMAT: EnumTable = {"uint16":1,"uint32":2};
export const FRONT_FACE: EnumTable = {"ccw":1,"cw":2};
export const CULL_MODE: EnumTable = {"none":1,"front":2,"back":3};
export const VERTEX_STEP_MODE: EnumTable = {"vertex":1,"instance":2};
export const LOAD_OP: EnumTable = {"load":1,"clear":2};
export const STORE_OP: EnumTable = {"store":1,"discard":2};
export const QUERY_TYPE: EnumTable = {"occlusion":1,"timestamp":2};
export const ERROR_FILTER: EnumTable = {"validation":1,"out-of-memory":2,"internal":3};
export const POWER_PREFERENCE: EnumTable = {"low-power":1,"high-performance":2};
export const TEXTURE_DIMENSION: EnumTable = {"1d":1,"2d":2,"3d":3};
export const TEXTURE_VIEW_DIMENSION: EnumTable = {"1d":1,"2d":2,"2d-array":3,"cube":4,"cube-array":5,"3d":6};
export const TEXTURE_ASPECT: EnumTable = {"all":1,"stencil-only":2,"depth-only":3};

/** Note the numbering: `BindingNotUsed = 0`, `Undefined = 1`, then the real kinds. */
export const BUFFER_BINDING_TYPE: EnumTable = {"uniform":2,"storage":3,"read-only-storage":4};
export const SAMPLER_BINDING_TYPE: EnumTable = {"filtering":2,"non-filtering":3,"comparison":4};
export const TEXTURE_SAMPLE_TYPE: EnumTable = {"float":2,"unfilterable-float":3,"depth":4,"sint":5,"uint":6};
export const STORAGE_TEXTURE_ACCESS: EnumTable = {"write-only":2,"read-only":3,"read-write":4};

/* eslint-enable @typescript-eslint/naming-convention */

/** The value every binding-layout enum uses for "this entry is not of this kind". */
export const BINDING_NOT_USED = 0;

/** C enum values that have no WebGPU spec string, needed by the plumbing rather than by callers. */
export const C = {
  sType: { shaderSourceWGSL: 2 },
  callbackMode: { waitAnyOnly: 1, allowProcessEvents: 2, allowSpontaneous: 3 },
  requestAdapterStatus: { success: 1, unavailable: 3, error: 4 },
  requestDeviceStatus: { success: 1, error: 3 },
  mapAsyncStatus: { success: 1, error: 3, aborted: 4 },
  popErrorScopeStatus: { success: 1, error: 3 },
  queueWorkDoneStatus: { success: 1, error: 3 },
  errorType: { noError: 1, validation: 2, outOfMemory: 3, internal: 4, unknown: 5 },
  featureLevel: { compatibility: 1, core: 2 },
  optionalBool: { false: 0, true: 1, undefined: 2 },
  backendType: { undefined: 0, null: 1, webGPU: 2, d3d11: 3, d3d12: 4, metal: 5, vulkan: 6, openGL: 7, openGLES: 8 },
  adapterType: { discreteGPU: 1, integratedGPU: 2, cpu: 3, unknown: 4 },
} as const;

/** Human-readable backend names, indexed by `WGPUBackendType`. Reported, never inferred. */
export const BACKEND_NAMES: readonly string[] = [
  "undefined", "null", "webgpu", "d3d11", "d3d12", "metal", "vulkan", "opengl", "opengles",
];

/** Human-readable adapter types, indexed by `WGPUAdapterType`. */
export const ADAPTER_TYPE_NAMES: readonly string[] = [
  "unknown", "discrete-gpu", "integrated-gpu", "cpu", "unknown",
];

/** Reverse lookup, built once, so `WGPUFeatureName` values can be reported as spec strings. */
const FEATURE_BY_VALUE = new Map<number, string>(
  Object.entries(FEATURE_NAME).map(([name, value]) => [value, name]),
);

/** Spec string for a `WGPUFeatureName`, or `null` for a native-only feature with no spec name. */
export function featureNameOf(value: number): string | null {
  return FEATURE_BY_VALUE.get(value) ?? null;
}

/**
 * Map a WebGPU spec string to its wgpu-native value.
 *
 * @throws on anything unknown. Never returns 0 as a fallback — see the module note; a zeroed enum
 *         is how a descriptor becomes structurally invalid in a way that aborts rather than errors.
 */
export function toEnum(table: EnumTable, value: string | undefined, what: string): number {
  if (value === undefined) {
    throw new Error(`wgpu-bun: ${what} is required but was not provided.`);
  }
  const mapped = table[value];
  if (mapped === undefined) {
    throw new Error(
      `wgpu-bun: "${value}" is not a valid ${what} for wgpu-native v29. ` +
        `Known values: ${Object.keys(table).join(", ")}.`,
    );
  }
  return mapped;
}

/** {@link toEnum}, but `undefined` maps to the C `Undefined` sentinel (0) instead of throwing. */
export function toEnumOrUndefined(table: EnumTable, value: string | undefined, what: string): number {
  return value === undefined ? 0 : toEnum(table, value, what);
}
