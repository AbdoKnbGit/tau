use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use toml::Value;

use crate::error::Result;
use crate::workspace::{canonicalize_friendly, inspect_workspace, is_within, path_key};

const SCHEMA_VERSION: u32 = 1;
const MAX_CONFIG_BYTES: u64 = 1024 * 1024;
const MAX_SETTING_CHARS: usize = 2_048;

const BUILD_KEYS: &[&str] = &[
    "incremental",
    "jobs",
    "rustc",
    "rustc-wrapper",
    "rustc-workspace-wrapper",
    "rustdoc",
    "rustdocflags",
    "rustflags",
    "target",
    "target-dir",
];

const TARGET_KEYS: &[&str] = &["linker", "runner", "rustdocflags", "rustflags"];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildEnvironmentReport {
    pub schema_version: u32,
    pub workspace_root: PathBuf,
    pub resolution_directory: PathBuf,
    pub requested_target: Option<String>,
    pub toolchain: Option<ToolchainSelection>,
    pub effective_toolchain: Option<BuildSetting>,
    pub config_sources: Vec<CargoConfigSource>,
    pub effective_settings: Vec<BuildSetting>,
    pub target_settings: Vec<BuildSetting>,
    pub conditional_target_settings: Vec<BuildSetting>,
    pub source_replacements: Vec<BuildSetting>,
    pub environment: Vec<BuildSetting>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolchainSelection {
    pub path: PathBuf,
    pub format: String,
    pub channel: Option<String>,
    pub profile: Option<String>,
    pub components: Vec<String>,
    pub targets: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CargoConfigSource {
    pub path: PathBuf,
    pub precedence: usize,
    pub keys: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildSetting {
    pub key: String,
    pub value: String,
    pub source: String,
}

struct ParsedConfig {
    path: PathBuf,
    precedence: usize,
    value: Value,
}

pub fn inspect_build_environment(
    query: &Path,
    target_triple: Option<&str>,
) -> Result<BuildEnvironmentReport> {
    let context = inspect_workspace(query)?;
    let resolution_directory = resolution_directory(&context.query_path, &context.workspace_root);
    let mut warnings = context.warnings;
    let config_paths = cargo_config_paths(
        &context.workspace_root,
        &resolution_directory,
        &mut warnings,
    );
    let mut configs = Vec::new();
    for (precedence, path) in config_paths.into_iter().enumerate() {
        match parse_toml_file(&path) {
            Ok(value) => configs.push(ParsedConfig {
                path,
                precedence: precedence + 1,
                value,
            }),
            Err(message) => warnings.push(message),
        }
    }

    let mut effective = BTreeMap::<String, BuildSetting>::new();
    let mut summaries = Vec::new();
    let mut conditional_target_settings = Vec::new();
    let mut target_settings = Vec::new();
    let mut source_replacements = Vec::new();
    for config in &configs {
        let source = config.path.display().to_string();
        let mut keys = BTreeSet::new();
        if let Some(build) = config.value.get("build").and_then(Value::as_table) {
            for key in BUILD_KEYS {
                if let Some(value) = build.get(*key) {
                    let setting_key = format!("build.{key}");
                    keys.insert(setting_key.clone());
                    merge_config_setting(&mut effective, &setting_key, value, &source);
                }
            }
        }
        if let Some(net) = config.value.get("net").and_then(Value::as_table) {
            if let Some(value) = net.get("offline") {
                keys.insert("net.offline".to_owned());
                merge_config_setting(&mut effective, "net.offline", value, &source);
            }
        }
        if let Some(targets) = config.value.get("target").and_then(Value::as_table) {
            for (target, table) in targets {
                let Some(table) = table.as_table() else {
                    continue;
                };
                for key in TARGET_KEYS {
                    let Some(value) = table.get(*key) else {
                        continue;
                    };
                    let setting_key = format!("target.{target}.{key}");
                    keys.insert(setting_key.clone());
                    let record = setting(&setting_key, value, &source);
                    if target.trim_start().starts_with("cfg(") {
                        conditional_target_settings.push(record);
                    } else {
                        target_settings.push(record);
                    }
                }
            }
        }
        collect_source_settings(&config.value, &source, &mut source_replacements, &mut keys);
        if let Some(env_table) = config.value.get("env").and_then(Value::as_table) {
            for key in env_table.keys() {
                keys.insert(format!("env.{key}=[value hidden]"));
            }
        }
        summaries.push(CargoConfigSource {
            path: config.path.clone(),
            precedence: config.precedence,
            keys: keys.into_iter().collect(),
        });
    }

    let mut environment = whitelisted_environment();
    apply_environment_overrides(&environment, &mut effective);
    let requested_target = target_triple
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned)
        .or_else(|| environment_value(&environment, "CARGO_BUILD_TARGET"))
        .or_else(|| {
            effective
                .get("build.target")
                .map(|setting| unquote(&setting.value))
        });
    if let Some(target) = requested_target.as_deref() {
        environment.extend(target_environment(target));
        environment.sort_by(|left, right| left.key.cmp(&right.key));
        apply_exact_target_settings(target, &target_settings, &mut effective);
        apply_target_environment(target, &environment, &mut effective);
    } else if !target_settings.is_empty() || !conditional_target_settings.is_empty() {
        warnings.push(
            "target-specific Cargo settings are reported but not selected because no target triple was requested or configured"
                .to_owned(),
        );
    }
    if !conditional_target_settings.is_empty() {
        warnings.push(
            "cfg(...) target tables are reported as conditional candidates; this static action does not evaluate rustc cfg expressions"
                .to_owned(),
        );
    }
    warnings.push(
        "Cargo configuration above the workspace root and Cargo home configuration are not read, preventing this workspace-scoped action from expanding into unrelated user files"
            .to_owned(),
    );
    warnings.push(
        "values are resolved from fresh files and a fixed environment allowlist; registry tokens and arbitrary environment variables are never returned"
            .to_owned(),
    );

    let toolchain = find_toolchain(&context.workspace_root, query, &mut warnings);
    let effective_toolchain = environment_value(&environment, "RUSTUP_TOOLCHAIN")
        .map(|value| BuildSetting {
            key: "toolchain.channel".to_owned(),
            value,
            source: "RUSTUP_TOOLCHAIN".to_owned(),
        })
        .or_else(|| {
            toolchain.as_ref().and_then(|selection| {
                selection.channel.as_ref().map(|channel| BuildSetting {
                    key: "toolchain.channel".to_owned(),
                    value: channel.clone(),
                    source: selection.path.display().to_string(),
                })
            })
        });

    target_settings.sort_by(|left, right| {
        (&left.key, &left.source, &left.value).cmp(&(&right.key, &right.source, &right.value))
    });
    conditional_target_settings.sort_by(|left, right| {
        (&left.key, &left.source, &left.value).cmp(&(&right.key, &right.source, &right.value))
    });
    source_replacements.sort_by(|left, right| {
        (&left.key, &left.source, &left.value).cmp(&(&right.key, &right.source, &right.value))
    });

    Ok(BuildEnvironmentReport {
        schema_version: SCHEMA_VERSION,
        workspace_root: context.workspace_root.clone(),
        resolution_directory,
        requested_target,
        toolchain,
        effective_toolchain,
        config_sources: summaries,
        effective_settings: effective.into_values().collect(),
        target_settings,
        conditional_target_settings,
        source_replacements,
        environment,
        warnings,
    })
}

fn resolution_directory(query: &Path, workspace_root: &Path) -> PathBuf {
    let candidate = if query.is_dir() {
        query.to_path_buf()
    } else {
        query.parent().unwrap_or(workspace_root).to_path_buf()
    };
    if is_within(workspace_root, &candidate) {
        candidate
    } else {
        workspace_root.to_path_buf()
    }
}

fn cargo_config_paths(
    workspace_root: &Path,
    resolution_directory: &Path,
    warnings: &mut Vec<String>,
) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    let mut cursor = resolution_directory;
    loop {
        if !is_within(workspace_root, cursor) {
            break;
        }
        directories.push(cursor.to_path_buf());
        if path_key(cursor) == path_key(workspace_root) {
            break;
        }
        let Some(parent) = cursor.parent() else {
            break;
        };
        cursor = parent;
    }
    directories.reverse();
    let mut paths = Vec::new();
    for directory in directories {
        let cargo_directory = directory.join(".cargo");
        let extensionless = cargo_directory.join("config");
        let toml = cargo_directory.join("config.toml");
        if extensionless.is_file() && toml.is_file() {
            warnings.push(format!(
                "both {} and {} exist; Cargo prefers the extensionless config",
                extensionless.display(),
                toml.display()
            ));
            paths.push(canonicalize_friendly(&extensionless));
        } else if extensionless.is_file() {
            paths.push(canonicalize_friendly(&extensionless));
        } else if toml.is_file() {
            paths.push(canonicalize_friendly(&toml));
        }
    }
    paths
}

fn parse_toml_file(path: &Path) -> std::result::Result<Value, String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("could not inspect {}: {error}", path.display()))?;
    if metadata.len() > MAX_CONFIG_BYTES {
        return Err(format!(
            "skipped {} because it exceeds {MAX_CONFIG_BYTES} bytes",
            path.display()
        ));
    }
    let source = fs::read_to_string(path)
        .map_err(|error| format!("could not read {}: {error}", path.display()))?;
    toml::from_str::<Value>(&source)
        .map_err(|error| format!("could not parse {}: {error}", path.display()))
}

