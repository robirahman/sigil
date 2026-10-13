//! Per-thread caching allocator for the THREADED wasm build only.
//!
//! wasm32's default allocator (dlmalloc) serialises every allocation on one
//! global lock once std is built with atomics. The search allocates per node
//! (turn lists, child vectors), so with several threads they queue on that lock:
//! measured in headless Chrome, two INDEPENDENT searches ran at 0.7x each and
//! three at 0.3x. This keeps a small free list per size class per thread
//! (powers of two from 16 to 4096 bytes, intrusive: a freed block stores the next
//! pointer in itself) in front of dlmalloc, so the hot path takes no lock. Blocks
//! freed on another thread join that thread's list; each list is capped, and
//! anything larger or more aligned goes straight to dlmalloc.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

const CLASSES: usize = 9;          // 16, 32, ..., 4096
const MAX_CACHED: u32 = 4096;      // blocks per class per thread

thread_local! {
    static HEAD: [Cell<*mut u8>; CLASSES] = const { [const { Cell::new(std::ptr::null_mut()) }; CLASSES] };
    static COUNT: [Cell<u32>; CLASSES] = const { [const { Cell::new(0) }; CLASSES] };
}

#[inline]
fn class_of(layout: &Layout) -> Option<usize> {
    if layout.align() > 16 || layout.size() > 4096 { return None; }
    let size = layout.size().max(16).next_power_of_two();
    Some(size.trailing_zeros() as usize - 4)
}

#[inline]
fn class_layout(c: usize) -> Layout {
    // SAFETY: power of two size >= 16 with alignment 16.
    unsafe { Layout::from_size_align_unchecked(16usize << c, 16) }
}

pub struct TcAlloc;

unsafe impl GlobalAlloc for TcAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        match class_of(&layout) {
            Some(c) => {
                let hit = HEAD.with(|h| {
                    let p = h[c].get();
                    if !p.is_null() {
                        h[c].set(*(p as *mut *mut u8));
                        COUNT.with(|n| n[c].set(n[c].get() - 1));
                    }
                    p
                });
                if !hit.is_null() { hit } else { System.alloc(class_layout(c)) }
            }
            None => System.alloc(layout),
        }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        match class_of(&layout) {
            Some(c) => {
                let cached = COUNT.with(|n| {
                    if n[c].get() < MAX_CACHED { n[c].set(n[c].get() + 1); true } else { false }
                });
                if cached {
                    HEAD.with(|h| {
                        *(ptr as *mut *mut u8) = h[c].get();
                        h[c].set(ptr);
                    });
                } else {
                    System.dealloc(ptr, class_layout(c));
                }
            }
            None => System.dealloc(ptr, layout),
        }
    }
}

#[global_allocator]
static GLOBAL: TcAlloc = TcAlloc;
