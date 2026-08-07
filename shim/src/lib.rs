/*!
# wgpu-bun-shim — the compiled half of the ABI seam

`bun:ffi` has no struct-by-value argument type. Seven wgpu-native entry points take a C aggregate
**by value**, and on the SysV x86-64 ABI (Linux x64, Intel macOS) such an aggregate is either copied
onto the stack (>16 bytes → class MEMORY) or passed in two registers (a 16-byte aggregate of two
integer-class members). Neither can be produced from JavaScript by any combination of `FFIType`
arguments. On Win64 and AArch64 the same aggregates are passed by hidden reference, so a pointer *is*
the correct calling sequence there — which is why the JS-only path works on those platforms and
cannot be made to work on SysV.

This crate closes that hole in the only way that is actually correct: it declares the aggregates as
real `#[repr(C)]` structs and lets a real compiler emit the calling sequence. Every exported wrapper
takes a **pointer** to an already-packed buffer and dereferences it on this side, so the signature
facing JavaScript is flat and identical to the one the JS-only path already uses. Adopting the shim
is a change of which library gets opened, and nothing else.

## Why it resolves wgpu-native at runtime instead of linking it

It would be simpler to link `wgpu_native` at build time. It would also be wrong:

* The consumer's wgpu-native is *fetched*, and its path is decided at runtime by a three-tier
  resolver. A link-time dependency would need that path to be fixed and on the loader search path.
* Worse, it could produce a **second instance** of wgpu-native in the process — one opened by the
  JavaScript binding, one pulled in by this library — each with its own global state. Loading it here
  by the exact absolute path the binding already resolved guarantees the opposite: `LoadLibraryW` and
  `dlopen` both return the existing handle for a path already loaded, refcounted, so the shim calls
  into the *same* instance.
* And it means this crate can be built with no headers, no import library, and no wgpu-native present
  at all — so a build runner needs a Rust toolchain and nothing else.

## What is deliberately not here

No error handling beyond "was the library opened". No argument validation, no lifetime management, no
allocation. This is a calling-convention adapter; every policy decision — ticket registries, polling,
callback lifetimes — stays in TypeScript where it can be tested. The whole crate is one C fact the
JavaScript could not express.
*/

#![allow(non_snake_case)]
// Every field of the aggregates below is *layout*, not data: this crate copies them wholesale and
// hands them to wgpu-native, and reads none of them. Rust cannot tell that from "never used", so the
// lint is switched off once, here, with the reason — rather than being papered over per field.
#![allow(dead_code)]

use std::ffi::{c_char, c_void};
use std::sync::{Mutex, OnceLock};

// ────────────────────────────────────────────────────────────────────────────────────────────────
// The contract with the TypeScript side
// ────────────────────────────────────────────────────────────────────────────────────────────────

/// Version of the *flat function surface* this library exports.
///
/// Bumped whenever an exported signature changes shape. `src/ffi/abiSeam.ts` refuses to bind a shim
/// that reports a different number, because the failure mode of a silently mismatched signature is a
/// corrupted stack, not an error.
const SHIM_ABI_VERSION: u32 = 1;

/// The wgpu-native generation whose struct definitions are transcribed below.
///
/// The layouts here are hand-written `#[repr(C)]` declarations, so they are correct only for the
/// generation they were written against. Pairing this shim with a different wgpu-native major is the
/// one runtime failure mode a compiled shim *adds* over the JS-only path, so it is checked rather
/// than assumed.
const SHIM_TARGET_GENERATION: u32 = 29;

// ────────────────────────────────────────────────────────────────────────────────────────────────
// The aggregates, as real C structs
// ────────────────────────────────────────────────────────────────────────────────────────────────

/// `WGPUFuture { uint64_t id; }` — returned by value.
///
/// Declared as a struct rather than typed as a bare `u64` on purpose. An 8-byte single-member
/// aggregate happens to return in `RAX`/`x0` under every ABI here, but that is a fact about the ABI
/// and not about the C declaration; writing the struct lets the compiler own the claim.
#[repr(C)]
#[derive(Clone, Copy)]
struct WGPUFuture {
    id: u64,
}

