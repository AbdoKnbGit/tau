import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'

/**
 * Discriminated union of all LSP operations (discriminator: 'operation').
 *
 * Position can be supplied two ways:
 *  - `symbol` (PREFERRED): the tool locates the symbol in the file for you, so
 *    the model never has to compute 1-based line/character. This removes the
 *    main source of failed LSP calls.
 *  - `line` + `character`: explicit 1-based coordinates (still accepted).
 *
 * `documentSymbol` and `workspaceSymbol` ignore position entirely.
 */
export const lspToolInputSchema = lazySchema(() => {
  const filePath = z
    .string()
    .describe('The absolute or relative path to the file')
  const symbol = z
    .string()
    .optional()
    .describe(
      'Name of the symbol to act on, e.g. "LogoV2". PREFERRED — the tool finds its position for you, so you do not need line/character. Provide this OR line+character.',
    )
  const line = z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'The line number (1-based, as shown in editors). Optional when symbol is provided.',
    )
  const character = z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'The character offset (1-based, as shown in editors). Optional when symbol is provided.',
    )

  const op = (operation: string) =>
    z.strictObject({
      operation: z.literal(operation),
      filePath,
      symbol,
      line,
      character,
    })

  return z.discriminatedUnion('operation', [
    op('goToDefinition'),
    op('findReferences'),
    op('hover'),
    op('documentSymbol'),
    op('workspaceSymbol'),
    op('goToImplementation'),
    op('prepareCallHierarchy'),
    op('incomingCalls'),
    op('outgoingCalls'),
  ])
})

/**
 * TypeScript type for LSPTool input
 */
export type LSPToolInput = z.infer<ReturnType<typeof lspToolInputSchema>>

/** Operations that require a position (symbol or line+character). */
export const LSP_POSITION_OPERATIONS: ReadonlySet<string> = new Set([
  'goToDefinition',
  'findReferences',
  'hover',
  'goToImplementation',
  'prepareCallHierarchy',
  'incomingCalls',
  'outgoingCalls',
])

/**
 * Type guard to check if an operation is a valid LSP operation
 */
export function isValidLSPOperation(
  operation: string,
): operation is LSPToolInput['operation'] {
  return [
    'goToDefinition',
    'findReferences',
    'hover',
    'documentSymbol',
    'workspaceSymbol',
    'goToImplementation',
    'prepareCallHierarchy',
    'incomingCalls',
    'outgoingCalls',
  ].includes(operation)
}
