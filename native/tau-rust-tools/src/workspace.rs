use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::env;
use std::path::{Component, Path, PathBuf};

use cargo_toml::{Dependency, Manifest, Product};
use glob::{glob, Pattern};
use serde::Serialize;

use crate::error::{Error, Result};

const SCHEMA_VERSION: u32 = 1;
const MAX_WORKSPACE_PACKAGES: usize = 4_096;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContext {
    pub schema_version: u32,
    pub query_path: PathBuf,
    pub workspace_root: PathBuf,
    pub workspace_manifest: PathBuf,
    pub resolver: Option<String>,
    pub selected_package: Option<PackageContext>,
    pub selected_target: Option<TargetContext>,
    pub packages: Vec<PackageContext>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageContext {
    pub name: String,
    pub version: String,
    pub edition: String,
    pub rust_version: Option<String>,
    pub manifest_path: PathBuf,
    pub package_root: PathBuf,
    pub is_default_member: bool,
    pub features: BTreeMap<String, Vec<String>>,
    pub targets: Vec<TargetContext>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetContext {
    pub name: String,
    pub kind: String,
    pub crate_types: Vec<String>,
    pub source_path: PathBuf,
    pub edition: String,
    pub required_features: Vec<String>,
    pub test: bool,
    pub doctest: bool,
    pub doc: bool,
}

pub fn inspect_workspace(query: &Path) -> Result<WorkspaceContext> {
    let query_path = absolute_lexical(query)?;
    let nearest_manifest = find_nearest_manifest(&query_path)?;
    let mut warnings = Vec::new();
    let workspace_manifest = locate_workspace_manifest(&nearest_manifest, &mut warnings)?;
    let workspace_root = workspace_manifest
        .parent()
        .ok_or_else(|| Error::Workspace("workspace manifest has no parent directory".to_owned()))?
        .to_path_buf();

    let root_manifest = parse_manifest(&workspace_manifest)?;
    let resolver = root_manifest
        .workspace
        .as_ref()
        .and_then(|workspace| workspace.resolver)
        .map(|resolver| resolver.to_string());
    let manifest_paths = collect_member_manifests(
        &workspace_manifest,
        &root_manifest,
        &nearest_manifest,
        &mut warnings,
    );
    let default_members = default_member_paths(&workspace_root, &root_manifest, &manifest_paths);

    let mut packages = Vec::new();
    for manifest_path in manifest_paths {
        match package_context(
            &manifest_path,
            default_members.contains(&path_key(&manifest_path)),
        ) {
            Ok(Some(package)) => packages.push(package),
            Ok(None) => {}
            Err(error) if manifest_path != nearest_manifest => warnings.push(error.to_string()),
            Err(error) => return Err(error),
        }
    }
    packages.sort_by(|left, right| {
        left.name
            .cmp(&right.name)
            .then(left.manifest_path.cmp(&right.manifest_path))
    });

    let selected_package = select_package(&packages, &query_path).cloned();
    let selected_target = selected_package
        .as_ref()
        .and_then(|package| select_target(package, &query_path).cloned());
    if selected_package.is_none() {
        warnings.push(format!(
            "{} is inside the Cargo workspace but is not owned by a discovered package",
            query_path.display()
        ));
    }

    Ok(WorkspaceContext {
        schema_version: SCHEMA_VERSION,
        query_path,
        workspace_root,
        workspace_manifest,
        resolver,
        selected_package,
        selected_target,
        packages,
        warnings,
    })
}

fn absolute_lexical(path: &Path) -> Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir()
            .map_err(|source| Error::Io {
                operation: "read current directory",
                path: PathBuf::from("."),
                source,
            })?
            .join(path)
    };
    let normalized = normalize_lexical(&absolute);
    Ok(canonicalize_friendly(&normalized))
}

fn normalize_lexical(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if !result.pop() {
                    result.push(component.as_os_str());
                }
            }
            _ => result.push(component.as_os_str()),
        }
    }
    result
}

fn find_nearest_manifest(query: &Path) -> Result<PathBuf> {
    let mut cursor =
        if query.is_file() || query.file_name().is_some_and(|name| name == "Cargo.toml") {
            query.parent().unwrap_or(query).to_path_buf()
        } else {
            query.to_path_buf()
        };

    loop {
        let candidate = cursor.join("Cargo.toml");
        if candidate.is_file() {
            return Ok(canonicalize_friendly(&candidate));
        }
        if !cursor.pop() {
            return Err(Error::ManifestNotFound(query.to_path_buf()));
        }
    }
}

