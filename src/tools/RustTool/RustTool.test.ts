import assert from 'node:assert/strict'
import {
  resetSessionPowerModeForTesting,
  setSessionPowerMode,
} from '../../utils/powerMode.js'
import { zodToJsonSchema } from '../../utils/zodToJsonSchema.js'
import {
  RustTool,
  buildRustNativeInvocation,
  formatRustCapability,
  formatRustWorkspaceContext,
  isRustCapabilityEnabled,
} from './RustTool.js'
import { RUST_TOOL_ACTIONS } from './constants.js'

async function main(): Promise<void> {
  try {
    setSessionPowerMode('normal')
    assert.equal(isRustCapabilityEnabled(), false)
    setSessionPowerMode('cheap')
    assert.equal(isRustCapabilityEnabled(), false)
    setSessionPowerMode('rust')
    assert.equal(
      isRustCapabilityEnabled(),
      true,
      'Rust mode should expose the capability when the built helper exists',
    )

    assert.equal(RustTool.name, 'Rust')
    assert.equal(RustTool.shouldDefer, true)
    assert.equal(RustTool.isReadOnly(), true)
    assert.equal(RustTool.interruptBehavior(), 'cancel')

    const text = formatRustWorkspaceContext(
      JSON.stringify({
        workspaceRoot: '/work/demo',
        queryPath: '/work/demo/src/lib.rs',
        selectedPackage: {
          name: 'demo-core',
          version: '1.2.3',
          edition: '2024',
          rustVersion: '1.85',
          isDefaultMember: true,
          features: { default: ['std'], std: [] },
        },
        selectedTarget: {
          name: 'demo_core',
          kind: 'lib',
          requiredFeatures: ['std'],
        },
        packages: [{ name: 'demo-core' }, { name: 'demo-cli' }],
        warnings: [],
      }),
    )
    assert.match(text, /package demo-core/)
    assert.match(text, /edition 2024/)
    assert.doesNotMatch(text, /cargo check/)

    const command = formatRustCapability(
      'focused_command',
      JSON.stringify({
        program: 'cargo',
        args: ['clippy', '-p', 'demo-core', '--lib'],
        cwd: '/work/demo',
        rationale: 'Plan only; Bash executes.',
        warnings: [],
      }),
    )
    assert.match(command, /cargo clippy -p demo-core --lib/)
    assert.match(command, /Bash executes/)

    const diagnostics = formatRustCapability(
      'diagnostics',
      JSON.stringify({
        counts: { error: 1 },
        diagnostics: [
          {
            level: 'error',
            code: 'E0308',
            message: 'mismatched types',
            occurrences: 1,
            primarySpan: {
              file: 'src/lib.rs',
              lineStart: 4,
              columnStart: 7,
            },
            suggestions: [],
          },
        ],
        warnings: [],
      }),
    )
    assert.match(diagnostics, /error\[E0308\]/)
    assert.match(diagnostics, /src[/\\]lib.rs:4:7/)

    const minimalInputs = [
      { action: 'workspace_context' },
      { action: 'focused_command', operation: 'check' },
      { action: 'test_map', path: 'src/lib.rs' },
      { action: 'diagnostics', input: '{}' },
      { action: 'dependency_cost' },
      { action: 'artifact_size' },
      { action: 'profile_advice', goal: 'balanced' },
      { action: 'unsafe_audit' },
    ]
    assert.deepEqual(
      minimalInputs.map(input => RustTool.inputSchema.safeParse(input).success),
      RUST_TOOL_ACTIONS.map(() => true),
    )
    assert.equal(RUST_TOOL_ACTIONS.length, 8)
    const providerSchema = zodToJsonSchema(RustTool.inputSchema)
    const properties = providerSchema.properties as Record<
      string,
      Record<string, unknown>
    >
    assert.deepEqual(properties.action?.enum, RUST_TOOL_ACTIONS)
    assert.equal(providerSchema.anyOf, undefined)
    assert.equal(providerSchema.oneOf, undefined)
    assert.equal(
      RustTool.inputSchema.safeParse({
        action: 'dependency_cost',
        unknownField: true,
      }).success,
      false,
      'The compatibility schema must remain strict for truly unknown fields',
    )

    assert.deepEqual(
      buildRustNativeInvocation({
        action: 'dependency_cost',
        path: '/work/demo',
        targetTriple: 'x86_64-unknown-linux-gnu',
      }),
      {
        command: 'dependency-cost',
        args: ['--path', '/work/demo', '--pretty'],
      },
    )
    assert.deepEqual(
      buildRustNativeInvocation({
        action: 'dependency_cost',
        path: '/work/demo',
        limit: 10,
      }),
      {
        command: 'dependency-cost',
        args: ['--path', '/work/demo', '--pretty'],
      },
    )
    assert.deepEqual(
      buildRustNativeInvocation({
        action: 'profile_advice',
        path: '/work/demo',
        goal: 'runtime_performance',
        targetTriple: 'x86_64-unknown-linux-gnu',
      }),
      {
        command: 'profile-advice',
        args: [
          '--path',
          '/work/demo',
          '--goal',
          'runtime_performance',
          '--pretty',
        ],
      },
    )
    assert.deepEqual(
      buildRustNativeInvocation({
        action: 'profile_advice',
        path: '/work/demo',
        goal: 'runtime_performance',
        release: true,
        targetTriple: 'x86_64-unknown-linux-gnu',
      }),
      {
        command: 'profile-advice',
        args: [
          '--path',
          '/work/demo',
          '--goal',
          'runtime_performance',
          '--profile',
          'release',
          '--pretty',
        ],
      },
    )
    assert.deepEqual(
      buildRustNativeInvocation({
        action: 'unsafe_audit',
        path: '/work/demo/src',
        maxFiles: 50,
        targetTriple: 'x86_64-unknown-linux-gnu',
      }),
      {
        command: 'unsafe-audit',
        args: [
          '--path',
          '/work/demo/src',
          '--max-files',
          '50',
          '--pretty',
        ],
      },
    )
    assert.deepEqual(
      buildRustNativeInvocation({
        action: 'artifact_size',
        path: '/work/demo',
        profile: 'dev',
        release: true,
        targetTriple: 'aarch64-unknown-linux-gnu',
        limit: 5,
      }),
      {
        command: 'artifact-size',
        args: [
          '--path',
          '/work/demo',
          '--profile',
          'dev',
          '--target',
          'aarch64-unknown-linux-gnu',
          '--limit',
          '5',
          '--pretty',
        ],
      },
      'An explicit profile should win over the release shorthand',
    )
    assert.throws(
      () => buildRustNativeInvocation({ action: 'focused_command' }),
      /focused_command requires operation/,
    )
    assert.throws(
      () => buildRustNativeInvocation({ action: 'profile_advice' }),
      /profile_advice requires goal/,
    )
    assert.throws(
      () => buildRustNativeInvocation({ action: 'diagnostics' }),
      /diagnostics requires exactly one of path or input/,
    )

    const inlineDiagnosticUse = RustTool.renderToolUseMessage(
      { action: 'diagnostics', input: 'error: fixture failure' },
      { theme: 'dark', verbose: false },
    ) as unknown as { props: { children: string } }
    assert.equal(
      inlineDiagnosticUse.props.children,
      'Rust diagnostics captured compiler output',
    )

    const prompt = await RustTool.prompt()
    assert.match(prompt, /focused_command: produce exact Cargo argv/)
    assert.match(prompt, /diagnostics.*never invokes/)
    assert.match(prompt, /not a proof of soundness/)
    assert.match(prompt, /recognized fields owned by another action.*ignored/)
    assert.match(prompt, /Never pass a workspace\/source directory/)
    console.log('RustTool: all capability assertions passed')
  } finally {
    resetSessionPowerModeForTesting()
  }
}

await main()
