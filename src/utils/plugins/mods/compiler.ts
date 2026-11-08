import { createHash } from 'crypto'
import { readFile, realpath } from 'fs/promises'
import { dirname, extname, relative, resolve, sep } from 'path'
import ts from 'typescript'
import { isWithinDirectory } from '../pluginFiles.js'

import { CORE_NOUNS, MOD_METHODS, modEventPatternError } from './contracts.js'
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
  /** The variable names its `$.env.get` / `$.env.set` calls spell. */
  env?: { reads: string[]; writes: string[] }
  /** The named values its `$.state` calls (and the library's `read` and
   * `update`) refer to by literal, each `{ plugin, key }`. */
  state?: { reads: StateName[]; writes: StateName[] }
  /** Its `Client` modules: the path under the plugin's folder a drawing
   * names, and the compiled file that path runs (in `files`). */
  clients?: Record<string, string>
  digest: string
}
type StateName = { plugin: string; key: string }

/** The values the claude-code library exports: the `$.state` helpers.
 * `read` and `update` take a hook's `$` as their first argument. */
const LIBRARY_VALUES = new Set(['atom', 'derive', 'memberOf', 'read', 'update'])
const STATE_TAKERS = new Set(['read', 'update'])

/** The local names a file binds the library's `read`/`update` to, and its
 * namespace imports of the library. */
function libraryBindings(ast: ts.SourceFile): { takers: ts.Identifier[]; namespaces: ts.Identifier[]; values: Map<string, string> } {
  const takers: ts.Identifier[] = [], namespaces: ts.Identifier[] = []
  const values = new Map<string, string>()
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) ||
        statement.moduleSpecifier.text !== 'claude-code' || statement.importClause?.isTypeOnly) continue
    const bindings = statement.importClause?.namedBindings
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.push(bindings.name)
    else if (bindings && ts.isNamedImports(bindings))
      for (const item of bindings.elements) {
        if (item.isTypeOnly) continue
        const name = (item.propertyName ?? item.name).text
        values.set(item.name.text, name)
        if (STATE_TAKERS.has(name)) takers.push(item.name)
      }
  }
  return { takers, namespaces, values }
}

const sortedNames = (names: Map<string, StateName>): StateName[] =>
  [...names.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, name]) => name)

/**
 * The `{ plugin, key }` values an argument of a `$.state` call names, read
 * from literals in this file: a reference written in place, a top-level
 * constant holding one, an atom or a family member made from one, or a
 * derived value over such sources. Anything computed names nothing.
 */