fn setting(key: &str, value: &Value, source: &str) -> BuildSetting {
    BuildSetting {
        key: key.to_owned(),
        value: redact_sensitive(&display_value(value)),
        source: source.to_owned(),
    }
}

fn merge_config_setting(
    effective: &mut BTreeMap<String, BuildSetting>,
    key: &str,
    value: &Value,
    source: &str,
) {
    let next = setting(key, value, source);
    if value.is_array() {
        if let Some(existing) = effective.get_mut(key) {
            existing.value = merge_array_text(&existing.value, &next.value);
            existing.source = format!("{} then {}", existing.source, next.source);
            return;
        }
    }
    effective.insert(key.to_owned(), next);
}

fn merge_array_text(left: &str, right: &str) -> String {
    let left = left.trim().trim_start_matches('[').trim_end_matches(']');
    let right = right.trim().trim_start_matches('[').trim_end_matches(']');
    match (left.is_empty(), right.is_empty()) {
        (true, true) => "[]".to_owned(),
        (true, false) => format!("[{right}]"),
        (false, true) => format!("[{left}]"),
        (false, false) => format!("[{left}, {right}]"),
    }
}

fn display_value(value: &Value) -> String {
    let value = match value {
        Value::String(value) => value.clone(),
        _ => value.to_string(),
    };
    value.chars().take(MAX_SETTING_CHARS).collect()
}

