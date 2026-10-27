import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { ToolUseContext } from '../../../Tool.js'
import type { PromptCommand } from '../../../types/command.js'
import type { SkillMetadata } from '../../../skills/skillMetadata.js'
import type { CanUseToolFn } from '../../../hooks/useCanUseTool.js'
import { dispatchModEvent, hasModEvent } from './manager.js'
import {
  inToolContext,
  replaceSubmittedPromptText,
  submittedPromptText,
} from './lifecycle.js'
import type { ModRecord } from './runtime.js'
import { getModToolContext, withModToolContext } from './toolContext.js'

type SkillPromptIdentity = {
  name: string
  source: string
  pluginName?: string
  skillMetadata?: SkillMetadata
}

/** Runs once per expansion, after interpolation and before transcript/compaction storage. */
export async function applySkillPromptMods<
  T extends string | ContentBlockParam[],
>(
  skill: SkillPromptIdentity,
  content: T,
  context: ToolUseContext,
  canUseTool?: CanUseToolFn,
): Promise<T> {
  if (!hasModEvent('skill.prompt')) return content
  const dispatch = async () =>
    (await dispatchModEvent(
      'skill.prompt',
      {
        skill: skill.name,
        source:
          skill.source === 'builtin' || skill.source === 'bundled'
            ? 'built-in'
            : skill.source,
        ...(skill.pluginName ? { pluginName: skill.pluginName } : {}),
        frontmatter: {},
        ...skill.skillMetadata,
        text: submittedPromptText(content),
      },
      async e => ({ text: e.text }),
      context.abortController.signal,
    )) as ModRecord
  const bound = getModToolContext()
  const result =
    bound?.toolUseContext === context
      ? await withModToolContext(
          { ...bound, canUseTool: canUseTool ?? bound.canUseTool },
          dispatch,
        )
      : await inToolContext(context, canUseTool, dispatch)
  return replaceSubmittedPromptText(content, result.text) as T
}

export async function expandSkillPrompt(
  command: PromptCommand & { name: string },
  args: string,
  context: ToolUseContext,
  canUseTool?: CanUseToolFn,
): Promise<ContentBlockParam[]> {
  const content = await command.getPromptForCommand(args, context)
  return applySkillPromptMods(
    {
      name: command.name,
      source: command.source,
      ...(command.source === 'plugin' && command.pluginInfo
        ? { pluginName: command.pluginInfo.pluginManifest.name }
        : {}),
      skillMetadata: command.skillMetadata,
    },
    content,
    context,
    canUseTool,
  )
}
