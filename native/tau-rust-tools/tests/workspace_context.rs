use std::fs;
use std::path::Path;

use tau_rust_tools::inspect_workspace;
use tempfile::TempDir;

fn write(root: &Path, relative: &str, contents: &str) {
    let path = root.join(relative);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("create fixture directory");
    }
    fs::write(path, contents).expect("write fixture file");
}

#[test]
fn resolves_virtual_workspace_inheritance_and_focused_target() {
    let fixture = TempDir::new().expect("temporary workspace");
    let root = fixture.path();
    write(
        root,
        "Cargo.toml",
        r#"
[workspace]
members = ["crates/*"]
default-members = ["crates/core"]
resolver = "2"

[workspace.package]
version = "1.2.3"
edition = "2021"
rust-version = "1.75"
"#,
    );
    write(
        root,
        "crates/core/Cargo.toml",
        r#"
[package]
name = "core-lib"
version.workspace = true
edition.workspace = true
rust-version.workspace = true

[features]
default = ["std"]
std = []
"#,
    );
    write(
        root,
        "crates/core/src/lib.rs",
        "pub fn answer() -> u8 { 42 }\n",
    );
    write(
        root,
        "crates/app/Cargo.toml",
        r#"
[package]
name = "app"
version.workspace = true
edition.workspace = true
"#,
    );
    write(root, "crates/app/src/main.rs", "fn main() {}\n");

    let context =
        inspect_workspace(&root.join("crates/core/src/lib.rs")).expect("inspect workspace");

    assert_eq!(context.schema_version, 1);
    assert_eq!(context.resolver.as_deref(), Some("2"));
    assert_eq!(context.packages.len(), 2);
    let package = context.selected_package.expect("selected package");
    assert_eq!(package.name, "core-lib");
    assert_eq!(package.version, "1.2.3");
    assert_eq!(package.edition, "2021");
    assert_eq!(package.rust_version.as_deref(), Some("1.75"));
    assert!(package.is_default_member);
    assert!(package.features.contains_key("std"));
    let target = context.selected_target.expect("selected target");
    assert_eq!(target.kind, "lib");
    assert_eq!(target.name, "core_lib");
    assert!(
        !root.join("Cargo.lock").exists(),
        "inspection created Cargo.lock"
    );
    assert!(
        !root.join("target").exists(),
        "inspection created target directory"
    );
}

#[test]
fn discovers_implicit_in_tree_path_dependency_member() {
    let fixture = TempDir::new().expect("temporary workspace");
    let root = fixture.path();
    write(
        root,
        "Cargo.toml",
        r#"
[workspace]
members = ["app"]
resolver = "2"
"#,
    );
    write(
        root,
        "app/Cargo.toml",
        r#"
[package]
name = "app"
version = "0.1.0"
edition = "2021"

[dependencies]
shared = { path = "../shared" }
"#,
    );
    write(root, "app/src/main.rs", "fn main() {}\n");
    write(
        root,
        "shared/Cargo.toml",
        r#"
[package]
name = "shared"
version = "0.1.0"
edition = "2021"
"#,
    );
    write(root, "shared/src/lib.rs", "pub struct Shared;\n");

    let context = inspect_workspace(&root.join("shared/src/lib.rs")).expect("inspect workspace");

    assert!(context
        .packages
        .iter()
        .any(|package| package.name == "shared"));
    assert_eq!(
        context
            .selected_package
            .as_ref()
            .map(|package| package.name.as_str()),
        Some("shared")
    );
    assert!(!root.join("Cargo.lock").exists());
}

#[test]
fn follows_explicit_package_workspace_with_filesystem_only_discovery() {
    let fixture = TempDir::new().expect("temporary workspace");
    let root = fixture.path();
    write(
        root,
        "workspace/Cargo.toml",
        r#"
[workspace]
members = []
resolver = "2"

[workspace.package]
version = "0.1.0"
edition = "2021"
"#,
    );
    write(
        root,
        "member/Cargo.toml",
        r#"
[package]
name = "explicit-member"
version.workspace = true
edition.workspace = true
workspace = "../workspace"
"#,
    );
    write(root, "member/src/lib.rs", "pub struct ExplicitMember;\n");

    let context = inspect_workspace(&root.join("member/src/lib.rs"))
        .expect("inspect explicitly linked workspace member");

    assert_eq!(context.workspace_root, root.join("workspace"));
    assert_eq!(
        context
            .selected_package
            .as_ref()
            .map(|package| package.name.as_str()),
        Some("explicit-member")
    );
    assert!(!root.join("workspace/Cargo.lock").exists());
    assert!(!root.join("workspace/target").exists());
}