fn collect_source_settings(
    value: &Value,
    source: &str,
    output: &mut Vec<BuildSetting>,
    keys: &mut BTreeSet<String>,
) {
    let Some(sources) = value.get("source").and_then(Value::as_table) else {
        return;
    };
    for (name, table) in sources {
        let Some(table) = table.as_table() else {
            continue;
        };
        for key in [
            "replace-with",
            "registry",
            "local-registry",
            "directory",
            "git",
            "branch",
            "tag",
            "rev",
        ] {
            let Some(value) = table.get(key) else {
                continue;
            };
            let setting_key = format!("source.{name}.{key}");
            keys.insert(setting_key.clone());
            output.push(setting(&setting_key, value, source));
        }
    }
}

fn whitelisted_environment() -> Vec<BuildSetting> {
    let mut keys = vec![
        "CARGO_BUILD_JOBS",
        "CARGO_BUILD_RUSTC",
        "CARGO_BUILD_RUSTC_WRAPPER",
        "CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER",
        "CARGO_BUILD_TARGET",
        "CARGO_ENCODED_RUSTFLAGS",
        "CARGO_INCREMENTAL",
        "CARGO_NET_OFFLINE",
        "CARGO_TARGET_DIR",
        "RUSTC",
        "RUSTC_WORKSPACE_WRAPPER",
        "RUSTC_WRAPPER",
        "RUSTDOC",
        "RUSTDOCFLAGS",
        "RUSTFLAGS",
        "RUSTUP_TOOLCHAIN",
    ];
    keys.sort_unstable();
    keys.into_iter()
        .filter_map(|key| {
            env::var_os(key).map(|value| BuildSetting {
                key: key.to_owned(),
                value: redact_sensitive(
                    &value
                        .to_string_lossy()
                        .replace('\u{1f}', " ")
                        .chars()
                        .take(MAX_SETTING_CHARS)
                        .collect::<String>(),
                ),
                source: "process environment".to_owned(),
            })
        })
        .collect()
}

fn environment_value(environment: &[BuildSetting], key: &str) -> Option<String> {
    environment
        .iter()
        .find(|setting| setting.key == key)
        .map(|setting| setting.value.clone())
}

