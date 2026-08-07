use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use walkdir::{DirEntry, WalkDir};

use crate::error::{Error, Result};
use crate::workspace::inspect_workspace;

const SCHEMA_VERSION: u32 = 1;
const DEFAULT_LIMIT: usize = 20;
const MAX_LIMIT: usize = 100;
const MAX_FILES: usize = 200_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactSizeReport {
    pub schema_version: u32,
    pub target_directory: PathBuf,
    pub profile: String,
    pub total_bytes: u64,
    pub artifact_files: usize,
    pub scanned_files: usize,
    pub incremental_bytes: u64,
    pub categories: Vec<ArtifactCategory>,
    pub top_artifacts: Vec<ArtifactEntry>,
    pub duplicate_variants: Vec<ArtifactVariant>,
    pub truncated: bool,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactCategory {
    pub category: String,
    pub files: usize,
    pub bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactEntry {
    pub path: PathBuf,
    pub category: String,
    pub bytes: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactVariant {
    pub crate_name: String,
    pub files: usize,
    pub bytes: u64,
}

pub fn inspect_artifact_sizes(
    query: &Path,
    profile: Option<&str>,
    target_triple: Option<&str>,
    limit: Option<usize>,
) -> Result<ArtifactSizeReport> {
    let context = inspect_workspace(query)?;
    if let Some(target_triple) = target_triple {
        validate_directory_name(target_triple, "target triple")?;
    }
    let target_root = target_triple
        .map(|triple| context.workspace_root.join("target").join(triple))
        .unwrap_or_else(|| context.workspace_root.join("target"));
    let selected_profile = profile
        .map(ToOwned::to_owned)
        .unwrap_or_else(|| default_profile(&target_root));
    validate_directory_name(&selected_profile, "artifact profile")?;
    let target_directory = target_root.join(&selected_profile);
    let output_limit = limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let mut warnings = context.warnings;
    if !target_directory.is_dir() {
        warnings.push(format!(
            "{} does not exist; artifact-size inspects existing outputs and will not run Cargo",
            target_directory.display()
        ));
        return Ok(ArtifactSizeReport {
            schema_version: SCHEMA_VERSION,
            target_directory,
            profile: selected_profile,
            total_bytes: 0,
            artifact_files: 0,
            scanned_files: 0,
            incremental_bytes: 0,
            categories: Vec::new(),
            top_artifacts: Vec::new(),
            duplicate_variants: Vec::new(),
            truncated: false,
            warnings,
        });
    }

    let mut entries = Vec::new();
    let mut category_totals = BTreeMap::<String, (usize, u64)>::new();
    let mut variants = BTreeMap::<String, (BTreeMap<String, usize>, u64)>::new();
    let mut scanned_files = 0usize;
    let mut incremental_bytes = 0u64;
    let mut truncated = false;

    let walker = WalkDir::new(&target_directory)
        .follow_links(false)
        .max_depth(8)
        .into_iter()
        .filter_entry(allow_entry);
    for item in walker {
        let entry = match item {
            Ok(entry) => entry,
            Err(error) => {
                warnings.push(format!("artifact traversal warning: {error}"));
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        scanned_files += 1;
        if scanned_files > MAX_FILES {
            truncated = true;
            warnings.push(format!(
                "artifact traversal stopped after {MAX_FILES} files"
            ));
            break;
        }
        let bytes = match entry.metadata() {
            Ok(metadata) => metadata.len(),
            Err(error) => {
                warnings.push(format!(
                    "could not inspect {}: {error}",
                    entry.path().display()
                ));
                continue;
            }
        };
        if entry
            .path()
            .components()
            .any(|component| component.as_os_str() == "incremental")
        {
            incremental_bytes = incremental_bytes.saturating_add(bytes);
            continue;
        }
        let Some(category) = artifact_category(entry.path()) else {
            continue;
        };
        let total = category_totals.entry(category.to_owned()).or_default();
        total.0 += 1;
        total.1 = total.1.saturating_add(bytes);
        if let Some((crate_name, variant_name)) = crate_variant(entry.path()) {
            let variant = variants.entry(crate_name).or_default();
            *variant.0.entry(variant_name).or_default() += 1;
            variant.1 = variant.1.saturating_add(bytes);
        }
        entries.push(ArtifactEntry {
            path: entry.path().to_path_buf(),
            category: category.to_owned(),
            bytes,
        });
    }
    entries.sort_by(|left, right| {
        right
            .bytes
            .cmp(&left.bytes)
            .then(left.path.cmp(&right.path))
    });
    let total_bytes = entries
        .iter()
        .fold(0u64, |total, entry| total.saturating_add(entry.bytes));
    let artifact_files = entries.len();
    entries.truncate(output_limit);
    let categories = category_totals
        .into_iter()
        .map(|(category, (files, bytes))| ArtifactCategory {
            category,
            files,
            bytes,
        })
        .collect();
    let mut duplicate_variants = variants
        .into_iter()
        .filter(|(_, (variants, _))| variants.len() > 1)
        .map(|(crate_name, (variants, bytes))| ArtifactVariant {
            crate_name,
            files: variants.values().sum(),
            bytes,
        })
        .collect::<Vec<_>>();
    duplicate_variants.sort_by(|left, right| {
        right
            .bytes
            .cmp(&left.bytes)
            .then(left.crate_name.cmp(&right.crate_name))
    });
    duplicate_variants.truncate(output_limit);

    Ok(ArtifactSizeReport {
        schema_version: SCHEMA_VERSION,
        target_directory,
        profile: selected_profile,
        total_bytes,
        artifact_files,
        scanned_files,
        incremental_bytes,
        categories,
        top_artifacts: entries,
        duplicate_variants,
        truncated,
        warnings,
    })
}

fn default_profile(target_root: &Path) -> String {
    if target_root.join("release").is_dir() {
        "release"
    } else {
        "debug"
    }
    .to_owned()
}

fn validate_directory_name(value: &str, label: &str) -> Result<()> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path.components().count() != 1
        || matches!(value, "." | "..")
    {
        return Err(Error::Usage(format!(
            "{label} must be a single directory name"
        )));
    }
    Ok(())
}

fn allow_entry(entry: &DirEntry) -> bool {
    if entry.depth() == 0 || !entry.file_type().is_dir() {
        return true;
    }
    !matches!(entry.file_name().to_str(), Some(".fingerprint" | "build"))
}

fn artifact_category(path: &Path) -> Option<&'static str> {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
    {
        "exe" => Some("executable"),
        "dll" | "so" | "dylib" => Some("dynamic_library"),
        "rlib" => Some("rust_library"),
        "a" | "lib" => Some("static_library"),
        "wasm" => Some("wasm"),
        "pdb" => Some("debug_symbols"),
        "rmeta" => Some("rust_metadata"),
        "o" | "obj" => Some("object"),
        "" if path.is_file() => Some("extensionless_executable"),
        _ => None,
    }
}

fn crate_variant(path: &Path) -> Option<(String, String)> {
    let mut stem = path.file_stem()?.to_string_lossy().into_owned();
    if let Some(stripped) = stem.strip_prefix("lib") {
        stem = stripped.to_owned();
    }
    if let Some((prefix, suffix)) = stem.rsplit_once('-') {
        if suffix.len() >= 8
            && suffix
                .chars()
                .all(|character| character.is_ascii_hexdigit())
        {
            return Some((prefix.to_owned(), suffix.to_owned()));
        }
    }
    (!stem.is_empty()).then(|| (stem.clone(), stem))
}
