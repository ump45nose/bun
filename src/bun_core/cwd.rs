//! The process working directory.
//!
//! Read from the operating system once, at process start ([`startup`]), and
//! again only when Bun changes directory (`bun_sys::chdir`/`fchdir` call
//! [`set`]). Code that needs the working directory reads it here with
//! [`get`] and joins onto it, rather than asking the OS again or keeping its
//! own copy. [`get`] returns a counted reference, [`Cwd`]; what is kept past
//! a `chdir` is the directory that was current when it was read.

use core::alloc::Layout;
use core::mem::size_of;
use core::ops::Deref;
use core::ptr::{self, NonNull};
use core::slice;
use core::sync::atomic::{self, AtomicPtr, AtomicU64, AtomicUsize, Ordering};

use crate::{Mutex, PathBuffer, ZStr};

/// Header of a recorded directory; `len` bytes and a NUL follow it in the
/// same allocation, so that [`Cwd`] is a thin pointer. Only ever handled by
/// raw pointer, so the pointer keeps provenance over the whole allocation.
#[repr(C)]
struct Entry {
    refs: AtomicUsize,
    len: usize,
    bytes: [u8; 0],
}

fn layout(len: usize) -> Layout {
    Layout::from_size_align(size_of::<Entry>() + len + 1, align_of::<Entry>()).unwrap()
}

/// A reference to a working directory: the one that was current when
/// [`get`] returned it. The directory's name is freed with its last
/// reference.
pub struct Cwd(NonNull<Entry>);

// SAFETY: an entry is immutable apart from its atomic count.
unsafe impl Send for Cwd {}
// SAFETY: as above.
unsafe impl Sync for Cwd {}

impl Cwd {
    /// Absolute, with no trailing separator except for a filesystem root.
    #[inline]
    pub fn as_bytes(&self) -> &[u8] {
        let p = self.0.as_ptr();
        // SAFETY: `len` initialized bytes follow the header, and this
        // reference keeps them allocated.
        unsafe { slice::from_raw_parts(ptr::addr_of!((*p).bytes).cast::<u8>(), (*p).len) }
    }

    #[inline]
    pub fn as_zstr(&self) -> &ZStr {
        let p = self.0.as_ptr();
        // SAFETY: as for `as_bytes`; a NUL follows the bytes.
        unsafe { ZStr::from_raw(ptr::addr_of!((*p).bytes).cast::<u8>(), (*p).len) }
    }
}

impl Deref for Cwd {
    type Target = [u8];
    #[inline]
    fn deref(&self) -> &[u8] {
        self.as_bytes()
    }
}

impl AsRef<[u8]> for Cwd {
    #[inline]
    fn as_ref(&self) -> &[u8] {
        self.as_bytes()
    }
}

impl Clone for Cwd {
    #[inline]
    fn clone(&self) -> Self {
        // SAFETY: this reference keeps the entry allocated.
        unsafe { (*self.0.as_ptr()).refs.fetch_add(1, Ordering::Relaxed) };
        Cwd(self.0)
    }
}

impl Drop for Cwd {
    #[inline]
    fn drop(&mut self) {
        // SAFETY: this is the reference being given up.
        unsafe { release(self.0.as_ptr()) };
    }
}

/// # Safety
/// The caller owns one reference to `p` and gives it up.
unsafe fn release(p: *mut Entry) {
    // SAFETY: the caller's reference keeps the entry allocated until the
    // count is seen to reach zero, after which nothing else can reach it.
    unsafe {
        if (*p).refs.fetch_sub(1, Ordering::Release) != 1 {
            return;
        }
        atomic::fence(Ordering::Acquire);
        std::alloc::dealloc(p.cast(), layout((*p).len));
    }
}

#[repr(C)]
struct Empty {
    refs: AtomicUsize,
    len: usize,
    nul: u8,
}
/// What [`CWD`] points at until [`startup`]. Its one reference is never given
/// up, so it is never freed.
static EMPTY: Empty = Empty {
    refs: AtomicUsize::new(1),
    len: 0,
    nul: 0,
};

/// The current directory; holds one reference to it.
static CWD: AtomicPtr<Entry> = AtomicPtr::new(ptr::addr_of!(EMPTY) as *mut Entry);

/// Readers that have loaded [`CWD`] and not yet counted their reference.
/// [`set`] gives up the previous directory's reference only once it has seen
/// this at zero after the swap: a reader that loaded the previous directory
/// announced itself here before the swap, and has counted itself by the time
/// it leaves.
static READERS: AtomicUsize = AtomicUsize::new(0);

static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Why [`startup`] could not read the working directory, until a `chdir`
/// records one. Its lock is also what keeps [`set`] to one caller at a time.
static UNREAD: Mutex<Option<Unread>> = Mutex::new(None);

#[derive(Clone, Copy)]
struct Unread {
    err: crate::Error,
    /// What `getcwd` left in `errno` (`GetLastError` on Windows).
    os_error: u32,
}

