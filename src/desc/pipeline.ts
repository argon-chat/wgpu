/**
 * Descriptor packing for compute and render pipelines.
 *
 * `layout: "auto"` is spelled as a NULL `layout` pointer, which is how `webgpu.h` asks for an
 * implicit layout. That works here because the WGSL front end reflects the module — it would *not*
 * work for a SPIR-V passthrough module, which carries no reflection, and this package has no
 * passthrough path for exactly that reason.
 *
 * Everything with a spec default is written explicitly rather than left to the C `INIT` value.
 * The two are usually the same, but not always: `WGPUPrimitiveState.topology` initialises to
 * `Undefined` while the WebGPU default is `triangle-list`, and `WGPUMultisampleState` is reached
 * through `sub()`, which by design does not apply per-struct defaults. Writing them out is the only
 * form that cannot drift when either default moves.
 */

import type { Arena } from "./build.ts";
import {
  BLEND_FACTOR,
  BLEND_OPERATION,
  COMPARE_FUNCTION,
  CULL_MODE,
  FRONT_FACE,
  INDEX_FORMAT,
  PRIMITIVE_TOPOLOGY,
  STENCIL_OPERATION,
  TEXTURE_FORMAT,
  VERTEX_FORMAT,
  VERTEX_STEP_MODE,
  toEnum,
} from "../enums.ts";
import type { Ptr } from "../ffi/pointer.ts";
import type { CStructView } from "../layouts/index.ts";
import type { IHandleOwner } from "./bindings.ts";

/** `layout: "auto"` → NULL; anything else must be a real `GPUPipelineLayout`. */
function layoutPointer(layout: GPUPipelineLayout | "auto"): Ptr | null {
  return layout === "auto" ? null : (layout as unknown as IHandleOwner).handle;
}

/** Shared shape of `WGPUComputeState`, `WGPUVertexState` and `WGPUFragmentState`. */
type ProgrammableStage = CStructView<"WGPUComputeState" | "WGPUVertexState" | "WGPUFragmentState">;

function writeStage(
  arena: Arena,
  stage: ProgrammableStage,
  descriptor: GPUProgrammableStage,
): void {
  stage.setPtr("module", (descriptor.module as unknown as IHandleOwner).handle);
  arena.writeString(stage.sub("entryPoint"), descriptor.entryPoint);

  const constants = descriptor.constants ? Object.entries(descriptor.constants) : [];
  if (constants.length === 0) return;
  const array = arena.structArray("WGPUConstantEntry", constants.length);
  constants.forEach(([key, value], index) => {
    const entry = array.at(index);
    arena.writeString(entry.sub("key"), key);
    entry.setF64("value", value);
  });
  stage.setUsize("constantCount", constants.length);
  stage.setPtr("constants", arena.hold(array));
}

export function packComputePipelineDescriptor(
  arena: Arena,
  descriptor: GPUComputePipelineDescriptor,
): Ptr {
  const d = arena.struct("WGPUComputePipelineDescriptor");
  arena.writeString(d.sub("label"), descriptor.label);
  d.setPtr("layout", layoutPointer(descriptor.layout));
  writeStage(arena, d.sub("compute"), descriptor.compute);
  return arena.hold(d);
}

function writeVertexBuffers(
  arena: Arena,
  vertex: CStructView<"WGPUVertexState">,
  buffers: GPUVertexState["buffers"],
): void {
  const list = buffers ? Array.from(buffers) : [];
  if (list.length === 0) return;

  const array = arena.structArray("WGPUVertexBufferLayout", list.length);
  list.forEach((layout, index) => {
    const b = array.at(index);
    // A `null` entry is the spec's way of saying "this slot is unused"; the C side spells that
    // with a zero stride and no attributes, which is what the zeroed element already is.
    if (!layout) return;
    b.setU64("arrayStride", BigInt(layout.arrayStride));
    b.setEnum("stepMode", toEnum(VERTEX_STEP_MODE, layout.stepMode ?? "vertex", "GPUVertexStepMode"));

    const attributes = Array.from(layout.attributes);
    const attrArray = arena.structArray("WGPUVertexAttribute", attributes.length);
    attributes.forEach((attribute, i) => {
      const a = attrArray.at(i);
      a.setEnum("format", toEnum(VERTEX_FORMAT, attribute.format, "GPUVertexFormat"));
      a.setU64("offset", BigInt(attribute.offset));
      a.setU32("shaderLocation", attribute.shaderLocation);
    });
    b.setUsize("attributeCount", attributes.length);
    b.setPtr("attributes", attributes.length > 0 ? arena.hold(attrArray) : null);
  });

  vertex.setUsize("bufferCount", list.length);
  vertex.setPtr("buffers", arena.hold(array));
}

function writeBlendComponent(
  view: CStructView<"WGPUBlendComponent">,
  component: GPUBlendComponent | undefined,
): void {
  view.setEnum("operation", toEnum(BLEND_OPERATION, component?.operation ?? "add", "GPUBlendOperation"));
  view.setEnum("srcFactor", toEnum(BLEND_FACTOR, component?.srcFactor ?? "one", "GPUBlendFactor"));
  view.setEnum("dstFactor", toEnum(BLEND_FACTOR, component?.dstFactor ?? "zero", "GPUBlendFactor"));
}

