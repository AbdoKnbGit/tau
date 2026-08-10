export const RUST_TOOL_NAME = 'Rust'

export const RUST_REQUEST_EFFICIENCY_GUIDANCE =
  'Plan Rust capability calls across the whole request before invoking them. Reuse a successful result whenever it already answers a later subquestion; do not repeat an action merely to restate that result in another section. If one workspace overview also needs selected package, target, edition, or feature metadata, call workspace_context once with the most specific relevant path instead of calling it at both workspace and file scope. If paths must be evaluated independently, call change_impact separately for each path (in parallel when available); never batch independent classifications because a multi-path call intentionally returns their union. Make one additional multi-path call only when combined impact is also requested. For a determinism check while the inputs and workspace are unchanged, an earlier identical result is the first sample: repeat it exactly once and compare stable fields, so the same input is not called three times. In the final response, print each unique Cargo program plus argv once, give it a short label, and refer to that label later; summarize package ranges only in prose and never alter or abbreviate argv.'

export const RUST_TOOL_ACTIONS = [
  'workspace_context',
  'focused_command',
  'test_map',
  'diagnostics',
  'dependency_cost',
  'artifact_size',
  'profile_advice',
  'unsafe_audit',
  'generated_code_map',
  'build_environment',
  'change_impact',
] as const