/// The working directory as the OS reports it.
#[inline]
pub fn get() -> Cwd {
    // `SeqCst` on these and on `set`'s swap and check: each side writes one
    // and then reads the other, and at least one of them must see the
    // other's write.
    READERS.fetch_add(1, Ordering::SeqCst);
    let p = CWD.load(Ordering::SeqCst);
    debug_assert!(
        !ptr::eq(p, ptr::addr_of!(EMPTY).cast()),
        "cwd::get() before cwd::startup()"
    );
    // SAFETY: `CWD` held a reference to `p` when it was loaded, and `set`
    // does not give that up while `READERS` is non-zero.
    unsafe { (*p).refs.fetch_add(1, Ordering::Relaxed) };
    READERS.fetch_sub(1, Ordering::SeqCst);
    // SAFETY: `CWD` is never null.
    Cwd(unsafe { NonNull::new_unchecked(p) })
}

/// Changes whenever the working directory does; for caches of values derived
/// from it. Never zero once [`startup`] has run.
#[inline]
pub fn generation() -> u64 {
    GENERATION.load(Ordering::Acquire)
}

/// [`generation`], if the working directory is `path`. A value read from the
/// OS while a `chdir` on another thread is in flight belongs to none.
pub fn generation_of(path: &[u8]) -> Option<u64> {
    let generation = generation();
    let cwd = get();
    (cwd.as_bytes() == path && self::generation() == generation).then_some(generation)
}

/// Reads and records the working directory; call once at process start,
/// before anything calls [`get`]. If the OS cannot report one (removed, or an
/// ancestor is not searchable) the executable's directory stands in — how
/// Node starts from a deleted directory — and [`require`] reports the error
/// to commands that must not guess.
pub fn startup() {
    let mut buf = PathBuffer::ZEROED;
    match crate::getcwd(&mut buf) {
        Ok(cwd) => {
            set(cwd.as_bytes());
        }
        Err(err) => {
            #[cfg(unix)]
            let os_error = crate::ffi::errno() as u32;
            #[cfg(windows)]
            let os_error = bun_windows_sys::kernel32::GetLastError();
            let exe_dir: &[u8] = crate::self_exe_path()
                .ok()
                .and_then(|p| crate::dirname(p.as_bytes()))
                .filter(|d| crate::path_sep::is_absolute_native(d))
                .unwrap_or(if cfg!(windows) { b"C:\\" } else { b"/" });
            set(exe_dir);
            *UNREAD.lock() = Some(Unread { err, os_error });
        }
    }
}

/// The working directory, or the error from [`startup`] if the OS could not
/// report one and nothing has been recorded since. For a command's first use,
/// where continuing from a stand-in directory would act on the wrong project.
pub fn require() -> crate::CrateResult<Cwd> {
    let unread = *UNREAD.lock();
    match unread {
        Some(unread) => Err(unread.err),
        None => Ok(get()),
    }
}

/// The OS error code behind a failing [`require`]: `errno`, or
/// `GetLastError` on Windows.
pub fn unread_os_error() -> Option<u32> {
    UNREAD.lock().map(|unread| unread.os_error)
}

/// Records `path` as the working directory. For [`startup`] and
/// `bun_sys::chdir`/`fchdir`, which have just read it back from the OS;
/// nothing else should need this.
pub fn set(path: &[u8]) {
    let mut unread = UNREAD.lock();
    *unread = None;

    let current = CWD.load(Ordering::SeqCst);
    let is_empty = ptr::eq(current, ptr::addr_of!(EMPTY).cast());
    // SAFETY: `CWD`'s reference keeps `current` allocated, and only this
    // function, one caller at a time, gives that reference up.
    let current_bytes = unsafe {
        slice::from_raw_parts(ptr::addr_of!((*current).bytes).cast::<u8>(), (*current).len)
    };
    if !is_empty && current_bytes == path {
        return;
    }

    // SAFETY: the layout is non-zero-sized and `Entry`-aligned; the writes
    // stay within it.
    #[expect(clippy::cast_ptr_alignment, reason = "layout is Entry-aligned")]
    let entry = unsafe {
        let p = std::alloc::alloc(layout(path.len())).cast::<Entry>();
        if p.is_null() {
            crate::out_of_memory();
        }
        ptr::addr_of_mut!((*p).refs).write(AtomicUsize::new(1));
        ptr::addr_of_mut!((*p).len).write(path.len());
        let bytes = ptr::addr_of_mut!((*p).bytes).cast::<u8>();
        ptr::copy_nonoverlapping(path.as_ptr(), bytes, path.len());
        bytes.add(path.len()).write(0);
        p
    };

    let previous = CWD.swap(entry, Ordering::SeqCst);
    GENERATION.fetch_add(1, Ordering::Release);
    while READERS.load(Ordering::SeqCst) != 0 {
        core::hint::spin_loop();
    }
    if !is_empty {
        // SAFETY: the reference `CWD` held; every reader that loaded
        // `previous` has counted its own.
        unsafe { release(previous) };
    }
}