fn apply_environment_overrides(
    environment: &[BuildSetting],
    effective: &mut BTreeMap<String, BuildSetting>,
) {
    let mappings = [
        ("CARGO_BUILD_JOBS", "build.jobs"),
        ("CARGO_BUILD_RUSTC", "build.rustc"),
        ("CARGO_BUILD_RUSTC_WRAPPER", "build.rustc-wrapper"),
        (
            "CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER",
            "build.rustc-workspace-wrapper",
        ),
        ("CARGO_BUILD_TARGET", "build.target"),
        ("CARGO_INCREMENTAL", "build.incremental"),
        ("CARGO_NET_OFFLINE", "net.offline"),
        ("CARGO_TARGET_DIR", "build.target-dir"),
        ("RUSTC", "build.rustc"),
        ("RUSTC_WRAPPER", "build.rustc-wrapper"),
        ("RUSTC_WORKSPACE_WRAPPER", "build.rustc-workspace-wrapper"),
        ("RUSTDOC", "build.rustdoc"),
        ("RUSTDOCFLAGS", "build.rustdocflags"),
        ("RUSTFLAGS", "build.rustflags"),
        ("CARGO_ENCODED_RUSTFLAGS", "build.rustflags"),
    ];
    for (environment_key, setting_key) in mappings {
        if let Some(value) = environment
            .iter()
            .find(|value| value.key == environment_key)
        {
            effective.insert(
                setting_key.to_owned(),
                BuildSetting {
                    key: setting_key.to_owned(),
                    value: value.value.clone(),
                    source: environment_key.to_owned(),
                },
            );
        }
    }
}

fn apply_exact_target_settings(
    target: &str,
    target_settings: &[BuildSetting],
    effective: &mut BTreeMap<String, BuildSetting>,
) {
    let prefix = format!("target.{target}.");
    for value in target_settings
        .iter()
        .filter(|setting| setting.key.starts_with(&prefix))
    {
        let key = format!(
            "target.{}",
            value.key.strip_prefix(&prefix).unwrap_or(&value.key)
        );
        let next = BuildSetting {
            key: key.clone(),
            value: value.value.clone(),
            source: value.source.clone(),
        };
        if value.value.trim_start().starts_with('[') {
            if let Some(existing) = effective.get_mut(&key) {
                existing.value = merge_array_text(&existing.value, &next.value);
                existing.source = format!("{} then {}", existing.source, next.source);
                continue;
            }
        }
        effective.insert(key, next);
    }
}

fn apply_target_environment(
    target: &str,
    environment: &[BuildSetting],
    effective: &mut BTreeMap<String, BuildSetting>,
) {
    let prefix = format!(
        "CARGO_TARGET_{}",
        target
            .chars()
            .map(|value| if value.is_ascii_alphanumeric() {
                value.to_ascii_uppercase()
            } else {
                '_'
            })
            .collect::<String>()
    );
    for (suffix, key) in [
        ("LINKER", "target.linker"),
        ("RUNNER", "target.runner"),
        ("RUSTFLAGS", "target.rustflags"),
    ] {
        let environment_key = format!("{prefix}_{suffix}");
        if let Some(value) = environment
            .iter()
            .find(|setting| setting.key == environment_key)
        {
            effective.insert(
                key.to_owned(),
                BuildSetting {
                    key: key.to_owned(),
                    value: value.value.clone(),
                    source: environment_key,
                },
            );
        }
    }
}

fn target_environment(target: &str) -> Vec<BuildSetting> {
    let prefix = format!(
        "CARGO_TARGET_{}",
        target
            .chars()
            .map(|value| if value.is_ascii_alphanumeric() {
                value.to_ascii_uppercase()
            } else {
                '_'
            })
            .collect::<String>()
    );
    ["LINKER", "RUNNER", "RUSTFLAGS"]
        .into_iter()
        .filter_map(|suffix| {
            let key = format!("{prefix}_{suffix}");
            env::var_os(&key).map(|value| BuildSetting {
                key,
                value: redact_sensitive(&value.to_string_lossy()),
                source: "process environment".to_owned(),
            })
        })
        .collect()
}

fn find_toolchain(
    workspace_root: &Path,
    query: &Path,
    warnings: &mut Vec<String>,
) -> Option<ToolchainSelection> {
    let mut cursor = if query.is_dir() {
        canonicalize_friendly(query)
    } else {
        canonicalize_friendly(query.parent().unwrap_or(workspace_root))
    };
    loop {
        if !is_within(workspace_root, &cursor) {
            return None;
        }
        let toml_path = cursor.join("rust-toolchain.toml");
        let legacy_path = cursor.join("rust-toolchain");
        if toml_path.is_file() || legacy_path.is_file() {
            if toml_path.is_file() && legacy_path.is_file() {
                warnings.push(format!(
                    "both {} and {} exist; reporting rust-toolchain.toml",
                    toml_path.display(),
                    legacy_path.display()
                ));
            }
            let path = if toml_path.is_file() {
                toml_path
            } else {
                legacy_path
            };
            return parse_toolchain(&path, warnings);
        }
        if path_key(&cursor) == path_key(workspace_root) || !cursor.pop() {
            return None;
        }
    }
}

