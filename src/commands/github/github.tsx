import { execFile } from 'child_process'
import * as React from 'react'
import { useEffect, useState } from 'react'
import { promisify } from 'util'
import { Select } from '../../components/CustomSelect/index.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import type {
  LocalJSXCommandOnDone,
  LocalJSXCommandContext,
} from '../../types/command.js'
import { HELP_TEXT, type Subcommand } from './prompts.js'

const execFileP = promisify(execFile)

type WizardProps = {
  onDone: LocalJSXCommandOnDone
}

type Step =
  | { kind: 'subcommand' }
  | { kind: 'issue-source'; sub: 'issue' | 'pr' }
  | { kind: 'wrap-branch' }
  | { kind: 'wrap-issue'; branch: string }
  | { kind: 'wrap-instructions'; branch: string; issueNum: string }
  | { kind: 'release-version' }
  | { kind: 'confirm'; sub: 'changelog' | 'triage' }

const SUBCOMMAND_OPTIONS: ReadonlyArray<{
  value: Subcommand | 'cancel'
  label: string
  description: string
}> = [
  {
    value: 'issue',
    label: 'issue',
    description: 'Investigate a GitHub issue and propose a fix',
  },
  {
    value: 'pr',
    label: 'pr',
    description: 'Review a pull request — Good / Bad / Ugly',
  },
  {
    value: 'wrap',
    label: 'wrap',
    description: 'Commit, push, link to issue, update changelog',
  },
  {
    value: 'changelog',
    label: 'changelog',
    description: 'Audit git history and draft changelog notes',
  },
  {
    value: 'triage',
    label: 'triage',
    description: 'Label, deduplicate, and assign open issues',
  },
  {
    value: 'release',
    label: 'release',
    description: 'Tag, push, publish a GitHub release, trigger deployment',
  },
  { value: 'cancel', label: 'Cancel', description: 'Close the picker' },
]

type BranchEntry = { name: string; relDate: string; subject: string }

async function loadRecentBranches(): Promise<{
  branches: BranchEntry[]
  current: string | null
  error?: string
}> {
  try {
    const [{ stdout: branchesRaw }, { stdout: currentRaw }] = await Promise.all([
      execFileP('git', [
        'branch',
        '--sort=-committerdate',
        '--format=%(refname:short)\t%(committerdate:relative)\t%(contents:subject)',
      ]),
      execFileP('git', ['branch', '--show-current']),
    ])
    const current = currentRaw.trim() || null
    const branches: BranchEntry[] = branchesRaw
      .split('\n')
      .map(line => {
        const [name, relDate, subject] = line.split('\t')
        if (!name) return null
        return {
          name: name.trim(),
          relDate: (relDate ?? '').trim(),
          subject: (subject ?? '').trim(),
        }
      })
      .filter((b): b is BranchEntry => b !== null)
      .slice(0, 12)
    return { branches, current }
  } catch (err) {
    return {
      branches: [],
      current: null,
      error: (err as Error).message,
    }
  }
}

function formatBranchDescription(b: BranchEntry): string {
  if (!b.relDate && !b.subject) return ''
  if (!b.subject) return b.relDate
  if (!b.relDate) return b.subject
  return `${b.relDate} · ${b.subject}`
}

