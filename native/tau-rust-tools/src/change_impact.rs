use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::path::{Path, PathBuf};

use cargo_toml::{Dependency, DepsSet, Manifest};
use serde::Serialize;

use crate::error::{Error, Result};
use crate::workspace::{
    canonicalize_friendly, inspect_workspace, is_within, path_key, PackageContext, WorkspaceContext,
};

const SCHEMA_VERSION: u32 = 1;
const MAX_CHANGED_PATHS: usize = 512;
const MAX_PACKAGES_PER_COMMAND: usize = 64;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeImpactReport {
    pub schema_version: u32,
    pub workspace_root: PathBuf,
    pub scope: String,
    pub input_paths: Vec<PathBuf>,
    pub changes: Vec<ClassifiedChange>,
    pub direct_packages: Vec<String>,
    pub affected_packages: Vec<AffectedPackage>,
    pub dependency_edges: usize,
    pub commands: Vec<ValidationCommand>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassifiedChange {
    pub path: PathBuf,
    pub classification: String,
    pub package: Option<String>,
    pub propagates_to_dependents: bool,
    pub reason: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AffectedPackage {
    pub name: String,
    pub manifest_path: PathBuf,
    pub direct: bool,
    pub dependency_distance: usize,
    pub reasons: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationCommand {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub priority: String,
    pub packages: Vec<String>,
    pub rationale: String,
}

#[derive(Clone, Debug)]
struct DependencyEdge {
    dependent: usize,
    dependency: usize,
    kind: String,
    target: Option<String>,
}

#[derive(Clone, Debug, Default)]
struct DirectImpact {
    reasons: BTreeSet<String>,
    propagate: bool,
    check: bool,
    test: bool,
    doc: bool,
}

pub fn analyze_change_impact(
    query: &Path,
    changed_paths: &[PathBuf],
) -> Result<ChangeImpactReport> {
    if changed_paths.len() > MAX_CHANGED_PATHS {
        return Err(Error::Usage(format!(
            "change-impact accepts at most {MAX_CHANGED_PATHS} changed paths"
        )));
    }
    let context = inspect_workspace(query)?;
    let mut warnings = context.warnings.clone();
    let edges = dependency_edges(&context, &mut warnings);
    let mut changes = Vec::new();
    let mut direct = BTreeMap::<usize, DirectImpact>::new();
    let mut whole_workspace = changed_paths.is_empty();
    let mut input_paths = Vec::new();

    if changed_paths.is_empty() {
        changes.push(ClassifiedChange {
            path: context.workspace_root.clone(),
            classification: "whole_workspace_default".to_owned(),
            package: None,
            propagates_to_dependents: true,
            reason: "no changedPaths were supplied, so the conservative whole-workspace scope was selected"
                .to_owned(),
        });
    } else {
        let mut seen = BTreeSet::new();
        for changed in changed_paths {
            let path = resolve_changed_path(&context.workspace_root, changed);
            if !seen.insert(path_key(&path)) {
                continue;
            }
            input_paths.push(path.clone());
            classify_change(
                &path,
                &context,
                &mut changes,
                &mut direct,
                &mut whole_workspace,
            );
        }
    }

    if whole_workspace {
        direct.clear();
        for index in 0..context.packages.len() {
            direct.insert(
                index,
                DirectImpact {
                    reasons: BTreeSet::from([
                        "workspace-wide configuration or unknown ownership requires conservative validation"
                            .to_owned(),
                    ]),
                    propagate: true,
                    check: true,
                    test: true,
                    doc: false,
                },
            );
        }
    }

    let (affected, impact_by_package) = affected_packages(&context, &direct, &edges);
    let direct_packages = direct
        .keys()
        .filter_map(|index| context.packages.get(*index))
        .map(|package| package.name.clone())
        .collect::<Vec<_>>();
    let commands = validation_commands(
        &context,
        whole_workspace,
        &direct,
        &impact_by_package,
        &mut warnings,
    );
    if edges.iter().any(|edge| edge.target.is_some()) {
        warnings.push(
            "target-conditional local dependency edges were included conservatively; this action does not evaluate cfg expressions"
                .to_owned(),
        );
    }
    warnings.push(
        "change impact never reads Git state or executes commands; changedPaths must come from the caller, and the returned argv is planning output for the normal shell path"
            .to_owned(),
    );
    if affected.is_empty() && !changes.is_empty() {
        warnings.push(
            "no source package requires validation for the supplied paths; generated target outputs are intentionally ignored"
                .to_owned(),
        );
    }

    Ok(ChangeImpactReport {
        schema_version: SCHEMA_VERSION,
        workspace_root: context.workspace_root,
        scope: if whole_workspace {
            "whole_workspace".to_owned()
        } else {
            "focused".to_owned()
        },
        input_paths,
        changes,
        direct_packages,
        affected_packages: affected,
        dependency_edges: edges.len(),
        commands,
        warnings,
    })
}

fn resolve_changed_path(workspace_root: &Path, path: &Path) -> PathBuf {
    if path.is_absolute() {
        canonicalize_friendly(path)
    } else {
        canonicalize_friendly(&workspace_root.join(path))
    }
}

fn classify_change(
    path: &Path,
    context: &WorkspaceContext,
    changes: &mut Vec<ClassifiedChange>,
    direct: &mut BTreeMap<usize, DirectImpact>,
    whole_workspace: &mut bool,
) {
    if !is_within(&context.workspace_root, path) {
        *whole_workspace = true;
        changes.push(ClassifiedChange {
            path: path.to_path_buf(),
            classification: "outside_workspace".to_owned(),
            package: None,
            propagates_to_dependents: true,
            reason: "the path is outside the resolved workspace, so ownership cannot be proven"
                .to_owned(),
        });
        return;
    }
    if is_workspace_global(path, context) {
        *whole_workspace = true;
        changes.push(ClassifiedChange {
            path: path.to_path_buf(),
            classification: "workspace_configuration".to_owned(),
            package: None,
            propagates_to_dependents: true,
            reason: "workspace-level Cargo, toolchain, lint, formatting, or lock configuration can affect every package"
                .to_owned(),
        });
        return;
    }
    let workspace_relative = path.strip_prefix(&context.workspace_root).unwrap_or(path);
    if workspace_relative
        .components()
        .next()
        .is_some_and(|component| component.as_os_str() == "target")
    {
        changes.push(ClassifiedChange {
            path: path.to_path_buf(),
            classification: "generated_target_output".to_owned(),
            package: None,
            propagates_to_dependents: false,
            reason: "Cargo target output is generated state and does not imply source validation"
                .to_owned(),
        });
        return;
    }
    let Some((index, package)) = owner_package(&context.packages, path) else {
        if path
            .extension()
            .and_then(|value| value.to_str())
            .is_some_and(|extension| matches!(extension, "md" | "mdx" | "rst"))
        {
            changes.push(ClassifiedChange {
                path: path.to_path_buf(),
                classification: "workspace_documentation".to_owned(),
                package: None,
                propagates_to_dependents: false,
                reason: "unowned workspace documentation does not require a Rust build by itself"
                    .to_owned(),
            });
            return;
        }
        *whole_workspace = true;
        changes.push(ClassifiedChange {
            path: path.to_path_buf(),
            classification: "unowned_workspace_path".to_owned(),
            package: None,
            propagates_to_dependents: true,
            reason: "the path is inside the workspace but is not owned by a discovered package"
                .to_owned(),
        });
        return;
    };
    let relative = path.strip_prefix(&package.package_root).unwrap_or(path);
    let relative_key = relative.to_string_lossy().replace('\\', "/");
    let file_name = relative.file_name().and_then(|value| value.to_str());
    let first = relative
        .components()
        .next()
        .and_then(|component| component.as_os_str().to_str());
    let (classification, propagate, check, test, doc, reason) = if first == Some("target") {
        (
            "generated_target_output",
            false,
            false,
            false,
            false,
            "Cargo target output is generated state and does not imply source validation",
        )
    } else if matches!(first, Some("tests" | "benches" | "examples")) {
        (
                "package_test_surface",
                false,
                false,
                true,
                false,
                "test, benchmark, or example changes affect the owning package without propagating as a library dependency",
            )
    } else if first == Some("src") {
        (
            "package_source",
            true,
            true,
            true,
            false,
            "Rust source can affect the owning package and reverse local dependents",
        )
    } else if file_name == Some("Cargo.toml") || file_name == Some("build.rs") {
        (
            "package_build_configuration",
            true,
            true,
            true,
            false,
            "package manifest or build-script changes can alter compilation and generated outputs",
        )
    } else if relative
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| matches!(extension, "md" | "mdx" | "rst"))
    {
        (
            "package_documentation",
            false,
            false,
            false,
            true,
            "documentation changes are scoped to the owning package unless included by its build",
        )
    } else {
        (
                "package_build_input",
                true,
                true,
                true,
                false,
                "a nonstandard package file may be consumed by build.rs, include macros, or another generator",
            )
    };
    changes.push(ClassifiedChange {
        path: path.to_path_buf(),
        classification: classification.to_owned(),
        package: Some(package.name.clone()),
        propagates_to_dependents: propagate,
        reason: reason.to_owned(),
    });
    if !check && !test && !doc {
        return;
    }
    let impact = direct.entry(index).or_default();
    impact.reasons.insert(format!("{relative_key}: {reason}"));
    impact.propagate |= propagate;
    impact.check |= check;
    impact.test |= test;
    impact.doc |= doc;
}

fn is_workspace_global(path: &Path, context: &WorkspaceContext) -> bool {
    if path_key(path) == path_key(&context.workspace_manifest) {
        return true;
    }
    let relative = path
        .strip_prefix(&context.workspace_root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    matches!(
        relative.as_str(),
        "Cargo.lock"
            | "rust-toolchain"
            | "rust-toolchain.toml"
            | "rustfmt.toml"
            | ".rustfmt.toml"
            | "clippy.toml"
            | ".clippy.toml"
            | "deny.toml"
            | ".config/nextest.toml"
    ) || relative.starts_with(".cargo/")
}

fn owner_package<'a>(
    packages: &'a [PackageContext],
    path: &Path,
) -> Option<(usize, &'a PackageContext)> {
    packages
        .iter()
        .enumerate()
        .filter(|(_, package)| is_within(&package.package_root, path))
        .max_by_key(|(_, package)| package.package_root.components().count())
}

fn dependency_edges(context: &WorkspaceContext, warnings: &mut Vec<String>) -> Vec<DependencyEdge> {
    let manifest_indices = context
        .packages
        .iter()
        .enumerate()
        .map(|(index, package)| (path_key(&package.manifest_path), index))
        .collect::<BTreeMap<_, _>>();
    let mut edges = Vec::new();
    for (dependent, package) in context.packages.iter().enumerate() {
        let manifest = match Manifest::from_path(&package.manifest_path) {
            Ok(manifest) => manifest,
            Err(error) => {
                warnings.push(format!(
                    "could not inspect dependency edges in {}: {error}",
                    package.manifest_path.display()
                ));
                continue;
            }
        };
        append_edges(
            &mut edges,
            dependent,
            "normal",
            None,
            &manifest.dependencies,
            &package.package_root,
            &manifest_indices,
        );
        append_edges(
            &mut edges,
            dependent,
            "development",
            None,
            &manifest.dev_dependencies,
            &package.package_root,
            &manifest_indices,
        );
        append_edges(
            &mut edges,
            dependent,
            "build",
            None,
            &manifest.build_dependencies,
            &package.package_root,
            &manifest_indices,
        );
        for (target, dependencies) in &manifest.target {
            append_edges(
                &mut edges,
                dependent,
                "normal",
                Some(target),
                &dependencies.dependencies,
                &package.package_root,
                &manifest_indices,
            );
            append_edges(
                &mut edges,
                dependent,
                "development",
                Some(target),
                &dependencies.dev_dependencies,
                &package.package_root,
                &manifest_indices,
            );
            append_edges(
                &mut edges,
                dependent,
                "build",
                Some(target),
                &dependencies.build_dependencies,
                &package.package_root,
                &manifest_indices,
            );
        }
    }
    edges.sort_by(|left, right| {
        left.dependent
            .cmp(&right.dependent)
            .then(left.dependency.cmp(&right.dependency))
            .then(left.kind.cmp(&right.kind))
            .then(left.target.cmp(&right.target))
    });
    edges.dedup_by(|left, right| {
        left.dependent == right.dependent
            && left.dependency == right.dependency
            && left.kind == right.kind
            && left.target == right.target
    });
    edges
}

fn append_edges(
    output: &mut Vec<DependencyEdge>,
    dependent: usize,
    kind: &str,
    target: Option<&String>,
    dependencies: &DepsSet,
    package_root: &Path,
    manifest_indices: &BTreeMap<String, usize>,
) {
    for dependency in dependencies.values() {
        let Some(index) = local_dependency_index(dependency, package_root, manifest_indices) else {
            continue;
        };
        output.push(DependencyEdge {
            dependent,
            dependency: index,
            kind: kind.to_owned(),
            target: target.cloned(),
        });
    }
}

fn local_dependency_index(
    dependency: &Dependency,
    package_root: &Path,
    manifest_indices: &BTreeMap<String, usize>,
) -> Option<usize> {
    let detail = dependency.detail()?;
    let raw_path = detail.path.as_deref()?;
    let path = Path::new(raw_path);
    let resolved = if path.is_absolute() {
        canonicalize_friendly(path)
    } else {
        canonicalize_friendly(&package_root.join(path))
    };
    let manifest = if resolved.is_dir() {
        resolved.join("Cargo.toml")
    } else {
        resolved
    };
    manifest_indices.get(&path_key(&manifest)).copied()
}

fn affected_packages(
    context: &WorkspaceContext,
    direct: &BTreeMap<usize, DirectImpact>,
    edges: &[DependencyEdge],
) -> (Vec<AffectedPackage>, BTreeMap<usize, DirectImpact>) {
    let mut reverse = vec![Vec::<&DependencyEdge>::new(); context.packages.len()];
    for edge in edges {
        if let Some(values) = reverse.get_mut(edge.dependency) {
            values.push(edge);
        }
    }
    let mut distances = BTreeMap::<usize, usize>::new();
    let mut impacts = direct.clone();
    let mut queue = VecDeque::new();
    let mut propagation_queue = BTreeSet::new();
    for (index, impact) in direct {
        distances.insert(*index, 0);
        if impact.propagate {
            queue.push_back(*index);
            propagation_queue.insert(*index);
        }
    }
    while let Some(dependency) = queue.pop_front() {
        let distance = distances.get(&dependency).copied().unwrap_or(0);
        for edge in reverse.get(dependency).into_iter().flatten() {
            let next_distance = distance.saturating_add(1);
            distances
                .entry(edge.dependent)
                .and_modify(|current| *current = (*current).min(next_distance))
                .or_insert(next_distance);
            let dependency_name = context
                .packages
                .get(dependency)
                .map(|package| package.name.as_str())
                .unwrap_or("local package");
            let reason = if let Some(target) = edge.target.as_deref() {
                format!(
                    "depends on {dependency_name} through a target-conditional {} dependency ({target})",
                    edge.kind
                )
            } else {
                format!(
                    "depends on {dependency_name} through a {} dependency",
                    edge.kind
                )
            };
            let impact = impacts.entry(edge.dependent).or_default();
            impact.reasons.insert(reason);
            impact.check = true;
            if edge.kind == "development" {
                impact.test = true;
            }
            if edge.kind != "development" && propagation_queue.insert(edge.dependent) {
                queue.push_back(edge.dependent);
            }
        }
    }
    let mut affected = distances
        .iter()
        .filter_map(|(index, distance)| {
            let package = context.packages.get(*index)?;
            let impact = impacts.get(index)?;
            Some(AffectedPackage {
                name: package.name.clone(),
                manifest_path: package.manifest_path.clone(),
                direct: direct.contains_key(index),
                dependency_distance: *distance,
                reasons: impact.reasons.iter().cloned().collect(),
            })
        })
        .collect::<Vec<_>>();
    affected.sort_by(|left, right| {
        left.dependency_distance
            .cmp(&right.dependency_distance)
            .then(left.name.cmp(&right.name))
            .then(left.manifest_path.cmp(&right.manifest_path))
    });
    (affected, impacts)
}

fn validation_commands(
    context: &WorkspaceContext,
    whole_workspace: bool,
    direct: &BTreeMap<usize, DirectImpact>,
    impacts: &BTreeMap<usize, DirectImpact>,
    warnings: &mut Vec<String>,
) -> Vec<ValidationCommand> {
    if impacts.is_empty() {
        return Vec::new();
    }
    if whole_workspace {
        let packages = context
            .packages
            .iter()
            .map(|package| package.name.clone())
            .collect::<Vec<_>>();
        return vec![
            ValidationCommand {
                program: "cargo".to_owned(),
                args: vec![
                    "check".to_owned(),
                    "--workspace".to_owned(),
                    "--all-targets".to_owned(),
                ],
                cwd: context.workspace_root.clone(),
                priority: "required".to_owned(),
                packages: packages.clone(),
                rationale: "workspace-level or unknown ownership requires checking every target"
                    .to_owned(),
            },
            ValidationCommand {
                program: "cargo".to_owned(),
                args: vec!["test".to_owned(), "--workspace".to_owned()],
                cwd: context.workspace_root.clone(),
                priority: "required".to_owned(),
                packages,
                rationale: "workspace-wide changes can affect tests across every member".to_owned(),
            },
        ];
    }

    let check = package_names(context, impacts, |impact| impact.check);
    let tests = package_names(context, direct, |impact| impact.test);
    let docs = package_names(context, direct, |impact| impact.doc);
    let lint = package_names(context, direct, |impact| impact.check);
    let dependent_tests = package_names(context, impacts, |impact| impact.check)
        .into_iter()
        .filter(|name| !tests.contains(name))
        .collect::<Vec<_>>();
    let mut commands = Vec::new();
    push_package_command(
        &mut commands,
        context,
        "check",
        &check,
        &["--all-targets"],
        "required",
        "check directly changed packages and their reverse local dependents",
        warnings,
    );
    push_package_command(
        &mut commands,
        context,
        "test",
        &tests,
        &[],
        "required",
        "run tests owned by directly changed packages",
        warnings,
    );
    push_package_command(
        &mut commands,
        context,
        "test",
        &dependent_tests,
        &[],
        "recommended",
        "run reverse-dependent tests when the changed API or behavior may cross package boundaries",
        warnings,
    );
    push_package_command(
        &mut commands,
        context,
        "clippy",
        &lint,
        &["--all-targets"],
        "recommended",
        "lint directly changed compilation surfaces without linting unrelated members",
        warnings,
    );
    push_package_command(
        &mut commands,
        context,
        "test",
        &docs,
        &["--doc"],
        "recommended",
        "validate package documentation examples",
        warnings,
    );
    commands
}

fn package_names(
    context: &WorkspaceContext,
    impacts: &BTreeMap<usize, DirectImpact>,
    predicate: impl Fn(&DirectImpact) -> bool,
) -> Vec<String> {
    let mut names = impacts
        .iter()
        .filter(|(_, impact)| predicate(impact))
        .filter_map(|(index, _)| context.packages.get(*index))
        .map(|package| package.name.clone())
        .collect::<Vec<_>>();
    names.sort();
    names.dedup();
    names
}

#[allow(clippy::too_many_arguments)]
fn push_package_command(
    output: &mut Vec<ValidationCommand>,
    context: &WorkspaceContext,
    operation: &str,
    packages: &[String],
    trailing_args: &[&str],
    priority: &str,
    rationale: &str,
    warnings: &mut Vec<String>,
) {
    if packages.is_empty() {
        return;
    }
    let mut args = vec![operation.to_owned()];
    if packages.len() > MAX_PACKAGES_PER_COMMAND {
        args.push("--workspace".to_owned());
        warnings.push(format!(
            "{operation} scope widened to --workspace because {} package selectors exceed the {MAX_PACKAGES_PER_COMMAND}-package argv limit",
            packages.len()
        ));
    } else {
        for package in packages {
            args.push("-p".to_owned());
            args.push(package.clone());
        }
    }
    args.extend(trailing_args.iter().map(|value| (*value).to_owned()));
    output.push(ValidationCommand {
        program: "cargo".to_owned(),
        args,
        cwd: context.workspace_root.clone(),
        priority: priority.to_owned(),
        packages: packages.to_vec(),
        rationale: rationale.to_owned(),
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changed_path_limit_is_provider_compatible() {
        assert_eq!(MAX_CHANGED_PATHS, 512);
        let paths = vec![PathBuf::from("src/lib.rs"); MAX_CHANGED_PATHS + 1];
        let error = analyze_change_impact(Path::new("."), &paths)
            .expect_err("oversized changed path list must fail before workspace inspection");
        assert!(matches!(error, Error::Usage(_)));
    }
}
