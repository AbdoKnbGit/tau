import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'

/** Public, cache-stable discovery schema. Alias repair happens before parsing. */
export const toolSearchInputSchema = lazySchema(() =>
  z.object({
    query: z
      .string()
      .describe(
        'Query deferred tools: "select:Name,Name" or capability keywords.',
      ),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe('Maximum keyword matches (default 5, max 10)'),
  }),
)

export type ToolSearchInputSchema = ReturnType<typeof toolSearchInputSchema>
