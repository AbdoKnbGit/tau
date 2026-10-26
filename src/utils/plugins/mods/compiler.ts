import { createHash } from 'crypto'
import { readFile, realpath } from 'fs/promises'
import { dirname, extname, resolve } from 'path'
import ts from 'typescript'
import { isWithinDirectory } from '../pluginFiles.js'

import { MOD_EVENTS, MOD_METHODS } from './contracts.js'
const EXTENSIONS = [
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
]

export type CompiledMod = {
  entry: string
  files: Record<string, { code: string; imports: Record<string, string> }>
  events: string[]
  calls: string[]
  digest: string
}

/** Parse and compile plugin-owned modules without evaluating any plugin code. */
export async function compileMod(
  root: string,
  entry: string,
): Promise<CompiledMod> {
  const canonicalRoot = await realpath(root)
  const files: CompiledMod['files'] = Object.create(null)
  const events = new Set<string>(),
    calls = new Set<string>()
  const hash = createHash('sha256')
  let totalBytes = 0
  const load = async (path: string): Promise<string> => {
    const canonical = await realpath(path)
    if (!isWithinDirectory(canonicalRoot, canonical))
      throw new Error(`Mod import escapes plugin directory: ${path}`)
    if (!EXTENSIONS.includes(extname(canonical)))
      throw new Error(`Unsupported mod file extension: ${path}`)
    if (files[canonical]) return canonical
    if (Object.keys(files).length >= 100)
      throw new Error('Mod exceeds 100 source files')
    const source = await readFile(canonical, 'utf8')
    totalBytes += Buffer.byteLength(source)
    if (totalBytes > 2 * 1024 * 1024)
      throw new Error('Mod exceeds 2 MiB of source')
    hash.update(canonical).update('\0').update(source)
    const ast = ts.createSourceFile(
      canonical,
      source,
      ts.ScriptTarget.Latest,
      true,
    )
    const syntaxErrors = (
      ast as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }
    ).parseDiagnostics
    if (syntaxErrors.length)
      throw new Error(
        `${canonical}: ${syntaxErrors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n')}`,
      )
    const imports: Record<string, string> = Object.create(null)
    files[canonical] = { code: '', imports }
    const specifiers = new Set<string>()
    const fail = (node: ts.Node, reason: string): never => {
      const line =
        ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1
      throw new Error(`${canonical}:${line}: ${reason}`)
    }
    const visit = (node: ts.Node) => {
      if (
        ts.isJsxElement(node) ||
        ts.isJsxSelfClosingElement(node) ||
        ts.isJsxFragment(node)
      )
        fail(node, 'Tau does not yet support mod UI/JSX rendering')
      if (ts.isImportEqualsDeclaration(node))
        fail(node, 'Mods use ES imports, not import=require')
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier
      ) {
        if (!ts.isStringLiteral(node.moduleSpecifier))
          fail(node, 'Import path must be a string literal')
        const specifier = (node.moduleSpecifier as ts.StringLiteral).text
        if (
          specifier !== 'claude-code' &&
          !specifier.startsWith('./') &&
          !specifier.startsWith('../')
        )
          fail(node, `Only plugin-relative imports are allowed: ${specifier}`)
        if (
          specifier === 'claude-code' &&
          ts.isImportDeclaration(node) &&
          !node.importClause?.isTypeOnly
        ) {
          const bindings = node.importClause?.namedBindings
          if (
            !bindings ||
            !ts.isNamedImports(bindings) ||
            bindings.elements.some((item) => !item.isTypeOnly)
          )
            fail(node, 'Only type imports from claude-code are supported')
        }
        // Type imports do not need to exist at runtime.
        if (
          !(ts.isImportDeclaration(node) && node.importClause?.isTypeOnly) &&
          !(ts.isExportDeclaration(node) && node.isTypeOnly)
        )
          specifiers.add(specifier)
      }
      if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword)
          fail(
            node,
            'Dynamic import is not supported; use a static plugin-relative import',
          )
        if (
          ts.isIdentifier(node.expression) &&
          ['require', 'eval', 'Function'].includes(node.expression.text)
        )
          fail(node, `${node.expression.text} is not available in a mod`)
        if (ts.isIdentifier(node.expression) && node.expression.text === 'on') {
          const event = node.arguments[0]
          if (!event || !ts.isStringLiteral(event))
            fail(node, 'The event passed to on() must be a string literal')
          const name = (event as ts.StringLiteral).text
          if (!MOD_EVENTS.has(name))
            fail(node, `Tau does not yet support mod event "${name}"`)
          events.add(name)
        }
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isPropertyAccessExpression(node.expression.expression) &&
          ts.isIdentifier(node.expression.expression.expression) &&
          node.expression.expression.expression.text === '$'
        ) {
          const method = `${node.expression.expression.name.text}.${node.expression.name.text}`
          if (!MOD_METHODS.has(method))
            fail(node, `Tau does not yet support mod API $.${method}`)
          calls.add(method)
        }
      }
      if (ts.isIdentifier(node) && node.text === '$') {
        const parent = node.parent
        if (ts.isParameter(parent) && parent.name === node) {
          /* hook parameter */
        } else if (
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === node
        ) {
          const outer = parent.parent
          if (
            parent.name.text !== 'plugin' &&
            !(
              ts.isPropertyAccessExpression(outer) &&
              outer.expression === parent &&
              ts.isCallExpression(outer.parent) &&
              outer.parent.expression === outer
            )
          )
            fail(
              node,
              'Write mod API calls as $.namespace.method(...); namespaces cannot be aliased',
            )
        } else fail(node, 'The mod API cannot be passed or aliased')
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
    for (const specifier of specifiers) {
      if (specifier === 'claude-code') {
        imports[specifier] = 'claude-code'
        continue
      }
      const requested = resolve(dirname(canonical), specifier)
      // TypeScript sources commonly import their eventual .js filename.
      const candidates = [
        requested,
        ...(extname(requested) === '.js'
          ? [requested.slice(0, -3) + '.ts', requested.slice(0, -3) + '.tsx']
          : []),
      ]
      let target: string | undefined
      for (const candidate of candidates) {
        try {
          target = await realpath(candidate)
          break
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      if (!target) throw new Error(`Mod import not found: ${requested}`)
      imports[specifier] = await load(target)
    }
    const compiled = ts.transpileModule(source, {
      fileName: canonical,
      reportDiagnostics: true,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.React,
        jsxFactory: 'h',
        jsxFragmentFactory: 'Fragment',
        strict: true,
      },
    })
    const errors = compiled.diagnostics?.filter(
      (d) => d.category === ts.DiagnosticCategory.Error,
    )
    if (errors?.length)
      throw new Error(
        `${canonical}: ${errors.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')).join('\n')}`,
      )
    files[canonical]!.code = compiled.outputText
    return canonical
  }
  const canonicalEntry = await load(entry)
  return {
    entry: canonicalEntry,
    files,
    events: [...events],
    calls: [...calls],
    digest: hash.digest('hex'),
  }
}
