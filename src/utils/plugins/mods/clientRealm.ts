import vm from 'node:vm'
import { createHash, randomFillSync, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { MOD_REALM_PRELUDE } from './realmPrelude.js'

type Files = Record<string, { code: string; imports: Record<string, string> }>
type Rec = Record<string, any>

// A call into a Client module: its function, a listener, a timer. Longer and
// the instance unmounts; the drawing thread is the person's terminal.
const CALL_MS = 1000

const safeText = (value: unknown): string => {
  try {
    return String(value && (value as Rec).message !== undefined ? (value as Rec).message : value)
  } catch {
    return 'an unreadable error'
  }
}
const replyOf = (fn: () => unknown): string => {
  try {
    return JSON.stringify({ ok: true, value: fn() })
  } catch (error) {
    return JSON.stringify({ ok: false, message: safeText(error) })
  }
}
const bytesIn = (view: ArrayBufferView) => Buffer.from(view.buffer, view.byteOffset, view.byteLength)
const urlParts = (url: URL) => ({
  href: url.href, origin: url.origin, protocol: url.protocol, username: url.username, password: url.password,
  host: url.host, hostname: url.hostname, port: url.port, pathname: url.pathname, search: url.search, hash: url.hash,
})
const URL_SETTERS = new Set(['protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash'])

/** The realm prelude's host helpers (as the hooks worker has them): each
 * takes primitives or a typed array the realm made, and answers a primitive. */
function webHelpers(debug: (text: string) => void) {
  return Object.freeze({
    debug: (text: unknown) => { try { debug(safeText(text)) } catch {} },
    url: (href: unknown, base: unknown, hasBase: unknown) => replyOf(() => {
      try {
        return urlParts(hasBase ? new URL(String(href), String(base)) : new URL(String(href)))
      } catch {
        throw new Error('Invalid URL')
      }
    }),
    urlSet: (href: unknown, part: unknown, value: unknown) => replyOf(() => {
      const url = new URL(String(href))
      if (URL_SETTERS.has(String(part))) (url as unknown as Rec)[String(part)] = String(value)
      return urlParts(url)
    }),
    utf8Length: (text: unknown) => Buffer.byteLength(String(text), 'utf8'),
    utf8Write: (text: unknown, view: ArrayBufferView) => {
      try { bytesIn(view).write(String(text), 'utf8') } catch {}
    },
    utf8Into: (text: unknown, view: ArrayBufferView) => replyOf(() => {
      const done = new TextEncoder().encodeInto(String(text), bytesIn(view))
      return [done.read, done.written]
    }),
    utf8Read: (view: ArrayBufferView, fatal: unknown, ignoreBOM: unknown) => replyOf(() => {
      try {
        return new TextDecoder('utf-8', { fatal: !!fatal, ignoreBOM: !!ignoreBOM }).decode(bytesIn(view))
      } catch {
        throw new Error('The encoded data was not valid utf-8')
      }
    }),
    percentDecode: (text: unknown) => replyOf(() => {
      const bytes: number[] = []
      const source = String(text)
      for (let index = 0; index < source.length; index++) {
        const hex = source.slice(index + 1, index + 3)
        if (source[index] === '%' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
          bytes.push(parseInt(hex, 16))
          index += 2
        } else {
          const point = source.codePointAt(index)!
          if (point > 0xffff) index++
          bytes.push(...Buffer.from(String.fromCodePoint(point), 'utf8'))
        }
      }
      return new TextDecoder().decode(Buffer.from(bytes))
    }),
    atob: (text: unknown) => replyOf(() => Buffer.from(String(text), 'base64').toString('latin1')),
    btoa: (text: unknown) => replyOf(() => Buffer.from(String(text), 'latin1').toString('base64')),
    uuid: () => randomUUID(),
    random: (view: ArrayBufferView) => replyOf(() => { randomFillSync(bytesIn(view)); return 0 }),
    digest: (hash: unknown, view: ArrayBufferView) => replyOf(() => createHash(String(hash)).update(bytesIn(view)).digest('hex')),
    now: () => performance.now(),
    timeOrigin: () => performance.timeOrigin,
    // A Client's timers are the surface's `every`: nothing here may call the
    // module outside a timed call, so AbortSignal.timeout never fires in one.
    after: () => {},
  })
}

/**
 * The realm side: the plugin's files, the element table (no Client, Raster
 * or Image inside a Client), and the instances with their state, listeners
 * and timers. The host asks and reads through a mailbox only it and this
 * kernel hold (no accessor of the module's can sit on it), in JSON text:
 * nothing but strings crosses.
 */
const CLIENT_KERNEL = String.raw`
(function () {
  'use strict';
  const parse = JSON.parse, stringify = JSON.stringify, freeze = Object.freeze, hasOwn = Object.hasOwn;
  const factories = Object.create(null), modules = Object.create(null);
  const mailbox = Object.create(null);
  globalThis.__tau_mailbox = mailbox;
  globalThis.__tau_install = (id, imports, factory) => { factories[id] = { imports: parse(imports), factory }; };
  const load = id => {
    if (id === 'claude-code') return freeze({});
    if (modules[id]) return modules[id].exports;
    const file = factories[id];
    if (!file) throw new Error('Unknown module: ' + id);
    const module = { exports: {} };
    modules[id] = module;
    file.factory(module.exports, specifier => {
      if (!hasOwn(file.imports, specifier)) throw new Error('Unregistered import: ' + specifier);
      return load(file.imports[specifier]);
    }, module);
    return module.exports;
  };
  const describe = error => {
    try {
      const text = String(error && error.message !== undefined ? error.message : error);
      return text || (error && error.name ? String(error.name) : 'the module failed without a message');
    } catch { return 'the module failed without a message'; }
  };
  const FRAGMENT = freeze({ fragment: true });
  const flatten = (items, out) => {
    for (const item of items) {
      if (Array.isArray(item)) flatten(item, out);
      else if (item !== null && item !== undefined && item !== false && item !== true)
        out.push(typeof item === 'number' ? String(item) : item);
    }
    return out;
  };
  const element = type => props => {
    const source = props && typeof props === 'object' ? props : {};
    const own = {};
    for (const name of Object.keys(source)) if (name !== 'children') own[name] = source[name];
    return freeze({ type, props: freeze(own),
      children: freeze(source.children === undefined ? [] : flatten([source.children], [])) });
  };
  const ELEMENTS = freeze({
    Box: element('Box'), Text: element('Text'), Button: element('Button'), Link: element('Link'),
    Code: element('Code'), Markdown: element('Markdown'), Input: element('Input'), Select: element('Select'),
    Svg: props => flatten([props && typeof props === 'object' ? props.children : undefined], []),
  });
  globalThis.h = (type, props, ...children) => {
    if (type === FRAGMENT) return flatten(children, []);
    if (typeof type !== 'function') throw new Error('A JSX tag is an element from surface.elements');
    const merged = props && typeof props === 'object' ? { ...props } : {};
    if (children.length) merged.children = children.length === 1 ? children[0] : children;
    return type(merged);
  };
  globalThis.Fragment = FRAGMENT;
  // The component a module exports: its default, else its one PascalCase export.
  const componentOf = exports => {
    if (typeof exports === 'function') return exports;
    if (exports && typeof exports.default === 'function') return exports.default;
    const named = Object.keys(exports || {}).filter(name => /^[A-Z]/.test(name) && typeof exports[name] === 'function');
    if (named.length === 1) return exports[named[0]];
    throw new Error(named.length ? 'the module exports several components and no default' : 'the module exports no component');
  };
  const instances = new Map();
  let effects = [];
  // A drawn handler stays here; the tree names it.
  const encodeTree = (node, instance) => {
    if (Array.isArray(node)) return node.map(child => encodeTree(child, instance));
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return node;
    const source = node.props && typeof node.props === 'object' ? node.props : {};
    const props = {};
    for (const name of Object.keys(source)) {
      const value = source[name];
      if (typeof value === 'function') {
        const id = ++instance.handlerSeq;
        instance.handlers.set(id, value);
        props[name] = { __client: id };
      } else props[name] = value;
    }
    const children = Array.isArray(node.children) ? node.children.map(child => encodeTree(child, instance)) : [];
    return { type: node.type, props, children };
  };
  const surfaceOf = instance => freeze({
    elements: ELEMENTS,
    get state() { return instance.state; },
    setState(next) { instance.state = next; effects.push({ type: 'redraw' }); },
    get columns() { return instance.columns; },
    get rows() { return instance.rows; },
    every(ms, fn) {
      if (typeof fn !== 'function' || typeof ms !== 'number' || !(ms >= 16)) throw new Error('every(ms, fn) takes at least 16 milliseconds and a function');
      const id = ++instance.timerSeq;
      instance.timers.set(id, fn);
      effects.push({ type: 'every', id, ms: Math.floor(ms) });
      return () => { if (instance.timers.delete(id)) effects.push({ type: 'clear', id }); };
    },
    onPointer(fn) {
      instance.pointer = typeof fn === 'function' ? fn : undefined;
      effects.push({ type: 'listen', pointer: !!instance.pointer, key: !!instance.key });
      return () => { instance.pointer = undefined; effects.push({ type: 'listen', pointer: false, key: !!instance.key }); };
    },
    onKey(fn) {
      instance.key = typeof fn === 'function' ? fn : undefined;
      effects.push({ type: 'listen', pointer: !!instance.pointer, key: !!instance.key });
      return () => { instance.key = undefined; effects.push({ type: 'listen', pointer: !!instance.pointer, key: false }); };
    },
    post(data) {
      let text;
      try { text = stringify(data); } catch { text = undefined; }
      if (text === undefined || text.length > 100000) return;
      effects.push({ type: 'post', data: text });
    },
  });
  const handle = request => {
    const instance = instances.get(request.id);
    switch (request.type) {
      case 'mount': {
        const component = componentOf(load(request.entry));
        const created = { component, props: undefined, state: undefined, columns: 0, rows: 0, timers: new Map(), timerSeq: 0,
          handlers: new Map(), handlerSeq: 0, pointer: undefined, key: undefined, quietRenders: 0 };
        created.surface = surfaceOf(created);
        instances.set(request.id, created);
        return {};
      }
      case 'render': {
        if (!instance) throw new Error('the instance is gone');
        if (request.input) instance.quietRenders = 0;
        instance.props = request.props === undefined ? undefined : parse(request.props);
        instance.columns = request.columns;
        instance.rows = request.rows;
        instance.handlers.clear();
        const before = effects.length;
        const tree = encodeTree(instance.component(instance.props, instance.surface), instance);
        // setState on each of three renders in a row, nothing else between: a loop.
        if (effects.slice(before).some(item => item.type === 'redraw')) {
          if (++instance.quietRenders >= 3) throw new Error('a render loop: setState on every render with no input between');
        } else instance.quietRenders = 0;
        return { tree };
      }
      case 'pointer':
        if (instance && instance.pointer) { instance.quietRenders = 0; instance.pointer(freeze(request.event)); }
        return {};
      case 'key':
        if (instance && instance.key) { instance.quietRenders = 0; instance.key(freeze(request.event)); }
        return {};
      case 'timer': {
        const fn = instance && instance.timers.get(request.timer);
        if (fn) { instance.quietRenders = 0; fn(); }
        return {};
      }
      case 'handler': {
        const fn = instance && instance.handlers.get(request.handler);
        if (fn) { instance.quietRenders = 0; fn(...(Array.isArray(request.args) ? request.args : [])); }
        return {};
      }
      case 'unmount':
        instances.delete(request.id);
        return {};
    }
    throw new Error('unknown request');
  };
  const dispatch = () => {
    effects = [];
    let reply;
    try {
      const request = parse(mailbox.request);
      reply = { ok: true, value: handle(request), effects };
    } catch (error) {
      reply = { ok: false, error: describe(error), effects };
    }
    mailbox.request = undefined;
    try { mailbox.reply = stringify(reply); } catch { mailbox.reply = stringify({ ok: false, error: 'the module drew what cannot be sent', effects: [] }); }
  };
  // A module that replaces this only stops its own instances: the mailbox,
  // where the data passes, stays out of its reach.
  globalThis.__tau_dispatch = dispatch;
})();
`

export type ModClientReply = { ok: boolean; value?: Rec; error?: string; effects: Rec[] }

/**
 * The realm a plugin's Client modules run in on the drawing thread: no `$`,
 * no Node, the web APIs of a hooks module. Each call is bounded in time.
 */
export class ModClientRealm {
  private readonly context: vm.Context
  private readonly mailbox: Rec
  private readonly dispatch = new vm.Script('__tau_dispatch()', { filename: 'tau:client-dispatch' })

  constructor(readonly plugin: string, files: Files, debug: (text: string) => void) {
    this.context = vm.createContext(Object.create(null), {
      codeGeneration: { strings: false, wasm: false },
      // A promise the module settles inside a call settles before it returns.
      microtaskMode: 'afterEvaluate',
    })
    this.context.__web = webHelpers(debug)
    new vm.Script(MOD_REALM_PRELUDE, { filename: 'tau:realm' }).runInContext(this.context, { timeout: CALL_MS })
    new vm.Script(CLIENT_KERNEL, { filename: 'tau:client' }).runInContext(this.context, { timeout: CALL_MS })
    // Taken before any of the module's code runs, then out of its reach.
    this.mailbox = new vm.Script('__tau_mailbox', { filename: 'tau:client' }).runInContext(this.context, { timeout: CALL_MS })
    new vm.Script('delete globalThis.__tau_mailbox', { filename: 'tau:client' }).runInContext(this.context, { timeout: CALL_MS })
    for (const [id, file] of Object.entries(files))
      new vm.Script(
        '__tau_install(' + JSON.stringify(id) + ',' + JSON.stringify(JSON.stringify(file.imports)) +
          ', function(exports, require, module) {\n' + file.code + '\n});',
        { filename: id },
      ).runInContext(this.context, { timeout: CALL_MS })
    new vm.Script('delete globalThis.__tau_install', { filename: 'tau:client' }).runInContext(this.context, { timeout: CALL_MS })
  }

  /** One request into the realm, answered as JSON; a timeout or a broken
   * reply is the instance's failure. */
  call(request: Rec): ModClientReply {
    this.mailbox.request = JSON.stringify(request)
    this.mailbox.reply = undefined
    const started = Date.now()
    try {
      this.dispatch.runInContext(this.context, { timeout: CALL_MS })
    } catch {
      // What escapes the kernel is the time limit, or a module that broke the
      // realm; the thrown value is the realm's and is never read here.
      return {
        ok: false,
        error: Date.now() - started >= CALL_MS - 50 ? `a call ran past ${CALL_MS} ms` : 'the module broke its call',
        effects: [],
      }
    }
    const reply = this.mailbox.reply
    this.mailbox.reply = undefined
    if (typeof reply !== 'string') return { ok: false, error: 'the module broke its reply', effects: [] }
    try {
      const parsed = JSON.parse(reply) as ModClientReply
      return { ok: parsed.ok === true, value: parsed.value, error: parsed.error, effects: Array.isArray(parsed.effects) ? parsed.effects : [] }
    } catch {
      return { ok: false, error: 'the module broke its reply', effects: [] }
    }
  }
}
