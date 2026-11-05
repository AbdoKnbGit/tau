import type { Buffer } from 'buffer'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ensureImageRuntime,
  findImagePackageRoot,
} from '../../../scripts/image-runtime.mjs'
import { isInBundledMode } from '../../utils/bundledMode.js'

export type SharpInstance = {
  metadata(): Promise<{ width: number; height: number; format: string }>
  resize(
    width: number,
    height: number,
    options?: { fit?: string; withoutEnlargement?: boolean },
  ): SharpInstance
  jpeg(options?: { quality?: number }): SharpInstance
  png(options?: {
    compressionLevel?: number
    palette?: boolean
    colors?: number
  }): SharpInstance
  webp(options?: { quality?: number }): SharpInstance
  toBuffer(): Promise<Buffer>
}

export type SharpFunction = (input: Buffer) => SharpInstance

type SharpCreatorOptions = {
  create: {
    width: number
    height: number
    channels: 3 | 4
    background: { r: number; g: number; b: number }
  }
}

type SharpCreator = (options: SharpCreatorOptions) => SharpInstance

const imageRequire = createRequire(import.meta.url)
let imageProcessorPromise: Promise<SharpFunction> | null = null
let sharpPromise: Promise<SharpFunction> | null = null
let imageFailureHint: string | null = null

export function getImageProcessorFailureHint(): string | null {
  return imageFailureHint
}

/**
 * Verification and repair happen in asynchronous child processes. Sharing the
 * promise covers image reads, pasted images and creators arriving together;
 * a failed repair is attempted only once in this process, never per image.
 */
function getSharp(): Promise<SharpFunction> {
  sharpPromise ??= (async () => {
    const launcherRoot = (
      globalThis as typeof globalThis & { __TAU_PACKAGE_ROOT__?: unknown }
    ).__TAU_PACKAGE_ROOT__
    const packageRoot =
      typeof launcherRoot === 'string'
        ? launcherRoot
        : findImagePackageRoot(dirname(fileURLToPath(import.meta.url)))
    if (!packageRoot) {
      throw new Error('Image decoding is unavailable: Tau package location could not be resolved')
    }
    const runtime = await ensureImageRuntime(packageRoot)
    if (!runtime.ok) {
      throw new Error(`Image decoding is unavailable: ${runtime.reason}`)
    }
    // A failed ESM import remains cached. The verified CJS entry is loaded
    // only after recovery, and an isolated cache entry has a distinct path.
    const sharp = unwrapDefault(
      imageRequire(runtime.modulePath) as MaybeDefault<SharpFunction>,
    )
    if (typeof sharp !== 'function') {
      throw new Error('Image decoding is unavailable: the image processor is invalid')
    }
    return sharp
  })().catch(error => {
    imageFailureHint = 'Image preview unavailable; restart Tau to retry automatic image setup.'
    throw error
  })
  return sharpPromise
}

export async function getImageProcessor(): Promise<SharpFunction> {
  imageProcessorPromise ??= (async () => {
    if (isInBundledMode()) {
      // Keep the existing standalone-binary processor when it is available.
      try {
        const imageProcessor = await import('image-processor-napi')
        const sharp = imageProcessor.sharp || imageProcessor.default
        if (typeof sharp === 'function') return sharp
      } catch {
        // Normal npm builds and standalone builds without this optional
        // module use the same verified Sharp runtime below.
      }
    }
    return getSharp()
  })()
  return imageProcessorPromise
}

/**
 * Get image creator for generating new images from scratch.
 * Note: image-processor-napi doesn't support image creation,
 * so this always uses sharp directly.
 */
export async function getImageCreator(): Promise<SharpCreator> {
  return (await getSharp()) as unknown as SharpCreator
}

// Dynamic import shape varies by module interop mode — ESM yields { default: fn }, CJS yields fn directly.
type MaybeDefault<T> = T | { default: T }

function unwrapDefault<T extends (...args: never[]) => unknown>(
  mod: MaybeDefault<T>,
): T {
  return typeof mod === 'function' ? mod : mod.default
}