/// `WGPUStringView { char const* data; size_t length; }` — 16 bytes.
///
/// Present only so `WGPUAdapterInfo` can be declared truthfully. Under SysV this classifies as
/// INTEGER+INTEGER and is passed in two registers, which is the second, size-invisible half of the
/// problem this crate exists to solve.
#[repr(C)]
#[derive(Clone, Copy)]
struct WGPUStringView {
    data: *const c_char,
    length: usize,
}

/// The shape shared by all five `*CallbackInfo` aggregates — 40 bytes.
///
/// `WGPURequestAdapterCallbackInfo`, `WGPURequestDeviceCallbackInfo`, `WGPUBufferMapCallbackInfo`,
/// `WGPUPopErrorScopeCallbackInfo` and `WGPUQueueWorkDoneCallbackInfo` are five distinct C types with
/// **identical** member sequences: `{ void const* nextInChain; uint32_t mode; void(*callback)();
/// void* userdata1; void* userdata2; }`. Only the callback's own prototype differs, and this crate
/// never calls the callback — it copies the aggregate and hands it on. Argument classification
/// depends on layout alone, so one Rust type produces the correct calling sequence for all five.
///
/// The 4 bytes of padding after `mode` are the compiler's, not a constant typed here. That is the
/// entire point: `wgpu_bun_shim_sizeof` re-exports `size_of` so the TypeScript side can check its own
/// independently-derived layout against what this compiler actually produced.
#[repr(C)]
#[derive(Clone, Copy)]
struct WGPUCallbackInfo {
    next_in_chain: *const c_void,
    mode: u32,
    callback: *const c_void,
    userdata1: *mut c_void,
    userdata2: *mut c_void,
}

/// `WGPUAdapterInfo` — 96 bytes, four `WGPUStringView`s and six 32-bit fields.
///
/// Passed by value to `wgpuAdapterInfoFreeMembers`, which frees the strings `wgpuAdapterGetInfo`
/// allocated. Getting this wrong does not fail loudly; it frees the wrong pointers.
#[repr(C)]
#[derive(Clone, Copy)]
struct WGPUAdapterInfo {
    next_in_chain: *const c_void,
    vendor: WGPUStringView,
    architecture: WGPUStringView,
    device: WGPUStringView,
    description: WGPUStringView,
    backend_type: u32,
    adapter_type: u32,
    vendor_id: u32,
    device_id: u32,
    subgroup_min_size: u32,
    subgroup_max_size: u32,
}

