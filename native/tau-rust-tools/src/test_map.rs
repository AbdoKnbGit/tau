use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};

use crate::error::{Error, Result};
use crate::workspace::inspect_workspace;

const SCHEMA_VERSION: u32 = 1;
const MAX_SOURCE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_TESTS: usize = 1_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestMap {
    pub schema_version: u32,
    pub query_path: PathBuf,
    pub package: String,
    pub target: Option<TestTarget>,
    pub scope: String,
    pub tests: Vec<TestCase>,
    pub has_doc_examples: bool,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestTarget {
    pub name: String,
    pub kind: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestCase {
    pub name: String,
    pub line: usize,
    pub framework: String,
    pub suggested_filter: String,
}

pub fn map_tests(query: &Path, include_doc_tests: bool) -> Result<TestMap> {
    if !query.is_file() {
        return Err(Error::Usage(format!(
            "test-map requires an existing Rust source file, got {}",
            query.display()
        )));
    }
    if query.extension().and_then(|value| value.to_str()) != Some("rs") {
        return Err(Error::Usage(format!(
            "test-map only accepts .rs source files, got {}",
            query.display()
        )));
    }
    let metadata = fs::metadata(query).map_err(|source| Error::Io {
        operation: "inspect Rust source metadata",
        path: query.to_path_buf(),
        source,
    })?;
    if metadata.len() > MAX_SOURCE_BYTES {
        return Err(Error::Usage(format!(
            "Rust source exceeds the {MAX_SOURCE_BYTES}-byte test-map limit"
        )));
    }
    let source = fs::read_to_string(query).map_err(|source| Error::Io {
        operation: "read Rust source",
        path: query.to_path_buf(),
        source,
    })?;
    let syntax = syn::parse_file(&source).map_err(|error| {
        Error::InvalidData(format!(
            "could not parse {} as Rust: {error}",
            query.display()
        ))
    })?;
    let context = inspect_workspace(query)?;
    let package = context.selected_package.ok_or_else(|| {
        Error::Usage(format!(
            "no Cargo package owns Rust source {}",
            query.display()
        ))
    })?;
    let target = context.selected_target.map(|value| TestTarget {
        name: value.name,
        kind: value.kind,
    });
    let scope = match target.as_ref().map(|value| value.kind.as_str()) {
        Some("test") => "integration_test",
        Some("bench") => "benchmark_harness",
        Some("example") => "example_target",
        Some("bin") => "binary_unit_tests",
        Some("lib") => "library_unit_tests",
        _ => "package_tests",
    }
    .to_owned();

    let mut collector = TestCollector::default();
    collector.visit_file(&syntax);
    let mut warnings = context.warnings;
    if collector.truncated {
        warnings.push(format!(
            "test discovery stopped after {MAX_TESTS} functions"
        ));
    }
    warnings.push(
        "macro-generated and dynamically registered tests cannot be enumerated without expansion"
            .to_owned(),
    );

    Ok(TestMap {
        schema_version: SCHEMA_VERSION,
        query_path: context.query_path,
        package: package.name,
        target,
        scope,
        tests: collector.tests,
        has_doc_examples: include_doc_tests && contains_rust_doc_fence(&source),
        warnings,
    })
}

#[derive(Default)]
struct TestCollector {
    modules: Vec<String>,
    tests: Vec<TestCase>,
    truncated: bool,
}

impl TestCollector {
    fn record(&mut self, function: &syn::ItemFn) {
        if self.tests.len() >= MAX_TESTS {
            self.truncated = true;
            return;
        }
        let Some(framework) = test_framework(&function.attrs) else {
            return;
        };
        let mut segments = self.modules.clone();
        segments.push(function.sig.ident.to_string());
        let name = segments.join("::");
        self.tests.push(TestCase {
            suggested_filter: name.clone(),
            name,
            line: function.span().start().line,
            framework,
        });
    }
}

impl<'ast> Visit<'ast> for TestCollector {
    fn visit_item_fn(&mut self, node: &'ast syn::ItemFn) {
        self.record(node);
        visit::visit_item_fn(self, node);
    }

    fn visit_item_mod(&mut self, node: &'ast syn::ItemMod) {
        if node.content.is_some() {
            self.modules.push(node.ident.to_string());
            visit::visit_item_mod(self, node);
            self.modules.pop();
        }
    }
}

fn test_framework(attributes: &[syn::Attribute]) -> Option<String> {
    const TEST_ATTRIBUTES: &[&str] = &[
        "test",
        "tokio::test",
        "async_std::test",
        "rstest",
        "rstest::rstest",
        "test_case",
        "test_case::test_case",
    ];
    attributes.iter().find_map(|attribute| {
        let name = attribute
            .path()
            .segments
            .iter()
            .map(|segment| segment.ident.to_string())
            .collect::<Vec<_>>()
            .join("::");
        TEST_ATTRIBUTES.contains(&name.as_str()).then_some(name)
    })
}

fn contains_rust_doc_fence(source: &str) -> bool {
    source.lines().any(|line| {
        let trimmed = line.trim_start();
        (trimmed.starts_with("///") || trimmed.starts_with("//!")) && trimmed.contains("```")
    })
}
