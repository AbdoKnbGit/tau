use std::fs;
use std::path::Path;

use tau_rust_tools::{
    advise_profile, analyze_dependency_cost, audit_unsafe, inspect_artifact_sizes, map_tests,
    parse_diagnostics, plan_focused_command, CargoOperation, FocusedCommandOptions, ProfileGoal,
};
use tempfile::TempDir;

fn write(root: &Path, relative: &str, contents: &str) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create fixture directory");
    }
    fs::write(path, contents).expect("write fixture file");
}

fn basic_crate() -> TempDir {
    let fixture = TempDir::new().expect("temporary crate");
    write(
        fixture.path(),
        "Cargo.toml",
        r#"
[package]
name = "native-fixture"
version = "0.1.0"
edition = "2021"

[features]
fast = []

[[bin]]
name = "worker"
path = "src/main.rs"
required-features = ["fast"]
"#,
    );
    write(fixture.path(), "src/main.rs", "fn main() {}\n");
    fixture
}

#[test]
fn focused_command_plans_argv_without_running_cargo() {
    let fixture = basic_crate();
    let root = fixture.path();
    let manifest_before = fs::read(root.join("Cargo.toml")).expect("read manifest");
    let plan = plan_focused_command(
        &root.join("src/main.rs"),
        CargoOperation::Clippy,
        &FocusedCommandOptions {
            features: vec!["extra,fast".to_owned()],
            no_default_features: true,
            ..FocusedCommandOptions::default()
        },
    )
    .expect("plan focused command");

    assert_eq!(
        plan.args,
        [
            "clippy",
            "-p",
            "native-fixture",
            "--bin",
            "worker",
            "--features",
            "extra,fast",
            "--no-default-features"
        ]
    );
    assert_eq!(fs::read(root.join("Cargo.toml")).unwrap(), manifest_before);
    assert!(!root.join("Cargo.lock").exists());
    assert!(!root.join("target").exists());
}

#[test]
fn test_map_uses_rust_syntax_and_nested_names() {
    let fixture = TempDir::new().expect("temporary crate");
    let root = fixture.path();
    write(
        root,
        "Cargo.toml",
        "[package]\nname='tests-fixture'\nversion='0.1.0'\nedition='2021'\n",
    );
    write(
        root,
        "src/lib.rs",
        r#"
/// ```
/// assert_eq!(2 + 2, 4);
/// ```
pub fn add() {}

#[cfg(test)]
mod tests {
    #[test]
    fn unit_works() {}

    #[tokio::test]
    async fn async_works() {}
}
"#,
    );

    let report = map_tests(&root.join("src/lib.rs"), true).expect("map tests");

    assert_eq!(report.scope, "library_unit_tests");
    assert!(report.has_doc_examples);
    assert_eq!(report.tests.len(), 2);
    assert_eq!(report.tests[0].name, "tests::unit_works");
    assert_eq!(report.tests[1].framework, "tokio::test");
    assert!(!root.join("Cargo.lock").exists());
}

#[test]
fn diagnostics_deduplicate_and_preserve_machine_suggestions() {
    let line = serde_json::json!({
        "reason": "compiler-message",
        "message": {
            "level": "warning",
            "code": {"code": "unused_mut"},
            "message": "variable does not need to be mutable",
            "spans": [{
                "file_name": "src/lib.rs",
                "line_start": 3,
                "column_start": 9,
                "line_end": 3,
                "column_end": 13,
                "is_primary": true,
                "label": null,
                "suggested_replacement": "value",
                "suggestion_applicability": "MachineApplicable"
            }],
            "children": [],
            "rendered": "warning: variable does not need to be mutable"
        }
    })
    .to_string();
    let report =
        parse_diagnostics(&format!("{line}\n{line}\n"), Some(20)).expect("parse diagnostics");

    assert_eq!(report.counts["warning"], 2);
    assert_eq!(report.diagnostics.len(), 1);
    assert_eq!(report.diagnostics[0].occurrences, 2);
    assert_eq!(
        report.diagnostics[0].suggestions[0]
            .applicability
            .as_deref(),
        Some("MachineApplicable")
    );
}

