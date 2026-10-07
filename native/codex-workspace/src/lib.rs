//! Native workspace database transport for the Cantelop Codex build.
//! This crate deliberately has no SQLite engine or local database connections.

pub const PROTOCOL_VERSION: u32 = 1;
pub const REQUEST_METHOD: &str = "cantelop/workspaceDatabase";

mod driver;
mod migrate;
mod scope;
pub use driver::*;
