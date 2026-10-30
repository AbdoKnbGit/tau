import type { McpbManifestAny as McpbManifest } from '@anthropic-ai/mcpb'
import { z } from 'zod/v4'
import { logForDebugging } from '../debug.js'
import { errorMessage } from '../errors.js'
import { lazySchema } from '../lazySchema.js'
import { McpbRuntimeError } from '../plugins/mcpbRuntime.js'
import { jsonParse } from '../slowOperations.js'

// Only what tau reads from a manifest. Used for versions newer than the bundled
// mcpb knows, whose other fields may have changed in ways it cannot judge.
const UnknownVersionManifestSchema = lazySchema(() => {
  const launch = {
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
  }
  return z.looseObject({
    name: z.string().min(1),
    server: z.looseObject({
      mcp_config: z.looseObject({
        ...launch,
        platform_overrides: z
          .record(z.string(), z.looseObject({ ...launch, command: launch.command.optional() }))
          .optional(),
      }),
    }),
    user_config: z.record(z.string(), z.looseObject({})).optional(),
  })
})

/**
 * Parses and validates a DXT manifest from a JSON object.
 *
 * Lazy-imports @anthropic-ai/mcpb: that package uses zod v3 which eagerly
 * creates 24 .bind(this) closures per schema instance (~300 instances between
 * schemas.js and schemas-loose.js). Deferring the import keeps ~700KB of bound
 * closures out of the startup heap for sessions that never touch .dxt/.mcpb.
 * The /browser entry is the part without mcpb's packing and signing CLI.
 *
 * Uses the loose schemas: a host should load what it can read, and the strict
 * ones refuse a whole bundle over one key they don't know.
 */
export async function validateManifest(
  manifestJson: unknown,
): Promise<McpbManifest> {
  const { MANIFEST_SCHEMAS_LOOSE } = await import('@anthropic-ai/mcpb/browser')
  const declared = manifestJson as {
    manifest_version?: unknown
    dxt_version?: unknown
  } | null
  const version = String(declared?.manifest_version ?? declared?.dxt_version ?? '')

  if (!Object.hasOwn(MANIFEST_SCHEMAS_LOOSE, version)) {
    const newer = UnknownVersionManifestSchema().safeParse(manifestJson)
    if (!newer.success) {
      throw new McpbRuntimeError(
        `This bundle uses manifest version "${version}", which this version of Tau cannot read. Update Tau, then run /reload-plugins.`,
      )
    }
    logForDebugging(
      `MCPB manifest version "${version}" is newer than this Tau knows; loading what it can read`,
      { level: 'warn' },
    )
    return newer.data as unknown as McpbManifest
  }

  const parseResult =
    MANIFEST_SCHEMAS_LOOSE[version as keyof typeof MANIFEST_SCHEMAS_LOOSE].safeParse(
      manifestJson,
    )

  if (!parseResult.success) {
    const errors = parseResult.error.flatten()
    const errorMessages = [
      ...Object.entries(errors.fieldErrors).map(
        ([field, errs]) => `${field}: ${(errs as string[] | undefined)?.join(', ')}`,
      ),
      ...(errors.formErrors || []),
    ]
      .filter(Boolean)
      .join('; ')

    throw new Error(`Invalid manifest: ${errorMessages}`)
  }

  return parseResult.data as McpbManifest
}

/**
 * Parses and validates a DXT manifest from raw text data.
 */
export async function parseAndValidateManifestFromText(
  manifestText: string,
): Promise<McpbManifest> {
  let manifestJson: unknown

  try {
    manifestJson = jsonParse(manifestText)
  } catch (error) {
    throw new Error(`Invalid JSON in manifest.json: ${errorMessage(error)}`)
  }

  return validateManifest(manifestJson)
}

/**
 * Parses and validates a DXT manifest from raw binary data.
 */
export async function parseAndValidateManifestFromBytes(
  manifestData: Uint8Array,
): Promise<McpbManifest> {
  const manifestText = new TextDecoder().decode(manifestData)
  return parseAndValidateManifestFromText(manifestText)
}

/**
 * Generates an extension ID from author name and extension name.
 * Uses the same algorithm as the directory backend for consistency.
 */
export function generateExtensionId(
  manifest: McpbManifest,
  prefix?: 'local.unpacked' | 'local.dxt',
): string {
  const sanitize = (str: string) =>
    str
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-_.]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')

  const authorName = manifest.author.name
  const extensionName = manifest.name

  const sanitizedAuthor = sanitize(authorName)
  const sanitizedName = sanitize(extensionName)

  return prefix
    ? `${prefix}.${sanitizedAuthor}.${sanitizedName}`
    : `${sanitizedAuthor}.${sanitizedName}`
}
