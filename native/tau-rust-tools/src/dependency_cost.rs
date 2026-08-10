use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

use cargo_toml::{Dependency, Manifest};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::workspace::inspect_workspace;

const SCHEMA_VERSION: u32 = 1;
const MAX_LOCK_BYTES: u64 = 16 * 1024 * 1024;
const MAX_LOCK_PACKAGES: usize = 100_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DependencyCostReport {
    pub schema_version: u32,
    pub package: String,
    pub manifest_path: PathBuf,
    pub lock_path: PathBuf,
    pub locked_packages: usize,
    pub direct_dependencies: Vec<DirectDependencyCost>,
    pub duplicate_versions: Vec<DuplicateVersion>,
    pub git_packages: usize,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectDependencyCost {
    pub alias: String,
    pub package: String,
    pub kinds: Vec<String>,
    pub requested: Option<String>,
    pub optional: bool,
    pub locked_versions: Vec<String>,
    pub transitive_packages: usize,
    pub duplicate_crates: usize,
    pub git_packages: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DuplicateVersion {
    pub package: String,
    pub versions: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct Lockfile {
    #[serde(default)]
    package: Vec<LockPackage>,
}

#[derive(Clone, Debug, Deserialize)]
struct LockPackage {
    name: String,
    version: String,
    source: Option<String>,
    #[serde(default)]
    dependencies: Vec<String>,
}

#[derive(Clone, Debug)]
struct DirectDependency {
    alias: String,
    package: String,
    kinds: BTreeSet<String>,
    requested: Option<String>,
    optional: bool,
}

pub fn analyze_dependency_cost(query: &Path) -> Result<DependencyCostReport> {
    let context = inspect_workspace(query)?;
    let lock_path = context.workspace_root.join("Cargo.lock");
    let mut warnings = context.warnings;
    let (package_name, package_version, manifest_path, direct) = if let Some(package) =
        context.selected_package
    {
        let manifest =
            Manifest::from_path(&package.manifest_path).map_err(|error| Error::Manifest {
                path: package.manifest_path.clone(),
                detail: error.to_string(),
            })?;
        let direct = collect_direct_dependencies(&manifest);
        (
            package.name,
            Some(package.version),
            package.manifest_path,
            direct,
        )
    } else {
        warnings.push(format!(
                "{} selects the workspace lock graph rather than one Cargo package; direct package dependency costs are omitted. Pass a package manifest, source path, or package directory to include direct fan-out",
                context.query_path.display()
            ));
        (
            "workspace".to_owned(),
            None,
            context.workspace_manifest,
            BTreeMap::new(),
        )
    };
    if !lock_path.is_file() {
        warnings.push(
            "Cargo.lock is absent; dependency cost requires an existing lockfile and will not generate one"
                .to_owned(),
        );
        return Ok(DependencyCostReport {
            schema_version: SCHEMA_VERSION,
            package: package_name,
            manifest_path,
            lock_path,
            locked_packages: 0,
            direct_dependencies: direct.into_values().map(empty_cost).collect(),
            duplicate_versions: Vec::new(),
            git_packages: 0,
            warnings,
        });
    }
    let metadata = fs::metadata(&lock_path).map_err(|source| Error::Io {
        operation: "inspect Cargo.lock",
        path: lock_path.clone(),
        source,
    })?;
    if metadata.len() > MAX_LOCK_BYTES {
        return Err(Error::Usage(format!(
            "Cargo.lock exceeds the {MAX_LOCK_BYTES}-byte analysis limit"
        )));
    }
    let lock_text = fs::read_to_string(&lock_path).map_err(|source| Error::Io {
        operation: "read Cargo.lock",
        path: lock_path.clone(),
        source,
    })?;
    let lock: Lockfile = toml::from_str(&lock_text).map_err(|error| {
        Error::InvalidData(format!("could not parse {}: {error}", lock_path.display()))
    })?;
    if lock.package.len() > MAX_LOCK_PACKAGES {
        return Err(Error::Usage(format!(
            "Cargo.lock contains more than {MAX_LOCK_PACKAGES} packages"
        )));
    }

    let by_name = index_packages(&lock.package);
    let graph = dependency_graph(&lock.package, &by_name);
    let (has_locked_root, direct_roots) = package_version.as_deref().map_or_else(
        || (false, BTreeMap::new()),
        |version| direct_lock_roots(&package_name, version, &lock.package, &graph),
    );
    if let Some(version) = package_version.as_deref().filter(|_| !has_locked_root) {
        warnings.push(format!(
            "package {:?} v{} is absent from Cargo.lock; direct costs use conservative name matching",
            package_name, version
        ));
    }
    let mut direct_costs = direct
        .into_values()
        .map(|dependency| {
            let roots = if has_locked_root {
                direct_roots
                    .get(&dependency.package)
                    .cloned()
                    .unwrap_or_default()
            } else {
                by_name
                    .get(&dependency.package)
                    .cloned()
                    .unwrap_or_default()
            };
            cost_for_dependency(dependency, roots, &lock.package, &graph)
        })
        .collect::<Vec<_>>();
    direct_costs.sort_by(|left, right| {
        right
            .transitive_packages
            .cmp(&left.transitive_packages)
            .then(left.package.cmp(&right.package))
    });
    let duplicate_versions = duplicate_versions(&lock.package);
    let git_packages = lock
        .package
        .iter()
        .filter(|package| {
            package
                .source
                .as_deref()
                .is_some_and(|value| value.starts_with("git+"))
        })
        .count();

    Ok(DependencyCostReport {
        schema_version: SCHEMA_VERSION,
        package: package_name,
        manifest_path,
        lock_path,
        locked_packages: lock.package.len(),
        direct_dependencies: direct_costs,
        duplicate_versions,
        git_packages,
        warnings,
    })
}

fn collect_direct_dependencies(manifest: &Manifest) -> BTreeMap<String, DirectDependency> {
    let mut output = BTreeMap::new();
    append_direct(&mut output, &manifest.dependencies, "normal");
    append_direct(&mut output, &manifest.dev_dependencies, "dev");
    append_direct(&mut output, &manifest.build_dependencies, "build");
    for target in manifest.target.values() {
        append_direct(&mut output, &target.dependencies, "target-normal");
        append_direct(&mut output, &target.dev_dependencies, "target-dev");
        append_direct(&mut output, &target.build_dependencies, "target-build");
    }
    output
}

fn append_direct(
    output: &mut BTreeMap<String, DirectDependency>,
    dependencies: &BTreeMap<String, Dependency>,
    kind: &str,
) {
    for (alias, dependency) in dependencies {
        let package = dependency.package().unwrap_or(alias).to_owned();
        let entry = output
            .entry(format!("{alias}\u{0}{package}"))
            .or_insert_with(|| DirectDependency {
                alias: alias.clone(),
                package,
                kinds: BTreeSet::new(),
                requested: dependency.try_req().ok().map(ToString::to_string),
                optional: dependency.optional(),
            });
        entry.kinds.insert(kind.to_owned());
        entry.optional |= dependency.optional();
    }
}

fn index_packages(packages: &[LockPackage]) -> BTreeMap<String, Vec<usize>> {
    let mut output = BTreeMap::<String, Vec<usize>>::new();
    for (index, package) in packages.iter().enumerate() {
        output.entry(package.name.clone()).or_default().push(index);
    }
    output
}

fn dependency_graph(
    packages: &[LockPackage],
    by_name: &BTreeMap<String, Vec<usize>>,
) -> Vec<Vec<usize>> {
    packages
        .iter()
        .map(|package| {
            let mut edges = BTreeSet::new();
            for dependency in &package.dependencies {
                let (name, version) = parse_lock_dependency(dependency);
                let Some(candidates) = by_name.get(name) else {
                    continue;
                };
                for index in candidates {
                    if version.is_none_or(|version| packages[*index].version == version) {
                        edges.insert(*index);
                    }
                }
            }
            edges.into_iter().collect()
        })
        .collect()
}

fn parse_lock_dependency(value: &str) -> (&str, Option<&str>) {
    let mut parts = value.split_whitespace();
    let name = parts.next().unwrap_or(value);
    let version = parts.next().filter(|value| {
        value
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_digit())
    });
    (name, version)
}

fn direct_lock_roots(
    package_name: &str,
    package_version: &str,
    packages: &[LockPackage],
    graph: &[Vec<usize>],
) -> (bool, BTreeMap<String, Vec<usize>>) {
    let roots = packages
        .iter()
        .enumerate()
        .filter(|(_, package)| package.name == package_name && package.version == package_version)
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    let mut direct = BTreeMap::<String, BTreeSet<usize>>::new();
    for root in &roots {
        for dependency in &graph[*root] {
            direct
                .entry(packages[*dependency].name.clone())
                .or_default()
                .insert(*dependency);
        }
    }
    (
        !roots.is_empty(),
        direct
            .into_iter()
            .map(|(name, indices)| (name, indices.into_iter().collect()))
            .collect(),
    )
}

fn cost_for_dependency(
    dependency: DirectDependency,
    roots: Vec<usize>,
    packages: &[LockPackage],
    graph: &[Vec<usize>],
) -> DirectDependencyCost {
    let mut visited = BTreeSet::new();
    let mut queue = VecDeque::from(roots.clone());
    while let Some(index) = queue.pop_front() {
        if !visited.insert(index) {
            continue;
        }
        queue.extend(graph[index].iter().copied());
    }
    let mut versions = BTreeSet::new();
    let mut closure_versions = BTreeMap::<String, BTreeSet<String>>::new();
    let mut git_packages = 0;
    for index in &visited {
        let package = &packages[*index];
        closure_versions
            .entry(package.name.clone())
            .or_default()
            .insert(package.version.clone());
        if roots.contains(index) {
            versions.insert(package.version.clone());
        }
        if package
            .source
            .as_deref()
            .is_some_and(|value| value.starts_with("git+"))
        {
            git_packages += 1;
        }
    }
    DirectDependencyCost {
        alias: dependency.alias,
        package: dependency.package,
        kinds: dependency.kinds.into_iter().collect(),
        requested: dependency.requested,
        optional: dependency.optional,
        locked_versions: versions.into_iter().collect(),
        transitive_packages: visited.len().saturating_sub(roots.len()),
        duplicate_crates: closure_versions
            .values()
            .filter(|versions| versions.len() > 1)
            .count(),
        git_packages,
    }
}

fn empty_cost(dependency: DirectDependency) -> DirectDependencyCost {
    DirectDependencyCost {
        alias: dependency.alias,
        package: dependency.package,
        kinds: dependency.kinds.into_iter().collect(),
        requested: dependency.requested,
        optional: dependency.optional,
        locked_versions: Vec::new(),
        transitive_packages: 0,
        duplicate_crates: 0,
        git_packages: 0,
    }
}

fn duplicate_versions(packages: &[LockPackage]) -> Vec<DuplicateVersion> {
    let mut versions = BTreeMap::<String, BTreeSet<String>>::new();
    for package in packages {
        versions
            .entry(package.name.clone())
            .or_default()
            .insert(package.version.clone());
    }
    versions
        .into_iter()
        .filter(|(_, versions)| versions.len() > 1)
        .map(|(package, versions)| DuplicateVersion {
            package,
            versions: versions.into_iter().collect(),
        })
        .collect()
}