function GithubWizard({ onDone }: WizardProps): React.ReactNode {
  const [step, setStep] = useState<Step>({ kind: 'subcommand' })
  const [branchData, setBranchData] = useState<{
    branches: BranchEntry[]
    current: string | null
    error?: string
  } | null>(null)
  const [branchInput, setBranchInput] = useState('')
  const [issueInput, setIssueInput] = useState('')
  const [instructionsInput, setInstructionsInput] = useState('')
  const [versionInput, setVersionInput] = useState('')

  useKeybinding(
    'confirm:no',
    () => {
      onDone('Cancelled /github', { display: 'system' })
    },
    { context: 'Settings' },
  )

  useEffect(() => {
    if (step.kind === 'wrap-branch' && branchData === null) {
      let alive = true
      void loadRecentBranches().then(data => {
        if (alive) setBranchData(data)
      })
      return () => {
        alive = false
      }
    }
  }, [step.kind, branchData])

  function submit(sub: Subcommand, args: string): void {
    const payload = args ? `/github-run ${sub} ${args}` : `/github-run ${sub}`
    onDone(`Running /github ${sub}${args ? ` ${args}` : ''}`, {
      display: 'system',
      submitNextInput: true,
      nextInput: payload,
    })
  }

  if (step.kind === 'subcommand') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>/github — pick a subcommand</Text>
        <Select
          options={SUBCOMMAND_OPTIONS.map(o => ({
            value: o.value,
            label: o.label,
            description: o.description,
          }))}
          onChange={value => {
            if (value === 'cancel') {
              onDone('Cancelled /github', { display: 'system' })
              return
            }
            if (value === 'issue' || value === 'pr') {
              setStep({ kind: 'issue-source', sub: value })
              return
            }
            if (value === 'wrap') {
              setStep({ kind: 'wrap-branch' })
              return
            }
            if (value === 'release') {
              setStep({ kind: 'release-version' })
              return
            }
            if (value === 'changelog' || value === 'triage') {
              setStep({ kind: 'confirm', sub: value })
              return
            }
          }}
          onCancel={() => onDone('Cancelled /github', { display: 'system' })}
          visibleOptionCount={SUBCOMMAND_OPTIONS.length}
        />
        <Text dimColor>Enter to pick · Esc to cancel</Text>
      </Box>
    )
  }

  if (step.kind === 'issue-source') {
    const noun = step.sub === 'issue' ? 'issue' : 'PR'
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>/github {step.sub} — pick a source</Text>
        <Select
          options={[
            {
              type: 'input',
              value: 'url',
              label: `Paste a GitHub ${noun} URL`,
              placeholder: `https://github.com/owner/repo/${
                step.sub === 'issue' ? 'issues' : 'pull'
              }/123`,
              onChange: (raw: string) => {
                const v = raw.trim()
                if (!v) {
                  setStep({ kind: 'subcommand' })
                  return
                }
                submit(step.sub, v)
              },
            },
            {
              type: 'input',
              value: 'number',
              label: `Enter ${noun} number from this repo`,
              placeholder: 'e.g. 42',
              onChange: (raw: string) => {
                const v = raw.trim().replace(/^#/, '')
                if (!v || !/^\d+$/.test(v)) {
                  setStep({ kind: 'subcommand' })
                  return
                }
                submit(step.sub, v)
              },
            },
            { value: 'back', label: 'Back', description: 'Pick a different subcommand' },
          ]}
          onChange={value => {
            if (value === 'back') setStep({ kind: 'subcommand' })
          }}
          onCancel={() => setStep({ kind: 'subcommand' })}
        />
        <Text dimColor>Enter on an option to type the value · Esc to go back</Text>
      </Box>
    )
  }

  if (step.kind === 'wrap-branch') {
    if (branchData === null) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>/github wrap — branch picker</Text>
          <Text dimColor>Loading branches…</Text>
        </Box>
      )
    }
    if (branchData.error) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text bold>/github wrap — branch picker</Text>
          <Text>Could not list branches: {branchData.error}</Text>
          <Select
            options={[
              {
                type: 'input',
                value: 'manual',
                label: 'Type a branch name',
                placeholder: 'feature/my-branch',
                onChange: (raw: string) => {
                  const v = raw.trim()
                  if (!v) {
                    setStep({ kind: 'subcommand' })
                    return
                  }
                  setStep({ kind: 'wrap-issue', branch: v })
                },
              },
              { value: 'back', label: 'Back', description: 'Pick a different subcommand' },
            ]}
            onChange={value => {
              if (value === 'back') setStep({ kind: 'subcommand' })
            }}
            onCancel={() => setStep({ kind: 'subcommand' })}
          />
        </Box>
      )
    }

    const { branches, current } = branchData
    // Exclude the current branch from the recent list so it does not appear
    // twice (once as "Use current branch ..." and once as "<name> (current)").
    const branchOptions = branches
      .filter(b => b.name !== current)
      .map(b => ({
        value: `branch:${b.name}`,
        label: b.name,
        description: formatBranchDescription(b),
      }))

    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>/github wrap — pick a branch</Text>
        <Select
          options={[
            ...(current
              ? [
                  {
                    value: `current:${current}`,
                    label: `Use current branch (${current})`,
                    description: 'Stay on the branch you are on now',
                  },
                ]
              : []),
            ...branchOptions,
            {
              type: 'input' as const,
              value: 'new',
              label: 'New branch — type a name',
              placeholder: 'type a new branch name',
              initialValue: branchInput,
              onChange: (raw: string) => {
                setBranchInput(raw)
              },
            },
            { value: 'back', label: 'Back', description: 'Pick a different subcommand' },
          ]}
          onChange={value => {
            if (value === 'back') {
              setStep({ kind: 'subcommand' })
              return
            }
            if (typeof value === 'string' && value.startsWith('current:')) {
              setStep({ kind: 'wrap-issue', branch: value.slice('current:'.length) })
              return
            }
            if (typeof value === 'string' && value.startsWith('branch:')) {
              setStep({ kind: 'wrap-issue', branch: value.slice('branch:'.length) })
              return
            }
            if (value === 'new') {
              const v = branchInput.trim()
              if (!v) return
              setStep({ kind: 'wrap-issue', branch: v })
            }
          }}
          onCancel={() => setStep({ kind: 'subcommand' })}
          visibleOptionCount={Math.min(10, branchOptions.length + (current ? 3 : 2))}
        />
        <Text dimColor>Enter to pick · Esc to go back</Text>
      </Box>
    )
  }

  if (step.kind === 'wrap-issue') {
    const advance = (issueNum: string) =>
      setStep({ kind: 'wrap-instructions', branch: step.branch, issueNum })
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>/github wrap — link an issue (optional)</Text>
        <Text dimColor>Branch: {step.branch}</Text>
        <Select
          options={[
            {
              type: 'input',
              value: 'issue',
              label: 'Issue # to close',
              placeholder: 'e.g. 42',
              initialValue: issueInput,
              onChange: (raw: string) => {
                setIssueInput(raw.trim().replace(/^#/, ''))
              },
            },
            { value: 'skip', label: 'Skip', description: 'Commit without linking to an issue' },
            { value: 'back', label: 'Back', description: 'Re-pick the branch' },
          ]}
          onChange={value => {
            if (value === 'back') {
              setStep({ kind: 'wrap-branch' })
              return
            }
            if (value === 'skip') {
              advance('')
              return
            }
            if (value === 'issue') {
              advance(/^\d+$/.test(issueInput) ? issueInput : '')
            }
          }}
          onCancel={() => advance('')}
        />
        <Text dimColor>Enter on Issue # to type · Enter on Skip to continue · Esc skips</Text>
      </Box>
    )
  }

  if (step.kind === 'wrap-instructions') {
    const runWith = (notes: string) => {
      const parts = [`--branch=${step.branch}`]
      if (step.issueNum) parts.push(`--issue=${step.issueNum}`)
      if (notes) parts.push(notes)
      submit('wrap', parts.join(' '))
    }
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>/github wrap — extra instructions (optional)</Text>
        <Text dimColor>
          Branch: {step.branch}
          {step.issueNum ? ` · Closes #${step.issueNum}` : ''}
        </Text>
        <Select
          options={[
            {
              type: 'input',
              value: 'instructions',
              label: 'Notes for the commit message',
              placeholder: 'e.g. fix mobile checkout overflow',
              initialValue: instructionsInput,
              onChange: (raw: string) => {
                setInstructionsInput(raw)
              },
            },
            { value: 'skip', label: 'Skip', description: 'Run without extra notes' },
            { value: 'back', label: 'Back', description: 'Re-enter the issue number' },
          ]}
          onChange={value => {
            if (value === 'back') {
              setStep({ kind: 'wrap-issue', branch: step.branch })
              return
            }
            if (value === 'skip') {
              runWith('')
              return
            }
            if (value === 'instructions') {
              runWith(instructionsInput.trim())
            }
          }}
          onCancel={() => runWith('')}
        />
        <Text dimColor>Enter on Notes to type · Enter on Skip to run · Esc runs without notes</Text>
      </Box>
    )
  }

  if (step.kind === 'release-version') {
    const submitRelease = () => submit('release', versionInput.trim())

    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>/github release — version</Text>
        <Select
          options={[
            {
              type: 'input',
              value: 'version',
              label: 'Version (Enter to auto-detect from last tag)',
              placeholder: 'e.g. v2.0.1',
              initialValue: versionInput,
              onChange: (raw: string) => {
                setVersionInput(raw.trim())
              },
            },
            { value: 'back', label: 'Back', description: 'Pick a different subcommand' },
          ]}
          onChange={value => {
            if (value === 'version') {
              submitRelease()
              return
            }
            if (value === 'back') setStep({ kind: 'subcommand' })
          }}
          onCancel={() => submit('release', '')}
        />
        <Text dimColor>Enter to confirm · Esc to skip and auto-detect</Text>
      </Box>
    )
  }

  if (step.kind === 'confirm') {
    const noun = step.sub
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>/github {noun} — ready to run</Text>
        <Text dimColor>
          {noun === 'changelog'
            ? 'Will diff from the last tag and draft notes — nothing is written until you confirm.'
            : 'Will list open issues and propose labels / dedup actions — nothing is applied until you confirm.'}
        </Text>
        <Select
          options={[
            {
              value: 'run',
              label: `Run /github ${noun}`,
              description: 'Hand off to the model now',
            },
            { value: 'back', label: 'Back', description: 'Pick a different subcommand' },
          ]}
          onChange={value => {
            if (value === 'run') submit(step.sub, '')
            else setStep({ kind: 'subcommand' })
          }}
          onCancel={() => setStep({ kind: 'subcommand' })}
        />
      </Box>
    )
  }

  return null
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode> {
  const trimmed = args?.trim() ?? ''

  if (trimmed === 'help' || trimmed === '-h' || trimmed === '--help') {
    onDone(HELP_TEXT, { display: 'system' })
    return null
  }

  // Power-user / scripted invocation: skip the wizard entirely and forward
  // straight to the engine. Mirrors the behavior the typed-args version
  // used to have.
  if (trimmed) {
    onDone(`Running /github ${trimmed}`, {
      display: 'system',
      submitNextInput: true,
      nextInput: `/github-run ${trimmed}`,
    })
    return null
  }

  return <GithubWizard onDone={onDone} />
}
