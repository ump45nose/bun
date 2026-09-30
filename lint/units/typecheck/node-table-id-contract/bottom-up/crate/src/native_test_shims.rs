//! Native symbols that Bun's C++ side provides, for the test binary of this crate. Never part of the real build.

#[unsafe(no_mangle)]
extern "C" fn Bun__StackCheck__getMaxStack() -> *mut core::ffi::c_void {
    let probe: u8 = 0;
    let approx_sp = (&raw const probe) as usize;
    (approx_sp.saturating_sub(512 * 1024)) as *mut core::ffi::c_void
}

#[unsafe(no_mangle)]
unsafe extern "C" fn highway_memmem(haystack: *const u8, haystack_len: usize, needle: *const u8, needle_len: usize) -> *const u8 {
    // SAFETY: the caller passes two valid slices.
    let (h, n) = unsafe { (core::slice::from_raw_parts(haystack, haystack_len), core::slice::from_raw_parts(needle, needle_len)) };
    if n.is_empty() {
        return haystack;
    }
    if h.len() < n.len() {
        return core::ptr::null();
    }
    match (0..=h.len() - n.len()).find(|&i| h[i..i + n.len()] == *n) {
        // SAFETY: i is inside the haystack.
        Some(i) => unsafe { haystack.add(i) },
        None => core::ptr::null(),
    }
}
