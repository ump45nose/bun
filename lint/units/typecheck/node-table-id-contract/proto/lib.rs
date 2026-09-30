//! Prototype of the node table, its builder and the id contract. Not part of the repository.

#[macro_use]
pub mod ids;
pub mod core;
pub mod golang;
pub mod internal;

#[cfg(test)]
mod native_test_shims;