/// `WGPUSupportedFeatures { size_t featureCount; WGPUFeatureName const* features; }` — 16 bytes.
///
/// The subtle SysV case in full: two integer-class members in 16 bytes are passed in **two
/// registers**, so substituting a pointer is wrong in a way no size check can detect.
#[repr(C)]
#[derive(Clone, Copy)]
struct WGPUSupportedFeatures {
    feature_count: usize,
    features: *const u32,
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// The wgpu-native entry points, as they really are
// ────────────────────────────────────────────────────────────────────────────────────────────────

type FnInstanceRequestAdapter =
    unsafe extern "C" fn(*mut c_void, *const c_void, WGPUCallbackInfo) -> WGPUFuture;
type FnAdapterRequestDevice =
    unsafe extern "C" fn(*mut c_void, *const c_void, WGPUCallbackInfo) -> WGPUFuture;
type FnBufferMapAsync =
    unsafe extern "C" fn(*mut c_void, u64, usize, usize, WGPUCallbackInfo) -> WGPUFuture;
type FnDevicePopErrorScope = unsafe extern "C" fn(*mut c_void, WGPUCallbackInfo) -> WGPUFuture;
type FnQueueOnSubmittedWorkDone = unsafe extern "C" fn(*mut c_void, WGPUCallbackInfo) -> WGPUFuture;
type FnAdapterInfoFreeMembers = unsafe extern "C" fn(WGPUAdapterInfo);
type FnSupportedFeaturesFreeMembers = unsafe extern "C" fn(WGPUSupportedFeatures);

struct Table {
    instance_request_adapter: FnInstanceRequestAdapter,
    adapter_request_device: FnAdapterRequestDevice,
    buffer_map_async: FnBufferMapAsync,
    device_pop_error_scope: FnDevicePopErrorScope,
    queue_on_submitted_work_done: FnQueueOnSubmittedWorkDone,
    adapter_info_free_members: FnAdapterInfoFreeMembers,
    supported_features_free_members: FnSupportedFeaturesFreeMembers,
}

struct Loaded {
    /// The path this table was resolved from. Kept so a second `open` with a *different* path is a
    /// reported error rather than a silent no-op — two libraries would mean two global states.
    path: String,
    table: Table,
}

// SAFETY: `Table` holds only function pointers into a library that stays loaded for the life of the
// process (nothing here ever unloads it). They are immutable after `OnceLock::set` and calling them
// concurrently is exactly what wgpu-native's own C API permits.
unsafe impl Send for Loaded {}
unsafe impl Sync for Loaded {}

static LOADED: OnceLock<Loaded> = OnceLock::new();
static LAST_ERROR: Mutex<String> = Mutex::new(String::new());

fn set_error(message: impl Into<String>) {
    if let Ok(mut slot) = LAST_ERROR.lock() {
        *slot = message.into();
    }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Platform loader
// ────────────────────────────────────────────────────────────────────────────────────────────────

#[cfg(windows)]
mod sys {
    use super::{c_char, c_void};

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn LoadLibraryW(name: *const u16) -> *mut c_void;
        fn GetProcAddress(module: *mut c_void, name: *const c_char) -> *mut c_void;
        fn GetLastError() -> u32;
    }

    pub fn open(path: &str) -> Result<*mut c_void, String> {
        // UTF-16 with an explicit NUL. `dlopen`-style narrow paths would mangle any non-ASCII
        // directory in a user's checkout, which is a bug that only ever reproduces on someone
        // else's machine.
        let mut wide: Vec<u16> = path.encode_utf16().collect();
        wide.push(0);
        let handle = unsafe { LoadLibraryW(wide.as_ptr()) };
        if handle.is_null() {
            let code = unsafe { GetLastError() };
            // 126 = ERROR_MOD_NOT_FOUND. It is reported both for "the file is not there" and for
            // "a dependency of it is not there", and the distinction costs people hours.
            return Err(format!(
                "LoadLibraryW failed with Win32 error {code} for \"{path}\"{}",
                if code == 126 {
                    " (ERROR_MOD_NOT_FOUND — the file itself, or one of its dependent DLLs, could \
                     not be found; note that an MSYS-style /c/... path also fails this way)"
                } else {
                    ""
                }
            ));
        }
        Ok(handle)
    }

    pub fn symbol(handle: *mut c_void, name: &str) -> Result<*mut c_void, String> {
        let mut bytes: Vec<u8> = name.as_bytes().to_vec();
        bytes.push(0);
        let addr = unsafe { GetProcAddress(handle, bytes.as_ptr() as *const c_char) };
        if addr.is_null() {
            return Err(format!("GetProcAddress(\"{name}\") returned null"));
        }
        Ok(addr)
    }
}

#[cfg(unix)]
mod sys {
    use super::{c_char, c_void};
    use std::ffi::c_int;

    /// `RTLD_NOW` is `2` on both Linux and macOS. Resolving eagerly turns a missing dependency into
    /// a failed `open` here rather than into a crash on first call, which is the difference between
    /// a diagnosable error and a segfault with no JS stack.
    const RTLD_NOW: c_int = 2;

    // `libdl` merged into `libc` in glibc 2.34, but the linker still accepts `-ldl` as a stub there,
    // and older glibc needs it. macOS has always had these in `libSystem`.
    #[cfg_attr(target_os = "linux", link(name = "dl"))]
    unsafe extern "C" {
        fn dlopen(filename: *const c_char, flag: c_int) -> *mut c_void;
        fn dlsym(handle: *mut c_void, symbol: *const c_char) -> *mut c_void;
        fn dlerror() -> *const c_char;
    }

