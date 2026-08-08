use std::env;
use std::io::{self, Read};
use std::path::PathBuf;

use clap::{Args, Parser, Subcommand};
use serde::Serialize;
use tau_rust_tools::{
    advise_profile, analyze_change_impact, analyze_dependency_cost, audit_unsafe,
    inspect_artifact_sizes, inspect_build_environment, inspect_workspace, map_generated_code,
    map_tests, parse_diagnostics, parse_diagnostics_file, plan_focused_command, CargoOperation,
    Error, FocusedCommandOptions, ProfileGoal, Result,
};

const MAX_DIAGNOSTIC_STDIN_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Debug, Parser)]
#[command(
    name = "tau-rust-tools",
    version,
    about = "Stateless native Rust capabilities for Tau",
    long_about = "Stateless, read-only Rust analysis and Cargo command planning for Tau. Workspace discovery is filesystem-only and never launches Cargo or Rustup. This binary never edits source or manifests, resolves dependencies, or runs builds, tests, Clippy, or profilers."
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Inspect Cargo workspace, package, target, feature, edition, and MSRV context.
    WorkspaceContext(PathOptions),
    /// Plan an argv-safe, narrowly scoped Cargo command without executing it.
    #[command(name = "focused-command")]
    Focused(FocusedCommandArgs),
    /// Map one Rust source file to its Cargo test scope and declared test functions.
    TestMap(TestMapArgs),
    /// Parse existing rustc or Clippy JSON diagnostics without invoking Cargo.
    Diagnostics(DiagnosticsArgs),
    /// Analyze an existing Cargo.lock graph without resolving or fetching dependencies.
    DependencyCost(PathOptions),
    /// Measure existing target artifacts without building them.
    ArtifactSize(ArtifactSizeArgs),
    /// Compare Cargo profile settings with a stated optimization goal.
    ProfileAdvice(ProfileAdviceArgs),
    /// Parse Rust syntax to inventory unsafe, FFI, and exported ABI surfaces.
    UnsafeAudit(UnsafeAuditArgs),
    /// Map generated Rust consumers, build scripts, generator inputs, and generated-file markers.
    GeneratedCodeMap(GeneratedCodeMapArgs),
    /// Explain workspace-scoped Cargo, target, toolchain, wrapper, and Rust flag resolution.
    BuildEnvironment(BuildEnvironmentArgs),
    /// Map changed paths to affected local packages and focused Cargo validation argv.
    ChangeImpact(ChangeImpactArgs),
}

#[derive(Clone, Debug, Args)]
struct PathOptions {
    /// Rust file, Cargo.toml, or directory. Defaults to the current directory.
    #[arg(long)]
    path: Option<PathBuf>,
    /// Pretty-print JSON output.
    #[arg(long)]
    pretty: bool,
}

#[derive(Debug, Args)]
struct FocusedCommandArgs {
    #[command(flatten)]
    common: PathOptions,
    /// Cargo operation: check, build, clippy, test, bench, doc, or run. Defaults to check.
    #[arg(long, default_value = "check")]
    operation: String,
    /// Features to add, as a comma-delimited list. May be repeated.
    #[arg(long, value_delimiter = ',')]
    features: Vec<String>,
    #[arg(long, conflicts_with = "features")]
    all_features: bool,
    #[arg(long)]
    no_default_features: bool,
    #[arg(long, conflicts_with = "profile")]
    release: bool,
    #[arg(long)]
    profile: Option<String>,
    /// Rust target triple passed to Cargo as a separate argv value.
    #[arg(long = "target")]
    target_triple: Option<String>,
}

#[derive(Debug, Args)]
struct TestMapArgs {
    #[command(flatten)]
    common: PathOptions,
    /// Detect fenced examples in Rust doc comments.
    #[arg(long, default_value_t = true, action = clap::ArgAction::Set)]
    include_doc_tests: bool,
}

#[derive(Debug, Args)]
struct DiagnosticsArgs {
    /// Read newline-delimited diagnostic output from this existing file.
    #[arg(long, conflicts_with = "stdin")]
    file: Option<PathBuf>,
    /// Read newline-delimited diagnostic output from standard input.
    #[arg(long, conflicts_with = "file")]
    stdin: bool,
    /// Maximum number of deduplicated diagnostic records to return.
    #[arg(long)]
    max_items: Option<usize>,
    #[arg(long)]
    pretty: bool,
}

#[derive(Debug, Args)]
struct ArtifactSizeArgs {
    #[command(flatten)]
    common: PathOptions,
    /// Existing Cargo profile directory, such as debug or release.
    #[arg(long)]
    profile: Option<String>,
    /// Rust target triple. Existing explicit-target output wins; native builds fall back to target/<profile>.
    #[arg(long = "target")]
    target_triple: Option<String>,
    /// Maximum number of top artifacts and duplicate groups to return.
    #[arg(long)]
    limit: Option<usize>,
}

#[derive(Debug, Args)]
struct ProfileAdviceArgs {
    #[command(flatten)]
    common: PathOptions,
    /// Goal: balanced, dev_speed, release_size, runtime_performance, or compile_time. Defaults to balanced.
    #[arg(long, default_value = "balanced")]
    goal: String,
    /// Cargo profile to assess. Defaults according to the selected goal.
    #[arg(long)]
    profile: Option<String>,
}

