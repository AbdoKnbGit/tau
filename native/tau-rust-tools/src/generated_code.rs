use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use cargo_toml::{Manifest, OptionalFile};
use serde::Serialize;
use syn::parse::Parser;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};
use walkdir::{DirEntry, WalkDir};

use crate::error::{Error, Result};
use crate::workspace::{
    canonicalize_friendly, inspect_workspace, is_within, path_key, PackageContext, WorkspaceContext,
};

const SCHEMA_VERSION: u32 = 1;
const DEFAULT_MAX_FILES: usize = 1_000;
const HARD_MAX_FILES: usize = 10_000;
const MAX_SOURCE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_TOTAL_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_CONSUMERS: usize = 5_000;
const MAX_GENERATED_FILES: usize = 5_000;
const MAX_EXPRESSION_CHARS: usize = 512;

const KNOWN_GENERATORS: &[&str] = &[
    "bindgen",
    "built",
    "capnpc",
    "cbindgen",
    "cc",
    "csbindgen",
    "embed-resource",
    "flutter-rust-bridge-codegen",
    "grpcio-compiler",
    "lalrpop",
    "napi-build",
    "pbjson-build",
    "phf-codegen",
    "prost-build",
    "protobuf-codegen",
    "serde-generate",
    "slint-build",
    "tauri-build",
    "tonic-build",
    "typify",
    "uniffi",
    "uniffi-bindgen",
    "vergen",
    "vergen-git2",
    "winres",
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedCodeReport {
    pub schema_version: u32,
    pub workspace_root: PathBuf,
    pub scan_root: PathBuf,
    pub scanned_files: usize,
    pub parsed_files: usize,
    pub scanned_bytes: u64,
    pub build_scripts: Vec<BuildScriptAnalysis>,
    pub consumers: Vec<GeneratedConsumer>,
    pub generated_files: Vec<GeneratedFileMarker>,
    pub counts: BTreeMap<String, usize>,
    pub truncated: bool,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildScriptAnalysis {
    pub package: String,
    pub package_root: PathBuf,
    pub path: PathBuf,
    pub build_dependencies: Vec<String>,
    pub generator_crates: Vec<String>,
    pub rerun_inputs: Vec<String>,
    pub output_hints: Vec<String>,
    pub uses_out_dir: bool,
    pub invokes_processes: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedConsumer {
    pub package: Option<String>,
    pub file: PathBuf,
    pub line: usize,
    pub macro_name: String,
    pub expression: String,
    pub resolved_path: Option<PathBuf>,
    pub output_hint: Option<String>,
    pub uses_out_dir: bool,
    pub build_script: Option<PathBuf>,
    pub generator_crates: Vec<String>,
    pub source_inputs: Vec<String>,
    pub confidence: String,
    pub recommendation: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedFileMarker {
    pub package: Option<String>,
    pub file: PathBuf,
    pub line: usize,
    pub marker: String,
    pub build_script: Option<PathBuf>,
    pub generator_crates: Vec<String>,
    pub confidence: String,
    pub recommendation: String,
}

#[derive(Clone, Debug)]
struct BuildScriptSeed {
    package: String,
    package_root: PathBuf,
    path: PathBuf,
    dependencies: Vec<BuildDependency>,
}

#[derive(Clone, Debug)]
struct BuildDependency {
    alias: String,
    package: String,
}

#[derive(Clone, Debug)]
struct RawConsumer {
    file: PathBuf,
    line: usize,
    macro_name: String,
    expression: String,
    resolved_path: Option<PathBuf>,
    output_hint: Option<String>,
    uses_out_dir: bool,
}

#[derive(Clone, Debug)]
struct RawMarker {
    file: PathBuf,
    line: usize,
    marker: String,
    confidence: String,
}

pub fn map_generated_code(query: &Path, max_files: Option<usize>) -> Result<GeneratedCodeReport> {
    let context = inspect_workspace(query)?;
    let scan_root = select_scan_root(&context);
    let limit = max_files
        .unwrap_or(DEFAULT_MAX_FILES)
        .clamp(1, HARD_MAX_FILES);
    let mut warnings = context.warnings.clone();
    let seeds = collect_build_script_seeds(&context, &scan_root, &mut warnings);
    let paths = collect_rust_files(
        &scan_root,
        &context.workspace_root,
        &seeds,
        limit,
        &mut warnings,
    )?;

    let mut consumers = Vec::new();
    let mut markers = Vec::new();
    let mut sources = BTreeMap::<String, String>::new();
    let mut parsed_files = 0usize;
    let mut scanned_bytes = 0u64;
    let mut truncated = paths.truncated;

    for path in &paths.paths {
        let metadata = match fs::metadata(path) {
            Ok(metadata) => metadata,
            Err(error) => {
                warnings.push(format!("could not inspect {}: {error}", path.display()));
                continue;
            }
        };
        if metadata.len() > MAX_SOURCE_BYTES {
            warnings.push(format!(
                "skipped {} because it exceeds {MAX_SOURCE_BYTES} bytes",
                path.display()
            ));
            continue;
        }
        if scanned_bytes.saturating_add(metadata.len()) > MAX_TOTAL_SOURCE_BYTES {
            truncated = true;
            warnings.push(format!(
                "generated-code scan stopped at the {MAX_TOTAL_SOURCE_BYTES}-byte source budget"
            ));
            break;
        }
        let source = match fs::read_to_string(path) {
            Ok(source) => source,
            Err(error) => {
                warnings.push(format!("could not read {}: {error}", path.display()));
                continue;
            }
        };
        scanned_bytes = scanned_bytes.saturating_add(metadata.len());
        if let Some(marker) = generated_marker(path, &source) {
            if markers.len() < MAX_GENERATED_FILES {
                markers.push(marker);
            } else {
                truncated = true;
            }
        }

        match syn::parse_file(&source) {
            Ok(syntax) => {
                parsed_files += 1;
                let package_root = owner_package(&context.packages, path)
                    .map(|package| package.package_root.as_path());
                let mut visitor = IncludeVisitor {
                    file: path,
                    workspace_root: &context.workspace_root,
                    package_root,
                    consumers: &mut consumers,
                };
                visitor.visit_file(&syntax);
                if consumers.len() >= MAX_CONSUMERS {
                    truncated = true;
                }
            }
            Err(error) => warnings.push(format!("could not parse {}: {error}", path.display())),
        }
        sources.insert(path_key(path), source);
    }

    let build_scripts = seeds
        .iter()
        .map(|seed| analyze_build_script(seed, sources.get(&path_key(&seed.path))))
        .collect::<Vec<_>>();
    let consumers = enrich_consumers(consumers, &context, &build_scripts, &markers);
    let generated_files = enrich_markers(markers, &context, &build_scripts);
    if paths.truncated {
        warnings.push(format!(
            "generated-code scan stopped after {limit} Rust files"
        ));
    }
    warnings.push(
        "analysis is syntax-only and never executes build.rs, procedural macros, generators, or Cargo build/check commands"
            .to_owned(),
    );

    let mut counts = BTreeMap::new();
    counts.insert("buildScripts".to_owned(), build_scripts.len());
    counts.insert("consumers".to_owned(), consumers.len());
    counts.insert("generatedFiles".to_owned(), generated_files.len());
    counts.insert(
        "outDirConsumers".to_owned(),
        consumers
            .iter()
            .filter(|consumer| consumer.uses_out_dir)
            .count(),
    );

    Ok(GeneratedCodeReport {
        schema_version: SCHEMA_VERSION,
        workspace_root: context.workspace_root,
        scan_root,
        scanned_files: sources.len(),
        parsed_files,
        scanned_bytes,
        build_scripts,
        consumers,
        generated_files,
        counts,
        truncated,
        warnings,
    })
}

fn select_scan_root(context: &WorkspaceContext) -> PathBuf {
    if context
        .query_path
        .extension()
        .and_then(|value| value.to_str())
        == Some("rs")
    {
        return context.query_path.clone();
    }
    if path_key(&context.query_path) == path_key(&context.workspace_root) {
        return context.workspace_root.clone();
    }
    context
        .selected_package
        .as_ref()
        .map(|package| package.package_root.clone())
        .unwrap_or_else(|| context.workspace_root.clone())
}

fn collect_build_script_seeds(
    context: &WorkspaceContext,
    scan_root: &Path,
    warnings: &mut Vec<String>,
) -> Vec<BuildScriptSeed> {
    let mut seeds = Vec::new();
    for package in &context.packages {
        if !is_within(scan_root, &package.package_root)
            && !is_within(&package.package_root, scan_root)
        {
            continue;
        }
        let manifest = match Manifest::from_path(&package.manifest_path) {
            Ok(manifest) => manifest,
            Err(error) => {
                warnings.push(format!(
                    "could not inspect build configuration in {}: {error}",
                    package.manifest_path.display()
                ));
                continue;
            }
        };
        let Some(path) = build_script_path(package, &manifest) else {
            continue;
        };
        if !is_within(&context.workspace_root, &path) {
            warnings.push(format!(
                "build script {} escapes the workspace root and was not read",
                path.display()
            ));
            continue;
        }
        if !path.is_file() {
            warnings.push(format!(
                "configured build script {} does not exist",
                path.display()
            ));
            continue;
        }
        let mut dependencies = Vec::new();
        append_build_dependencies(&mut dependencies, &manifest.build_dependencies);
        for target in manifest.target.values() {
            append_build_dependencies(&mut dependencies, &target.build_dependencies);
        }
        dependencies.sort_by(|left, right| {
            left.package
                .cmp(&right.package)
                .then(left.alias.cmp(&right.alias))
        });
        dependencies
            .dedup_by(|left, right| left.alias == right.alias && left.package == right.package);
        seeds.push(BuildScriptSeed {
            package: package.name.clone(),
            package_root: package.package_root.clone(),
            path,
            dependencies,
        });
    }
    seeds.sort_by(|left, right| {
        left.package
            .cmp(&right.package)
            .then(left.path.cmp(&right.path))
    });
    seeds
}

fn build_script_path(package: &PackageContext, manifest: &Manifest) -> Option<PathBuf> {
    let configured = manifest
        .package
        .as_ref()
        .and_then(|value| value.build.as_ref());
    let relative = match configured {
        Some(OptionalFile::Flag(false)) => return None,
        Some(OptionalFile::Path(path)) => path.clone(),
        Some(OptionalFile::Flag(true)) | None => PathBuf::from("build.rs"),
    };
    let path = canonicalize_friendly(&package.package_root.join(relative));
    path.is_file().then_some(path)
}

fn append_build_dependencies(
    output: &mut Vec<BuildDependency>,
    dependencies: &cargo_toml::DepsSet,
) {
    for (alias, dependency) in dependencies {
        output.push(BuildDependency {
            alias: normalize_crate_name(alias),
            package: dependency.package().unwrap_or(alias).to_owned(),
        });
    }
}

struct RustPaths {
    paths: Vec<PathBuf>,
    truncated: bool,
}

fn collect_rust_files(
    scan_root: &Path,
    workspace_root: &Path,
    seeds: &[BuildScriptSeed],
    limit: usize,
    warnings: &mut Vec<String>,
) -> Result<RustPaths> {
    if scan_root.is_file() && scan_root.extension().and_then(|value| value.to_str()) != Some("rs") {
        return Err(Error::Usage(format!(
            "generated-code-map file input must end in .rs, got {}",
            scan_root.display()
        )));
    }
    if scan_root.is_file() {
        let mut paths = vec![scan_root.to_path_buf()];
        let mut seen = BTreeSet::from([path_key(scan_root)]);
        let mut truncated = false;
        for seed in seeds {
            if !seen.insert(path_key(&seed.path)) {
                continue;
            }
            if paths.len() >= limit {
                truncated = true;
                break;
            }
            paths.push(seed.path.clone());
        }
        return Ok(RustPaths { paths, truncated });
    }
    let mut candidates = BTreeMap::<String, PathBuf>::new();
    for item in WalkDir::new(scan_root)
        .follow_links(false)
        .max_depth(32)
        .into_iter()
        .filter_entry(allow_source_entry)
    {
        let entry = match item {
            Ok(entry) => entry,
            Err(error) => {
                warnings.push(format!(
                    "could not traverse part of {}: {error}",
                    scan_root.display()
                ));
                continue;
            }
        };
        if !entry.file_type().is_file()
            || entry.path().extension().and_then(|value| value.to_str()) != Some("rs")
            || !is_within(workspace_root, entry.path())
        {
            continue;
        }
        candidates.insert(path_key(entry.path()), entry.path().to_path_buf());
    }
    let truncated = candidates.len() > limit;
    let mut paths = Vec::new();
    let mut seen = BTreeSet::new();
    for seed in seeds {
        if seen.insert(path_key(&seed.path)) && paths.len() < limit {
            paths.push(seed.path.clone());
        }
    }
    for (key, path) in candidates {
        if seen.insert(key) && paths.len() < limit {
            paths.push(path);
        }
    }
    let truncated = truncated || seen.len() > paths.len();
    Ok(RustPaths { paths, truncated })
}

fn allow_source_entry(entry: &DirEntry) -> bool {
    if entry.depth() == 0 || !entry.file_type().is_dir() {
        return true;
    }
    !matches!(
        entry.file_name().to_str(),
        Some("target" | ".git" | "vendor" | "node_modules")
    )
}

fn analyze_build_script(seed: &BuildScriptSeed, source: Option<&String>) -> BuildScriptAnalysis {
    let source = source.map(String::as_str).unwrap_or_default();
    let build_dependencies = seed
        .dependencies
        .iter()
        .map(|dependency| dependency.package.clone())
        .collect::<BTreeSet<_>>();
    let generator_crates = seed
        .dependencies
        .iter()
        .filter(|dependency| is_known_generator(&dependency.package))
        .filter(|dependency| {
            source.is_empty()
                || source.contains(&dependency.alias)
                || source.contains(&normalize_crate_name(&dependency.package))
        })
        .map(|dependency| dependency.package.clone())
        .collect::<BTreeSet<_>>();
    BuildScriptAnalysis {
        package: seed.package.clone(),
        package_root: seed.package_root.clone(),
        path: seed.path.clone(),
        build_dependencies: build_dependencies.into_iter().collect(),
        generator_crates: generator_crates.into_iter().collect(),
        rerun_inputs: extract_directive_values(source, "rerun-if-changed="),
        output_hints: extract_output_hints(source),
        uses_out_dir: source.contains("OUT_DIR"),
        invokes_processes: source.contains("Command::new")
            || source.contains("process::Command")
            || source.contains("std::process"),
    }
}

fn normalize_crate_name(value: &str) -> String {
    value.replace('-', "_")
}

fn is_known_generator(value: &str) -> bool {
    let normalized = value.replace('_', "-");
    KNOWN_GENERATORS.contains(&normalized.as_str())
}

fn extract_directive_values(source: &str, directive: &str) -> Vec<String> {
    let mut values = BTreeSet::new();
    for line in source.lines() {
        let mut rest = line;
        while let Some(index) = rest.find(directive) {
            let tail = &rest[index + directive.len()..];
            let value = tail
                .split(['"', '\'', ')', ';'])
                .next()
                .unwrap_or_default()
                .trim();
            if !value.is_empty() && value.len() <= MAX_EXPRESSION_CHARS {
                values.insert(value.to_owned());
            }
            if tail.is_empty() {
                break;
            }
            let advance = value.len().max(1).min(tail.len());
            rest = &tail[advance..];
        }
    }
    values.into_iter().collect()
}

fn extract_output_hints(source: &str) -> Vec<String> {
    let mut hints = BTreeSet::new();
    for segment in source.split('"').skip(1).step_by(2) {
        let value = segment.trim();
        if value.len() > MAX_EXPRESSION_CHARS {
            continue;
        }
        let lower = value.to_ascii_lowercase();
        if lower.ends_with(".rs")
            || lower.ends_with(".h")
            || lower.ends_with(".hpp")
            || lower.ends_with(".c")
            || lower.ends_with(".cpp")
        {
            hints.insert(value.to_owned());
        }
    }
    hints.into_iter().take(128).collect()
}

fn generated_marker(path: &Path, source: &str) -> Option<RawMarker> {
    for (index, line) in source.lines().take(40).enumerate() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with("//")
            && !trimmed.starts_with("/*")
            && !trimmed.starts_with('*')
            && !trimmed.starts_with('#')
        {
            continue;
        }
        let lower = trimmed.to_ascii_lowercase();
        let (marker, confidence) = if lower.contains("@generated") {
            ("@generated", "high")
        } else if lower.contains("do not edit") {
            ("do not edit", "high")
        } else if lower.contains("code generated") {
            ("code generated", "high")
        } else if lower.contains("automatically generated") {
            ("automatically generated", "medium")
        } else if lower.contains("generated file") {
            ("generated file", "medium")
        } else {
            continue;
        };
        return Some(RawMarker {
            file: path.to_path_buf(),
            line: index + 1,
            marker: marker.to_owned(),
            confidence: confidence.to_owned(),
        });
    }
    None
}

struct IncludeVisitor<'a> {
    file: &'a Path,
    workspace_root: &'a Path,
    package_root: Option<&'a Path>,
    consumers: &'a mut Vec<RawConsumer>,
}

impl<'ast> Visit<'ast> for IncludeVisitor<'_> {
    fn visit_macro(&mut self, node: &'ast syn::Macro) {
        if self.consumers.len() >= MAX_CONSUMERS {
            return;
        }
        let name = node
            .path
            .segments
            .last()
            .map(|segment| segment.ident.to_string())
            .unwrap_or_default();
        if matches!(name.as_str(), "include" | "include_str" | "include_bytes") {
            let expression = truncate_expression(node.tokens.to_string());
            let analyzed = analyze_path_expression(
                node.tokens.clone(),
                self.file,
                self.workspace_root,
                self.package_root,
            );
            self.consumers.push(RawConsumer {
                file: self.file.to_path_buf(),
                line: node.span().start().line,
                macro_name: format!("{name}!"),
                expression,
                resolved_path: analyzed.resolved_path,
                output_hint: analyzed.output_hint,
                uses_out_dir: analyzed.uses_out_dir,
            });
        }
        visit::visit_macro(self, node);
    }
}

struct PathExpression {
    resolved_path: Option<PathBuf>,
    output_hint: Option<String>,
    uses_out_dir: bool,
}

#[derive(Clone, Debug)]
enum PathPart {
    Literal(String),
    Environment(String),
    Dynamic,
}

fn analyze_path_expression(
    tokens: proc_macro2::TokenStream,
    source_file: &Path,
    workspace_root: &Path,
    package_root: Option<&Path>,
) -> PathExpression {
    let expression = match syn::parse2::<syn::Expr>(tokens) {
        Ok(expression) => expression,
        Err(_) => {
            return PathExpression {
                resolved_path: None,
                output_hint: None,
                uses_out_dir: false,
            }
        }
    };
    let mut parts = Vec::new();
    collect_path_parts(&expression, &mut parts);
    let uses_out_dir = parts
        .iter()
        .any(|part| matches!(part, PathPart::Environment(name) if name == "OUT_DIR"));
    let literals = parts
        .iter()
        .filter_map(|part| match part {
            PathPart::Literal(value) => Some(value.as_str()),
            _ => None,
        })
        .collect::<String>();
    let output_hint = (!literals.is_empty()).then(|| {
        literals
            .trim_start_matches(['/', '\\'])
            .chars()
            .take(MAX_EXPRESSION_CHARS)
            .collect::<String>()
    });
    let resolved_path = resolve_expression_path(&parts, source_file, workspace_root, package_root);
    PathExpression {
        resolved_path,
        output_hint,
        uses_out_dir,
    }
}

fn collect_path_parts(expression: &syn::Expr, output: &mut Vec<PathPart>) {
    match expression {
        syn::Expr::Lit(value) => match &value.lit {
            syn::Lit::Str(value) => output.push(PathPart::Literal(value.value())),
            _ => output.push(PathPart::Dynamic),
        },
        syn::Expr::Macro(value) => {
            let name = value
                .mac
                .path
                .segments
                .last()
                .map(|segment| segment.ident.to_string())
                .unwrap_or_default();
            match name.as_str() {
                "env" | "option_env" => {
                    match syn::parse2::<syn::LitStr>(value.mac.tokens.clone()) {
                        Ok(variable) => output.push(PathPart::Environment(variable.value())),
                        Err(_) => output.push(PathPart::Dynamic),
                    }
                }
                "concat" => {
                    let parser =
                        syn::punctuated::Punctuated::<syn::Expr, syn::Token![,]>::parse_terminated;
                    match parser.parse2(value.mac.tokens.clone()) {
                        Ok(values) => {
                            for value in values {
                                collect_path_parts(&value, output);
                            }
                        }
                        Err(_) => output.push(PathPart::Dynamic),
                    }
                }
                _ => output.push(PathPart::Dynamic),
            }
        }
        syn::Expr::Paren(value) => collect_path_parts(&value.expr, output),
        syn::Expr::Group(value) => collect_path_parts(&value.expr, output),
        _ => output.push(PathPart::Dynamic),
    }
}

fn resolve_expression_path(
    parts: &[PathPart],
    source_file: &Path,
    workspace_root: &Path,
    package_root: Option<&Path>,
) -> Option<PathBuf> {
    if parts.is_empty() || parts.iter().any(|part| matches!(part, PathPart::Dynamic)) {
        return None;
    }
    let mut path = PathBuf::new();
    let mut rooted = false;
    for part in parts {
        match part {
            PathPart::Literal(value) => {
                let literal = Path::new(value);
                if path.as_os_str().is_empty() && literal.is_absolute() {
                    path = literal.to_path_buf();
                    rooted = true;
                } else {
                    path.push(value.trim_start_matches(['/', '\\']));
                }
            }
            PathPart::Environment(name) if name == "CARGO_MANIFEST_DIR" => {
                path = package_root?.to_path_buf();
                rooted = true;
            }
            PathPart::Environment(_) => return None,
            PathPart::Dynamic => return None,
        }
    }
    if !rooted {
        path = source_file.parent()?.join(path);
    }
    let path = canonicalize_friendly(&path);
    is_within(workspace_root, &path).then_some(path)
}

fn truncate_expression(value: String) -> String {
    if value.chars().count() <= MAX_EXPRESSION_CHARS {
        value
    } else {
        value
            .chars()
            .take(MAX_EXPRESSION_CHARS.saturating_sub(1))
            .chain(std::iter::once('…'))
            .collect()
    }
}

fn enrich_consumers(
    mut consumers: Vec<RawConsumer>,
    context: &WorkspaceContext,
    scripts: &[BuildScriptAnalysis],
    markers: &[RawMarker],
) -> Vec<GeneratedConsumer> {
    consumers.sort_by(|left, right| {
        left.file
            .cmp(&right.file)
            .then(left.line.cmp(&right.line))
            .then(left.macro_name.cmp(&right.macro_name))
    });
    consumers
        .into_iter()
        .map(|consumer| {
            let package = owner_package(&context.packages, &consumer.file);
            let target_is_marked = consumer.resolved_path.as_ref().is_some_and(|target| {
                markers
                    .iter()
                    .any(|marker| path_key(&marker.file) == path_key(target))
            });
            let package_script = package.and_then(|package| script_for_package(scripts, package));
            let script = if consumer.uses_out_dir {
                package_script
            } else if target_is_marked {
                consumer.resolved_path.as_ref().and_then(|target| {
                    package_script.filter(|script| script_mentions_file(script, target))
                })
            } else {
                None
            };
            let (confidence, recommendation) = if consumer.uses_out_dir {
                match script {
                    Some(script) if !script.generator_crates.is_empty() => (
                        "high",
                        "Edit the generator inputs or build script, then regenerate; do not edit the OUT_DIR copy.",
                    ),
                    Some(_) => (
                        "medium",
                        "Trace the owning build script before editing; the included OUT_DIR file is build output.",
                    ),
                    None => (
                        "low",
                        "The include depends on OUT_DIR, but no owning build script was found; inspect package build configuration.",
                    ),
                }
            } else if target_is_marked {
                (
                    "high",
                    "The included file declares itself generated; locate and edit its generator input instead.",
                )
            } else if consumer.resolved_path.is_some() {
                (
                    "medium",
                    "This is a statically resolved include; inspect the included file before choosing the edit location.",
                )
            } else {
                (
                    "low",
                    "The include path is dynamic; verify its source of truth before editing.",
                )
            };
            GeneratedConsumer {
                package: package.map(|package| package.name.clone()),
                file: consumer.file,
                line: consumer.line,
                macro_name: consumer.macro_name,
                expression: consumer.expression,
                resolved_path: consumer.resolved_path,
                output_hint: consumer.output_hint,
                uses_out_dir: consumer.uses_out_dir,
                build_script: script.map(|script| script.path.clone()),
                generator_crates: script
                    .map(|script| script.generator_crates.clone())
                    .unwrap_or_default(),
                source_inputs: script
                    .map(|script| script.rerun_inputs.clone())
                    .unwrap_or_default(),
                confidence: confidence.to_owned(),
                recommendation: recommendation.to_owned(),
            }
        })
        .collect()
}

fn enrich_markers(
    mut markers: Vec<RawMarker>,
    context: &WorkspaceContext,
    scripts: &[BuildScriptAnalysis],
) -> Vec<GeneratedFileMarker> {
    markers.sort_by(|left, right| left.file.cmp(&right.file).then(left.line.cmp(&right.line)));
    markers
        .into_iter()
        .map(|marker| {
            let package = owner_package(&context.packages, &marker.file);
            let script = package
                .and_then(|package| script_for_package(scripts, package))
                .filter(|script| script_mentions_file(script, &marker.file));
            GeneratedFileMarker {
                package: package.map(|package| package.name.clone()),
                file: marker.file,
                line: marker.line,
                marker: marker.marker,
                build_script: script.map(|script| script.path.clone()),
                generator_crates: script
                    .map(|script| script.generator_crates.clone())
                    .unwrap_or_default(),
                confidence: marker.confidence,
                recommendation: if script.is_some() {
                    "Treat this file as generated and inspect the owning build script inputs before editing."
                        .to_owned()
                } else {
                    "Treat this file as generated and locate its external generator or checked-in source template before editing."
                        .to_owned()
                },
            }
        })
        .collect()
}

fn owner_package<'a>(packages: &'a [PackageContext], path: &Path) -> Option<&'a PackageContext> {
    packages
        .iter()
        .filter(|package| is_within(&package.package_root, path))
        .max_by_key(|package| package.package_root.components().count())
}