fn locate_workspace_manifest(nearest: &Path, warnings: &mut Vec<String>) -> Result<PathBuf> {
    let nearest_manifest = parse_manifest(nearest)?;
    if nearest_manifest.workspace.is_some() {
        return Ok(nearest.to_path_buf());
    }

    if let Some(workspace_hint) = nearest_manifest
        .package
        .as_ref()
        .and_then(|package| package.workspace.as_deref())
    {
        let candidate = explicit_workspace_manifest(nearest, workspace_hint);
        match parse_manifest(&candidate) {
            Ok(manifest) if manifest.workspace.is_some() => return Ok(candidate),
            Ok(_) => warnings.push(format!(
                "package.workspace resolves to {}, but that manifest has no [workspace] table; treating the package as standalone",
                candidate.display()
            )),
            Err(error) => warnings.push(format!(
                "package.workspace could not be resolved through {} ({error}); treating the package as standalone",
                candidate.display()
            )),
        }
        return Ok(nearest.to_path_buf());
    }

    let Some(package_root) = nearest.parent() else {
        return Ok(nearest.to_path_buf());
    };
    for ancestor in package_root.ancestors().skip(1) {
        let candidate = ancestor.join("Cargo.toml");
        if !candidate.is_file() {
            continue;
        }
        let manifest = match parse_manifest(&candidate) {
            Ok(manifest) => manifest,
            Err(error) => {
                warnings.push(format!(
                    "ancestor manifest {} could not be inspected ({error}); continuing filesystem-only workspace discovery",
                    candidate.display()
                ));
                continue;
            }
        };
        if manifest.workspace.is_none() {
            continue;
        }
        let candidate = canonicalize_friendly(&candidate);
        if workspace_contains_manifest(&candidate, &manifest, nearest) {
            return Ok(candidate);
        }
        warnings.push(format!(
            "{} is below workspace {}, but is not a declared or in-tree path dependency member; treating it as a standalone package",
            nearest.display(),
            candidate.display()
        ));
        return Ok(nearest.to_path_buf());
    }

    Ok(nearest.to_path_buf())
}

fn explicit_workspace_manifest(package_manifest: &Path, workspace_hint: &Path) -> PathBuf {
    let package_root = package_manifest.parent().unwrap_or(Path::new("."));
    let resolved = if workspace_hint.is_absolute() {
        workspace_hint.to_path_buf()
    } else {
        package_root.join(workspace_hint)
    };
    let normalized = normalize_lexical(&resolved);
    let candidate = if normalized
        .file_name()
        .is_some_and(|name| name == "Cargo.toml")
    {
        normalized
    } else {
        normalized.join("Cargo.toml")
    };
    canonicalize_friendly(&candidate)
}

fn workspace_contains_manifest(
    workspace_manifest: &Path,
    manifest: &Manifest,
    target_manifest: &Path,
) -> bool {
    let mut ignored_warnings = Vec::new();
    collect_member_manifests(
        workspace_manifest,
        manifest,
        workspace_manifest,
        &mut ignored_warnings,
    )
    .iter()
    .any(|candidate| path_key(candidate) == path_key(target_manifest))
}

fn parse_manifest(path: &Path) -> Result<Manifest> {
    Manifest::from_path(path).map_err(|error| Error::Manifest {
        path: path.to_path_buf(),
        detail: error.to_string(),
    })
}