    fn last_dlerror() -> String {
        let raw = unsafe { dlerror() };
        if raw.is_null() {
            return "(dlerror reported nothing)".to_string();
        }
        unsafe { std::ffi::CStr::from_ptr(raw) }
            .to_string_lossy()
            .into_owned()
    }

    pub fn open(path: &str) -> Result<*mut c_void, String> {
        let mut bytes: Vec<u8> = path.as_bytes().to_vec();
        bytes.push(0);
        // Clear any stale error first: `dlerror` is sticky, and reporting a previous call's message
        // for this one is a classic misdirection.
        unsafe { dlerror() };
        let handle = unsafe { dlopen(bytes.as_ptr() as *const c_char, RTLD_NOW) };
        if handle.is_null() {
            return Err(format!("dlopen(\"{path}\") failed: {}", last_dlerror()));
        }
        Ok(handle)
    }

    pub fn symbol(handle: *mut c_void, name: &str) -> Result<*mut c_void, String> {
        let mut bytes: Vec<u8> = name.as_bytes().to_vec();
        bytes.push(0);
        unsafe { dlerror() };
        let addr = unsafe { dlsym(handle, bytes.as_ptr() as *const c_char) };
        if addr.is_null() {
            return Err(format!("dlsym(\"{name}\") failed: {}", last_dlerror()));
        }
        Ok(addr)
    }
}

/// Resolve one symbol and transmute it to a typed function pointer.
///
/// The transmute is the unavoidable core of any dynamic binding: a loader returns an address and
/// somebody has to assert its prototype. The assertion is made exactly once per symbol, next to the
/// C declaration it corresponds to, rather than being spread over the call sites.
macro_rules! resolve {
    ($handle:expr, $name:literal, $ty:ty) => {{
        let addr = sys::symbol($handle, $name)?;
        // SAFETY: `$name` is a wgpu-native export whose C prototype `$ty` transcribes. A mismatch
        // here is undefined behaviour, which is why the generation check exists.
        unsafe { std::mem::transmute::<*mut c_void, $ty>(addr) }
    }};
}

fn load(path: &str) -> Result<Table, String> {
    let handle = sys::open(path)?;
    Ok(Table {
        instance_request_adapter: resolve!(
            handle,
            "wgpuInstanceRequestAdapter",
            FnInstanceRequestAdapter
        ),
        adapter_request_device: resolve!(handle, "wgpuAdapterRequestDevice", FnAdapterRequestDevice),
        buffer_map_async: resolve!(handle, "wgpuBufferMapAsync", FnBufferMapAsync),
        device_pop_error_scope: resolve!(handle, "wgpuDevicePopErrorScope", FnDevicePopErrorScope),
        queue_on_submitted_work_done: resolve!(
            handle,
            "wgpuQueueOnSubmittedWorkDone",
            FnQueueOnSubmittedWorkDone
        ),
        adapter_info_free_members: resolve!(
            handle,
            "wgpuAdapterInfoFreeMembers",
            FnAdapterInfoFreeMembers
        ),
        supported_features_free_members: resolve!(
            handle,
            "wgpuSupportedFeaturesFreeMembers",
            FnSupportedFeaturesFreeMembers
        ),
    })
}

fn table() -> Option<&'static Table> {
    LOADED.get().map(|l| &l.table)
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Exported surface: lifecycle and self-description
// ────────────────────────────────────────────────────────────────────────────────────────────────

/// Version of the flat function surface below. See {@link SHIM_ABI_VERSION}.
#[no_mangle]
pub extern "C" fn wgpu_bun_shim_abi_version() -> u32 {
    SHIM_ABI_VERSION
}

/// The wgpu-native generation these struct declarations were written against.
#[no_mangle]
pub extern "C" fn wgpu_bun_shim_target_generation() -> u32 {
    SHIM_TARGET_GENERATION
}

/// `sizeof` of each aggregate this crate declares, as this compiler laid it out.
///
/// Exported so the binding can cross-check its own independently derived C-ABI layouts against a
/// real compiler at runtime, on the actual target — which is the same discipline the header oracle
/// applies at build time, extended to the one platform pair the oracle cannot cover from a
/// developer's machine. Returns `0` for an unknown selector rather than panicking.
///
/// Selectors: 0 `WGPUStringView` · 1 `*CallbackInfo` · 2 `WGPUAdapterInfo` ·
/// 3 `WGPUSupportedFeatures` · 4 `WGPUFuture`.
#[no_mangle]
pub extern "C" fn wgpu_bun_shim_sizeof(selector: u32) -> usize {
    match selector {
        0 => std::mem::size_of::<WGPUStringView>(),
        1 => std::mem::size_of::<WGPUCallbackInfo>(),
        2 => std::mem::size_of::<WGPUAdapterInfo>(),
        3 => std::mem::size_of::<WGPUSupportedFeatures>(),
        4 => std::mem::size_of::<WGPUFuture>(),
        _ => 0,
    }
}

/// Open the wgpu-native library at `path` (UTF-8, `len` bytes, need not be NUL-terminated) and
/// resolve the seven entry points.
///
/// Must be called before any wrapper below. Idempotent for the same path; a second call with a
/// *different* path fails rather than silently keeping the first, because two wgpu-native instances
/// in one process is a class of bug nobody should have to diagnose from a wrong-looking adapter.
///
/// Returns `0` on success and a negative code otherwise; call
/// {@link wgpu_bun_shim_last_error} for the text.
///
/// * `-1` the path was not valid UTF-8
/// * `-2` the library could not be opened, or a symbol was missing
/// * `-3` already open with a different path
#[no_mangle]
pub unsafe extern "C" fn wgpu_bun_shim_open(path: *const u8, len: usize) -> i32 {
    let bytes = if path.is_null() || len == 0 {
        &[][..]
    } else {
        unsafe { std::slice::from_raw_parts(path, len) }
    };
    let Ok(path) = std::str::from_utf8(bytes) else {
        set_error("the library path was not valid UTF-8");
        return -1;
    };

    if let Some(existing) = LOADED.get() {
        if existing.path == path {
            return 0;
        }
        set_error(format!(
            "already opened \"{}\"; refusing to also open \"{}\". Two wgpu-native instances in one \
             process would each keep their own global state.",
            existing.path, path
        ));
        return -3;
    }

    match load(path) {
        Ok(table) => {
            // A racing caller may have won; that is fine as long as it used the same path, which the
            // check above already established for every path that reaches here.
            let _ = LOADED.set(Loaded {
                path: path.to_string(),
                table,
            });
            0
        }
        Err(message) => {
            set_error(message);
            -2
        }
    }
}

/// Has {@link wgpu_bun_shim_open} succeeded? `1` or `0`.
#[no_mangle]
pub extern "C" fn wgpu_bun_shim_is_open() -> i32 {
    i32::from(LOADED.get().is_some())
}

/// Copy the last error message into `out` as UTF-8, NUL-terminated, truncating to `cap`.
///
/// Returns the number of bytes written excluding the terminator. Reading the error is not
/// destructive: a caller that reads it twice gets the same answer, which matters because the first
/// read is usually a log line and the second is the exception message.
#[no_mangle]
pub unsafe extern "C" fn wgpu_bun_shim_last_error(out: *mut u8, cap: usize) -> usize {
    if out.is_null() || cap == 0 {
        return 0;
    }
    let Ok(message) = LAST_ERROR.lock() else {
        return 0;
    };
    let bytes = message.as_bytes();
    let n = bytes.len().min(cap - 1);
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, n);
        *out.add(n) = 0;
    }
    n
}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// Exported surface: the seven wrappers
// ────────────────────────────────────────────────────────────────────────────────────────────────
//
// Every one has the same shape: read the aggregate the caller packed, pass it BY VALUE to
// wgpu-native, return the future id. `read_unaligned` rather than a plain dereference because the
// caller's buffer is a JavaScript `ArrayBuffer` view whose alignment this crate has no way to
// assert — and an unaligned read costs nothing measurable on either supported architecture.
//
// A call made before `wgpu_bun_shim_open` returns 0 (an invalid future id) and does not fire a
// callback. That surfaces as the binding's async deadline expiring with a diagnosis, which is the
// designed loud failure; the alternative — pretending the operation completed — is the silent one.

