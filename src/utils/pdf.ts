import { randomUUID } from 'crypto'
import { mkdir, readdir, readFile } from 'fs/promises'
import { join } from 'path'
import {
  PDF_MAX_EXTRACT_SIZE,
  PDF_TARGET_RAW_SIZE,
} from '../constants/apiLimits.js'
import { errorMessage } from './errors.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { formatFileSize } from './format.js'
import { getFsImplementation } from './fsOperations.js'
import { runPythonDocReader } from './pythonDocs.js'
import { getToolResultsDir } from './toolResultStorage.js'

export type PDFError = {
  reason:
    | 'empty'
    | 'too_large'
    | 'password_protected'
    | 'corrupted'
    | 'unknown'
    | 'unavailable'
  message: string
  /**
   * Set when no Python here has a PDF library: which interpreters were
   * checked and the command that installs one (pythonDocs.ts).
   */
  pythonInstall?: string
}

export type PDFResult<T> =
  | { success: true; data: T }
  | { success: false; error: PDFError }

/**
 * Read a PDF file and return it as base64-encoded data.
 * @param filePath Path to the PDF file
 * @returns Result containing PDF data or a structured error
 */
export async function readPDF(filePath: string): Promise<
  PDFResult<{
    type: 'pdf'
    file: {
      filePath: string
      base64: string
      originalSize: number
    }
  }>
> {
  try {
    const fs = getFsImplementation()
    const stats = await fs.stat(filePath)
    const originalSize = stats.size

    // Check if file is empty
    if (originalSize === 0) {
      return {
        success: false,
        error: { reason: 'empty', message: `PDF file is empty: ${filePath}` },
      }
    }

    // Check if PDF exceeds maximum size
    // The API has a 32MB total request limit. After base64 encoding (~33% larger),
    // a PDF must be under ~20MB raw to leave room for conversation context.
    if (originalSize > PDF_TARGET_RAW_SIZE) {
      return {
        success: false,
        error: {
          reason: 'too_large',
          message: `PDF file exceeds maximum allowed size of ${formatFileSize(PDF_TARGET_RAW_SIZE)}.`,
        },
      }
    }

    const fileBuffer = await readFile(filePath)

    // Validate PDF magic bytes — reject files that aren't actually PDFs
    // (e.g., HTML files renamed to .pdf) before they enter conversation context.
    // Once an invalid PDF document block is in the message history, every subsequent
    // API call fails with 400 "The PDF specified was not valid" and the session
    // becomes unrecoverable without /clear.
    const header = fileBuffer.subarray(0, 5).toString('ascii')
    if (!header.startsWith('%PDF-')) {
      return {
        success: false,
        error: {
          reason: 'corrupted',
          message: `File is not a valid PDF (missing %PDF- header): ${filePath}`,
        },
      }
    }

    const base64 = fileBuffer.toString('base64')

    // Note: We cannot check page count here without parsing the PDF
    // The API will enforce the 100-page limit and return an error if exceeded

    return {
      success: true,
      data: {
        type: 'pdf',
        file: {
          filePath,
          base64,
          originalSize,
        },
      },
    }
  } catch (e: unknown) {
    return {
      success: false,
      error: {
        reason: 'unknown',
        message: errorMessage(e),
      },
    }
  }
}

/**
 * Get the number of pages in a PDF file using `pdfinfo` (from poppler-utils).
 * Returns `null` if pdfinfo is not available or if the page count cannot be determined.
 */
export async function getPDFPageCount(
  filePath: string,
): Promise<number | null> {
  const { code, stdout } = await execFileNoThrow('pdfinfo', [filePath], {
    timeout: 10_000,
    useCwd: false,
  })
  if (code !== 0) {
    return null
  }
  const match = /^Pages:\s+(\d+)/m.exec(stdout)
  if (!match) {
    return null
  }
  const count = parseInt(match[1]!, 10)
  return isNaN(count) ? null : count
}

export type PDFExtractPagesResult = {
  type: 'parts'
  file: {
    filePath: string
    originalSize: number
    count: number
    outputDir: string
  }
}

type PdfTool = 'pdftoppm' | 'pdftotext'

const pdfToolAvailability = new Map<PdfTool, Promise<boolean>>()

/**
 * Reset the PDF tool availability cache. Used by tests only.
 */
export function resetPdftoppmCache(): void {
  pdfToolAvailability.clear()
}

/**
 * True when `-v` output proves the tool ran. Poppler prints
 * "pdftoppm version 24.02.0" and exits 0; Xpdf prints
 * "pdftotext version 4.06" and exits 99. A launch failure writes to stderr
 * too (cmd.exe's "'pdftoppm' is not recognized..." on Windows), so stderr
 * alone proves nothing; the version banner does.
 */
