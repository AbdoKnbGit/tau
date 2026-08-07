//! Native, stateless Rust-mode capabilities for Tau.
//!
//! This crate deliberately owns no daemon, cache, shell, permission system, or
//! editor integration. Tau owns those concerns and invokes this binary once per
//! approved tool call.

pub mod artifact_size;
pub mod dependency_cost;
pub mod diagnostics;
pub mod error;
pub mod focused_command;
pub mod profile_advice;
pub mod test_map;
pub mod unsafe_audit;
pub mod workspace;

pub use artifact_size::{inspect_artifact_sizes, ArtifactSizeReport};
pub use dependency_cost::{analyze_dependency_cost, DependencyCostReport};
pub use diagnostics::{parse_diagnostics, parse_diagnostics_file, DiagnosticsReport};
pub use error::{Error, Result};
pub use focused_command::{
    plan_focused_command, CargoOperation, FocusedCommandOptions, FocusedCommandPlan,
};
pub use profile_advice::{advise_profile, ProfileAdviceReport, ProfileGoal};
pub use test_map::{map_tests, TestMap};
pub use unsafe_audit::{audit_unsafe, UnsafeAuditReport};
pub use workspace::{inspect_workspace, WorkspaceContext};