/// Read a `*CallbackInfo` the caller packed, or `None` if the pointer is null.
///
/// A null callback info is a caller bug, not a wgpu-native input: every entry point below requires
/// one. Refusing here keeps a null dereference out of wgpu-native's stack frame.
#[inline]
unsafe fn read_callback_info(p: *const c_void) -> Option<WGPUCallbackInfo> {
    if p.is_null() {
        set_error("a *CallbackInfo pointer was null");
        return None;
    }
    Some(unsafe { std::ptr::read_unaligned(p as *const WGPUCallbackInfo) })
}

#[inline]
fn not_open() -> u64 {
    set_error("wgpu_bun_shim_open has not been called; no wgpu-native entry points are bound");
    0
}

/// `wgpuInstanceRequestAdapter(instance, options*, WGPURequestAdapterCallbackInfo /* by value */)`
#[no_mangle]
pub unsafe extern "C" fn wgpu_bun_shim_instance_request_adapter(
    instance: *mut c_void,
    options: *const c_void,
    callback_info: *const c_void,
) -> u64 {
    let Some(t) = table() else { return not_open() };
    let Some(info) = (unsafe { read_callback_info(callback_info) }) else { return 0 };
    unsafe { (t.instance_request_adapter)(instance, options, info).id }
}

/// `wgpuAdapterRequestDevice(adapter, descriptor*, WGPURequestDeviceCallbackInfo /* by value */)`
#[no_mangle]
pub unsafe extern "C" fn wgpu_bun_shim_adapter_request_device(
    adapter: *mut c_void,
    descriptor: *const c_void,
    callback_info: *const c_void,
) -> u64 {
    let Some(t) = table() else { return not_open() };
    let Some(info) = (unsafe { read_callback_info(callback_info) }) else { return 0 };
    unsafe { (t.adapter_request_device)(adapter, descriptor, info).id }
}