fn collect_member_manifests(
    workspace_manifest: &Path,
    root_manifest: &Manifest,
    nearest_manifest: &Path,
    warnings: &mut Vec<String>,
) -> Vec<PathBuf> {
    let workspace_root = workspace_manifest.parent().unwrap_or(Path::new("."));
    let workspace = root_manifest.workspace.as_ref();
    let excludes = workspace
        .map(|value| value.exclude.as_slice())
        .unwrap_or(&[]);
    let mut found = BTreeMap::<String, PathBuf>::new();
    let mut scheduled = BTreeSet::<String>::new();
    let mut queue = VecDeque::new();

    if root_manifest.package.is_some() {
        enqueue_manifest(&mut queue, &mut scheduled, workspace_manifest.to_path_buf());
    }
    if let Some(workspace) = workspace {
        for member in &workspace.members {
            if scheduled.len() >= MAX_WORKSPACE_PACKAGES {
                warnings.push(format!(
                    "workspace inspection stopped at {MAX_WORKSPACE_PACKAGES} package manifests"
                ));
                break;
            }
            if !is_safe_member_pattern(workspace_root, member) {
                warnings.push(format!(
                    "workspace member pattern {member:?} escapes the workspace root and was skipped"
                ));
                continue;
            }
            let pattern = workspace_root.join(member);
            let pattern_text = pattern.to_string_lossy().into_owned();
            match glob(&pattern_text) {
                Ok(paths) => {
                    let mut matched = false;
                    for item in paths {
                        match item {
                            Ok(path) => {
                                let manifest = if path.is_dir() {
                                    path.join("Cargo.toml")
                                } else {
                                    path
                                };
                                if manifest.is_file()
                                    && !is_excluded(workspace_root, &manifest, excludes)
                                {
                                    matched = true;
                                    enqueue_manifest(
                                        &mut queue,
                                        &mut scheduled,
                                        canonicalize_friendly(&manifest),
                                    );
                                    if scheduled.len() >= MAX_WORKSPACE_PACKAGES {
                                        warnings.push(format!(
                                            "workspace inspection stopped at {MAX_WORKSPACE_PACKAGES} package manifests"
                                        ));
                                        break;
                                    }
                                }
                            }
                            Err(error) => warnings.push(format!(
                                "workspace member glob error for {member:?}: {error}"
                            )),
                        }
                    }
                    if !matched {
                        warnings.push(format!(
                            "workspace member pattern {member:?} matched no Cargo.toml"
                        ));
                    }
                }
                Err(error) => warnings.push(format!(
                    "invalid workspace member pattern {member:?}: {error}"
                )),
            }
        }
    }

    // Cargo also treats in-tree path dependencies as workspace members. Walk
    // those edges without resolving registries or touching Cargo.lock.
    while let Some(manifest_path) = queue.pop_front() {
        if found.len() >= MAX_WORKSPACE_PACKAGES {
            break;
        }
        let key = path_key(&manifest_path);
        if found.contains_key(&key) || is_excluded(workspace_root, &manifest_path, excludes) {
            continue;
        }
        found.insert(key, manifest_path.clone());
        let Ok(manifest) = parse_manifest(&manifest_path) else {
            continue;
        };
        let package_root = manifest_path.parent().unwrap_or(workspace_root);
        for dependency_path in local_dependency_paths(&manifest, package_root) {
            let candidate = if dependency_path.is_dir() {
                dependency_path.join("Cargo.toml")
            } else {
                dependency_path
            };
            if candidate.is_file()
                && is_within(workspace_root, &candidate)
                && !is_excluded(workspace_root, &candidate, excludes)
            {
                enqueue_manifest(
                    &mut queue,
                    &mut scheduled,
                    canonicalize_friendly(&candidate),
                );
            }
        }
    }

    // The queried manifest is authoritative even when Cargo fell back because
    // a surrounding workspace is temporarily incomplete.
    found
        .entry(path_key(nearest_manifest))
        .or_insert_with(|| nearest_manifest.to_path_buf());
    found.into_values().collect()
}

fn enqueue_manifest(
    queue: &mut VecDeque<PathBuf>,
    scheduled: &mut BTreeSet<String>,
    manifest: PathBuf,
) {
    if scheduled.len() >= MAX_WORKSPACE_PACKAGES {
        return;
    }
    if scheduled.insert(path_key(&manifest)) {
        queue.push_back(manifest);
    }
}

fn is_safe_member_pattern(workspace_root: &Path, member: &str) -> bool {
    let path = Path::new(member);
    if path.is_absolute() {
        return false;
    }
    let mut fixed_prefix = workspace_root.to_path_buf();
    for component in path.components() {
        let text = component.as_os_str().to_string_lossy();
        if text
            .chars()
            .any(|character| matches!(character, '*' | '?' | '[' | ']'))
        {
            break;
        }
        fixed_prefix.push(component.as_os_str());
    }
    is_within(workspace_root, &normalize_lexical(&fixed_prefix))
}

fn local_dependency_paths(manifest: &Manifest, package_root: &Path) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let sets = [
        &manifest.dependencies,
        &manifest.dev_dependencies,
        &manifest.build_dependencies,
    ];
    for set in sets {
        append_dependency_paths(set.values(), package_root, &mut paths);
    }
    for target in manifest.target.values() {
        append_dependency_paths(target.dependencies.values(), package_root, &mut paths);
        append_dependency_paths(target.dev_dependencies.values(), package_root, &mut paths);
        append_dependency_paths(target.build_dependencies.values(), package_root, &mut paths);
    }
    paths
}

fn append_dependency_paths<'a>(
    dependencies: impl Iterator<Item = &'a Dependency>,
    package_root: &Path,
    output: &mut Vec<PathBuf>,
) {
    for dependency in dependencies {
        let Some(detail) = dependency.detail() else {
            continue;
        };
        let Some(path) = detail.path.as_deref() else {
            continue;
        };
        let path = PathBuf::from(path);
        output.push(if path.is_absolute() {
            path
        } else {
            package_root.join(path)
        });
    }
}

