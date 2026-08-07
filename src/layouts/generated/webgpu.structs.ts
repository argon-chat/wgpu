/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Derived from webgpu.h (the Khronos webgpu-native header) by `bun run scripts/gen-layouts.ts`.
 *
 * Contains member names and C-ABI type tags only. Offsets and sizes are computed from this table at
 * import time (`src/layouts/cabi.ts`) and verified against a real C compiler in CI
 * (`test/layout-oracle.test.ts`), so this file is structurally incapable of carrying a wrong number.
 */

export const WEBGPU_AGGREGATES = {
  WGPUStringView: ["data:ptr", "length:usize"],
  WGPUChainedStruct: ["next:ptr", "sType:enum32"],
  WGPUBufferMapCallbackInfo: [
    "nextInChain:ptr", "mode:enum32", "callback:ptr", "userdata1:ptr", "userdata2:ptr",
  ],
  WGPUCompilationInfoCallbackInfo: [
    "nextInChain:ptr", "mode:enum32", "callback:ptr", "userdata1:ptr", "userdata2:ptr",
  ],
  WGPUCreateComputePipelineAsyncCallbackInfo: [
    "nextInChain:ptr", "mode:enum32", "callback:ptr", "userdata1:ptr", "userdata2:ptr",
  ],
  WGPUCreateRenderPipelineAsyncCallbackInfo: [
    "nextInChain:ptr", "mode:enum32", "callback:ptr", "userdata1:ptr", "userdata2:ptr",
  ],
  WGPUDeviceLostCallbackInfo: [
    "nextInChain:ptr", "mode:enum32", "callback:ptr", "userdata1:ptr", "userdata2:ptr",
  ],
  WGPUPopErrorScopeCallbackInfo: [
    "nextInChain:ptr", "mode:enum32", "callback:ptr", "userdata1:ptr", "userdata2:ptr",
  ],
  WGPUQueueWorkDoneCallbackInfo: [
    "nextInChain:ptr", "mode:enum32", "callback:ptr", "userdata1:ptr", "userdata2:ptr",
  ],
  WGPURequestAdapterCallbackInfo: [
    "nextInChain:ptr", "mode:enum32", "callback:ptr", "userdata1:ptr", "userdata2:ptr",
  ],
  WGPURequestDeviceCallbackInfo: [
    "nextInChain:ptr", "mode:enum32", "callback:ptr", "userdata1:ptr", "userdata2:ptr",
  ],
  WGPUUncapturedErrorCallbackInfo: ["nextInChain:ptr", "callback:ptr", "userdata1:ptr", "userdata2:ptr"],
  WGPUAdapterInfo: [
    "nextInChain:ptr", "vendor:@WGPUStringView", "architecture:@WGPUStringView", "device:@WGPUStringView",
    "description:@WGPUStringView", "backendType:enum32", "adapterType:enum32", "vendorID:u32",
    "deviceID:u32", "subgroupMinSize:u32", "subgroupMaxSize:u32",
  ],
  WGPUBlendComponent: ["operation:enum32", "srcFactor:enum32", "dstFactor:enum32"],
  WGPUBufferBindingLayout: [
    "nextInChain:ptr", "type:enum32", "hasDynamicOffset:bool32", "minBindingSize:u64",
  ],
  WGPUBufferDescriptor: [
    "nextInChain:ptr", "label:@WGPUStringView", "usage:flags64", "size:u64", "mappedAtCreation:bool32",
  ],
  WGPUColor: ["r:f64", "g:f64", "b:f64", "a:f64"],
  WGPUCommandBufferDescriptor: ["nextInChain:ptr", "label:@WGPUStringView"],
  WGPUCommandEncoderDescriptor: ["nextInChain:ptr", "label:@WGPUStringView"],
  WGPUCompatibilityModeLimits: [
    "chain:@WGPUChainedStruct", "maxStorageBuffersInVertexStage:u32",
    "maxStorageTexturesInVertexStage:u32", "maxStorageBuffersInFragmentStage:u32",
    "maxStorageTexturesInFragmentStage:u32",
  ],
  WGPUCompilationMessage: [
    "nextInChain:ptr", "message:@WGPUStringView", "type:enum32", "lineNum:u64", "linePos:u64",
    "offset:u64", "length:u64",
  ],
  WGPUConstantEntry: ["nextInChain:ptr", "key:@WGPUStringView", "value:f64"],
  WGPUExtent3D: ["width:u32", "height:u32", "depthOrArrayLayers:u32"],
  WGPUExternalTextureBindingEntry: ["chain:@WGPUChainedStruct", "externalTexture:ptr"],
  WGPUExternalTextureBindingLayout: ["chain:@WGPUChainedStruct"],
  WGPUFuture: ["id:u64"],
  WGPUInstanceLimits: ["nextInChain:ptr", "timedWaitAnyMaxCount:usize"],
  WGPUMultisampleState: ["nextInChain:ptr", "count:u32", "mask:u32", "alphaToCoverageEnabled:bool32"],
  WGPUOrigin3D: ["x:u32", "y:u32", "z:u32"],
  WGPUPassTimestampWrites: [
    "nextInChain:ptr", "querySet:ptr", "beginningOfPassWriteIndex:u32", "endOfPassWriteIndex:u32",
  ],
  WGPUPipelineLayoutDescriptor: [
    "nextInChain:ptr", "label:@WGPUStringView", "bindGroupLayoutCount:usize", "bindGroupLayouts:ptr",
    "immediateSize:u32",
  ],
  WGPUPrimitiveState: [
    "nextInChain:ptr", "topology:enum32", "stripIndexFormat:enum32", "frontFace:enum32",
    "cullMode:enum32", "unclippedDepth:bool32",
  ],
  WGPUQuerySetDescriptor: ["nextInChain:ptr", "label:@WGPUStringView", "type:enum32", "count:u32"],
  WGPUQueueDescriptor: ["nextInChain:ptr", "label:@WGPUStringView"],
  WGPURenderBundleDescriptor: ["nextInChain:ptr", "label:@WGPUStringView"],
  WGPURenderBundleEncoderDescriptor: [
    "nextInChain:ptr", "label:@WGPUStringView", "colorFormatCount:usize", "colorFormats:ptr",
    "depthStencilFormat:enum32", "sampleCount:u32", "depthReadOnly:bool32", "stencilReadOnly:bool32",
  ],
  WGPURenderPassDepthStencilAttachment: [
    "nextInChain:ptr", "view:ptr", "depthLoadOp:enum32", "depthStoreOp:enum32", "depthClearValue:f32",
    "depthReadOnly:bool32", "stencilLoadOp:enum32", "stencilStoreOp:enum32", "stencilClearValue:u32",
    "stencilReadOnly:bool32",
  ],
  WGPURenderPassMaxDrawCount: ["chain:@WGPUChainedStruct", "maxDrawCount:u64"],
  WGPURequestAdapterWebXROptions: ["chain:@WGPUChainedStruct", "xrCompatible:bool32"],
  WGPUSamplerBindingLayout: ["nextInChain:ptr", "type:enum32"],
  WGPUSamplerDescriptor: [
    "nextInChain:ptr", "label:@WGPUStringView", "addressModeU:enum32", "addressModeV:enum32",
    "addressModeW:enum32", "magFilter:enum32", "minFilter:enum32", "mipmapFilter:enum32",
    "lodMinClamp:f32", "lodMaxClamp:f32", "compare:enum32", "maxAnisotropy:u16",
  ],
  WGPUShaderSourceSPIRV: ["chain:@WGPUChainedStruct", "codeSize:u32", "code:ptr"],
  WGPUShaderSourceWGSL: ["chain:@WGPUChainedStruct", "code:@WGPUStringView"],
  WGPUStencilFaceState: ["compare:enum32", "failOp:enum32", "depthFailOp:enum32", "passOp:enum32"],
  WGPUStorageTextureBindingLayout: [
    "nextInChain:ptr", "access:enum32", "format:enum32", "viewDimension:enum32",
  ],
  WGPUSupportedFeatures: ["featureCount:usize", "features:ptr"],
  WGPUSupportedInstanceFeatures: ["featureCount:usize", "features:ptr"],
  WGPUSupportedWGSLLanguageFeatures: ["featureCount:usize", "features:ptr"],
  WGPUSurfaceCapabilities: [
    "nextInChain:ptr", "usages:flags64", "formatCount:usize", "formats:ptr", "presentModeCount:usize",
    "presentModes:ptr", "alphaModeCount:usize", "alphaModes:ptr",
  ],
  WGPUSurfaceColorManagement: ["chain:@WGPUChainedStruct", "colorSpace:enum32", "toneMappingMode:enum32"],
  WGPUSurfaceConfiguration: [
    "nextInChain:ptr", "device:ptr", "format:enum32", "usage:flags64", "width:u32", "height:u32",
    "viewFormatCount:usize", "viewFormats:ptr", "alphaMode:enum32", "presentMode:enum32",
  ],
  WGPUSurfaceSourceAndroidNativeWindow: ["chain:@WGPUChainedStruct", "window:ptr"],
  WGPUSurfaceSourceMetalLayer: ["chain:@WGPUChainedStruct", "layer:ptr"],
  WGPUSurfaceSourceWaylandSurface: ["chain:@WGPUChainedStruct", "display:ptr", "surface:ptr"],
  WGPUSurfaceSourceWindowsHWND: ["chain:@WGPUChainedStruct", "hinstance:ptr", "hwnd:ptr"],
  WGPUSurfaceSourceXCBWindow: ["chain:@WGPUChainedStruct", "connection:ptr", "window:u32"],
  WGPUSurfaceSourceXlibWindow: ["chain:@WGPUChainedStruct", "display:ptr", "window:u64"],
  WGPUSurfaceTexture: ["nextInChain:ptr", "texture:ptr", "status:enum32"],
  WGPUTexelCopyBufferLayout: ["offset:u64", "bytesPerRow:u32", "rowsPerImage:u32"],
  WGPUTextureBindingLayout: [
    "nextInChain:ptr", "sampleType:enum32", "viewDimension:enum32", "multisampled:bool32",
  ],
  WGPUTextureBindingViewDimension: ["chain:@WGPUChainedStruct", "textureBindingViewDimension:enum32"],
  WGPUTextureComponentSwizzle: ["r:enum32", "g:enum32", "b:enum32", "a:enum32"],
  WGPUVertexAttribute: ["nextInChain:ptr", "format:enum32", "offset:u64", "shaderLocation:u32"],
  WGPUBindGroupEntry: [
    "nextInChain:ptr", "binding:u32", "buffer:ptr", "offset:u64", "size:u64", "sampler:ptr",
    "textureView:ptr",
  ],
  WGPUBindGroupLayoutEntry: [
    "nextInChain:ptr", "binding:u32", "visibility:flags64", "bindingArraySize:u32",
    "buffer:@WGPUBufferBindingLayout", "sampler:@WGPUSamplerBindingLayout",
    "texture:@WGPUTextureBindingLayout", "storageTexture:@WGPUStorageTextureBindingLayout",
  ],
  WGPUBlendState: ["color:@WGPUBlendComponent", "alpha:@WGPUBlendComponent"],
  WGPUCompilationInfo: ["nextInChain:ptr", "messageCount:usize", "messages:ptr"],
  WGPUComputePassDescriptor: ["nextInChain:ptr", "label:@WGPUStringView", "timestampWrites:ptr"],
  WGPUComputeState: [
    "nextInChain:ptr", "module:ptr", "entryPoint:@WGPUStringView", "constantCount:usize", "constants:ptr",
  ],
  WGPUDepthStencilState: [
    "nextInChain:ptr", "format:enum32", "depthWriteEnabled:enum32", "depthCompare:enum32",
    "stencilFront:@WGPUStencilFaceState", "stencilBack:@WGPUStencilFaceState", "stencilReadMask:u32",
    "stencilWriteMask:u32", "depthBias:i32", "depthBiasSlopeScale:f32", "depthBiasClamp:f32",
  ],
  WGPUFutureWaitInfo: ["future:@WGPUFuture", "completed:bool32"],
  WGPUInstanceDescriptor: [
    "nextInChain:ptr", "requiredFeatureCount:usize", "requiredFeatures:ptr", "requiredLimits:ptr",
  ],
  WGPULimits: [
    "nextInChain:ptr", "maxTextureDimension1D:u32", "maxTextureDimension2D:u32",
    "maxTextureDimension3D:u32", "maxTextureArrayLayers:u32", "maxBindGroups:u32",
    "maxBindGroupsPlusVertexBuffers:u32", "maxBindingsPerBindGroup:u32",
    "maxDynamicUniformBuffersPerPipelineLayout:u32", "maxDynamicStorageBuffersPerPipelineLayout:u32",
    "maxSampledTexturesPerShaderStage:u32", "maxSamplersPerShaderStage:u32",
    "maxStorageBuffersPerShaderStage:u32", "maxStorageTexturesPerShaderStage:u32",
    "maxUniformBuffersPerShaderStage:u32", "maxUniformBufferBindingSize:u64",
    "maxStorageBufferBindingSize:u64", "minUniformBufferOffsetAlignment:u32",
    "minStorageBufferOffsetAlignment:u32", "maxVertexBuffers:u32", "maxBufferSize:u64",
    "maxVertexAttributes:u32", "maxVertexBufferArrayStride:u32", "maxInterStageShaderVariables:u32",
    "maxColorAttachments:u32", "maxColorAttachmentBytesPerSample:u32",
    "maxComputeWorkgroupStorageSize:u32", "maxComputeInvocationsPerWorkgroup:u32",
    "maxComputeWorkgroupSizeX:u32", "maxComputeWorkgroupSizeY:u32", "maxComputeWorkgroupSizeZ:u32",
    "maxComputeWorkgroupsPerDimension:u32", "maxImmediateSize:u32",
  ],
  WGPURenderPassColorAttachment: [
    "nextInChain:ptr", "view:ptr", "depthSlice:u32", "resolveTarget:ptr", "loadOp:enum32",
    "storeOp:enum32", "clearValue:@WGPUColor",
  ],
  WGPURequestAdapterOptions: [
    "nextInChain:ptr", "featureLevel:enum32", "powerPreference:enum32", "forceFallbackAdapter:bool32",
    "backendType:enum32", "compatibleSurface:ptr",
  ],
  WGPUShaderModuleDescriptor: ["nextInChain:ptr", "label:@WGPUStringView"],
  WGPUSurfaceDescriptor: ["nextInChain:ptr", "label:@WGPUStringView"],
  WGPUTexelCopyBufferInfo: ["layout:@WGPUTexelCopyBufferLayout", "buffer:ptr"],
  WGPUTexelCopyTextureInfo: ["texture:ptr", "mipLevel:u32", "origin:@WGPUOrigin3D", "aspect:enum32"],
  WGPUTextureComponentSwizzleDescriptor: [
    "chain:@WGPUChainedStruct", "swizzle:@WGPUTextureComponentSwizzle",
  ],
  WGPUTextureDescriptor: [
    "nextInChain:ptr", "label:@WGPUStringView", "usage:flags64", "dimension:enum32", "size:@WGPUExtent3D",
    "format:enum32", "mipLevelCount:u32", "sampleCount:u32", "viewFormatCount:usize", "viewFormats:ptr",
  ],
  WGPUVertexBufferLayout: [
    "nextInChain:ptr", "stepMode:enum32", "arrayStride:u64", "attributeCount:usize", "attributes:ptr",
  ],
  WGPUBindGroupDescriptor: [
    "nextInChain:ptr", "label:@WGPUStringView", "layout:ptr", "entryCount:usize", "entries:ptr",
  ],
  WGPUBindGroupLayoutDescriptor: [
    "nextInChain:ptr", "label:@WGPUStringView", "entryCount:usize", "entries:ptr",
  ],
  WGPUColorTargetState: ["nextInChain:ptr", "format:enum32", "blend:ptr", "writeMask:flags64"],
  WGPUComputePipelineDescriptor: [
    "nextInChain:ptr", "label:@WGPUStringView", "layout:ptr", "compute:@WGPUComputeState",
  ],
  WGPUDeviceDescriptor: [
    "nextInChain:ptr", "label:@WGPUStringView", "requiredFeatureCount:usize", "requiredFeatures:ptr",
    "requiredLimits:ptr", "defaultQueue:@WGPUQueueDescriptor",
    "deviceLostCallbackInfo:@WGPUDeviceLostCallbackInfo",
    "uncapturedErrorCallbackInfo:@WGPUUncapturedErrorCallbackInfo",
  ],
  WGPURenderPassDescriptor: [
    "nextInChain:ptr", "label:@WGPUStringView", "colorAttachmentCount:usize", "colorAttachments:ptr",
    "depthStencilAttachment:ptr", "occlusionQuerySet:ptr", "timestampWrites:ptr",
  ],
  WGPUTextureViewDescriptor: [
    "nextInChain:ptr", "label:@WGPUStringView", "format:enum32", "dimension:enum32", "baseMipLevel:u32",
    "mipLevelCount:u32", "baseArrayLayer:u32", "arrayLayerCount:u32", "aspect:enum32", "usage:flags64",
  ],
  WGPUVertexState: [
    "nextInChain:ptr", "module:ptr", "entryPoint:@WGPUStringView", "constantCount:usize", "constants:ptr",
    "bufferCount:usize", "buffers:ptr",
  ],
  WGPUFragmentState: [
    "nextInChain:ptr", "module:ptr", "entryPoint:@WGPUStringView", "constantCount:usize", "constants:ptr",
    "targetCount:usize", "targets:ptr",
  ],
  WGPURenderPipelineDescriptor: [
    "nextInChain:ptr", "label:@WGPUStringView", "layout:ptr", "vertex:@WGPUVertexState",
    "primitive:@WGPUPrimitiveState", "depthStencil:ptr", "multisample:@WGPUMultisampleState",
    "fragment:ptr",
  ],
} as const;
