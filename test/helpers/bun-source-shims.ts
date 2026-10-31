// The rule build.mjs applies to the bundle, for a test run straight from source: a file this tree does not
// ship, or an optional package, resolves to the shared shim. Without it, any test whose imports reach one
// of them cannot even start. Loaded for every `bun run` and `bun test` here through bunfig.toml.
import { plugin } from 'bun'
import { existsSync, lstatSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { SHIM_SOURCE } from '../../build-shim.mjs'

const root = resolve(import.meta.dir, '../..')

// build.mjs adds this to the bundle too: this React has no useEffectEvent. Done through require, so the
// export is already there when the first ESM import of React takes its list of names.
const React = createRequire(import.meta.url)('react')
React.useEffectEvent ??= function useEffectEvent<T extends (...args: never[]) => unknown>(fn: T) {
  const ref = React.useRef(fn)
  ref.current = fn
  return React.useCallback(function (this: unknown, ...args: never[]) {
    return ref.current.apply(undefined, args)
  }, [])
}
const shim = () => ({ contents: SHIM_SOURCE, loader: 'js' as const })

function isShipped(path: string): boolean {
  const candidates = [
    path,
    path.replace(/\.js$/, '.ts'),
    path.replace(/\.js$/, '.tsx'),
    path.replace(/\.js$/, '.d.ts'),
    path.replace(/\.mjs$/, '.ts'),
    path.replace(/\.mjs$/, '.tsx'),
    `${path}.ts`,
    `${path}.tsx`,
    join(path, 'index.ts'),
    join(path, 'index.tsx'),
    join(path, 'index.js'),
  ]
  return candidates.some(file => existsSync(file) && !lstatSync(file).isDirectory())
}

plugin({
  name: 'tau-source-shims',
  setup(build) {
    // A bare specifier that cannot be resolved never reaches onResolve, so each one is named.
    for (const name of [
      '@ant/claude-for-chrome-mcp',
      '@ant/computer-use-input',
      '@ant/computer-use-mcp',
      '@ant/computer-use-swift',
      '@anthropic-ai/sandbox-runtime',
    ]) {
      build.module(name, shim)
    }
    build.module('color-diff-napi', () => ({
      contents: `export * from ${JSON.stringify(resolve(root, 'src/native-ts/color-diff/index.ts'))}`,
      loader: 'js',
    }))
    build.onResolve({ filter: /^(src\/|\.|[a-zA-Z]:|\/)/ }, args => {
      const absolute = args.path.startsWith('src/')
        ? resolve(root, args.path)
        : isAbsolute(args.path)
          ? args.path
          : resolve(dirname(args.importer), args.path)
      if (!absolute.startsWith(root) || absolute.includes('node_modules') || isShipped(absolute)) return undefined
      return { path: absolute, namespace: 'tau-shim' }
    })
    build.onLoad({ filter: /.*/, namespace: 'tau-shim' }, shim)
  },
})
