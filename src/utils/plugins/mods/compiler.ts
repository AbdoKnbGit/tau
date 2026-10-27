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

/** Keep source inspection bounded without recursive JavaScript traversal. */
function modNodes(
  ast: ts.SourceFile,
  fail: (node: ts.Node, reason: string) => never,
): ts.Node[] {
  const nodes: ts.Node[] = []
  const pending = [{ node: ast as ts.Node, depth: 0 }]
  let scopes = 0
  while (pending.length) {
    const { node, depth } = pending.pop()!
    if (depth > 512) fail(node, 'Mod source is nested too deeply to scan')
    if (
      (ts.isFunctionLike(node) ||
        ts.isBlock(node) ||
        ts.isModuleBlock(node) ||
        ts.isClassLike(node)) &&
      ++scopes > 2000
    )
      fail(node, 'Mod source exceeds 2000 scopes')
    nodes.push(node)
    const children: ts.Node[] = []
    ts.forEachChild(node, (child) => {
      children.push(child)
    })
    for (let index = children.length - 1; index >= 0; index--)
      pending.push({ node: children[index]!, depth: depth + 1 })
  }
  return nodes
}

/** Resolve names lexically: a shadowed or imported name is not the helper. */
function modAPIHelpers(
  ast: ts.SourceFile,
  nodes: ts.Node[],
  fail: (node: ts.Node, reason: string) => never,
) {
  type Helper = {
    declaration: ts.Declaration
    fn: ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction
    parameters: readonly ts.ParameterDeclaration[]
  }
  const declarations: Array<{ name: ts.Identifier; helper: Helper }> = []
  for (const statement of ast.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body)
      declarations.push({
        name: statement.name,
        helper: {
          declaration: statement,
          fn: statement,
          parameters: statement.parameters,
        },
      })
    else if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.flags & ts.NodeFlags.Const
    ) {
      for (const declaration of statement.declarationList.declarations)
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer &&
          (ts.isArrowFunction(declaration.initializer) ||
            ts.isFunctionExpression(declaration.initializer))
        )
          declarations.push({
            name: declaration.name,
            helper: {
              declaration,
              fn: declaration.initializer,
              parameters: declaration.initializer.parameters,
            },
          })
    }
  }
  const candidates = declarations.filter(({ helper }) =>
    helper.parameters.some(
      (parameter) =>
        ts.isIdentifier(parameter.name) &&
        parameter.name.text === '$' &&
        !parameter.dotDotDotToken,
    ),
  )
  if (!candidates.length)
    return { accepts: (_node: ts.Identifier) => false, checkWrites() {} }
  // No type checking or dependency loading is needed; the binder supplies
  // declaration identity for this one already-parsed file.
  const host: ts.CompilerHost = {
    getSourceFile: (name) =>
      resolve(name) === resolve(ast.fileName) ? ast : undefined,
    getDefaultLibFileName: () => '',
    writeFile() {},
    getCurrentDirectory: () => dirname(ast.fileName),
    getDirectories: () => [],
    fileExists: (name) => resolve(name) === resolve(ast.fileName),
    readFile: () => undefined,
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  }
  const checker = ts
    .createProgram([ast.fileName], { noLib: true, noResolve: true }, host)
    .getTypeChecker()
  const helpers = new Map<ts.Symbol, Helper>()
  for (const { name, helper } of candidates) {
    const symbol = checker.getSymbolAtLocation(name)
    if (
      symbol &&
      symbol.declarations?.every(
        (declaration) =>
          declaration === helper.declaration ||
          (ts.isFunctionDeclaration(declaration) && !declaration.body),
      )
    ) {
      helpers.set(symbol, helper)
      // A named function expression's recursive name denotes the same
      // top-level function, but has its own lexical symbol.
      if (ts.isFunctionExpression(helper.fn) && helper.fn.name) {
        const self = checker.getSymbolAtLocation(helper.fn.name)
        if (self) helpers.set(self, helper)
      }
    }
  }
  const passed = new Set<ts.Symbol>()
  return {
    accepts(node: ts.Identifier): boolean {
      const call = node.parent
      if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression))
        return false
      const symbol = checker.getSymbolAtLocation(call.expression)
      const helper = symbol && helpers.get(symbol)
      const argumentIndex = call.arguments.indexOf(node)
      // Spreads make the runtime argument position unknowable. TypeScript's
      // explicit `this` parameter, unlike normal parameters, is erased.
      if (call.arguments.slice(0, argumentIndex).some(ts.isSpreadElement))
        return false
      const parameter = helper?.parameters.filter(
        (parameter) =>
          !ts.isIdentifier(parameter.name) || parameter.name.text !== 'this',
      )[argumentIndex]
      if (
        !symbol ||
        !parameter ||
        parameter.dotDotDotToken ||
        !ts.isIdentifier(parameter.name) ||
        parameter.name.text !== '$'
      )
        return false
      passed.add(symbol)
      return true
    },
    checkWrites() {
      const passedFunctions = new Set(
        [...passed].map((symbol) => helpers.get(symbol)!.fn),
      )
      for (const node of nodes) {
        if (!ts.isIdentifier(node)) continue
        if (node.text === 'arguments') {
          let owner = node.parent
          while (
            owner &&
            !(ts.isFunctionLike(owner) && !ts.isArrowFunction(owner))
          )
            owner = owner.parent
          if (owner && passedFunctions.has(owner as ts.FunctionDeclaration))
            fail(
              node,
              'A mod API helper must use its $ parameter directly, not arguments',
            )
        }
        const symbol = ts.isShorthandPropertyAssignment(node.parent)
          ? checker.getShorthandAssignmentValueSymbol(node.parent)
          : checker.getSymbolAtLocation(node)
        if (!symbol || !passed.has(symbol)) continue
        let target: ts.Node = node
        while (target.parent) {
          const parent = target.parent
          if (
            (ts.isBinaryExpression(parent) &&
              parent.left === target &&
              parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
              parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
            ((ts.isPrefixUnaryExpression(parent) ||
              ts.isPostfixUnaryExpression(parent)) &&
              (parent.operator === ts.SyntaxKind.PlusPlusToken ||
                parent.operator === ts.SyntaxKind.MinusMinusToken)) ||
            ((ts.isForOfStatement(parent) || ts.isForInStatement(parent)) &&
              parent.initializer === target)
          )
            fail(node, 'A mod API helper cannot be reassigned')
          if (
            (ts.isParenthesizedExpression(parent) &&
              parent.expression === target) ||
            ((ts.isAsExpression(parent) ||
              ts.isTypeAssertionExpression(parent) ||
              ts.isNonNullExpression(parent) ||
              ts.isSatisfiesExpression(parent)) &&
              parent.expression === target) ||
            (ts.isArrayLiteralExpression(parent) &&
              parent.elements.includes(target as ts.Expression)) ||
            ((ts.isSpreadElement(parent) || ts.isSpreadAssignment(parent)) &&
              parent.expression === target) ||
            (ts.isPropertyAssignment(parent) &&
              parent.initializer === target) ||
            (ts.isShorthandPropertyAssignment(parent) &&
              parent.name === target) ||
            ts.isObjectLiteralExpression(parent)
          )
            target = parent
          else break
        }
      }
    },
  }
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
    const nodes = modNodes(ast, fail)
    const helpers = modAPIHelpers(ast, nodes, fail)
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
        } else if (!helpers.accepts(node))
          fail(
            node,
            'The mod API can only be passed directly to a same-file top-level helper with a $ parameter; it cannot be aliased',
          )
      }
    }
    for (const node of nodes) visit(node)
    helpers.checkWrites()
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