/// `wgpuBufferMapAsync(buffer, mode, offset, size, WGPUBufferMapCallbackInfo /* by value */)`
///
/// `offset` and `size` are `size_t` in C and `u64` here; the binding refuses to run on a 32-bit host,
/// so the narrowing cast cannot lose anything on a supported target.
#[no_mangle]
pub unsafe extern "C" fn wgpu_bun_shim_buffer_map_async(
    buffer: *mut c_void,
    mode: u64,
    offset: u64,
    size: u64,
    callback_info: *const c_void,
) -> u64 {
    let Some(t) = table() else { return not_open() };
    let Some(info) = (unsafe { read_callback_info(callback_info) }) else { return 0 };
    unsafe { (t.buffer_map_async)(buffer, mode, offset as usize, size as usize, info).id }
}

/// `wgpuDevicePopErrorScope(device, WGPUPopErrorScopeCallbackInfo /* by value */)`
#[no_mangle]
pub unsafe extern "C" fn wgpu_bun_shim_device_pop_error_scope(
    device: *mut c_void,
    callback_info: *const c_void,
) -> u64 {
    let Some(t) = table() else { return not_open() };
    let Some(info) = (unsafe { read_callback_info(callback_info) }) else { return 0 };
    unsafe { (t.device_pop_error_scope)(device, info).id }
}

/// `wgpuQueueOnSubmittedWorkDone(queue, WGPUQueueWorkDoneCallbackInfo /* by value */)`
#[no_mangle]
pub unsafe extern "C" fn wgpu_bun_shim_queue_on_submitted_work_done(
    queue: *mut c_void,
    callback_info: *const c_void,
) -> u64 {
    let Some(t) = table() else { return not_open() };
    let Some(info) = (unsafe { read_callback_info(callback_info) }) else { return 0 };
    unsafe { (t.queue_on_submitted_work_done)(queue, info).id }
}

