use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use syn::spanned::Spanned;
use syn::visit::{self, Visit};
use walkdir::{DirEntry, WalkDir};

use crate::error::{Error, Result};
use crate::workspace::{inspect_workspace, path_key};

const SCHEMA_VERSION: u32 = 1;
const DEFAULT_MAX_FILES: usize = 1_000;
const HARD_MAX_FILES: usize = 10_000;
const MAX_SOURCE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_FINDINGS: usize = 10_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsafeAuditReport {
    pub schema_version: u32,
    pub scan_root: PathBuf,
    pub scanned_files: usize,
    pub parsed_files: usize,
    pub findings: Vec<UnsafeFinding>,
    pub counts: BTreeMap<String, usize>,
    pub undocumented_unsafe: usize,
    pub truncated: bool,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsafeFinding {
    pub kind: String,
    pub risk: String,
    pub file: PathBuf,
    pub line: usize,
    pub column: usize,
    pub symbol: Option<String>,
    pub safety_documented: bool,
    pub detail: String,
}

pub fn audit_unsafe(query: &Path, max_files: Option<usize>) -> Result<UnsafeAuditReport> {
    let context = inspect_workspace(query)?;
    let scan_root = if query.is_file() {
        context.query_path.clone()
    } else if let Some(package) = context.selected_package.as_ref() {
        package.package_root.clone()
    } else {
        context.workspace_root.clone()
    };
    let limit = max_files
        .unwrap_or(DEFAULT_MAX_FILES)
        .clamp(1, HARD_MAX_FILES);
    let files = rust_files(&scan_root, &context.workspace_root, limit)?;
    let truncated = files.truncated;
    let mut findings = Vec::new();
    let mut warnings = context.warnings;
    let mut parsed_files = 0usize;
    for path in &files.paths {
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
        let source = match fs::read_to_string(path) {
            Ok(source) => source,
            Err(error) => {
                warnings.push(format!("could not read {}: {error}", path.display()));
                continue;
            }
        };
        let syntax = match syn::parse_file(&source) {
            Ok(syntax) => syntax,
            Err(error) => {
                warnings.push(format!("could not parse {}: {error}", path.display()));
                continue;
            }
        };
        parsed_files += 1;
        let mut visitor = UnsafeVisitor {
            file: path,
            source_lines: source.lines().collect(),
            symbol_stack: Vec::new(),
            findings: &mut findings,
        };
        visitor.visit_file(&syntax);
        if findings.len() >= MAX_FINDINGS {
            findings.truncate(MAX_FINDINGS);
            warnings.push(format!(
                "unsafe audit stopped collecting after {MAX_FINDINGS} findings"
            ));
            break;
        }
    }
    if truncated {
        warnings.push(format!("unsafe audit stopped after {limit} Rust files"));
    }
    warnings.push(
        "macro-expanded and build-script-generated unsafe or FFI code is not visible to this syntax-only audit"
            .to_owned(),
    );
    findings.sort_by(|left, right| {
        left.file
            .cmp(&right.file)
            .then(left.line.cmp(&right.line))
            .then(left.column.cmp(&right.column))
            .then(left.kind.cmp(&right.kind))
    });
    let mut counts = BTreeMap::new();
    for finding in &findings {
        *counts.entry(finding.kind.clone()).or_insert(0) += 1;
    }
    let undocumented_unsafe = findings
        .iter()
        .filter(|finding| {
            matches!(
                finding.kind.as_str(),
                "unsafe_block" | "unsafe_function" | "unsafe_impl" | "unsafe_trait" | "static_mut"
            ) && !finding.safety_documented
        })
        .count();

    Ok(UnsafeAuditReport {
        schema_version: SCHEMA_VERSION,
        scan_root,
        scanned_files: files.paths.len(),
        parsed_files,
        findings,
        counts,
        undocumented_unsafe,
        truncated,
        warnings,
    })
}

struct RustFiles {
    paths: Vec<PathBuf>,
    truncated: bool,
}

fn rust_files(scan_root: &Path, workspace_root: &Path, limit: usize) -> Result<RustFiles> {
    if scan_root.is_file() {
        if scan_root.extension().and_then(|value| value.to_str()) != Some("rs") {
            return Err(Error::Usage(format!(
                "unsafe-audit file input must end in .rs, got {}",
                scan_root.display()
            )));
        }
        return Ok(RustFiles {
            paths: vec![scan_root.to_path_buf()],
            truncated: false,
        });
    }
    let mut paths = Vec::new();
    let mut seen = BTreeSet::new();
    let mut truncated = false;
    for item in WalkDir::new(scan_root)
        .follow_links(false)
        .max_depth(32)
        .into_iter()
        .filter_entry(allow_source_entry)
    {
        let entry = item.map_err(|error| {
            Error::InvalidData(format!(
                "could not traverse {}: {error}",
                scan_root.display()
            ))
        })?;
        if !entry.file_type().is_file()
            || entry.path().extension().and_then(|value| value.to_str()) != Some("rs")
        {
            continue;
        }
        if !entry.path().starts_with(workspace_root) {
            continue;
        }
        if seen.insert(path_key(entry.path())) {
            if paths.len() >= limit {
                truncated = true;
                break;
            }
            paths.push(entry.path().to_path_buf());
        }
    }
    paths.sort();
    Ok(RustFiles { paths, truncated })
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

struct UnsafeVisitor<'a, 'source> {
    file: &'a Path,
    source_lines: Vec<&'source str>,
    symbol_stack: Vec<String>,
    findings: &'a mut Vec<UnsafeFinding>,
}

impl UnsafeVisitor<'_, '_> {
    fn record(
        &mut self,
        kind: &str,
        risk: &str,
        span: proc_macro2::Span,
        attributes: &[syn::Attribute],
        detail: &str,
    ) {
        if self.findings.len() >= MAX_FINDINGS {
            return;
        }
        let start = span.start();
        self.findings.push(UnsafeFinding {
            kind: kind.to_owned(),
            risk: risk.to_owned(),
            file: self.file.to_path_buf(),
            line: start.line,
            column: start.column.saturating_add(1),
            symbol: self.symbol_stack.last().cloned(),
            safety_documented: safety_documented(attributes, start.line, &self.source_lines),
            detail: detail.to_owned(),
        });
    }

    fn record_export_attributes(&mut self, attributes: &[syn::Attribute]) {
        for attribute in attributes {
            let name = attribute
                .path()
                .segments
                .iter()
                .map(|segment| segment.ident.to_string())
                .collect::<Vec<_>>()
                .join("::");
            if matches!(
                name.as_str(),
                "no_mangle" | "export_name" | "link_section" | "unsafe"
            ) {
                self.record(
                    "export_attribute",
                    "high",
                    attribute.span(),
                    attributes,
                    &format!("attribute {name:?} can expose or alter an ABI boundary"),
                );
            }
        }
    }
}

impl<'ast> Visit<'ast> for UnsafeVisitor<'_, '_> {
    fn visit_item_fn(&mut self, node: &'ast syn::ItemFn) {
        let symbol = node.sig.ident.to_string();
        self.symbol_stack.push(symbol);
        if node.sig.unsafety.is_some() {
            self.record(
                "unsafe_function",
                "high",
                node.sig.span(),
                &node.attrs,
                "unsafe function places proof obligations on every caller",
            );
        }
        if node.sig.abi.is_some() {
            self.record(
                "extern_function",
                "high",
                node.sig.span(),
                &node.attrs,
                "extern function crosses a language or binary interface",
            );
        }
        self.record_export_attributes(&node.attrs);
        visit::visit_item_fn(self, node);
        self.symbol_stack.pop();
    }

    fn visit_impl_item_fn(&mut self, node: &'ast syn::ImplItemFn) {
        let symbol = node.sig.ident.to_string();
        self.symbol_stack.push(symbol);
        if node.sig.unsafety.is_some() {
            self.record(
                "unsafe_function",
                "high",
                node.sig.span(),
                &node.attrs,
                "unsafe method places proof obligations on every caller",
            );
        }
        if node.sig.abi.is_some() {
            self.record(
                "extern_function",
                "high",
                node.sig.span(),
                &node.attrs,
                "extern method crosses a language or binary interface",
            );
        }
        self.record_export_attributes(&node.attrs);
        visit::visit_impl_item_fn(self, node);
        self.symbol_stack.pop();
    }

    fn visit_trait_item_fn(&mut self, node: &'ast syn::TraitItemFn) {
        let symbol = node.sig.ident.to_string();
        self.symbol_stack.push(symbol);
        if node.sig.unsafety.is_some() {
            self.record(
                "unsafe_function",
                "high",
                node.sig.span(),
                &node.attrs,
                "unsafe trait method places proof obligations on implementors or callers",
            );
        }
        visit::visit_trait_item_fn(self, node);
        self.symbol_stack.pop();
    }

    fn visit_expr_unsafe(&mut self, node: &'ast syn::ExprUnsafe) {
        self.record(
            "unsafe_block",
            "medium",
            node.unsafe_token.span,
            &node.attrs,
            "unsafe block locally opts out of compiler-checked safety guarantees",
        );
        visit::visit_expr_unsafe(self, node);
    }

    fn visit_item_trait(&mut self, node: &'ast syn::ItemTrait) {
        self.symbol_stack.push(node.ident.to_string());
        if node.unsafety.is_some() {
            self.record(
                "unsafe_trait",
                "high",
                node.span(),
                &node.attrs,
                "unsafe trait requires invariants the compiler cannot verify",
            );
        }
        visit::visit_item_trait(self, node);
        self.symbol_stack.pop();
    }

    fn visit_item_impl(&mut self, node: &'ast syn::ItemImpl) {
        if node.unsafety.is_some() {
            self.record(
                "unsafe_impl",
                "high",
                node.span(),
                &node.attrs,
                "unsafe impl promises that external safety invariants hold",
            );
        }
        visit::visit_item_impl(self, node);
    }

    fn visit_item_foreign_mod(&mut self, node: &'ast syn::ItemForeignMod) {
        self.record(
            "extern_block",
            "high",
            node.span(),
            &node.attrs,
            "extern block declares symbols whose ABI and validity Rust cannot verify",
        );
        visit::visit_item_foreign_mod(self, node);
    }

    fn visit_item_static(&mut self, node: &'ast syn::ItemStatic) {
        if matches!(node.mutability, syn::StaticMutability::Mut(_)) {
            self.symbol_stack.push(node.ident.to_string());
            self.record(
                "static_mut",
                "high",
                node.span(),
                &node.attrs,
                "mutable static state permits unsynchronized global mutation",
            );
            self.symbol_stack.pop();
        }
        visit::visit_item_static(self, node);
    }

    fn visit_item_struct(&mut self, node: &'ast syn::ItemStruct) {
        if let Some(representation) = ffi_representation(&node.attrs) {
            self.symbol_stack.push(node.ident.to_string());
            self.record(
                "ffi_layout",
                "medium",
                node.span(),
                &node.attrs,
                &format!("{representation} fixes or constrains memory layout across boundaries"),
            );
            self.symbol_stack.pop();
        }
        visit::visit_item_struct(self, node);
    }

    fn visit_item_enum(&mut self, node: &'ast syn::ItemEnum) {
        if let Some(representation) = ffi_representation(&node.attrs) {
            self.symbol_stack.push(node.ident.to_string());
            self.record(
                "ffi_layout",
                "medium",
                node.span(),
                &node.attrs,
                &format!("{representation} fixes or constrains memory layout across boundaries"),
            );
            self.symbol_stack.pop();
        }
        visit::visit_item_enum(self, node);
    }

    fn visit_item_union(&mut self, node: &'ast syn::ItemUnion) {
        self.symbol_stack.push(node.ident.to_string());
        self.record(
            "union",
            "high",
            node.span(),
            &node.attrs,
            "union fields overlap and reading a field requires the active representation invariant",
        );
        visit::visit_item_union(self, node);
        self.symbol_stack.pop();
    }
}

fn ffi_representation(attributes: &[syn::Attribute]) -> Option<String> {
    attributes.iter().find_map(|attribute| {
        if !attribute.path().is_ident("repr") {
            return None;
        }
        let syn::Meta::List(list) = &attribute.meta else {
            return None;
        };
        let representation = list.tokens.to_string();
        let compact = representation.replace(' ', "").to_ascii_lowercase();
        (compact.contains('c') || compact.contains("transparent") || compact.contains("packed"))
            .then(|| format!("repr({representation})"))
    })
}

fn safety_documented(attributes: &[syn::Attribute], line: usize, source: &[&str]) -> bool {
    let documented = attributes.iter().any(|attribute| {
        if !attribute.path().is_ident("doc") {
            return false;
        }
        let syn::Meta::NameValue(value) = &attribute.meta else {
            return false;
        };
        let syn::Expr::Lit(value) = &value.value else {
            return false;
        };
        let syn::Lit::Str(value) = &value.lit else {
            return false;
        };
        let text = value.value().to_ascii_lowercase();
        text.contains("# safety") || text.contains("safety:")
    });
    if documented {
        return true;
    }
    let end = line.saturating_sub(1).min(source.len());
    let start = end.saturating_sub(5);
    for line in source[start..end].iter().rev() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !trimmed.starts_with("//") && !trimmed.starts_with("/*") && !trimmed.starts_with('*') {
            break;
        }
        let lower = trimmed.to_ascii_lowercase();
        if lower.contains("safety:") || lower.contains("# safety") {
            return true;
        }
    }
    false
}
