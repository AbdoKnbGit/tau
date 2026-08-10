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
// Planned commands may be copied through cmd.exe even when Tau itself uses a
// different shell. Stay below its 8,191-character boundary without consulting
// machine-specific state, and split focused selectors instead of widening the
// validation scope merely because a workspace has many packages.
const PORTABLE_COMMAND_BYTES: usize = 7_000;
// A Cargo work unit normally contributes at least one progress/summary line.
// Modeling it as 64 output bytes lets the planner compare extra compilation
// with the exact serialized size of package selectors in one deterministic,
// provider-independent unit. This is a scope estimate, not wall-clock timing.
const ESTIMATED_WORK_OUTPUT_BYTES: u64 = 64;
const COMMAND_LAUNCH_OUTPUT_BYTES: u64 = 32;

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

#[derive(Clone, Debug)]
struct CommandPlan {
    commands: Vec<ValidationCommand>,
    estimated_cost_bytes: u64,
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
        &edges,
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
    edges: &[DependencyEdge],
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
    push_optimized_package_commands(
        &mut commands,
        context,
        edges,
        "check",
        &check,
        &["--all-targets"],
        "required",
        "check directly changed packages and their reverse local dependents",
    );
    push_optimized_package_commands(
        &mut commands,
        context,
        edges,
        "test",
        &tests,
        &[],
        "required",
        "run tests owned by directly changed packages",
    );
    push_optimized_package_commands(
        &mut commands,
        context,
        edges,
        "test",
        &dependent_tests,
        &[],
        "recommended",
        "run reverse-dependent tests when the changed API or behavior may cross package boundaries",
    );
    push_optimized_package_commands(
        &mut commands,
        context,
        edges,
        "clippy",
        &lint,
        &["--all-targets"],
        "recommended",
        "lint directly changed compilation surfaces without linting unrelated members",
    );
    push_optimized_package_commands(
        &mut commands,
        context,
        edges,
        "test",
        &docs,
        &["--doc"],
        "recommended",
        "validate package documentation examples",
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
fn push_optimized_package_commands(
    output: &mut Vec<ValidationCommand>,
    context: &WorkspaceContext,
    edges: &[DependencyEdge],
    operation: &str,
    packages: &[String],
    trailing_args: &[&str],
    priority: &str,
    rationale: &str,
) {
    if packages.is_empty() {
        return;
    }

    let focused = focused_command_plan(
        context,
        edges,
        operation,
        packages,
        trailing_args,
        priority,
        rationale,
    );
    let excluded = workspace_exclusion_command_plan(
        context,
        edges,
        operation,
        packages,
        trailing_args,
        priority,
        rationale,
    );
    let workspace = workspace_command_plan(
        context,
        edges,
        operation,
        trailing_args,
        priority,
        rationale,
    );
    // Exact focused coverage wins ties. First select its shortest portable
    // representation, then widen only when validating the complete workspace
    // has a strictly lower static cost.
    let exact = match excluded {
        Some(plan) if plan.estimated_cost_bytes < focused.estimated_cost_bytes => plan,
        _ => focused,
    };
    let selected = if workspace.estimated_cost_bytes < exact.estimated_cost_bytes {
        workspace
    } else {
        exact
    };
    output.extend(selected.commands);
}

fn focused_command_plan(
    context: &WorkspaceContext,
    edges: &[DependencyEdge],
    operation: &str,
    packages: &[String],
    trailing_args: &[&str],
    priority: &str,
    rationale: &str,
) -> CommandPlan {
    let package_indices = named_package_indices(context, packages);
    let work_units =
        estimated_work_units(context, edges, &package_indices, operation, trailing_args);
    let batches = focused_package_batches(operation, packages, trailing_args);
    let commands = batches
        .into_iter()
        .map(|batch| {
            package_command(
                context,
                operation,
                &batch,
                trailing_args,
                priority,
                rationale,
                false,
                &[],
            )
        })
        .collect::<Vec<_>>();
    CommandPlan {
        estimated_cost_bytes: estimated_plan_cost(work_units, &commands),
        commands,
    }
}

fn workspace_exclusion_command_plan(
    context: &WorkspaceContext,
    edges: &[DependencyEdge],
    operation: &str,
    packages: &[String],
    trailing_args: &[&str],
    priority: &str,
    rationale: &str,
) -> Option<CommandPlan> {
    let selected_indices = named_package_indices(context, packages);
    let excluded = context
        .packages
        .iter()
        .enumerate()
        .filter(|(index, _)| !selected_indices.contains(index))
        .map(|(_, package)| package.name.clone())
        .collect::<Vec<_>>();
    if excluded.is_empty() {
        return None;
    }

    let command = package_command(
        context,
        operation,
        packages,
        trailing_args,
        priority,
        rationale,
        true,
        &excluded,
    );
    if rendered_args_bytes(&command.program, command.args.iter().map(String::as_str))
        > PORTABLE_COMMAND_BYTES
    {
        return None;
    }
    let work_units =
        estimated_work_units(context, edges, &selected_indices, operation, trailing_args);
    Some(CommandPlan {
        estimated_cost_bytes: estimated_plan_cost(work_units, std::slice::from_ref(&command)),
        commands: vec![command],
    })
}

fn workspace_command_plan(
    context: &WorkspaceContext,
    edges: &[DependencyEdge],
    operation: &str,
    trailing_args: &[&str],
    priority: &str,
    rationale: &str,
) -> CommandPlan {
    let all_indices = (0..context.packages.len()).collect::<BTreeSet<_>>();
    let work_units = estimated_work_units(context, edges, &all_indices, operation, trailing_args);
    let packages = context
        .packages
        .iter()
        .map(|package| package.name.clone())
        .collect::<Vec<_>>();
    let commands = vec![package_command(
        context,
        operation,
        &packages,
        trailing_args,
        priority,
        rationale,
        true,
        &[],
    )];
    CommandPlan {
        estimated_cost_bytes: estimated_plan_cost(work_units, &commands),
        commands,
    }
}

#[allow(clippy::too_many_arguments)]
fn package_command(
    context: &WorkspaceContext,
    operation: &str,
    packages: &[String],
    trailing_args: &[&str],
    priority: &str,
    rationale: &str,
    workspace: bool,
    excluded: &[String],
) -> ValidationCommand {
    let mut args = vec![operation.to_owned()];
    if workspace {
        args.push("--workspace".to_owned());
        for package in excluded {
            args.push("--exclude".to_owned());
            args.push(package.clone());
        }
    } else {
        for package in packages {
            args.push("-p".to_owned());
            args.push(package.clone());
        }
    }
    args.extend(trailing_args.iter().map(|value| (*value).to_owned()));
    ValidationCommand {
        program: "cargo".to_owned(),
        args,
        cwd: context.workspace_root.clone(),
        priority: priority.to_owned(),
        packages: packages.to_vec(),
        rationale: rationale.to_owned(),
    }
}

fn focused_package_batches(
    operation: &str,
    packages: &[String],
    trailing_args: &[&str],
) -> Vec<Vec<String>> {
    let fixed_bytes = rendered_args_bytes(
        "cargo",
        std::iter::once(operation).chain(trailing_args.iter().copied()),
    );
    let mut batches = Vec::<Vec<String>>::new();
    let mut current = Vec::<String>::new();
    let mut current_bytes = fixed_bytes;
    for package in packages {
        // Rendered selector is ` -p <package>`.
        let selector_bytes = 4usize.saturating_add(package.len());
        if !current.is_empty()
            && current_bytes.saturating_add(selector_bytes) > PORTABLE_COMMAND_BYTES
        {
            batches.push(std::mem::take(&mut current));
            current_bytes = fixed_bytes;
        }
        current.push(package.clone());
        current_bytes = current_bytes.saturating_add(selector_bytes);
    }
    if !current.is_empty() {
        batches.push(current);
    }
    batches
}

fn named_package_indices(context: &WorkspaceContext, packages: &[String]) -> BTreeSet<usize> {
    let names = packages.iter().map(String::as_str).collect::<BTreeSet<_>>();
    context
        .packages
        .iter()
        .enumerate()
        .filter_map(|(index, package)| names.contains(package.name.as_str()).then_some(index))
        .collect()
}

fn estimated_work_units(
    context: &WorkspaceContext,
    edges: &[DependencyEdge],
    selected: &BTreeSet<usize>,
    operation: &str,
    trailing_args: &[&str],
) -> usize {
    let mut closure = selected.clone();
    let mut queue = selected.iter().copied().collect::<VecDeque<_>>();
    while let Some(dependent) = queue.pop_front() {
        for edge in edges.iter().filter(|edge| edge.dependent == dependent) {
            if closure.insert(edge.dependency) {
                queue.push_back(edge.dependency);
            }
        }
    }
    closure
        .into_iter()
        .filter_map(|index| context.packages.get(index).map(|package| (index, package)))
        .map(|(index, package)| {
            if selected.contains(&index) {
                selected_package_work_units(package, operation, trailing_args)
            } else {
                1
            }
        })
        .sum()
}

fn selected_package_work_units(
    package: &PackageContext,
    operation: &str,
    trailing_args: &[&str],
) -> usize {
    if operation == "test" && trailing_args.contains(&"--doc") {
        // A selected doctest package is both compiled as a dependency surface
        // and executed as documentation tests. A transitive dependency only
        // pays the former unit in `estimated_work_units`.
        return 2;
    }
    match operation {
        "test" => package.targets.len().max(1).saturating_add(1),
        "check" | "clippy" => package.targets.len().max(1),
        _ => 1,
    }
}

fn estimated_plan_cost(work_units: usize, commands: &[ValidationCommand]) -> u64 {
    let command_bytes = commands
        .iter()
        .map(|command| {
            rendered_args_bytes(&command.program, command.args.iter().map(String::as_str)) as u64
        })
        .sum::<u64>();
    (work_units as u64)
        .saturating_mul(ESTIMATED_WORK_OUTPUT_BYTES)
        .saturating_add(command_bytes)
        .saturating_add((commands.len() as u64).saturating_mul(COMMAND_LAUNCH_OUTPUT_BYTES))
}

fn rendered_args_bytes<'a>(program: &str, args: impl Iterator<Item = &'a str>) -> usize {
    args.fold(program.len(), |bytes, argument| {
        bytes.saturating_add(1).saturating_add(argument.len())
    })
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

    #[test]
    fn focused_batches_are_portable_complete_and_deterministic() {
        let packages = (0..160)
            .map(|index| format!("package-{index:03}-{}", "x".repeat(48)))
            .collect::<Vec<_>>();
        let first = focused_package_batches("check", &packages, &["--all-targets"]);
        let second = focused_package_batches("check", &packages, &["--all-targets"]);

        assert_eq!(first, second);
        assert!(
            first.len() > 1,
            "long selectors should be split, not widened"
        );
        assert_eq!(
            first.iter().flatten().cloned().collect::<Vec<_>>(),
            packages,
            "batching must preserve every package exactly once and in order"
        );
        assert!(first.iter().all(|batch| {
            let args = std::iter::once("check")
                .chain(batch.iter().flat_map(|package| ["-p", package.as_str()]))
                .chain(std::iter::once("--all-targets"));
            rendered_args_bytes("cargo", args) <= PORTABLE_COMMAND_BYTES
        }));
    }
}