fn parse_toolchain(path: &Path, warnings: &mut Vec<String>) -> Option<ToolchainSelection> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => {
            warnings.push(format!("could not inspect {}: {error}", path.display()));
            return None;
        }
    };
    if metadata.len() > MAX_CONFIG_BYTES {
        warnings.push(format!(
            "skipped {} because it exceeds {MAX_CONFIG_BYTES} bytes",
            path.display()
        ));
        return None;
    }
    let source = match fs::read_to_string(path) {
        Ok(source) => source,
        Err(error) => {
            warnings.push(format!("could not read {}: {error}", path.display()));
            return None;
        }
    };
    if path.extension().and_then(|value| value.to_str()) == Some("toml") {
        let value = match toml::from_str::<Value>(&source) {
            Ok(value) => value,
            Err(error) => {
                warnings.push(format!("could not parse {}: {error}", path.display()));
                return None;
            }
        };
        let toolchain = value.get("toolchain").and_then(Value::as_table);
        let string = |key: &str| {
            toolchain
                .and_then(|table| table.get(key))
                .and_then(Value::as_str)
                .map(str::to_owned)
        };
        let list = |key: &str| {
            toolchain
                .and_then(|table| table.get(key))
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        };
        Some(ToolchainSelection {
            path: canonicalize_friendly(path),
            format: "toml".to_owned(),
            channel: string("channel").or_else(|| string("path")),
            profile: string("profile"),
            components: list("components"),
            targets: list("targets"),
        })
    } else {
        let channel = source
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty() && !line.starts_with('#'))
            .map(str::to_owned);
        Some(ToolchainSelection {
            path: canonicalize_friendly(path),
            format: "legacy".to_owned(),
            channel,
            profile: None,
            components: Vec::new(),
            targets: Vec::new(),
        })
    }
}

fn unquote(value: &str) -> String {
    value.trim().trim_matches('"').trim_matches('\'').to_owned()
}

fn redact_sensitive(value: &str) -> String {
    let mut output = value.chars().take(MAX_SETTING_CHARS).collect::<String>();
    let mut search_from = 0usize;
    while let Some(relative_scheme) = output[search_from..].find("://") {
        let scheme = search_from + relative_scheme;
        let authority_start = scheme + 3;
        let authority_end = output[authority_start..]
            .find(['/', '?', '#'])
            .map(|offset| authority_start + offset)
            .unwrap_or(output.len());
        let Some(relative_at) = output[authority_start..authority_end].rfind('@') else {
            search_from = authority_end.min(output.len());
            if search_from >= output.len() {
                break;
            }
            continue;
        };
        let at = authority_start + relative_at;
        output.replace_range(authority_start..at, "[redacted]");
        search_from = authority_start + "[redacted]@".len();
    }

    redact_url_queries(output)
}

fn redact_url_queries(mut output: String) -> String {
    let mut search_from = 0usize;
    while let Some(relative_scheme) = output[search_from..].find("://") {
        let authority_start = search_from + relative_scheme + 3;
        let url_end = output[authority_start..]
            .find(|character: char| {
                character.is_whitespace() || matches!(character, '"' | '\'' | ']' | ')' | ',' | ';')
            })
            .map(|offset| authority_start + offset)
            .unwrap_or(output.len());
        let Some(relative_query) = output[authority_start..url_end].find('?') else {
            search_from = url_end.min(output.len());
            if search_from >= output.len() {
                break;
            }
            continue;
        };
        let query_start = authority_start + relative_query + 1;
        let query_end = output[query_start..url_end]
            .find('#')
            .map(|offset| query_start + offset)
            .unwrap_or(url_end);
        output.replace_range(query_start..query_end, "[redacted]");
        search_from = query_start + "[redacted]".len();
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_url_userinfo_without_hiding_the_registry_host() {
        let value = redact_sensitive("sparse+https://user:password@example.invalid/index");
        assert_eq!(value, "sparse+https://[redacted]@example.invalid/index");
    }

    #[test]
    fn redacts_url_queries_without_hiding_fragments() {
        let value = redact_sensitive(
            "sparse+https://example.invalid/index?token=secret&scope=all#registry",
        );
        assert_eq!(
            value,
            "sparse+https://example.invalid/index?[redacted]#registry"
        );
    }
}