export function isPdfToolVersionBanner(tool: PdfTool, output: string): boolean {
  return new RegExp(`\\b${tool}\\s+version\\s+\\d`, 'i').test(output)
}

/** Probe once per process whether `tool` (Poppler or Xpdf) can run. */
function isPdfToolAvailable(tool: PdfTool): Promise<boolean> {
  let available = pdfToolAvailability.get(tool)
  if (!available) {
    available = execFileNoThrow(tool, ['-v'], {
      timeout: 5000,
      useCwd: false,
    }).then(
      ({ code, stdout, stderr }) =>
        code === 0 || isPdfToolVersionBanner(tool, `${stdout}\n${stderr}`),
    )
    pdfToolAvailability.set(tool, available)
  }
  return available
}

// Signals that mean the program itself crashed, as opposed to being stopped.
const CRASH_SIGNALS = new Set(['SIGSEGV', 'SIGBUS', 'SIGILL', 'SIGFPE', 'SIGABRT'])

/**
 * Why a PDF tool run failed, in words that do not depend on the OS. A crash
 * shows as an NTSTATUS exit code on Windows (0xC0000005 is an access
 * violation) and as a signal elsewhere; both say "crashed", so the model does
 * not blame the PDF. The tool's stderr is the detail when it has any, else
 * execa's reason (timeout, kill, launch failure) without the command it
 * echoes.
 */
export function describePdfToolFailure(
  tool: PdfTool,
  result: { code: number; stderr: string; error?: string },
): string {
  const { code, stderr, error } = result
  const signal = error?.match(/\b(SIG[A-Z0-9]+)\b/)?.[1]
  const unsigned = code >>> 0
  const how =
    unsigned >= 0xc0000000
      ? `crashed (Windows error 0x${unsigned.toString(16).toUpperCase()})`
      : signal && CRASH_SIGNALS.has(signal)
        ? `crashed (${signal})`
        : `failed (exit code ${code})`
  const reason = error?.split(/:\s/)[0]?.trim() ?? ''
  const detail =
    stderr.trim() ||
    (/^Command failed with exit code -?\d+$/.test(reason) ? '' : reason)
  return detail ? `${tool} ${how}: ${detail}` : `${tool} ${how}.`
}

/**
 * Check whether the `pdftoppm` binary (from poppler-utils) is available.
 * The result is cached for the lifetime of the process.
 */
export function isPdftoppmAvailable(): Promise<boolean> {
  return isPdfToolAvailable('pdftoppm')
}

/**
 * How to get Poppler's command-line tools here. A running Tau keeps the PATH
 * it started with, so the tools appear only after a restart.
 */
export function getPopplerInstallHint(
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === 'win32') {
    return 'Install Poppler for Windows (for example `winget install oschwartz10612.Poppler`), make sure its bin folder is on PATH, and restart Tau.'
  }
  if (platform === 'darwin') {
    return 'Install Poppler with `brew install poppler` and restart Tau.'
  }
  return 'Install poppler-utils (`sudo apt-get install poppler-utils` on Debian/Ubuntu, `sudo dnf install poppler-utils` on Fedora) and restart Tau.'
}

/** A page range as the Python reader takes it: 0 for "to the end". */
function pythonPageArgs(options?: { firstPage?: number; lastPage?: number }): string[] {
  const last =
    options?.lastPage && options.lastPage !== Infinity ? options.lastPage : 0
  return [String(options?.firstPage ?? 1), String(last)]
}

/**
 * Extract PDF pages as images: pdftoppm (Poppler) when it is installed and
 * works, else PyMuPDF from whichever Python here has it. Produces page-NN
 * JPEG (or PNG, on an old PyMuPDF) files in an output directory. This enables
 * reading large PDFs and works with all API providers.
 *
 * @param filePath Path to the PDF file
 * @param options Optional page range (1-indexed, inclusive)
 */
