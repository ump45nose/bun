// Upstream package internal/core plus what replaces Go's runtime. The module is not named `core`: that name hides the `core` crate.
pub mod ids;
pub mod deps;
pub mod golang;
pub mod internal;
pub mod stable;
pub mod text;