function writeFragment(
  arena: Arena,
  fragment: GPUFragmentState,
): Ptr {
  const f = arena.struct("WGPUFragmentState");
  writeStage(arena, f, fragment);

  const targets = Array.from(fragment.targets);
  const array = arena.structArray("WGPUColorTargetState", targets.length);
  targets.forEach((target, index) => {
    const t = array.at(index);
    if (!target) return; // a null target means "no output at this location"
    t.setEnum("format", toEnum(TEXTURE_FORMAT, target.format, "GPUTextureFormat"));
    if (target.writeMask !== undefined) t.setFlags("writeMask", BigInt(target.writeMask));
    if (target.blend) {
      const blend = arena.struct("WGPUBlendState");
      writeBlendComponent(blend.sub("color"), target.blend.color);
      writeBlendComponent(blend.sub("alpha"), target.blend.alpha);
      t.setPtr("blend", arena.hold(blend));
    }
  });
  f.setUsize("targetCount", targets.length);
  f.setPtr("targets", targets.length > 0 ? arena.hold(array) : null);
  return arena.hold(f);
}

function writeStencilFace(
  view: CStructView<"WGPUStencilFaceState">,
  face: GPUStencilFaceState | undefined,
): void {
  view.setEnum("compare", toEnum(COMPARE_FUNCTION, face?.compare ?? "always", "GPUCompareFunction"));
  view.setEnum("failOp", toEnum(STENCIL_OPERATION, face?.failOp ?? "keep", "GPUStencilOperation"));
  view.setEnum("depthFailOp", toEnum(STENCIL_OPERATION, face?.depthFailOp ?? "keep", "GPUStencilOperation"));
  view.setEnum("passOp", toEnum(STENCIL_OPERATION, face?.passOp ?? "keep", "GPUStencilOperation"));
}

function writeDepthStencil(arena: Arena, state: GPUDepthStencilState): Ptr {
  const d = arena.struct("WGPUDepthStencilState");
  d.setEnum("format", toEnum(TEXTURE_FORMAT, state.format, "GPUTextureFormat"));
  // WGPUOptionalBool: 0 false, 1 true, 2 undefined. "Undefined" is not "false" — leave it alone
  // when the caller said nothing, so wgpu-native applies the format's own rule.
  if (state.depthWriteEnabled !== undefined) d.setEnum("depthWriteEnabled", state.depthWriteEnabled ? 1 : 0);
  if (state.depthCompare) {
    d.setEnum("depthCompare", toEnum(COMPARE_FUNCTION, state.depthCompare, "GPUCompareFunction"));
  }
  writeStencilFace(d.sub("stencilFront"), state.stencilFront);
  writeStencilFace(d.sub("stencilBack"), state.stencilBack);
  if (state.stencilReadMask !== undefined) d.setU32("stencilReadMask", state.stencilReadMask);
  if (state.stencilWriteMask !== undefined) d.setU32("stencilWriteMask", state.stencilWriteMask);
  if (state.depthBias !== undefined) d.setI32("depthBias", state.depthBias);
  if (state.depthBiasSlopeScale !== undefined) d.setF32("depthBiasSlopeScale", state.depthBiasSlopeScale);
  if (state.depthBiasClamp !== undefined) d.setF32("depthBiasClamp", state.depthBiasClamp);
  return arena.hold(d);
}

export function packRenderPipelineDescriptor(
  arena: Arena,
  descriptor: GPURenderPipelineDescriptor,
): Ptr {
  const d = arena.struct("WGPURenderPipelineDescriptor");
  arena.writeString(d.sub("label"), descriptor.label);
  d.setPtr("layout", layoutPointer(descriptor.layout));

  const vertex = d.sub("vertex");
  writeStage(arena, vertex, descriptor.vertex);
  writeVertexBuffers(arena, vertex, descriptor.vertex.buffers);

  const primitive = descriptor.primitive ?? {};
  const p = d.sub("primitive");
  p.setEnum("topology", toEnum(PRIMITIVE_TOPOLOGY, primitive.topology ?? "triangle-list", "GPUPrimitiveTopology"));
  if (primitive.stripIndexFormat) {
    p.setEnum("stripIndexFormat", toEnum(INDEX_FORMAT, primitive.stripIndexFormat, "GPUIndexFormat"));
  }
  p.setEnum("frontFace", toEnum(FRONT_FACE, primitive.frontFace ?? "ccw", "GPUFrontFace"));
  p.setEnum("cullMode", toEnum(CULL_MODE, primitive.cullMode ?? "none", "GPUCullMode"));
  p.setBool("unclippedDepth", primitive.unclippedDepth ?? false);

  // Reached through sub(), so the header's WGPU_MULTISAMPLE_STATE_INIT does not apply — written out.
  const multisample = descriptor.multisample ?? {};
  d.sub("multisample")
    .setU32("count", multisample.count ?? 1)
    .setU32("mask", multisample.mask ?? 0xffffffff)
    .setBool("alphaToCoverageEnabled", multisample.alphaToCoverageEnabled ?? false);

  if (descriptor.depthStencil) d.setPtr("depthStencil", writeDepthStencil(arena, descriptor.depthStencil));
  if (descriptor.fragment) d.setPtr("fragment", writeFragment(arena, descriptor.fragment));

  return arena.hold(d);
}
