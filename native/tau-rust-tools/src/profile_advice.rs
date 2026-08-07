use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use toml::Value;

use crate::error::{Error, Result};
use crate::workspace::inspect_workspace;

const SCHEMA_VERSION: u32 = 1;
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProfileGoal {
    Balanced,
    DevSpeed,
    ReleaseSize,
    RuntimePerformance,
    CompileTime,
}

impl ProfileGoal {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "balanced" => Ok(Self::Balanced),
            "dev_speed" => Ok(Self::DevSpeed),
            "release_size" => Ok(Self::ReleaseSize),
            "runtime_performance" => Ok(Self::RuntimePerformance),
            "compile_time" => Ok(Self::CompileTime),
            other => Err(Error::Usage(format!(
                "unsupported profile goal {other:?}; expected balanced, dev_speed, release_size, runtime_performance, or compile_time"
            ))),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileAdviceReport {
    pub schema_version: u32,
    pub workspace_manifest: PathBuf,
    pub goal: ProfileGoal,
    pub profile: String,
    pub explicit_settings: BTreeMap<String, String>,
    pub recommendations: Vec<ProfileRecommendation>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRecommendation {
    pub setting: String,
    pub current: String,
    pub suggested: String,
    pub reason: String,
    pub tradeoff: String,
}

pub fn advise_profile(
    query: &Path,
    goal: ProfileGoal,
    profile: Option<&str>,
) -> Result<ProfileAdviceReport> {
    let context = inspect_workspace(query)?;
    let selected_profile = profile
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| default_profile(goal).to_owned());
    validate_profile_name(&selected_profile)?;
    let metadata = fs::metadata(&context.workspace_manifest).map_err(|source| Error::Io {
        operation: "inspect workspace manifest",
        path: context.workspace_manifest.clone(),
        source,
    })?;
    if metadata.len() > MAX_MANIFEST_BYTES {
        return Err(Error::Usage(format!(
            "workspace manifest exceeds the {MAX_MANIFEST_BYTES}-byte profile-analysis limit"
        )));
    }
    let contents = fs::read_to_string(&context.workspace_manifest).map_err(|source| Error::Io {
        operation: "read workspace manifest",
        path: context.workspace_manifest.clone(),
        source,
    })?;
    let manifest: Value = toml::from_str(&contents).map_err(|error| {
        Error::InvalidData(format!(
            "could not parse {}: {error}",
            context.workspace_manifest.display()
        ))
    })?;
    let profile_table = manifest
        .get("profile")
        .and_then(Value::as_table)
        .and_then(|profiles| profiles.get(&selected_profile))
        .and_then(Value::as_table);
    let explicit_settings: BTreeMap<String, String> = profile_table
        .map(|table| {
            table
                .iter()
                .filter(|(_, value)| !value.is_table())
                .map(|(key, value)| (key.clone(), display_value(value)))
                .collect()
        })
        .unwrap_or_default();
    let candidates = recommendations(goal, &selected_profile);
    let inherited_profile = profile_table
        .and_then(|table| table.get("inherits"))
        .and_then(Value::as_str)
        .unwrap_or(&selected_profile);
    let recommendations = candidates
        .into_iter()
        .filter_map(|candidate| {
            let current = explicit_settings
                .get(candidate.setting)
                .cloned()
                .unwrap_or_else(|| cargo_default(inherited_profile, candidate.setting).to_owned());
            (current != candidate.suggested).then_some(ProfileRecommendation {
                setting: candidate.setting.to_owned(),
                current,
                suggested: candidate.suggested.to_owned(),
                reason: candidate.reason.to_owned(),
                tradeoff: candidate.tradeoff.to_owned(),
            })
        })
        .collect();
    let mut warnings = context.warnings;
    if selected_profile != "dev" && selected_profile != "release" {
        let inherits = profile_table
            .and_then(|table| table.get("inherits"))
            .and_then(Value::as_str);
        if inherits.is_none() {
            warnings.push(format!(
                "custom profile {selected_profile:?} has no explicit inherits value"
            ));
        }
    }
    warnings.push(
        "recommendations are manifest-only heuristics; benchmark and measure artifacts before adopting them"
            .to_owned(),
    );

    Ok(ProfileAdviceReport {
        schema_version: SCHEMA_VERSION,
        workspace_manifest: context.workspace_manifest,
        goal,
        profile: selected_profile,
        explicit_settings,
        recommendations,
        warnings,
    })
}

struct Candidate {
    setting: &'static str,
    suggested: &'static str,
    reason: &'static str,
    tradeoff: &'static str,
}

fn recommendations(goal: ProfileGoal, profile: &str) -> Vec<Candidate> {
    let release_like = profile != "dev";
    match goal {
        ProfileGoal::Balanced if release_like => vec![Candidate {
            setting: "lto",
            suggested: "thin",
            reason: "Thin LTO often removes cross-crate overhead without the full cost of fat LTO.",
            tradeoff: "Release builds become slower and use more linker memory.",
        }],
        ProfileGoal::Balanced => Vec::new(),
        ProfileGoal::DevSpeed => vec![
            Candidate {
                setting: "opt-level",
                suggested: "0",
                reason: "Disabling optimization minimizes LLVM work during edit-check cycles.",
                tradeoff: "Development binaries run more slowly.",
            },
            Candidate {
                setting: "incremental",
                suggested: "true",
                reason: "Incremental compilation reuses work between local builds.",
                tradeoff: "The target directory grows and clean builds do not benefit.",
            },
            Candidate {
                setting: "debug",
                suggested: "line-tables-only",
                reason: "Line tables retain useful backtraces with less debug-info generation.",
                tradeoff: "Debugger inspection of variables and types is reduced.",
            },
        ],
        ProfileGoal::CompileTime => vec![
            Candidate {
                setting: "lto",
                suggested: "false",
                reason: "Disabling LTO avoids expensive cross-crate optimization and linking.",
                tradeoff: "Runtime speed and final artifact size can regress.",
            },
            Candidate {
                setting: "codegen-units",
                suggested: "256",
                reason: "More codegen units expose more parallel LLVM work.",
                tradeoff: "Runtime optimization and artifact size can regress.",
            },
        ],
        ProfileGoal::ReleaseSize => vec![
            Candidate {
                setting: "opt-level",
                suggested: "z",
                reason: "Optimize specifically for binary size.",
                tradeoff: "Runtime performance may be lower than opt-level 3 or s.",
            },
            Candidate {
                setting: "lto",
                suggested: "true",
                reason: "Whole-program optimization can remove unused cross-crate code.",
                tradeoff: "Release builds use substantially more time and memory.",
            },
            Candidate {
                setting: "codegen-units",
                suggested: "1",
                reason: "One codegen unit gives LLVM its broadest optimization view.",
                tradeoff: "Compilation parallelism is reduced.",
            },
            Candidate {
                setting: "strip",
                suggested: "symbols",
                reason: "Removing symbols reduces shipped binary size.",
                tradeoff: "Production crash symbolication requires separately retained symbols.",
            },
            Candidate {
                setting: "panic",
                suggested: "abort",
                reason: "Abort removes unwinding machinery from many binaries.",
                tradeoff:
                    "Panics cannot unwind or be caught; validate library and FFI requirements.",
            },
        ],
        ProfileGoal::RuntimePerformance => vec![
            Candidate {
                setting: "opt-level",
                suggested: "3",
                reason: "Enable aggressive runtime optimization.",
                tradeoff: "Compilation time and generated code size can increase.",
            },
            Candidate {
                setting: "lto",
                suggested: "fat",
                reason: "Fat LTO gives LLVM the widest cross-crate optimization view.",
                tradeoff: "Release builds become much slower and more memory intensive.",
            },
            Candidate {
                setting: "codegen-units",
                suggested: "1",
                reason: "One unit maximizes optimization opportunities.",
                tradeoff: "Compilation parallelism is reduced.",
            },
        ],
    }
}

fn default_profile(goal: ProfileGoal) -> &'static str {
    match goal {
        ProfileGoal::DevSpeed | ProfileGoal::CompileTime => "dev",
        _ => "release",
    }
}

fn cargo_default(profile: &str, setting: &str) -> &'static str {
    let release_like = profile != "dev";
    match (release_like, setting) {
        (false, "opt-level") => "0",
        (true, "opt-level") => "3",
        (false, "debug") => "2",
        (true, "debug") => "false",
        (false, "incremental") => "true",
        (true, "incremental") => "false",
        (false, "codegen-units") => "256",
        (true, "codegen-units") => "16",
        (_, "lto") => "false",
        (_, "strip") => "none",
        (_, "panic") => "unwind",
        _ => "Cargo default",
    }
}

fn validate_profile_name(profile: &str) -> Result<()> {
    if profile.is_empty() || profile.contains(['/', '\\']) || profile == "." || profile == ".." {
        return Err(Error::Usage(
            "profile must be a single Cargo profile name".to_owned(),
        ));
    }
    Ok(())
}

fn display_value(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Integer(value) => value.to_string(),
        Value::Float(value) => value.to_string(),
        Value::Boolean(value) => value.to_string(),
        Value::Datetime(value) => value.to_string(),
        Value::Array(_) | Value::Table(_) => value.to_string(),
    }
}