fn script_for_package<'a>(
    scripts: &'a [BuildScriptAnalysis],
    package: &PackageContext,
) -> Option<&'a BuildScriptAnalysis> {
    scripts.iter().find(|script| {
        script.package == package.name
            && path_key(&script.package_root) == path_key(&package.package_root)
    })
}

fn script_mentions_file(script: &BuildScriptAnalysis, file: &Path) -> bool {
    let file_name = file
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let relative = file
        .strip_prefix(&script.package_root)
        .unwrap_or(file)
        .to_string_lossy()
        .replace('\\', "/");
    script.output_hints.iter().any(|hint| {
        let normalized = hint.replace('\\', "/");
        normalized == relative
            || (!file_name.is_empty()
                && Path::new(&normalized)
                    .file_name()
                    .and_then(|value| value.to_str())
                    == Some(file_name))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_expression_resolves_manifest_dir_but_not_out_dir() {
        let workspace = if cfg!(windows) {
            Path::new("C:\\workspace")
        } else {
            Path::new("/workspace")
        };
        let source = workspace.join("src/lib.rs");
        let manifest = syn::parse_str::<syn::Macro>(
            "include!(concat!(env!(\"CARGO_MANIFEST_DIR\"), \"/generated/types.rs\"))",
        )
        .expect("parse include macro");
        let resolved =
            analyze_path_expression(manifest.tokens, &source, workspace, Some(workspace));
        assert_eq!(
            resolved.resolved_path,
            Some(canonicalize_friendly(&workspace.join("generated/types.rs")))
        );
        assert!(!resolved.uses_out_dir);

        let out_dir =
            syn::parse_str::<syn::Macro>("include!(concat!(env!(\"OUT_DIR\"), \"/types.rs\"))")
                .expect("parse OUT_DIR include");
        let unresolved =
            analyze_path_expression(out_dir.tokens, &source, workspace, Some(workspace));
        assert!(unresolved.resolved_path.is_none());
        assert!(unresolved.uses_out_dir);
        assert_eq!(unresolved.output_hint.as_deref(), Some("types.rs"));
    }
}