fn is_excluded(root: &Path, manifest: &Path, patterns: &[String]) -> bool {
    let package_dir = manifest.parent().unwrap_or(manifest);
    let relative = package_dir
        .strip_prefix(root)
        .unwrap_or(package_dir)
        .to_string_lossy()
        .replace('\\', "/");
    patterns.iter().any(|value| {
        Pattern::new(&value.replace('\\', "/")).is_ok_and(|pattern| pattern.matches(&relative))
    })
}

fn default_member_paths(
    workspace_root: &Path,
    manifest: &Manifest,
    all_manifests: &[PathBuf],
) -> BTreeSet<String> {
    let Some(workspace) = manifest.workspace.as_ref() else {
        return all_manifests.iter().map(|path| path_key(path)).collect();
    };
    if workspace.default_members.is_empty() {
        if manifest.package.is_some() {
            return [path_key(&workspace_root.join("Cargo.toml"))]
                .into_iter()
                .collect();
        }
        return all_manifests.iter().map(|path| path_key(path)).collect();
    }

    all_manifests
        .iter()
        .filter(|manifest_path| {
            let relative = manifest_path
                .parent()
                .unwrap_or(manifest_path)
                .strip_prefix(workspace_root)
                .unwrap_or(manifest_path)
                .to_string_lossy()
                .replace('\\', "/");
            workspace.default_members.iter().any(|value| {
                Pattern::new(&value.replace('\\', "/"))
                    .is_ok_and(|pattern| pattern.matches(&relative))
            })
        })
        .map(|path| path_key(path))
        .collect()
}

fn package_context(
    manifest_path: &Path,
    is_default_member: bool,
) -> Result<Option<PackageContext>> {
    let manifest = parse_manifest(manifest_path)?;
    let Some(package) = manifest.package.as_ref() else {
        return Ok(None);
    };
    let package_root = manifest_path
        .parent()
        .ok_or_else(|| Error::Manifest {
            path: manifest_path.to_path_buf(),
            detail: "manifest has no parent directory".to_owned(),
        })?
        .to_path_buf();
    let edition = package.edition().to_string();
    let rust_version = package
        .rust_version
        .as_ref()
        .and_then(|value| value.get().ok())
        .cloned();
    let version = package.version().to_string();
    let mut targets = Vec::new();
    if let Some(product) = manifest.lib.as_ref() {
        targets.push(target_context(
            product,
            "lib",
            &package.name,
            &package_root,
            &edition,
        ));
    }
    for product in &manifest.bin {
        targets.push(target_context(
            product,
            "bin",
            &package.name,
            &package_root,
            &edition,
        ));
    }
    for product in &manifest.test {
        targets.push(target_context(
            product,
            "test",
            &package.name,
            &package_root,
            &edition,
        ));
    }
    for product in &manifest.example {
        targets.push(target_context(
            product,
            "example",
            &package.name,
            &package_root,
            &edition,
        ));
    }
    for product in &manifest.bench {
        targets.push(target_context(
            product,
            "bench",
            &package.name,
            &package_root,
            &edition,
        ));
    }
    targets.sort_by(|left, right| left.kind.cmp(&right.kind).then(left.name.cmp(&right.name)));

    Ok(Some(PackageContext {
        name: package.name.clone(),
        version,
        edition,
        rust_version,
        manifest_path: manifest_path.to_path_buf(),
        package_root,
        is_default_member,
        features: manifest.features,
        targets,
    }))
}

fn target_context(
    product: &Product,
    kind: &str,
    package_name: &str,
    package_root: &Path,
    package_edition: &str,
) -> TargetContext {
    let name = product
        .name
        .clone()
        .unwrap_or_else(|| package_name.replace('-', "_"));
    let default_path = match kind {
        "lib" => PathBuf::from("src/lib.rs"),
        "bin" => PathBuf::from("src/main.rs"),
        "test" => PathBuf::from(format!("tests/{name}.rs")),
        "example" => PathBuf::from(format!("examples/{name}.rs")),
        "bench" => PathBuf::from(format!("benches/{name}.rs")),
        _ => PathBuf::new(),
    };
    let source_path = package_root.join(
        product
            .path
            .as_deref()
            .map(Path::new)
            .unwrap_or(&default_path),
    );
    let mut crate_types = product.crate_type.clone();
    if crate_types.is_empty() {
        crate_types.push(if product.proc_macro {
            "proc-macro".to_owned()
        } else {
            kind.to_owned()
        });
    }
    TargetContext {
        name,
        kind: kind.to_owned(),
        crate_types,
        source_path: canonicalize_friendly(&source_path),
        edition: product
            .edition
            .map(|value| value.to_string())
            .unwrap_or_else(|| package_edition.to_owned()),
        required_features: product.required_features.clone(),
        test: product.test,
        doctest: product.doctest,
        doc: product.doc,
    }
}

