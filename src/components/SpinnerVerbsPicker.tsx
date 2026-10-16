import * as React from 'react'
import { useMemo, useState } from 'react'
import {
  getSpinnerVerbsChoice,
  normalizeCustomSpinnerVerb,
  PLAIN_SPINNER_VERB,
  type SpinnerVerbsSetting,
} from '../constants/spinnerVerbs.js'
import { Box, Text } from '../ink.js'
import { type OptionWithDescription, Select } from './CustomSelect/select.js'

type Choice = 'on' | 'off' | 'custom'

type Props = {
  initial: SpinnerVerbsSetting
  onComplete: (spinnerVerbs: SpinnerVerbsSetting) => void
  onCancel: () => void
}

/**
 * /config's Spinner verbs submenu: the built-in random verbs (On), one plain
 * verb (Off), or one verb typed here (Custom). Esc cancels from the list and
 * from the text field alike.
 */
export function SpinnerVerbsPicker({
  initial,
  onComplete,
  onCancel,
}: Props): React.ReactNode {
  const current = getSpinnerVerbsChoice(initial)
  const initialVerb = current.kind === 'custom' ? current.verb : ''
  const [typedVerb, setTypedVerb] = useState(initialVerb)
  const currentValue: Choice | undefined =
    current.kind === 'list' ? undefined : current.kind

  const options = useMemo<OptionWithDescription<Choice>[]>(
    () => [
      {
        label: 'On',
        value: 'on',
        description: 'A random verb each time (default)',
      },
      {
        label: 'Off',
        value: 'off',
        description: `Always "${PLAIN_SPINNER_VERB}…"`,
      },
      {
        type: 'input',
        label: 'Custom',
        value: 'custom',
        description: 'Your own word, every time',
        placeholder: 'type a word, e.g. Thinking',
        initialValue: initialVerb,
        onChange: setTypedVerb,
        showLabelWithValue: true,
        labelValueSeparator: ': ',
      },
    ],
    [initialVerb],
  )

  function handleChange(choice: Choice): void {
    if (choice === 'on') {
      onComplete(undefined)
      return
    }
    if (choice === 'off') {
      onComplete({ mode: 'replace', verbs: [PLAIN_SPINNER_VERB] })
      return
    }
    const verb = normalizeCustomSpinnerVerb(typedVerb)
    // Only dots or spaces typed: keep the setting as it was.
    if (!verb) {
      onCancel()
      return
    }
    onComplete({ mode: 'replace', verbs: [verb] })
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text>Choose what the spinner says while Tau works:</Text>
      {current.kind === 'list' && (
        <Text dimColor>
          Your settings.json has its own list of verbs; picking here replaces
          it.
        </Text>
      )}
      <Select
        options={options}
        // Descriptions under the labels: Custom's text field keeps the
        // side-by-side columns from lining up.
        layout="compact-vertical"
        defaultValue={currentValue}
        defaultFocusValue={currentValue}
        onChange={handleChange}
        onCancel={onCancel}
      />
    </Box>
  )
}
