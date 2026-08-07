use std::fs;
use std::io::Write;
use std::process::{Command, Stdio};

use serde_json::Value;
use tempfile::TempDir;

fn binary() -> Command {
    Command::new(env!("CARGO_BIN_EXE_tau-rust-tools"))
}

#[test]
fn emits_json_for_paths_with_spaces_without_project_side_effects() {
    let fixture = TempDir::new().expect("temporary directory");
    let root = fixture.path().join("workspace with spaces");
    fs::create_dir_all(root.join("src")).expect("create source directory");
    fs::write(
        root.join("Cargo.toml"),
        r#"
[package]
name = "space-safe"
version = "0.1.0"
edition = "2021"
"#,
    )
    .expect("write Cargo.toml");
    fs::write(root.join("src/lib.rs"), "pub struct SpaceSafe;\n").expect("write lib.rs");

    let output = binary()
        .args(["workspace-context", "--path"])
        .arg(root.join("src/lib.rs"))
        .arg("--pretty")
        .output()
        .expect("run native helper");

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let json: Value = serde_json::from_slice(&output.stdout).expect("valid JSON output");
    assert_eq!(json["selectedPackage"]["name"], "space-safe");
    assert_eq!(json["selectedTarget"]["kind"], "lib");
    assert!(!root.join("Cargo.lock").exists());
    assert!(!root.join("target").exists());
}

#[test]
fn rejects_duplicate_path_flags_with_usage_exit_code() {
    let output = binary()
        .args(["workspace-context", "--path", ".", "--path=another"])
        .output()
        .expect("run native helper");

    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("cannot be used multiple times"));
}

#[test]
fn help_advertises_every_native_rust_capability() {
    let output = binary().arg("--help").output().expect("show helper help");
    assert!(output.status.success());
    let help = String::from_utf8_lossy(&output.stdout);
    for command in [
        "workspace-context",
        "focused-command",
        "test-map",
        "diagnostics",
        "dependency-cost",
        "artifact-size",
        "profile-advice",
        "unsafe-audit",
    ] {
        assert!(help.contains(command), "missing {command} from CLI help");
    }
}

#[test]
fn diagnostics_accepts_json_lines_over_stdin() {
    let mut child = binary()
        .args(["diagnostics", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("start native helper");
    let line = serde_json::json!({
        "level": "error",
        "message": "fixture failure",
        "spans": []
    })
    .to_string();
    child
        .stdin
        .take()
        .expect("diagnostic stdin")
        .write_all(line.as_bytes())
        .expect("write diagnostic input");
    let output = child.wait_with_output().expect("read native output");

    assert!(output.status.success());
    let json: Value = serde_json::from_slice(&output.stdout).expect("valid JSON output");
    assert_eq!(json["counts"]["error"], 1);
    assert_eq!(json["diagnostics"][0]["message"], "fixture failure");
}