#[derive(Debug, Args)]
struct UnsafeAuditArgs {
    #[command(flatten)]
    common: PathOptions,
    /// Maximum number of Rust files to parse.
    #[arg(long)]
    max_files: Option<usize>,
}

#[derive(Debug, Args)]
struct GeneratedCodeMapArgs {
    #[command(flatten)]
    common: PathOptions,
    /// Maximum number of Rust files to parse.
    #[arg(long)]
    max_files: Option<usize>,
}

#[derive(Debug, Args)]
struct BuildEnvironmentArgs {
    #[command(flatten)]
    common: PathOptions,
    /// Target triple whose exact linker, runner, and rustflags settings should be selected.
    #[arg(long = "target")]
    target_triple: Option<String>,
}

#[derive(Debug, Args)]
struct ChangeImpactArgs {
    #[command(flatten)]
    common: PathOptions,
    /// Workspace-relative or absolute changed path. May be repeated; omitted means whole workspace.
    #[arg(long = "changed-path")]
    changed_paths: Vec<PathBuf>,
}

fn main() {
    let cli = match Cli::try_parse() {
        Ok(cli) => cli,
        Err(error) => error.exit(),
    };
    if let Err(error) = run(cli) {
        eprintln!("tau-rust-tools: {error}");
        std::process::exit(error.exit_code());
    }
}

fn run(cli: Cli) -> Result<()> {
    match cli.command {
        Command::WorkspaceContext(options) => {
            let value = inspect_workspace(&query_path(options.path)?)?;
            print_json(&value, options.pretty)
        }
        Command::Focused(arguments) => {
            let operation = CargoOperation::parse(&arguments.operation)?;
            let options = FocusedCommandOptions {
                features: arguments.features,
                all_features: arguments.all_features,
                no_default_features: arguments.no_default_features,
                release: arguments.release,
                profile: arguments.profile,
                target_triple: arguments.target_triple,
            };
            let value =
                plan_focused_command(&query_path(arguments.common.path)?, operation, &options)?;
            print_json(&value, arguments.common.pretty)
        }
        Command::TestMap(arguments) => {
            let value = map_tests(
                &query_path(arguments.common.path)?,
                arguments.include_doc_tests,
            )?;
            print_json(&value, arguments.common.pretty)
        }
        Command::Diagnostics(arguments) => {
            let value = if let Some(path) = arguments.file {
                parse_diagnostics_file(&path, arguments.max_items)?
            } else if arguments.stdin {
                let mut input = String::new();
                io::stdin()
                    .take(MAX_DIAGNOSTIC_STDIN_BYTES + 1)
                    .read_to_string(&mut input)
                    .map_err(|source| Error::Io {
                        operation: "read diagnostic standard input",
                        path: PathBuf::from("<stdin>"),
                        source,
                    })?;
                parse_diagnostics(&input, arguments.max_items)?
            } else {
                return Err(Error::Usage(
                    "diagnostics requires exactly one of --file <PATH> or --stdin".to_owned(),
                ));
            };
            print_json(&value, arguments.pretty)
        }
        Command::DependencyCost(options) => {
            let value = analyze_dependency_cost(&query_path(options.path)?)?;
            print_json(&value, options.pretty)
        }
        Command::ArtifactSize(arguments) => {
            let value = inspect_artifact_sizes(
                &query_path(arguments.common.path)?,
                arguments.profile.as_deref(),
                arguments.target_triple.as_deref(),
                arguments.limit,
            )?;
            print_json(&value, arguments.common.pretty)
        }
        Command::ProfileAdvice(arguments) => {
            let value = advise_profile(
                &query_path(arguments.common.path)?,
                ProfileGoal::parse(&arguments.goal)?,
                arguments.profile.as_deref(),
            )?;
            print_json(&value, arguments.common.pretty)
        }
        Command::UnsafeAudit(arguments) => {
            let value = audit_unsafe(&query_path(arguments.common.path)?, arguments.max_files)?;
            print_json(&value, arguments.common.pretty)
        }
        Command::GeneratedCodeMap(arguments) => {
            let value =
                map_generated_code(&query_path(arguments.common.path)?, arguments.max_files)?;
            print_json(&value, arguments.common.pretty)
        }
        Command::BuildEnvironment(arguments) => {
            let value = inspect_build_environment(
                &query_path(arguments.common.path)?,
                arguments.target_triple.as_deref(),
            )?;
            print_json(&value, arguments.common.pretty)
        }
        Command::ChangeImpact(arguments) => {
            let value = analyze_change_impact(
                &query_path(arguments.common.path)?,
                &arguments.changed_paths,
            )?;
            print_json(&value, arguments.common.pretty)
        }
    }
}

fn query_path(path: Option<PathBuf>) -> Result<PathBuf> {
    path.map(Ok).unwrap_or_else(|| {
        env::current_dir().map_err(|source| Error::Io {
            operation: "read current directory",
            path: PathBuf::from("."),
            source,
        })
    })
}

fn print_json(value: &impl Serialize, pretty: bool) -> Result<()> {
    if pretty {
        println!("{}", serde_json::to_string_pretty(value)?);
    } else {
        println!("{}", serde_json::to_string(value)?);
    }
    Ok(())
}