#[test]
fn dependency_cost_reads_existing_lock_graph_without_rewriting_it() {
    let fixture = TempDir::new().expect("temporary crate");
    let root = fixture.path();
    write(
        root,
        "Cargo.toml",
        r#"
[package]
name = "cost-fixture"
version = "0.1.0"
edition = "2021"

[dependencies]
foo = "1"
"#,
    );
    write(root, "src/lib.rs", "pub struct Cost;\n");
    write(
        root,
        "Cargo.lock",
        r#"
version = 3

[[package]]
name = "cost-fixture"
version = "0.1.0"
dependencies = ["foo 1.0.0", "foo 2.0.0"]

[[package]]
name = "foo"
version = "1.0.0"
dependencies = ["leaf"]

[[package]]
name = "foo"
version = "2.0.0"

[[package]]
name = "leaf"
version = "1.0.0"
"#,
    );
    let lock_before = fs::read(root.join("Cargo.lock")).expect("read lockfile");

    let report = analyze_dependency_cost(root).expect("analyze dependency cost");

    assert_eq!(report.locked_packages, 4);
    assert_eq!(report.direct_dependencies[0].locked_versions.len(), 2);
    assert_eq!(report.direct_dependencies[0].transitive_packages, 1);
    assert_eq!(report.duplicate_versions[0].package, "foo");
    assert_eq!(fs::read(root.join("Cargo.lock")).unwrap(), lock_before);
}

#[test]
fn artifact_size_only_measures_existing_outputs() {
    let fixture = basic_crate();
    let root = fixture.path();
    write(root, "target/release/worker.exe", &"x".repeat(64));
    write(
        root,
        "target/release/deps/libalpha-12345678.rlib",
        &"x".repeat(32),
    );
    write(
        root,
        "target/release/incremental/cache.bin",
        &"x".repeat(16),
    );

    let report = inspect_artifact_sizes(root, Some("release"), None, Some(10))
        .expect("inspect artifact sizes");

    assert_eq!(report.total_bytes, 96);
    assert_eq!(report.artifact_files, 2);
    assert_eq!(report.incremental_bytes, 16);
    assert_eq!(report.top_artifacts[0].bytes, 64);
}

#[test]
fn profile_advice_uses_actual_workspace_profile_values() {
    let fixture = TempDir::new().expect("temporary crate");
    let root = fixture.path();
    write(
        root,
        "Cargo.toml",
        r#"
[package]
name = "profile-fixture"
version = "0.1.0"
edition = "2021"

[profile.release]
lto = false
codegen-units = 16
"#,
    );
    write(root, "src/lib.rs", "pub struct Profile;\n");

    let report = advise_profile(root, ProfileGoal::Balanced, None).expect("advise profile");

    assert_eq!(report.profile, "release");
    assert_eq!(report.explicit_settings["lto"], "false");
    assert_eq!(report.recommendations[0].setting, "lto");
    assert_eq!(report.recommendations[0].suggested, "thin");
}

#[test]
fn unsafe_audit_distinguishes_documented_and_undocumented_surfaces() {
    let fixture = TempDir::new().expect("temporary crate");
    let root = fixture.path();
    write(
        root,
        "Cargo.toml",
        "[package]\nname='unsafe-fixture'\nversion='0.1.0'\nedition='2021'\n",
    );
    write(
        root,
        "src/lib.rs",
        r#"
/// # Safety
/// The pointer must be valid.
pub unsafe fn documented(pointer: *const u8) -> u8 {
    // SAFETY: guaranteed by the caller.
    unsafe { *pointer }
}

pub unsafe fn undocumented() {}

#[repr(C)]
pub struct WireValue {
    value: u32,
}

static mut GLOBAL_VALUE: u32 = 0;

extern "C" {
    fn external_value() -> i32;
}
"#,
    );

    let report = audit_unsafe(root, Some(10)).expect("audit unsafe code");

    assert_eq!(report.scanned_files, 1);
    assert_eq!(report.counts["unsafe_function"], 2);
    assert_eq!(report.counts["unsafe_block"], 1);
    assert_eq!(report.counts["extern_block"], 1);
    assert_eq!(report.counts["ffi_layout"], 1);
    assert_eq!(report.counts["static_mut"], 1);
    assert_eq!(report.undocumented_unsafe, 2);
}