#[test]
fn keeps_unlisted_nested_package_out_of_an_ancestor_workspace() {
    let fixture = TempDir::new().expect("temporary workspace");
    let root = fixture.path();
    write(
        root,
        "Cargo.toml",
        r#"
[workspace]
members = ["member"]
resolver = "2"
"#,
    );
    write(
        root,
        "member/Cargo.toml",
        "[package]\nname='listed'\nversion='0.1.0'\nedition='2021'\n",
    );
    write(root, "member/src/lib.rs", "pub struct Listed;\n");
    write(
        root,
        "scratch/Cargo.toml",
        "[package]\nname='standalone'\nversion='0.1.0'\nedition='2021'\n",
    );
    write(root, "scratch/src/lib.rs", "pub struct Standalone;\n");

    let context =
        inspect_workspace(&root.join("scratch/src/lib.rs")).expect("inspect nested standalone");

    assert_eq!(context.workspace_root, root.join("scratch"));
    assert_eq!(context.packages.len(), 1);
    assert_eq!(context.packages[0].name, "standalone");
    assert!(context
        .warnings
        .iter()
        .any(|warning| warning.contains("not a declared or in-tree path dependency member")));
}

#[test]
fn maps_nonexistent_module_to_library_without_touching_disk() {
    let fixture = TempDir::new().expect("temporary workspace");
    let root = fixture.path();
    write(
        root,
        "Cargo.toml",
        r#"
[package]
name = "single"
version = "0.1.0"
edition = "2024"
"#,
    );
    write(root, "src/lib.rs", "pub mod existing;\n");
    let query = root.join("src/new/deep/module.rs");

    let context = inspect_workspace(&query).expect("inspect workspace");

    assert_eq!(context.query_path, query);
    assert_eq!(
        context
            .selected_target
            .as_ref()
            .map(|target| target.kind.as_str()),
        Some("lib")
    );
    assert!(!query.exists());
    assert!(!root.join("Cargo.lock").exists());
}

#[test]
fn maps_a_single_file_binary_module_to_that_binary() {
    let fixture = TempDir::new().expect("temporary workspace");
    let root = fixture.path();
    write(
        root,
        "Cargo.toml",
        r#"
[package]
name = "mixed"
version = "0.1.0"
edition = "2021"
"#,
    );
    write(root, "src/lib.rs", "pub struct Library;\n");
    write(root, "src/bin/worker.rs", "mod task; fn main() {}\n");
    write(root, "src/bin/worker/task.rs", "pub fn run() {}\n");

    let context =
        inspect_workspace(&root.join("src/bin/worker/task.rs")).expect("inspect binary module");

    let target = context.selected_target.expect("selected target");
    assert_eq!(target.kind, "bin");
    assert_eq!(target.name, "worker");
}

#[test]
fn refuses_workspace_globs_that_escape_the_workspace_root() {
    let fixture = TempDir::new().expect("temporary workspace");
    let root = fixture.path().join("workspace");
    write(
        &root,
        "Cargo.toml",
        r#"
[workspace]
members = ["../*"]
"#,
    );

    let context = inspect_workspace(&root).expect("inspect bounded workspace");

    assert!(context.packages.is_empty());
    assert!(context
        .warnings
        .iter()
        .any(|warning| warning.contains("escapes the workspace root")));
}

#[test]
fn errors_cleanly_outside_a_cargo_project() {
    let fixture = TempDir::new().expect("temporary directory");
    let error = inspect_workspace(fixture.path()).expect_err("missing manifest should fail");
    assert!(error.to_string().contains("no Cargo.toml"));
}