export async function extractPDFPages(
  filePath: string,
  options?: { firstPage?: number; lastPage?: number },
  /**
   * Set false where the pages are not actually used (the whole-PDF read only
   * logs whether extraction works): a Python fallback would render every page
   * of a large PDF for nothing.
   */
  pythonFallback = true,
): Promise<PDFResult<PDFExtractPagesResult>> {
  const poppler = await extractPDFPagesWithPoppler(filePath, options)
  // Problems with the file itself fail every renderer the same way.
  if (
    !pythonFallback ||
    poppler.success ||
    !['unavailable', 'unknown'].includes(poppler.error.reason)
  ) {
    return poppler
  }
  try {
    const outputDir = join(getToolResultsDir(), `pdf-${randomUUID()}`)
    await mkdir(outputDir, { recursive: true })
    const viaPython = await runPythonDocReader('pdf-render', filePath, [
      ...pythonPageArgs(options),
      outputDir,
      '100',
    ])
    if (viaPython.ok) {
      const count = Number(viaPython.data.count ?? 0)
      if (count > 0) {
        const { size } = await getFsImplementation().stat(filePath)
        return {
          success: true,
          data: { type: 'parts', file: { filePath, originalSize: size, outputDir, count } },
        }
      }
      return {
        success: false,
        error: { reason: 'corrupted', message: 'PyMuPDF rendered no pages: the range may be past the end of the PDF.' },
      }
    }
    if (viaPython.reason === 'password') {
      return {
        success: false,
        error: { reason: 'password_protected', message: 'PDF is password-protected. Please provide an unprotected version.' },
      }
    }
    const popplerPart =
      poppler.error.reason === 'unavailable'
        ? 'pdftoppm is not installed'
        : poppler.error.message.replace(/\.$/, '')
    return viaPython.reason === 'missing'
      ? {
          success: false,
          error: {
            reason: poppler.error.reason,
            message: `${popplerPart} and no Python here has PyMuPDF, so PDF pages cannot be rendered as images.`,
            pythonInstall: viaPython.message,
          },
        }
      : {
          success: false,
          error: {
            reason: 'unknown',
            message: `${popplerPart}, and rendering the pages with PyMuPDF failed too: ${viaPython.message}`,
          },
        }
  } catch (e: unknown) {
    return { success: false, error: { reason: 'unknown', message: errorMessage(e) } }
  }
}

async function extractPDFPagesWithPoppler(
  filePath: string,
  options?: { firstPage?: number; lastPage?: number },
): Promise<PDFResult<PDFExtractPagesResult>> {
  try {
    const fs = getFsImplementation()
    const stats = await fs.stat(filePath)
    const originalSize = stats.size

    if (originalSize === 0) {
      return {
        success: false,
        error: { reason: 'empty', message: `PDF file is empty: ${filePath}` },
      }
    }

    if (originalSize > PDF_MAX_EXTRACT_SIZE) {
      return {
        success: false,
        error: {
          reason: 'too_large',
          message: `PDF file exceeds maximum allowed size for text extraction (${formatFileSize(PDF_MAX_EXTRACT_SIZE)}).`,
        },
      }
    }

    const available = await isPdftoppmAvailable()
    if (!available) {
      return {
        success: false,
        error: {
          reason: 'unavailable',
          message: `pdftoppm is not installed, so PDF pages cannot be rendered as images. ${getPopplerInstallHint()}`,
        },
      }
    }

    const uuid = randomUUID()
    const outputDir = join(getToolResultsDir(), `pdf-${uuid}`)
    await mkdir(outputDir, { recursive: true })

    // pdftoppm produces files like <prefix>-01.jpg, <prefix>-02.jpg, etc.
    const prefix = join(outputDir, 'page')
    const args = ['-jpeg', '-r', '100']
    if (options?.firstPage) {
      args.push('-f', String(options.firstPage))
    }
    if (options?.lastPage && options.lastPage !== Infinity) {
      args.push('-l', String(options.lastPage))
    }
    args.push(filePath, prefix)
    const { code, stderr, error } = await execFileNoThrow('pdftoppm', args, {
      timeout: 120_000,
      useCwd: false,
    })

    if (code !== 0) {
      if (/password/i.test(stderr)) {
        return {
          success: false,
          error: {
            reason: 'password_protected',
            message:
              'PDF is password-protected. Please provide an unprotected version.',
          },
        }
      }
      if (/damaged|corrupt|invalid/i.test(stderr)) {
        return {
          success: false,
          error: {
            reason: 'corrupted',
            message: 'PDF file is corrupted or invalid.',
          },
        }
      }
      return {
        success: false,
        error: {
          reason: 'unknown',
          message: describePdfToolFailure('pdftoppm', { code, stderr, error }),
        },
      }
    }

    // Read generated image files and sort naturally
    const entries = await readdir(outputDir)
    const imageFiles = entries.filter(f => f.endsWith('.jpg')).sort()
    const pageCount = imageFiles.length

    if (pageCount === 0) {
      return {
        success: false,
        error: {
          reason: 'corrupted',
          message: 'pdftoppm produced no output pages. The PDF may be invalid.',
        },
      }
    }

    const count = imageFiles.length

    return {
      success: true,
      data: {
        type: 'parts',
        file: {
          filePath,
          originalSize,
          outputDir,
          count,
        },
      },
    }
  } catch (e: unknown) {
    return {
      success: false,
      error: {
        reason: 'unknown',
        message: errorMessage(e),
      },
    }
  }
}

