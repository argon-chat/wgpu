/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Derived from wgpu.h (wgpu-native's own extensions) by `bun run scripts/gen-layouts.ts`.
 *
 * Contains member names and C-ABI type tags only. Offsets and sizes are computed from this table at
 * import time (`src/layouts/cabi.ts`) and verified against a real C compiler in CI
 * (`test/layout-oracle.test.ts`), so this file is structurally incapable of carrying a wrong number.
 */

export const WGPU_NATIVE_AGGREGATES = {
  WGPUXlibDisplayHandle: ["display:ptr", "screen:i32"],
  WGPUXcbDisplayHandle: ["connection:ptr", "screen:i32"],
  WGPUWaylandDisplayHandle: ["display:ptr"],
  "WGPUNativeDisplayHandle::data": [
    "xlib:@WGPUXlibDisplayHandle", "xcb:@WGPUXcbDisplayHandle", "wayland:@WGPUWaylandDisplayHandle",
  ],
  WGPUNativeDisplayHandle: ["type:enum32", "data:@WGPUNativeDisplayHandle::data"],
  WGPUInstanceExtras: [
    "chain:@WGPUChainedStruct", "backends:flags64", "flags:flags64", "dx12ShaderCompiler:enum32",
    "gles3MinorVersion:enum32", "glFenceBehaviour:enum32", "dxcPath:@WGPUStringView",
    "dxcMaxShaderModel:enum32", "dx12PresentationSystem:enum32", "budgetForDeviceCreation:ptr",
    "budgetForDeviceLoss:ptr", "displayHandle:@WGPUNativeDisplayHandle",
  ],
  WGPUDeviceExtras: ["chain:@WGPUChainedStruct", "tracePath:@WGPUStringView"],
  WGPUNativeLimits: [
    "chain:@WGPUChainedStruct", "maxNonSamplerBindings:u32", "maxBindingArrayElementsPerShaderStage:u32",
    "maxBindingArraySamplerElementsPerShaderStage:u32", "maxMultiviewViewCount:u32",
  ],
  WGPUShaderDefine: ["name:@WGPUStringView", "value:@WGPUStringView"],
  WGPUShaderSourceGLSL: [
    "chain:@WGPUChainedStruct", "stage:flags64", "code:@WGPUStringView", "defineCount:u32", "defines:ptr",
  ],
  WGPUShaderModuleDescriptorSpirV: ["label:@WGPUStringView", "sourceSize:u32", "source:ptr"],
  WGPURegistryReport: [
    "numAllocated:usize", "numKeptFromUser:usize", "numReleasedFromUser:usize", "elementSize:usize",
  ],
  WGPUHubReport: [
    "adapters:@WGPURegistryReport", "devices:@WGPURegistryReport", "queues:@WGPURegistryReport",
    "pipelineLayouts:@WGPURegistryReport", "shaderModules:@WGPURegistryReport",
    "bindGroupLayouts:@WGPURegistryReport", "bindGroups:@WGPURegistryReport",
    "commandBuffers:@WGPURegistryReport", "renderBundles:@WGPURegistryReport",
    "renderPipelines:@WGPURegistryReport", "computePipelines:@WGPURegistryReport",
    "pipelineCaches:@WGPURegistryReport", "querySets:@WGPURegistryReport", "buffers:@WGPURegistryReport",
    "textures:@WGPURegistryReport", "textureViews:@WGPURegistryReport", "samplers:@WGPURegistryReport",
  ],
  WGPUGlobalReport: ["surfaces:@WGPURegistryReport", "hub:@WGPUHubReport"],
  WGPUInstanceEnumerateAdapterOptions: ["nextInChain:ptr", "backends:flags64"],
  WGPUBindGroupEntryExtras: [
    "chain:@WGPUChainedStruct", "buffers:ptr", "bufferCount:usize", "samplers:ptr", "samplerCount:usize",
    "textureViews:ptr", "textureViewCount:usize",
  ],
  WGPUBindGroupLayoutEntryExtras: ["chain:@WGPUChainedStruct", "count:u32"],
  WGPUQuerySetDescriptorExtras: [
    "chain:@WGPUChainedStruct", "pipelineStatistics:ptr", "pipelineStatisticCount:usize",
  ],
  WGPUSurfaceConfigurationExtras: ["chain:@WGPUChainedStruct", "desiredMaximumFrameLatency:u32"],
  WGPUSurfaceSourceSwapChainPanel: ["chain:@WGPUChainedStruct", "panelNative:ptr"],
  WGPUPrimitiveStateExtras: ["chain:@WGPUChainedStruct", "polygonMode:enum32", "conservative:bool32"],
  WGPUImageSubresourceRange: [
    "aspect:enum32", "baseMipLevel:u32", "mipLevelCount:u32", "baseArrayLayer:u32", "arrayLayerCount:u32",
  ],
  WGPUSamplerDescriptorExtras: ["chain:@WGPUChainedStruct", "samplerBorderColor:enum32"],
} as const;
