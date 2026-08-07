use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::error::{Error, Result};
use crate::workspace::{inspect_workspace, target_selector, PackageContext, TargetContext};

const SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CargoOperation {
    Check,
    Build,
    Clippy,
    Test,
    Bench,
    Doc,
    Run,
}

impl CargoOperation {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "check" => Ok(Self::Check),
            "build" => Ok(Self::Build),
            "clippy" => Ok(Self::Clippy),
            "test" => Ok(Self::Test),
            "bench" => Ok(Self::Bench),
            "doc" => Ok(Self::Doc),
            "run" => Ok(Self::Run),
            other => Err(Error::Usage(format!(
                "unsupported Cargo operation {other:?}; expected check, build, clippy, test, bench, doc, or run"
            ))),
        }
    }

    fn cargo_subcommand(self) -> &'static str {
        match self {
            Self::Check => "check",
            Self::Build => "build",
            Self::Clippy => "clippy",
            Self::Test => "test",
            Self::Bench => "bench",
            Self::Doc => "doc",
            Self::Run => "run",
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct FocusedCommandOptions {
    pub features: Vec<String>,
    pub all_features: bool,
    pub no_default_features: bool,
    pub release: bool,
    pub profile: Option<String>,
    pub target_triple: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusedCommandPlan {
    pub schema_version: u32,
    pub operation: CargoOperation,
    pub program: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub package: Option<String>,
    pub target: Option<FocusedTarget>,
    pub rationale: String,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FocusedTarget {
    pub name: String,
    pub kind: String,
}

pub fn plan_focused_command(
    query: &Path,
    operation: CargoOperation,
    options: &FocusedCommandOptions,
) -> Result<FocusedCommandPlan> {
    validate_options(options)?;
    let context = inspect_workspace(query)?;
    let package = context.selected_package.as_ref();
    let mut target = context.selected_target.as_ref();
    let mut warnings = context.warnings;

    if operation == CargoOperation::Run {
        target = select_runnable_target(package, target, &mut warnings)?;
    }

    let mut args = vec![operation.cargo_subcommand().to_owned()];
    if let Some(package) = package {
        args.extend(["-p".to_owned(), package.name.clone()]);
        append_target_scope(&mut args, operation, target, &mut warnings);
    } else {
        args.push("--workspace".to_owned());
    }

    let mut features = options
        .features
        .iter()
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .collect::<BTreeSet<_>>();
    if let Some(target) = target {
        features.extend(target.required_features.iter().cloned());
    }
    if options.all_features {
        args.push("--all-features".to_owned());
    } else if !features.is_empty() {
        args.extend([
            "--features".to_owned(),
            features.into_iter().collect::<Vec<_>>().join(","),
        ]);
    }
    if options.no_default_features {
        args.push("--no-default-features".to_owned());
    }
    if options.release {
        args.push("--release".to_owned());
    }
    if let Some(profile) = options.profile.as_deref() {
        args.extend(["--profile".to_owned(), profile.to_owned()]);
    }
    if let Some(target_triple) = options.target_triple.as_deref() {
        args.extend(["--target".to_owned(), target_triple.to_owned()]);
    }

    let rationale = match (package, target) {
        (Some(package), Some(target)) => format!(
            "Scope Cargo {} to package {:?} and its {} target {:?}; Tau must use Bash to execute this argv.",
            operation.cargo_subcommand(),
            package.name,
            target.kind,
            target.name
        ),
        (Some(package), None) => format!(
            "Scope Cargo {} to package {:?}; Tau must use Bash to execute this argv.",
            operation.cargo_subcommand(),
            package.name
        ),
        (None, _) => format!(
            "No package owns the requested path, so scope Cargo {} to the workspace; Tau must use Bash to execute this argv.",
            operation.cargo_subcommand()
        ),
    };

    Ok(FocusedCommandPlan {
        schema_version: SCHEMA_VERSION,
        operation,
        program: "cargo".to_owned(),
        args,
        cwd: context.workspace_root,
        package: package.map(|value| value.name.clone()),
        target: target.map(|value| FocusedTarget {
            name: value.name.clone(),
            kind: value.kind.clone(),
        }),
        rationale,
        warnings,
    })
}

fn validate_options(options: &FocusedCommandOptions) -> Result<()> {
    if options.release && options.profile.is_some() {
        return Err(Error::Usage(
            "--release and --profile are mutually exclusive".to_owned(),
        ));
    }
    if options.all_features && !options.features.is_empty() {
        return Err(Error::Usage(
            "--all-features and explicit --features are mutually exclusive".to_owned(),
        ));
    }
    if options.profile.as_deref().is_some_and(str::is_empty) {
        return Err(Error::Usage("--profile must not be empty".to_owned()));
    }
    if options.target_triple.as_deref().is_some_and(str::is_empty) {
        return Err(Error::Usage("--target must not be empty".to_owned()));
    }
    Ok(())
}

fn select_runnable_target<'a>(
    package: Option<&'a PackageContext>,
    selected: Option<&'a TargetContext>,
    warnings: &mut Vec<String>,
) -> Result<Option<&'a TargetContext>> {
    if selected.is_some_and(|target| matches!(target.kind.as_str(), "bin" | "example")) {
        return Ok(selected);
    }
    let Some(package) = package else {
        return Err(Error::Usage(
            "focused run requires a path owned by a Cargo package".to_owned(),
        ));
    };
    let runnable = package
        .targets
        .iter()
        .filter(|target| matches!(target.kind.as_str(), "bin" | "example"))
        .collect::<Vec<_>>();
    if runnable.len() == 1 {
        warnings.push(format!(
            "the requested path is not owned by a runnable target; selected the package's only {} target {:?}",
            runnable[0].kind, runnable[0].name
        ));
        return Ok(runnable.first().copied());
    }
    Err(Error::Usage(format!(
        "package {:?} has {} runnable targets; provide a path owned by the intended binary or example",
        package.name,
        runnable.len()
    )))
}

fn append_target_scope(
    args: &mut Vec<String>,
    operation: CargoOperation,
    target: Option<&TargetContext>,
    warnings: &mut Vec<String>,
) {
    let Some(target) = target else {
        return;
    };
    let supported = match operation {
        CargoOperation::Run => matches!(target.kind.as_str(), "bin" | "example"),
        CargoOperation::Doc => matches!(target.kind.as_str(), "lib" | "bin" | "example"),
        _ => true,
    };
    if supported {
        args.extend(target_selector(target));
    } else {
        warnings.push(format!(
            "Cargo {} does not accept a focused {} selector; kept package scope",
            operation.cargo_subcommand(),
            target.kind
        ));
    }
}