function stateNameReader(ast: ts.SourceFile, library: Map<string, string>) {
  const constants = new Map<string, ts.Expression>()
  for (const statement of ast.statements)
    if (ts.isVariableStatement(statement) && statement.declarationList.flags & ts.NodeFlags.Const)
      for (const declaration of statement.declarationList.declarations)
        if (ts.isIdentifier(declaration.name) && declaration.initializer)
          constants.set(declaration.name.text, declaration.initializer)
  const unwrap = (node: ts.Expression): ts.Expression => {
    while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) ||
        ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node))
      node = node.expression
    return node
  }
  const text = (literal: ts.ObjectLiteralExpression, name: string): string | undefined => {
    for (const property of literal.properties)
      if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
          property.name.text === name) {
        const value = unwrap(property.initializer)
        return ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value) ? value.text : undefined
      }
    return undefined
  }
  const names = (expression: ts.Expression, depth: number): StateName[] => {
    if (depth > 16) return []
    const node = unwrap(expression)
    if (ts.isObjectLiteralExpression(node)) {
      const plugin = text(node, 'plugin'), key = text(node, 'key')
      return plugin && key ? [{ plugin, key }] : []
    }
    if (ts.isIdentifier(node)) {
      const value = constants.get(node.text)
      return value ? names(value, depth + 1) : []
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'ref') return names(node.expression, depth + 1)
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const helper = library.get(node.expression.text)
      const [first] = node.arguments
      if ((helper === 'atom' || helper === 'memberOf') && first) return names(first, depth + 1)
      if (helper === 'derive' && first && ts.isArrayLiteralExpression(unwrap(first)))
        return (unwrap(first) as ts.ArrayLiteralExpression).elements.flatMap(item => names(item, depth + 1))
    }
    return []
  }
  return (expression: ts.Expression) => names(expression, 0)
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
  const library = libraryBindings(ast)
  if (!candidates.length && !library.takers.length && !library.namespaces.length)
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
  const takers = new Set(library.takers.map(name => checker.getSymbolAtLocation(name)).filter(Boolean))
  const namespaces = new Set(library.namespaces.map(name => checker.getSymbolAtLocation(name)).filter(Boolean))
  return {
    accepts(node: ts.Identifier): boolean {
      const call = node.parent
      if (!ts.isCallExpression(call)) return false
      // The library's read($, source) and update($, target, fn) call
      // $.state on the $ they are handed, as the hook itself would.
      if (call.arguments[0] === node) {
        const callee = call.expression
        if (ts.isIdentifier(callee) && takers.has(checker.getSymbolAtLocation(callee)))
          return true
        if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) &&
            STATE_TAKERS.has(callee.name.text) && namespaces.has(checker.getSymbolAtLocation(callee.expression)))
          return true
      }
      if (!ts.isIdentifier(call.expression)) return false
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
  const envReads = new Set<string>(), envWrites = new Set<string>()
  const clients: Record<string, string> = Object.create(null)
  const stateReads = new Map<string, StateName>(), stateWrites = new Map<string, StateName>()
  const noteState = (into: Map<string, StateName>, names: StateName[]) => {
    for (const name of names) into.set(JSON.stringify([name.plugin, name.key]), name)
  }
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
    const library = libraryBindings(ast)
    const stateNames = stateNameReader(ast, library.values)
    const visit = (node: ts.Node) => {
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
          // Its types, and the $.state helpers as values.
          const clause = node.importClause
          if (clause?.name)
            fail(node, 'claude-code has no default export; import its values by name')
          const bindings = clause?.namedBindings
          if (bindings && ts.isNamedImports(bindings))
            for (const item of bindings.elements) {
              const name = (item.propertyName ?? item.name).text
              if (!item.isTypeOnly && !LIBRARY_VALUES.has(name))
                fail(item, `claude-code has no value ${name} in Tau; its values are atom, derive, memberOf, read and update`)
            }
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
          const refusal = modEventPatternError(name)
          if (refusal) fail(node, refusal)
          events.add(name)
        }
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isPropertyAccessExpression(node.expression.expression) &&
          ts.isIdentifier(node.expression.expression.expression) &&
          node.expression.expression.expression.text === '$'
        ) {
          const noun = node.expression.expression.name.text
          const method = `${noun}.${node.expression.name.text}`
          // A noun of Claude Code's own: its method must be one Tau serves. Any
          // other noun is one a mod adds at engine.create, checked after the fold.
          if (!MOD_METHODS.has(method) && CORE_NOUNS.has(noun))
            fail(node, `Tau does not yet support mod API $.${method}`)
          calls.add(method)
          const name = node.arguments[0]
          if ((method === 'env.get' || method === 'env.set') && name && ts.isStringLiteral(name))
            (method === 'env.get' ? envReads : envWrites).add(name.text)
          if ((method === 'state.get' || method === 'state.set') && name)
            noteState(method === 'state.get' ? stateReads : stateWrites, stateNames(name))
        }
        // The library's read and update make $.state calls of their own.
        const taker = ts.isIdentifier(node.expression)
          ? library.values.get(node.expression.text)
          : ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) &&
              library.namespaces.some(item => item.text === (node.expression as ts.PropertyAccessExpression).expression.getText(ast))
            ? node.expression.name.text
            : undefined
        if (taker === 'read' || taker === 'update') {
          calls.add('state.get')
          if (taker === 'update') calls.add('state.set')
          const source = node.arguments[1]
          if (source) {
            noteState(stateReads, stateNames(source))
            if (taker === 'update') noteState(stateWrites, stateNames(source))
          }
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
    // A Client's module: a string literal path, relative to this file, to a
    // file of the plugin. It is compiled here and the literal rewritten to
    // the path under the plugin's folder the drawing carries.
    const clientPaths: Array<{ start: number; end: number; specifier: string; node: ts.Node }> = []
    const clientLiteral = (holder: ts.Node, value: ts.Node | undefined) => {
      let literal = value
      if (literal && ts.isJsxExpression(literal)) literal = literal.expression
      if (!literal || !(ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal)))
        fail(holder, `A Client's module is a string literal path relative to this file, like module="./spinner.tsx"`)
      const text = (literal as ts.StringLiteral).text
      if (!text.startsWith('./') && !text.startsWith('../'))
        fail(holder, `A Client's module is a path relative to this file: ${text}`)
      clientPaths.push({ start: literal!.getStart(ast), end: literal!.end, specifier: text, node: holder })
    }
    for (const node of nodes) {
      if ((ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) && ts.isIdentifier(node.tagName) && node.tagName.text === 'Client') {
        const attribute = node.attributes.properties.find(
          (item): item is ts.JsxAttribute => ts.isJsxAttribute(item) && ts.isIdentifier(item.name) && item.name.text === 'module')
        if (attribute) clientLiteral(attribute, attribute.initializer)
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'h' &&
          node.arguments[0] && ts.isIdentifier(node.arguments[0]) && node.arguments[0].text === 'Client' &&
          node.arguments[1] && ts.isObjectLiteralExpression(node.arguments[1])) {
        const property = node.arguments[1].properties.find(
          (item): item is ts.PropertyAssignment => ts.isPropertyAssignment(item) && (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) && item.name.text === 'module')
        if (property) clientLiteral(property, property.initializer)
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
    let emitted = source
    for (const client of [...clientPaths].sort((a, b) => b.start - a.start)) {
      let target: string
      try {
        target = await realpath(resolve(dirname(canonical), client.specifier))
      } catch {
        fail(client.node, `A Client's module names no file: ${client.specifier}`)
      }
      if (!isWithinDirectory(canonicalRoot, target!))
        fail(client.node, `A Client's module is outside the plugin: ${client.specifier}`)
      const path = relative(canonicalRoot, target!).split(sep).join('/')
      clients[path] = await load(target!)
      emitted = emitted.slice(0, client.start) + JSON.stringify(path) + emitted.slice(client.end)
    }
    const compiled = ts.transpileModule(emitted, {
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
    ...(envReads.size || envWrites.size ? { env: { reads: [...envReads].sort(), writes: [...envWrites].sort() } } : {}),
    ...(stateReads.size || stateWrites.size
      ? { state: { reads: sortedNames(stateReads), writes: sortedNames(stateWrites) } }
      : {}),
    ...(Object.keys(clients).length ? { clients: { ...clients } } : {}),
    digest: hash.digest('hex'),
  }
}