/// `wgpuAdapterInfoFreeMembers(WGPUAdapterInfo /* 96 bytes by value */)`
///
/// Frees the strings `wgpuAdapterGetInfo` allocated into the caller's buffer. A wrong layout here
/// does not fault — it frees the wrong pointers.
#[no_mangle]
pub unsafe extern "C" fn wgpu_bun_shim_adapter_info_free_members(adapter_info: *const c_void) {
    let Some(t) = table() else {
        not_open();
        return;
    };
    if adapter_info.is_null() {
        set_error("wgpu_bun_shim_adapter_info_free_members was passed a null pointer");
        return;
    }
    let info = unsafe { std::ptr::read_unaligned(adapter_info as *const WGPUAdapterInfo) };
    unsafe { (t.adapter_info_free_members)(info) }
}

/// `wgpuSupportedFeaturesFreeMembers(WGPUSupportedFeatures /* 16 bytes by value */)`
///
/// The two-register SysV case. A pointer substitution here does not merely pass the wrong thing —
/// it passes a pointer in the register pair where a count and an array address were expected, and
/// the callee frees whatever that decodes to.
#[no_mangle]
pub unsafe extern "C" fn wgpu_bun_shim_supported_features_free_members(features: *const c_void) {
    let Some(t) = table() else {
        not_open();
        return;
    };
    if features.is_null() {
        set_error("wgpu_bun_shim_supported_features_free_members was passed a null pointer");
        return;
    }
    let value = unsafe { std::ptr::read_unaligned(features as *const WGPUSupportedFeatures) };
    unsafe { (t.supported_features_free_members)(value) }
}

// ────────────────────────────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// The sizes the binding derives independently, from the pinned headers. If these ever disagree
    /// the two descriptions of the same C types have diverged, and one of them is silently wrong.
    #[test]
    fn aggregate_sizes_match_the_pinned_headers() {
        assert_eq!(std::mem::size_of::<WGPUStringView>(), 16);
        assert_eq!(std::mem::size_of::<WGPUCallbackInfo>(), 40);
        assert_eq!(std::mem::size_of::<WGPUAdapterInfo>(), 96);
        assert_eq!(std::mem::size_of::<WGPUSupportedFeatures>(), 16);
        assert_eq!(std::mem::size_of::<WGPUFuture>(), 8);
    }

    /// Offsets, not just sizes — a struct can be the right total size with its members in the wrong
    /// places, and that is the failure mode that presents as a callback with a nonsense status.
    #[test]
    fn callback_info_members_sit_where_the_header_puts_them() {
        let info = WGPUCallbackInfo {
            next_in_chain: std::ptr::null(),
            mode: 0,
            callback: std::ptr::null(),
            userdata1: std::ptr::null_mut(),
            userdata2: std::ptr::null_mut(),
        };
        let base = &info as *const _ as usize;
        assert_eq!(&info.next_in_chain as *const _ as usize - base, 0);
        assert_eq!(&info.mode as *const _ as usize - base, 8);
        assert_eq!(&info.callback as *const _ as usize - base, 16);
        assert_eq!(&info.userdata1 as *const _ as usize - base, 24);
        assert_eq!(&info.userdata2 as *const _ as usize - base, 32);
    }

    #[test]
    fn a_wrapper_called_before_open_is_inert_rather_than_pretending() {
        // No `open` in this test binary, so the table is empty. The contract is "return an invalid
        // future id and record why", never "return something that looks like success".
        let info = [0u8; 40];
        let future = unsafe {
            wgpu_bun_shim_instance_request_adapter(
                std::ptr::null_mut(),
                std::ptr::null(),
                info.as_ptr() as *const c_void,
            )
        };
        assert_eq!(future, 0);
        assert_eq!(wgpu_bun_shim_is_open(), 0);
    }
}