export type PDFTextResult = {
  /** Pages separated by form feeds, as pdftotext writes them. */
  text: string
  firstPage: number
  /** What extracted it: pdftotext, or the Python library used. */
  tool: string
}

/**
 * Extract the text layer of PDF pages, for when the pages cannot be rendered
 * as images: `pdftotext` (Poppler or Xpdf) when it is installed and works,
 * else a Python PDF library (PyMuPDF, pypdf, PyPDF2, pdfplumber) from
 * whichever Python here has one. Only the text comes back: images, charts,
 * scanned pages and layout are not in it.
 *
 * @param filePath Path to the PDF file
 * @param options Optional page range (1-indexed, inclusive)
 */
export async function extractPDFText(
  filePath: string,
  options?: { firstPage?: number; lastPage?: number },
): Promise<PDFResult<PDFTextResult>> {
  const poppler = await extractPDFTextWithPoppler(filePath, options)
  if (poppler.success || !['unavailable', 'unknown'].includes(poppler.error.reason)) {
    return poppler
  }
  try {
    const viaPython = await runPythonDocReader('pdf-text', filePath, pythonPageArgs(options))
    if (viaPython.ok) {
      const pages = Array.isArray(viaPython.data.pages)
        ? (viaPython.data.pages as [number, string][])
        : []
      return {
        success: true,
        data: {
          text: pages.map(([, text]) => text).join('\f'),
          firstPage: pages[0]?.[0] ?? options?.firstPage ?? 1,
          tool: viaPython.library,
        },
      }
    }
    if (viaPython.reason === 'password') {
      return {
        success: false,
        error: { reason: 'password_protected', message: 'PDF is password-protected. Please provide an unprotected version.' },
      }
    }
    const popplerPart =
      poppler.error.reason === 'unavailable'
        ? 'pdftotext is not installed'
        : poppler.error.message.replace(/\.$/, '')
    return viaPython.reason === 'missing'
      ? {
          success: false,
          error: {
            reason: poppler.error.reason,
            message: `${popplerPart} and no Python here has a PDF library (PyMuPDF, pypdf, PyPDF2 or pdfplumber), so the text cannot be extracted.`,
            pythonInstall: viaPython.message,
          },
        }
      : {
          success: false,
          error: {
            reason: 'unknown',
            message: `${popplerPart}, and extracting the text with Python failed too: ${viaPython.message}`,
          },
        }
  } catch (e: unknown) {
    return { success: false, error: { reason: 'unknown', message: errorMessage(e) } }
  }
}

async function extractPDFTextWithPoppler(
  filePath: string,
  options?: { firstPage?: number; lastPage?: number },
): Promise<PDFResult<PDFTextResult>> {
  try {
    if (!(await isPdfToolAvailable('pdftotext'))) {
      return {
        success: false,
        error: {
          reason: 'unavailable',
          message: `pdftotext is not installed, so the PDF's text cannot be extracted. ${getPopplerInstallHint()}`,
        },
      }
    }

    const firstPage = options?.firstPage ?? 1
    // Xpdf defaults to Latin-1 output; '-' writes the text to stdout.
    const args = ['-layout', '-enc', 'UTF-8', '-f', String(firstPage)]
    if (options?.lastPage && options.lastPage !== Infinity) {
      args.push('-l', String(options.lastPage))
    }
    args.push(filePath, '-')
    const { code, stdout, stderr, error } = await execFileNoThrow('pdftotext', args, {
      timeout: 60_000,
      useCwd: false,
    })

    if (code !== 0) {
      if (/password/i.test(stderr)) {
        return {
          success: false,
          error: {
            reason: 'password_protected',
            message:
              'PDF is password-protected. Please provide an unprotected version.',
          },
        }
      }
      if (/damaged|corrupt|invalid/i.test(stderr)) {
        return {
          success: false,
          error: {
            reason: 'corrupted',
            message: 'PDF file is corrupted or invalid.',
          },
        }
      }
      return {
        success: false,
        error: {
          reason: 'unknown',
          message: describePdfToolFailure('pdftotext', { code, stderr, error }),
        },
      }
    }

    return { success: true, data: { text: stdout, firstPage, tool: 'pdftotext' } }
  } catch (e: unknown) {
    return {
      success: false,
      error: {
        reason: 'unknown',
        message: errorMessage(e),
      },
    }
  }
}