fn select_package<'a>(packages: &'a [PackageContext], query: &Path) -> Option<&'a PackageContext> {
    packages
        .iter()
        .filter(|package| is_within(&package.package_root, query))
        .max_by_key(|package| package.package_root.components().count())
}

fn select_target<'a>(package: &'a PackageContext, query: &Path) -> Option<&'a TargetContext> {
    package
        .targets
        .iter()
        .max_by_key(|target| target_score(target, query))
        .filter(|target| target_score(target, query) > 0)
}

fn target_score(target: &TargetContext, query: &Path) -> usize {
    if path_key(&target.source_path) == path_key(query) {
        return 100_000;
    }
    // A file target such as src/bin/worker.rs resolves `mod task;` below
    // src/bin/worker/task.rs. That module belongs to the worker binary, not to
    // a library whose broader src/ directory also contains it.
    let module_directory = target.source_path.with_extension("");
    if is_within(&module_directory, query) {
        return 80_000 + module_directory.components().count();
    }
    let source_parent = target.source_path.parent().unwrap_or(&target.source_path);
    if !is_within(source_parent, query) {
        return 0;
    }
    let depth = source_parent.components().count();
    match target.kind.as_str() {
        "lib" => 50_000 + depth,
        "bin" if target.source_path.ends_with(Path::new("src/main.rs")) => 40_000 + depth,
        "bin" => 60_000 + depth,
        "test" | "example" | "bench" => 60_000 + depth,
        _ => depth,
    }
}

pub(crate) fn target_selector(target: &TargetContext) -> Vec<String> {
    match target.kind.as_str() {
        "lib" => vec!["--lib".to_owned()],
        "bin" => vec!["--bin".to_owned(), target.name.clone()],
        "test" => vec!["--test".to_owned(), target.name.clone()],
        "example" => vec!["--example".to_owned(), target.name.clone()],
        "bench" => vec!["--bench".to_owned(), target.name.clone()],
        _ => Vec::new(),
    }
}

pub(crate) fn is_within(parent: &Path, child: &Path) -> bool {
    let parent = path_key(parent);
    let child = path_key(child);
    child == parent
        || child
            .strip_prefix(&parent)
            .is_some_and(|remainder| remainder.starts_with('/') || remainder.starts_with('\\'))
}

pub(crate) fn path_key(path: &Path) -> String {
    let normalized = canonicalize_friendly(path);
    let value = normalized.to_string_lossy().replace('\\', "/");
    if cfg!(windows) {
        value.to_lowercase()
    } else {
        value
    }
}

pub(crate) fn canonicalize_friendly(path: &Path) -> PathBuf {
    if let Ok(canonical) = dunce::canonicalize(path) {
        return canonical;
    }

    // Preserve symlink and path-case normalization for a not-yet-created
    // module by canonicalizing its longest existing ancestor, then appending
    // the missing suffix without touching the filesystem.
    let mut cursor = path;
    let mut missing = Vec::new();
    while !cursor.exists() {
        let Some(name) = cursor.file_name() else {
            return normalize_lexical(path);
        };
        missing.push(name.to_owned());
        let Some(parent) = cursor.parent() else {
            return normalize_lexical(path);
        };
        cursor = parent;
    }
    let mut canonical = dunce::canonicalize(cursor).unwrap_or_else(|_| normalize_lexical(cursor));
    for component in missing.into_iter().rev() {
        canonical.push(component);
    }
    canonical
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lexical_normalization_does_not_escape_absolute_root() {
        let root = if cfg!(windows) {
            Path::new("C:\\")
        } else {
            Path::new("/")
        };
        let normalized = normalize_lexical(&root.join("one/../two"));
        assert!(normalized.ends_with("two"));
        assert!(!normalized.to_string_lossy().contains("one"));
    }

    #[test]
    fn path_containment_rejects_sibling_prefixes() {
        let root = if cfg!(windows) {
            Path::new("C:\\work\\crate")
        } else {
            Path::new("/work/crate")
        };
        let sibling = if cfg!(windows) {
            Path::new("C:\\work\\crate-other")
        } else {
            Path::new("/work/crate-other")
        };
        assert!(!is_within(root, sibling));
    }
}
