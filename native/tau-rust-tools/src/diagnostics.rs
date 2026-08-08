use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use crate::error::{Error, Result};

const SCHEMA_VERSION: u32 = 1;
const MAX_INPUT_BYTES: usize = 8 * 1024 * 1024;
const DEFAULT_MAX_ITEMS: usize = 200;
const HARD_MAX_ITEMS: usize = 2_000;
const MAX_RENDERED_CHARS: usize = 2_000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsReport {
    pub schema_version: u32,
    pub source: String,
    pub counts: BTreeMap<String, usize>,
    pub diagnostics: Vec<Diagnostic>,
    pub omitted: usize,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub level: String,
    pub code: Option<String>,
    pub message: String,
    pub primary_span: Option<DiagnosticSpan>,
    pub suggestions: Vec<DiagnosticSuggestion>,
    pub rendered: Option<String>,
    pub occurrences: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticSpan {
    pub file: PathBuf,
    pub line_start: usize,
    pub column_start: usize,
    pub line_end: usize,
    pub column_end: usize,
    pub label: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticSuggestion {
    pub file: PathBuf,
    pub line_start: usize,
    pub column_start: usize,
    pub line_end: usize,
    pub column_end: usize,
    pub replacement: String,
    pub applicability: Option<String>,
    pub message: Option<String>,
}

pub fn parse_diagnostics(input: &str, max_items: Option<usize>) -> Result<DiagnosticsReport> {
    if input.len() > MAX_INPUT_BYTES {
        return Err(Error::Usage(format!(
            "diagnostic input exceeds the {MAX_INPUT_BYTES}-byte limit"
        )));
    }
    let limit = max_items
        .unwrap_or(DEFAULT_MAX_ITEMS)
        .clamp(1, HARD_MAX_ITEMS);
    let mut diagnostics = Vec::<Diagnostic>::new();
    let mut dedup = BTreeMap::<String, usize>::new();
    let mut ignored_json_lines = 0usize;
    let mut plain_candidates = 0usize;

    for line in input.lines().filter(|line| !line.trim().is_empty()) {
        match serde_json::from_str::<Value>(line) {
            Ok(value) => {
                let message =
                    if value.get("reason").and_then(Value::as_str) == Some("compiler-message") {
                        value.get("message")
                    } else if value.get("level").is_some() && value.get("message").is_some() {
                        Some(&value)
                    } else {
                        None
                    };
                if let Some(message) = message.and_then(parse_message) {
                    insert_diagnostic(&mut diagnostics, &mut dedup, message);
                } else {
                    ignored_json_lines += 1;
                }
            }
            Err(_) => {
                if let Some(diagnostic) = parse_plain_line(line) {
                    plain_candidates += 1;
                    insert_diagnostic(&mut diagnostics, &mut dedup, diagnostic);
                }
            }
        }
    }

    let mut counts = BTreeMap::new();
    for diagnostic in &diagnostics {
        *counts.entry(diagnostic.level.clone()).or_insert(0) += diagnostic.occurrences;
    }
    diagnostics.sort_by(|left, right| {
        level_rank(&left.level)
            .cmp(&level_rank(&right.level))
            .then_with(|| span_key(&left.primary_span).cmp(&span_key(&right.primary_span)))
            .then_with(|| left.message.cmp(&right.message))
    });
    let omitted = diagnostics.len().saturating_sub(limit);
    diagnostics.truncate(limit);

    let mut warnings = Vec::new();
    if ignored_json_lines > 0 {
        warnings.push(format!(
            "ignored {ignored_json_lines} JSON messages that were not compiler diagnostics"
        ));
    }
    if plain_candidates > 0 {
        warnings.push(
            "plain-text diagnostics have no reliable span or suggestion metadata; prefer Cargo --message-format=json"
                .to_owned(),
        );
    }
    if omitted > 0 {
        warnings.push(format!("omitted {omitted} diagnostics after deduplication"));
    }

    Ok(DiagnosticsReport {
        schema_version: SCHEMA_VERSION,
        source: if plain_candidates > 0 {
            "mixed_or_text"
        } else {
            "rustc_json"
        }
        .to_owned(),
        counts,
        diagnostics,
        omitted,
        warnings,
    })
}

pub fn parse_diagnostics_file(path: &Path, max_items: Option<usize>) -> Result<DiagnosticsReport> {
    let metadata = fs::metadata(path).map_err(|source| Error::Io {
        operation: "inspect diagnostic input",
        path: path.to_path_buf(),
        source,
    })?;
    if !metadata.is_file() {
        let path_kind = if metadata.is_dir() {
            "a directory"
        } else {
            "a non-regular file"
        };
        return Err(Error::Usage(format!(
            "diagnostics --file expects a regular file containing existing rustc or Clippy output; received {path_kind}: {}. Use --stdin for captured diagnostic text",
            path.display()
        )));
    }
    if metadata.len() > MAX_INPUT_BYTES as u64 {
        return Err(Error::Usage(format!(
            "diagnostic file exceeds the {MAX_INPUT_BYTES}-byte limit"
        )));
    }
    let input = fs::read_to_string(path).map_err(|source| Error::Io {
        operation: "read diagnostic input",
        path: path.to_path_buf(),
        source,
    })?;
    let mut report = parse_diagnostics(&input, max_items)?;
    report.source = path.to_string_lossy().into_owned();
    Ok(report)
}

fn parse_message(value: &Value) -> Option<Diagnostic> {
    let level = value.get("level")?.as_str()?.to_owned();
    let message = value.get("message")?.as_str()?.to_owned();
    let code = value.get("code").and_then(|code| {
        code.as_str()
            .or_else(|| code.get("code").and_then(Value::as_str))
            .map(ToOwned::to_owned)
    });
    let spans = value
        .get("spans")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let primary = spans
        .iter()
        .find(|span| span.get("is_primary").and_then(Value::as_bool) == Some(true))
        .or_else(|| spans.first())
        .and_then(parse_span);
    let mut suggestions = Vec::new();
    collect_suggestions(spans, None, &mut suggestions);
    if let Some(children) = value.get("children").and_then(Value::as_array) {
        for child in children {
            let child_message = child
                .get("message")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            if let Some(spans) = child.get("spans").and_then(Value::as_array) {
                collect_suggestions(spans, child_message, &mut suggestions);
            }
        }
    }
    let mut seen = BTreeSet::new();
    suggestions.retain(|suggestion| {
        seen.insert(format!(
            "{}:{}:{}:{}",
            suggestion.file.display(),
            suggestion.line_start,
            suggestion.column_start,
            suggestion.replacement
        ))
    });
    let rendered = value
        .get("rendered")
        .and_then(Value::as_str)
        .map(|text| truncate_chars(text.trim(), MAX_RENDERED_CHARS));
    Some(Diagnostic {
        level,
        code,
        message,
        primary_span: primary,
        suggestions,
        rendered,
        occurrences: 1,
    })
}

fn parse_span(value: &Value) -> Option<DiagnosticSpan> {
    Some(DiagnosticSpan {
        file: PathBuf::from(value.get("file_name")?.as_str()?),
        line_start: value.get("line_start")?.as_u64()? as usize,
        column_start: value.get("column_start")?.as_u64()? as usize,
        line_end: value.get("line_end")?.as_u64()? as usize,
        column_end: value.get("column_end")?.as_u64()? as usize,
        label: value
            .get("label")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
    })
}

fn collect_suggestions(
    spans: &[Value],
    message: Option<String>,
    output: &mut Vec<DiagnosticSuggestion>,
) {
    for span in spans {
        let Some(replacement) = span.get("suggested_replacement").and_then(Value::as_str) else {
            continue;
        };
        let Some(parsed) = parse_span(span) else {
            continue;
        };
        output.push(DiagnosticSuggestion {
            file: parsed.file,
            line_start: parsed.line_start,
            column_start: parsed.column_start,
            line_end: parsed.line_end,
            column_end: parsed.column_end,
            replacement: replacement.to_owned(),
            applicability: span
                .get("suggestion_applicability")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned),
            message: message.clone().or(parsed.label),
        });
    }
}

fn parse_plain_line(line: &str) -> Option<Diagnostic> {
    let trimmed = line.trim();
    let (level, message) = ["error", "warning", "note", "help"]
        .into_iter()
        .find_map(|level| {
            let rest = trimmed.strip_prefix(level)?;
            let message = if let Some(message) = rest.strip_prefix(':') {
                message.trim()
            } else {
                let coded = rest.strip_prefix('[')?;
                coded
                    .split_once("]:")
                    .map(|(_, message)| message.trim())
                    .unwrap_or(coded.trim())
            };
            Some((level, message))
        })?;
    Some(Diagnostic {
        level: level.to_owned(),
        code: None,
        message: if message.is_empty() {
            trimmed.to_owned()
        } else {
            message.to_owned()
        },
        primary_span: None,
        suggestions: Vec::new(),
        rendered: None,
        occurrences: 1,
    })
}

fn insert_diagnostic(
    diagnostics: &mut Vec<Diagnostic>,
    dedup: &mut BTreeMap<String, usize>,
    diagnostic: Diagnostic,
) {
    let key = format!(
        "{}\u{0}{}\u{0}{}\u{0}{}",
        diagnostic.level,
        diagnostic.code.as_deref().unwrap_or_default(),
        diagnostic.message,
        span_key(&diagnostic.primary_span)
    );
    if let Some(index) = dedup.get(&key).copied() {
        diagnostics[index].occurrences += 1;
    } else {
        dedup.insert(key, diagnostics.len());
        diagnostics.push(diagnostic);
    }
}

fn span_key(span: &Option<DiagnosticSpan>) -> String {
    span.as_ref()
        .map(|span| {
            format!(
                "{}:{}:{}",
                span.file.display(),
                span.line_start,
                span.column_start
            )
        })
        .unwrap_or_default()
}

fn level_rank(level: &str) -> usize {
    match level {
        "error" => 0,
        "warning" => 1,
        "failure-note" => 2,
        "note" => 3,
        "help" => 4,
        _ => 5,
    }
}

fn truncate_chars(value: &str, max: usize) -> String {
    let mut chars = value.chars();
    let truncated = chars.by_ref().take(max).collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}
