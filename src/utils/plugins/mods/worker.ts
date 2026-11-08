// Kept as source so the shipped CLI needs no extra worker file or runtime compiler.
// A separate worker lets the host terminate synchronous or asynchronous runaway code.
export const MOD_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
// A promise plugin code left rejected and unhandled (a call it did not await)
// would otherwise end this thread and every hook of the module with it.
process.on('unhandledRejection', reason => {
  let text;
  try { text = String(reason && reason.message !== undefined ? reason.message : reason); } catch { text = 'an unreadable reason'; }
  parentPort.postMessage({ type: 'debug', text: 'unhandled rejection in plugin code: ' + text.slice(0, 2000) });
});
const { AsyncLocalStorage } = require('node:async_hooks');
const lentContext = new AsyncLocalStorage();
const pending = new Map();
let sequence = 0;
const context = vm.createContext(Object.create(null), {
  codeGeneration: { strings: false, wasm: false },
});
// Work outside any hook (timer callbacks, calls made after a hook returned)
// has no invocation timeout. While it runs, report liveness so the host can
// unload a module whose plugin code blocks this thread.
let background = 0, busy = 0, alive;
const updateAlive = () => {
  if (background + busy > 0 && !alive) {
    parentPort.postMessage({ type: 'alive' });
    alive = setInterval(() => parentPort.postMessage({ type: 'alive' }), 5000);
    alive.unref();
  } else if (background + busy === 0 && alive) {
    clearInterval(alive);
    alive = undefined;
    parentPort.postMessage({ type: 'idle' });
  }
};
const bridge = (invocation, method, encoded, onId) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject, invocation, method });
  if (invocation === null) { background++; updateAlive(); }
  if (onId) onId(id);
  const ctx = invocation === null ? lentContext.getStore() : undefined;
  parentPort.postMessage({ type: 'call', id, invocation, method, args: JSON.parse(encoded), ...(ctx ? { ctx } : {}) });
});
const control = (kind, value) => {
  if (kind === 'busy') { busy += value; updateAlive(); }
  else if (kind === 'debug') parentPort.postMessage({ type: 'debug', text: String(value).slice(0, 4000) });
  else if (kind === 'cancel') parentPort.postMessage({ type: 'cancel', id: value });
  else if (kind === 'chunk') parentPort.postMessage({ type: 'chunk', ...JSON.parse(value) });
};
// What the realm's web APIs ask of Node (realmPrelude.ts). Each helper takes
// primitives, or a typed array the realm made, and answers a primitive or a
// JSON reply: never a host object or a host error.
const nodeCrypto = require('node:crypto');
const { performance: hostPerformance } = require('node:perf_hooks');
const safeText = value => { try { return String(value && value.message !== undefined ? value.message : value); } catch { return 'an unreadable error'; } };
const replyOf = fn => { try { return JSON.stringify({ ok: true, value: fn() }); } catch (error) { return JSON.stringify({ ok: false, message: safeText(error) }); } };
const bytesIn = view => Buffer.from(view.buffer, view.byteOffset, view.byteLength);
const urlParts = url => ({ href: url.href, origin: url.origin, protocol: url.protocol, username: url.username,
  password: url.password, host: url.host, hostname: url.hostname, port: url.port, pathname: url.pathname,
  search: url.search, hash: url.hash });
const URL_SETTERS = new Set(['protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash']);
context.__web = Object.freeze({
  debug: text => { try { control('debug', safeText(text)); } catch {} },
  url: (href, base, hasBase) => replyOf(() => {
    try { return urlParts(hasBase ? new URL(String(href), String(base)) : new URL(String(href))); }
    catch { throw new Error('Invalid URL'); }
  }),
  urlSet: (href, part, value) => replyOf(() => {
    const url = new URL(String(href));
    if (URL_SETTERS.has(part)) url[part] = String(value);
    return urlParts(url);
  }),
  utf8Length: text => Buffer.byteLength(String(text), 'utf8'),
  utf8Write: (text, view) => { try { bytesIn(view).write(String(text), 'utf8'); } catch {} },
  utf8Into: (text, view) => replyOf(() => {
    const done = new TextEncoder().encodeInto(String(text), bytesIn(view));
    return [done.read, done.written];
  }),
  utf8Read: (view, fatal, ignoreBOM) => replyOf(() => {
    try { return new TextDecoder('utf-8', { fatal: !!fatal, ignoreBOM: !!ignoreBOM }).decode(bytesIn(view)); }
    catch { throw new Error('The encoded data was not valid utf-8'); }
  }),
  percentDecode: text => replyOf(() => {
    const bytes = [];
    const source = String(text);
    for (let index = 0; index < source.length; index++) {
      const hex = source.slice(index + 1, index + 3);
      if (source[index] === '%' && /^[0-9A-Fa-f]{2}$/.test(hex)) { bytes.push(parseInt(hex, 16)); index += 2; }
      else {
        const point = source.codePointAt(index);
        if (point > 0xffff) index++;
        bytes.push(...Buffer.from(String.fromCodePoint(point), 'utf8'));
      }
    }
    return new TextDecoder().decode(Buffer.from(bytes));
  }),
  atob: text => replyOf(() => Buffer.from(String(text), 'base64').toString('latin1')),
  btoa: text => replyOf(() => Buffer.from(String(text), 'latin1').toString('base64')),
  uuid: () => nodeCrypto.randomUUID(),
  random: view => replyOf(() => { nodeCrypto.randomFillSync(bytesIn(view)); return 0; }),
  digest: (hash, view) => replyOf(() => nodeCrypto.createHash(String(hash)).update(bytesIn(view)).digest('hex')),
  now: () => hostPerformance.now(),
  timeOrigin: () => hostPerformance.timeOrigin,
  // AbortSignal.timeout: a timer that never keeps the worker alive; its
  // callback is plugin code, watched like a timer's.
  after: (ms, fn) => {
    const timer = setTimeout(() => {
      control('busy', 1);
      try { fn(); } catch (error) { control('debug', 'AbortSignal.timeout callback failed: ' + safeText(error)); }
      finally { control('busy', -1); }
    }, Math.max(0, Math.min(2147483647, Number(ms) || 0)));
    timer.unref();
  },
});
new vm.Script(workerData.prelude, { filename: 'tau:realm' }).runInContext(context, { timeout: 1000 });
context.__bridge = bridge;
context.__control = control;
const api = new vm.Script(
  '(' + function(bridge, control) {
    'use strict';
    delete globalThis.__bridge;
    delete globalThis.__control;
    const factories = Object.create(null), modules = Object.create(null), hooks = [];
    const signals = new Map(), budgets = new Map(), active = new Set(), traces = new Map();
    // engine.create: methods this module lent to $, the noun objects a fold
    // handed it (by identity, to tell a noun kept from one replaced), and the
    // nouns added or withheld once the fold settled.
    const lentFns = new Map(), nounDescriptors = new WeakMap(), builtNouns = new Map();
    let lentSeq = 0, engineState = { lent: Object.create(null), withheld: Object.create(null) };
    const NO_TRACE = Object.freeze([]);
    // Plugin globals are mutable. Keep transport serialization independent of
    // anything a handler returns or assigns to JSON.stringify/JSON.parse.
    const parse = JSON.parse, stringify = JSON.stringify, create = Object.create;
    const hasOwn = Object.hasOwn;
    let registering = true;
    const freeze = value => {
      if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const key of Object.keys(value)) freeze(value[key]);
      }
      return value;
    };
    const read = json => parse(json);
    const encodeResult = (matched, value) => {
      // A mod may attach toJSON to its result or Object.prototype. Neither
      // must be able to rewrite the transport's separate match decision.
      const envelope = create(null);
      envelope.matched = matched;
      if (matched) envelope.value = value;
      if (matched && value && typeof value === 'object' && hasOwn(value, 'value') && value.value === undefined) envelope.voidAPIValue = true;
      return stringify(envelope);
    };
    const encode = value => stringify(value, (_key, val) => val instanceof RegExp
      ? { __tauRegexp: val.source, flags: val.flags } : val);
    // An array filter is any-of; a filter against an array value holds when
    // some element matches it.
    const matches = (filter, value) => {
      if (Array.isArray(filter)) return filter.some(candidate => matches(candidate, value));
      if (Array.isArray(value)) return value.some(item => matches(filter, item));
      if (filter instanceof RegExp) {
        // A global/sticky RegExp must start fresh for every event, as it did
        // before matchers moved into this worker.
        return typeof value === 'string' && new RegExp(filter.source, filter.flags).test(value);
      }
      if (filter && typeof filter === 'object') {
        return !!value && typeof value === 'object' &&
          Object.entries(filter).every(([key, wanted]) => matches(wanted, value[key]));
      }
      return filter === value;
    };
    // The host's modPatternSelects, for next.is in a glob or negation hook.
    const selects = (pattern, event) => pattern === event || (event !== 'classic.MessageDisplay' &&
      (pattern === '*' ? !event.startsWith('telemetry.')
        : pattern.startsWith('!') ? !selects(pattern.slice(1), event)
          : pattern.endsWith('.*') && event.startsWith(pattern.slice(0, -1))));
    const describe =error => String(error && error.message !== undefined ? error.message : error);
    // A timer's wait is one host dispatch per period, outside any hook; its
    // callback runs here once that dispatch resolves.
    const startTimer = (method, ms, fn) => {
      if (typeof fn !== 'function') throw new Error('$.' + method + ' requires a callback');
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < (method === 'clock.every' ? 1 : 0))
        throw new Error('$.' + method + ' requires a delay in milliseconds');
      const timer = { cancelled: false, call: undefined };
      const fire = () => {
        control('busy', 1);
        let settled = true;
        try {
          const result = fn();
          if (result && typeof result.then === 'function') {
            settled = false;
            Promise.resolve(result).then(undefined, error => control('debug', '$.' + method + ' callback failed: ' + describe(error)))
              .finally(() => control('busy', -1));
          }
        } catch (error) {
          control('debug', '$.' + method + ' callback failed: ' + describe(error));
        } finally {
          if (settled) control('busy', -1);
        }
      };
      (async () => {
        try {
          while (!timer.cancelled) {
            await call(null, method, [ms], id => { timer.call = id; });
            timer.call = undefined;
            if (timer.cancelled) return;
            fire();
            if (method === 'clock.after') return;
          }
        } catch (error) {
          if (!timer.cancelled) control('debug', '$.' + method + ' stopped: ' + describe(error));
        }
      })();
      return Object.freeze({
        cancel() {
          if (timer.cancelled) return;
          timer.cancelled = true;
          if (timer.call !== undefined) control('cancel', timer.call);
        },
      });
    };
    // JSX and the terminal's element table: a tag is a constructor from
    // $.ui.resolve(e), and h() calls it, so a tree is plain data.
    const FRAGMENT = Object.freeze({ fragment: true });
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
      return Object.freeze({ type, props: Object.freeze(own),
        children: Object.freeze(source.children === undefined ? [] : flatten([source.children], [])) });
    };
    const ELEMENTS = Object.freeze({
      Box: element('Box'), Text: element('Text'), Button: element('Button'), Link: element('Link'),
      Code: element('Code'), Markdown: element('Markdown'), Input: element('Input'), Select: element('Select'),
      Raster: element('Raster'), Image: element('Image'), Client: element('Client'),
      Svg: props => flatten([props && typeof props === 'object' ? props.children : undefined], []),
    });
    const h = (type, props, ...children) => {
      if (type === FRAGMENT) return flatten(children, []);
      if (typeof type !== 'function') throw new Error('A JSX tag is an element from $.ui.resolve(e)');
      const merged = props && typeof props === 'object' ? { ...props } : {};
      if (children.length) merged.children = children.length === 1 ? children[0] : children;
      return type(merged);
    };
    globalThis.h = h;
    globalThis.Fragment = FRAGMENT;
    // A drawn control's closure stays here; the tree carries a reference the
    // host hands back when the control is used. A redraw drops the site's old ones.
    const TOKEN = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const handlerFns = new Map(), siteHandlers = new Map();
    let handlerSeq = 0;
    const encodeTree = (node, ids) => {
      if (Array.isArray(node)) return node.map(child => encodeTree(child, ids));
      if (!node || typeof node !== 'object' || typeof node.type !== 'string' || node.type === 'engine') return node;
      // A tree built by hand may leave out props or children.
      const source = node.props && typeof node.props === 'object' ? node.props : {};
      const props = {};
      for (const name of Object.keys(source)) {
        const value = source[name];
        if (typeof value === 'function') {
          const id = TOKEN + ':' + (++handlerSeq);
          handlerFns.set(id, value);
          ids.push(id);
          props[name] = { __handler: id };
        } else props[name] = value;
      }
      const children = node.children === undefined ? []
        : Array.isArray(node.children) ? node.children.map(child => encodeTree(child, ids)) : node.children;
      return { type: node.type, props, children };
    };
    // $.process.spawn: the command's output as an async iterator of
    // { stream, text } chunks, its exit on .result once read to the end;
    // leaving the loop early (or kill()) stops the command.
    const spawnStream = (invoke, argv, init) => {
      const started = invoke('process.spawn', init === undefined ? [argv] : [argv, init]);
      const buffer = [];
      let ended = false, settle, fail;
      const result = new Promise((resolve, reject) => { settle = resolve; fail = reject; });
      result.catch(() => {});
      const end = (error, value) => { if (ended) return; ended = true; error ? fail(error) : settle(value); };
      started.catch(error => end(error));
      const pull = async () => {
        const { id } = await started;
        const reply = await invoke('process.__next', [{ id }]);
        for (const chunk of reply.chunks) buffer.push(Object.freeze({ stream: chunk.stream, text: chunk.text }));
        if (reply.done) end(reply.error ? new Error(reply.error) : undefined, reply.result && Object.freeze(reply.result));
      };
      const stream = {
        async next() {
          while (!buffer.length && !ended) await pull();
          if (buffer.length) return { value: buffer.shift(), done: false };
          return { value: await result, done: true };
        },
        async return(value) {
          if (!ended) {
            try {
              const { id } = await started;
              await invoke('process.__kill', [{ id }]);
              while (!ended) { await pull(); buffer.length = 0; }
            } catch (error) { end(error); }
          }
          buffer.length = 0;
          return { value, done: true };
        },
        kill() { return stream.return(); },
        result,
        [Symbol.asyncIterator]() { return stream; },
      };
      return Object.freeze(stream);
    };
    // The claude-code library's values a module imports: the $.state helpers.
    // atom, derive and memberOf describe; read and update call $.state on
    // the $ a hook hands them, so a read made while drawing subscribes it.
    const isAtom = source => !!source && typeof source === 'object' && !!source.ref &&
      typeof source.ref === 'object' && hasOwn(source, 'initial');
    const isDerived = source => !!source && typeof source === 'object' &&
      Array.isArray(source.sources) && typeof source.compute === 'function';
    const copy = value => value === undefined ? undefined : parse(stringify(value));
    // A stored value under another shape tag reads as absent.
    const unshape = (source, value) => source.shape === undefined ? value
      : value && typeof value === 'object' && value.shape === source.shape ? value.value : undefined;
    const stateOf = ($, helper) => {
      if (!$ || !$.state || typeof $.state.get !== 'function')
        throw new Error(helper + ' takes the $ of a hook, whose $.state it calls');
      return $.state;
    };
    const derivedCache = new WeakMap();
    // A source's value and a stamp of the versions it was read at.
    const readSource = async ($, source) => {
      if (isDerived(source)) {
        const reads = [];
        for (const item of source.sources) reads.push(await readSource($, item));
        const stamp = '(' + reads.map(item => item.stamp).join(',') + ')';
        const cached = derivedCache.get(source);
        if (cached && cached.stamp === stamp) return { value: cached.value, stamp };
        const value = await source.compute(...reads.map(item => item.value));
        derivedCache.set(source, { stamp, value });
        return { value, stamp };
      }
      const got = await stateOf($, 'read($, source)').get(isAtom(source) ? source.ref : source);
      const stamp = String(got && got.version !== undefined ? got.version : 0);
      const raw = got ? got.value : undefined;
      if (!isAtom(source)) return { value: raw, stamp };
      const value = unshape(source, raw);
      return { value: value === undefined ? copy(source.initial) : value, stamp };
    };
    const LIBRARY = Object.freeze({
      atom(ref, initial, options) {
        if (!ref || typeof ref !== 'object' || typeof ref.plugin !== 'string' || typeof ref.key !== 'string')
          throw new Error('atom(ref, initial) takes a reference { plugin, key }');
        if (initial !== undefined && stringify(initial) === undefined) throw new Error('an atom\'s initial is JSON data');
        const out = { ref: Object.freeze({ ...ref }), initial: freeze(copy(initial)) };
        if (options && options.shape !== undefined) {
          if (typeof options.shape !== 'string') throw new Error('an atom\'s shape is a string');
          out.shape = options.shape;
        }
        return Object.freeze(out);
      },
      derive(sources, compute) {
        if (!Array.isArray(sources) || typeof compute !== 'function')
          throw new Error('derive(sources, fn) takes a list of sources and a function');
        return Object.freeze({ sources: Object.freeze([...sources]), compute });
      },
      memberOf(family, e) {
        if (!e || e.requestId === undefined || e.requestId === null)
          throw new Error('memberOf(family, e) takes the event being drawn');
        const id = String(e.requestId);
        if (isAtom(family)) {
          const out = { ref: Object.freeze({ ...family.ref, id }), initial: family.initial };
          if (family.shape !== undefined) out.shape = family.shape;
          return Object.freeze(out);
        }
        if (!family || typeof family !== 'object') throw new Error('memberOf(family, e) takes an atom or a reference');
        return Object.freeze({ ...family, id });
      },
      async read($, source) { return (await readSource($, source)).value; },
      // Reads, applies fn here, writes only while nothing else wrote, and
      // tries again on a miss: two presses before a redraw both land.
      async update($, target, change) {
        if (typeof change !== 'function') throw new Error('update($, target, fn) takes a function');
        const state = stateOf($, 'update($, target, fn)');
        const atomic = isAtom(target), ref = atomic ? target.ref : target;
        for (let attempt = 0; attempt < 64; attempt++) {
          const got = await state.get(ref);
          let current = got ? got.value : undefined;
          if (atomic) {
            current = unshape(target, current);
            if (current === undefined) current = copy(target.initial);
          }
          const value = await change(current);
          const stored = atomic && target.shape !== undefined ? { shape: target.shape, value } : value;
          const result = await state.set(ref, stored, { ifVersion: got && got.version !== undefined ? got.version : 0 });
          if (result && result.isSet) return value;
        }
        throw new Error('update could not write: the value kept changing under it');
      },
    });
    function on(event, matcher, handler) {
      if (!registering) throw new Error('on() may only be called during register()');
      if (typeof matcher === 'function') { handler = matcher; matcher = undefined; }
      if (typeof event !== 'string' || typeof handler !== 'function') throw new Error('Invalid mod registration');
      const hook = { event, matcher, handler };
      hooks.push(hook);
      return { catch(fn) { if (!registering || typeof fn !== 'function') throw new Error('Invalid catch handler'); hook.catch = fn; } };
    }
    function load(id) {
      if (id === 'claude-code') return LIBRARY;
      if (modules[id]) return modules[id].exports;
      const file = factories[id];
      if (!file) throw new Error('Unknown mod module: ' + id);
      const module = { exports: {} };
      modules[id] = module;
      const require = specifier => {
        if (!Object.hasOwn(file.imports, specifier)) throw new Error('Unregistered import: ' + specifier);
        return load(file.imports[specifier]);
      };
      file.factory(module.exports, require, module);
      return module.exports;
    }
    // $ for one caller: every method of the host's table, the timer, spawn
    // and element-table helpers, and this plugin's identity.
    const buildApi = (plugin, methods, invoke, check) => {
      const api = { plugin: freeze(read(plugin)) };
      for (const method of read(methods)) {
        const [namespace, name] = method.split('.');
        api[namespace] ??= {};
        api[namespace][name] = (...args) => {
          const pending = invoke(method, args);
          // These answer nothing (contracts.ts MOD_SYNC_METHODS); a failure
          // is the host's to log, never an unhandled rejection here.
          if (method === 'ui.log' || method === 'ui.toast' || method === 'ui.status' || method === 'ui.invalidate' || method === 'ui.notice') {
            pending.catch(() => {});
            return;
          }
          return pending;
        };
      }
      if (api.clock) {
        api.clock.after = (ms, fn) => { check(); return startTimer('clock.after', ms, fn); };
        api.clock.every = (ms, fn) => { check(); return startTimer('clock.every', ms, fn); };
      }
      if (api.process) api.process.spawn = (argv, init) => { check(); return spawnStream(invoke, argv, init); };
      // A clip's AbortSignal stays here; aborting it stops the host's player.
      if (api.audio && api.audio.play) api.audio.play = (clip, options) => {
        check();
        const settings = options && typeof options === 'object' ? options : {};
        const stop = settings.signal;
        if (stop !== undefined && (!stop || typeof stop.addEventListener !== 'function'))
          return Promise.reject(new Error('$.audio.play signal must be an AbortSignal'));
        if (settings.shouldLoop === true && !stop)
          return Promise.reject(new Error('$.audio.play with shouldLoop needs the signal that ends it'));
        if (stop && stop.aborted) return Promise.resolve();
        const rest = {};
        for (const key of Object.keys(settings)) if (key !== 'signal') rest[key] = settings[key];
        let id, stopped = false;
        const onAbort = () => { stopped = true; if (id !== undefined) control('cancel', id); };
        if (stop) stop.addEventListener('abort', onAbort);
        const pending = invoke('audio.play', options === undefined ? [clip] : [clip, rest], callId => {
          id = callId;
          if (stopped) control('cancel', id);
        });
        const done = () => { if (stop && typeof stop.removeEventListener === 'function') stop.removeEventListener('abort', onAbort); };
        return pending.then(value => { done(); return value; }, error => { done(); if (stopped) return undefined; throw error; });
      };
      // A read of the surface's element table, not a dispatch.
      if (api.ui) api.ui.resolve = () => ELEMENTS;
      return api;
    };
    const lentNoun = (methods, invoke) => freeze(Object.fromEntries(Object.entries(methods)
      .map(([name, id]) => [name, (...args) => invoke('lent.call', [id, args])])));
    // The nouns other mods added at engine.create, and the ones an org mod
    // withheld from every module's $.
    const withEngine = (api, invoke) => {
      for (const noun of Object.keys(engineState.lent)) api[noun] = lentNoun(engineState.lent[noun], invoke);
      for (const noun of Object.keys(engineState.withheld)) {
        const by = engineState.withheld[noun];
        const refuse = () => { throw new Error('$.' + noun + ' is withheld by ' + by); };
        api[noun] = freeze(Object.fromEntries(Object.keys(api[noun] || {}).map(name => [name, refuse])));
      }
      return api;
    };
    // What next(e) of an engine.create hook resolves to: $ as the steps
    // beneath built it. Its calls run in this module's own context, or in the
    // calling hook's while a method it lent runs.
    const materialize = (descriptor, invocation, plugin, methods) => {
      const own = buildApi(plugin, methods, (method, args, onId) => call(null, method, args, onId), () => {});
      const built = {};
      for (const noun of Object.keys(descriptor || {})) {
        const entry = descriptor[noun];
        built[noun] = entry.kind === 'lent' ? lentNoun(entry.methods, (method, args) => call(null, method, args))
          : own[noun] !== undefined ? freeze(own[noun]) : freeze({});
        nounDescriptors.set(built[noun], entry);
      }
      builtNouns.set(invocation, new Set(Object.keys(built)));
      return freeze(built);
    };
    // An engine.create step's answer as noun descriptors: nouns it kept by
    // identity, and the ones it added, whose methods stay here, lent.
    const encodeEngine = (result, invocation) => {
      if (!result || typeof result !== 'object' || Array.isArray(result))
        throw new Error('engine.create must return $ as built, with the nouns this plugin adds');
      const beneath = builtNouns.get(invocation) || new Set();
      const out = create(null);
      for (const noun of Object.keys(result)) {
        const value = result[noun];
        const known = value && typeof value === 'object' ? nounDescriptors.get(value) : undefined;
        if (known) { out[noun] = known; continue; }
        if (beneath.has(noun)) throw new Error('engine.create may not replace $.' + noun + ', which a step beneath built');
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('$.' + noun + ' must be an object of methods');
        const lent = create(null);
        for (const name of Object.keys(value)) {
          if (typeof value[name] !== 'function') throw new Error('$.' + noun + '.' + name + ' must be a function');
          const id = TOKEN + ':lent:' + (++lentSeq);
          lentFns.set(id, value[name]);
          lent[name] = id;
        }
        out[noun] = { kind: 'lent', methods: lent };
      }
      return out;
    };
    const call = async (invocation, method, args, onId) => {
      if ((method === 'store.set' || method === 'state.set') && stringify(args[1]) === undefined) throw new Error(method + ' requires JSON data');
      // JSON encodes undefined array entries as null. Omitted optional trailing
      // arguments must stay omitted across the worker boundary.
      while (args.length && args[args.length - 1] === undefined) args.pop();
      // next.budget stands still during a call, except a hook's own sleep.
      const budget = method === 'clock.sleep' ? undefined : budgets.get(invocation);
      if (budget && budget.waiting++ === 0) budget.paused = Date.now();
      try {
        const reply = read(await bridge(invocation, method, stringify(args), onId));
        // What settled beneath, for next.trace: set even when next() rejected.
        if (method === 'next' || method === 'next.pull') traces.set(invocation, freeze(Array.isArray(reply.trace) ? reply.trace : []));
        if (reply.error) throw new Error(reply.error);
        if (reply.voidAPIValue) reply.value.value = undefined;
        return reply.value;
      } finally {
        if (budget && --budget.waiting === 0) budget.deadline += Date.now() - budget.paused;
      }
    };
    return {
      install(id, imports, factory) { factories[id] = { imports: read(imports), factory }; },
      async initialize(entry, options) {
        const module = load(entry);
        if (typeof module.register !== 'function') throw new Error('Mod must export register(on, options)');
        await module.register(on, freeze(read(options)));
        registering = false;
        return encode(hooks.map(({ event, matcher, catch: failed }) => ({ event, matcher, hasCatch: !!failed })));
      },
      async invoke(index, invocation, encodedInput, encodedMeta, plugin, methods) {
        const input = freeze(read(encodedInput)), meta = read(encodedMeta);
        const hook = hooks[index];
        // Keep plugin-controlled matching off the host thread. This runs after
        // the host arms the invocation timeout, including for runaway regexes.
        if (!meta.error && hook.matcher && !matches(hook.matcher, input)) {
          return encodeResult(false);
        }
        let aborted = false;
        const listeners = new Set();
        let cancel;
        const cancelled = new Promise((_, reject) => { cancel = () => reject(new Error('Mod event aborted')); });
        const signal = Object.freeze({
          get aborted() { return aborted; },
          addEventListener(name, listener) { if (name === 'abort') listeners.add(listener); },
          removeEventListener(name, listener) { if (name === 'abort') listeners.delete(listener); },
          throwIfAborted() { if (aborted) throw new Error('Mod event aborted'); },
        });
        signals.set(invocation, () => {
          aborted = true;
          cancel();
          for (const listener of listeners) { try { Promise.resolve(listener()).catch(() => {}); } catch {} }
          listeners.clear();
        });
        const budget = { deadline: meta.deadline, waiting: 0, paused: 0 };
        budgets.set(invocation, budget);
        active.add(invocation);
        // After its hook returns, a call it left running (a then() callback,
        // a timer) runs in the mod's own context. A cancelled hook's calls stop.
        const invokeCall = async (method, args, onId) => {
          signal.throwIfAborted();
          if (active.has(invocation)) return call(invocation, method, args, onId);
          if (method === 'next' || method.startsWith('next.')) throw new Error('next() was called after its hook returned');
          return call(null, method, args, onId);
        };
        // An engine.create hook builds $ and has none of its own.
        const api = meta.event === 'engine.create' ? create(null)
          : withEngine(buildApi(plugin, methods, invokeCall, () => signal.throwIfAborted()), invokeCall);
        // A streaming event (turn.step): next(e) is the stream beneath, pulled
        // a batch at a time; its done value is the result, so yield* returns it.
        const streaming = meta.stream === true;
        const openStream = (event, tier) => {
          const opened = invokeCall('next.open', tier === undefined ? [event] : [event, tier]);
          opened.catch(() => {});
          const buffer = [];
          let ended = false, final, failure, settle, fail;
          const result = new Promise((resolve, reject) => { settle = resolve; fail = reject; });
          result.catch(() => {});
          const end = (error, value) => {
            if (ended) return;
            ended = true;
            if (error) { failure = error; fail(error); } else { final = value; settle(value); }
          };
          opened.catch(error => end(error));
          const pull = async () => {
            const { id } = await opened;
            const reply = await invokeCall('next.pull', [{ id }]);
            for (const chunk of reply.chunks) buffer.push(freeze(chunk));
            if (reply.done) end(reply.error ? new Error(reply.error) : undefined, reply.result === undefined ? undefined : freeze(reply.result));
          };
          const stream = {
            async next() {
              while (!buffer.length && !ended) await pull();
              if (buffer.length) return { value: buffer.shift(), done: false };
              if (failure) throw failure;
              return { value: final, done: true };
            },
            async return(value) {
              if (!ended) {
                try { const { id } = await opened; await invokeCall('next.cancel', [{ id }]); } catch {}
                end(undefined, undefined);
              }
              buffer.length = 0;
              return { value, done: true };
            },
            async throw(error) { await stream.return(); throw error; },
            result,
            [Symbol.asyncIterator]() { return stream; },
          };
          return Object.freeze(stream);
        };
        const next = streaming ? event => openStream(event) : async event => {
          const value = await invokeCall('next', [event]);
          return meta.event === 'engine.create' ? materialize(value, invocation, plugin, methods) : freeze(value);
        };
        Object.defineProperty(next, 'trace', { enumerable: true, get: () => traces.get(invocation) || NO_TRACE });
        Object.assign(next, {
          to: streaming ? (event, tier) => openStream(event, tier) : async (event, tier) => freeze(await invokeCall('next', [event, tier])),
          event: meta.event,
          is: pattern => typeof pattern === 'string' && selects(pattern, meta.event),
          signal, origin: freeze(meta.origin), called: meta.called,
          ...(meta.error ? { error: freeze(meta.error) } : {}),
          budget: Object.freeze({ ms: meta.budget, get remainingMs() { return Math.max(0, budget.deadline - (budget.waiting ? budget.paused : Date.now())); } }),
        });
        try {
          let produced = (meta.error ? hook.catch : hook.handler)(freeze(api), input, Object.freeze(next));
          let result;
          const isStream = value => !!value && typeof value.next === 'function' && typeof value[Symbol.asyncIterator] === 'function';
          // A plain function on a streaming event (a '*' observer): what it
          // resolves to is the stream beneath (return next(e)), drained as a
          // generator's would be, or its result.
          if (streaming && !isStream(produced) && produced && typeof produced.then === 'function')
            produced = await Promise.race([produced, cancelled]);
          if (streaming && isStream(produced)) {
            // Each chunk the hook yields goes up the chain as it comes.
            let yielded = 0;
            try {
              while (true) {
                const step = await Promise.race([produced.next(), cancelled]);
                if (step.done) { result = step.value; break; }
                if (++yielded > 100000) throw new Error(meta.event + ' hook yielded over 100000 chunks');
                const chunk = step.value === undefined ? null : step.value;
                control('chunk', stringify({ invocation, chunk }));
              }
            } finally {
              if (aborted) Promise.resolve().then(() => produced.return()).catch(() => {});
            }
          } else if (streaming) result = produced;
          else result = await Promise.race([produced, cancelled]);
          if (meta.event === 'engine.create') return encodeResult(true, encodeEngine(result, invocation));
          if (meta.event !== 'ui.render') return encodeResult(true, result);
          const ids = [], site = String(input.component) + ':' + String(input.requestId);
          const tree = encodeTree(result, ids);
          // The terminal shows the drawing before this one until this one
          // reaches it (through the hooks above, its checks), and keeps it if
          // this one is refused: a press there must still find its closure.
          // Closures of the last three drawings live; older ones are gone.
          const kept = [...(siteHandlers.get(site) || []), ids];
          while (kept.length > 3) for (const id of kept.shift()) handlerFns.delete(id);
          siteHandlers.set(site, kept);
          return encodeResult(true, tree);
        } finally { signals.delete(invocation); budgets.delete(invocation); active.delete(invocation); traces.delete(invocation); builtNouns.delete(invocation); }
      },
      abort(invocation) {
        const cancel = signals.get(invocation);
        signals.delete(invocation);
        budgets.delete(invocation);
        active.delete(invocation);
        cancel?.();
      },
      token: TOKEN,
      // The nouns added and withheld once the fold settled.
      setEngine(encoded) {
        const state = read(encoded);
        engineState = { lent: state.lent || create(null), withheld: state.withheld || create(null) };
      },
      // A method this module lent to $, called by another mod's code.
      async runLent(id, encodedArgs) {
        const fn = lentFns.get(id);
        if (!fn) throw new Error('That method is no longer lent');
        return fn(...read(encodedArgs));
      },
      // A control's own closure (onPress, onInput, onSubmit, onSelect), run
      // in this module's context when the person uses what it drew.
      async runHandler(id, encodedArgs) {
        const fn = handlerFns.get(id);
        if (!fn) throw new Error('This control was redrawn since; use it again');
        await fn(...read(encodedArgs));
      },
    };
  }.toString() + ')(__bridge, __control)',
).runInContext(context, { timeout: 1000 });
parentPort.on('message', message => {
  if (message.type === 'reply') {
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (request && request.invocation === null) { background--; updateAlive(); }
    request?.resolve(JSON.stringify({ value: message.value, error: message.error, voidAPIValue: message.voidAPIValue, trace: message.trace }));
    return;
  }
  if (message.type === 'handler') {
    busy++; updateAlive();
    Promise.resolve()
      .then(() => api.runHandler(message.handler, JSON.stringify(message.args ?? [])))
      .then(() => parentPort.postMessage({ type: 'handled', id: message.id }),
        error => parentPort.postMessage({ type: 'handled', id: message.id, error: String(error?.message ?? error) }))
      .finally(() => { busy--; updateAlive(); });
    return;
  }
  if (message.type === 'engine') {
    api.setEngine(JSON.stringify(message.state));
    return;
  }
  if (message.type === 'lent') {
    busy++; updateAlive();
    lentContext.run(message.ctx, () => Promise.resolve().then(() => api.runLent(message.lent, JSON.stringify(message.args ?? []))))
      .then(value => parentPort.postMessage({ type: 'lentDone', id: message.id, value: value === undefined ? undefined : JSON.parse(JSON.stringify(value)) }),
        error => parentPort.postMessage({ type: 'lentDone', id: message.id, error: String(error?.message ?? error) }))
      .finally(() => { busy--; updateAlive(); });
    return;
  }
  if (message.type === 'abort') {
    api.abort(message.invocation);
    for (const [id, request] of pending) {
      if (request.invocation !== message.invocation) continue;
      // A queued prompt has its own lifetime and settles with its actual drop
      // receipt even when the hook which submitted it is being cancelled.
      if (request.method === 'prompt.submit') continue;
      pending.delete(id);
      request.resolve(JSON.stringify({ error: 'Mod event aborted' }));
    }
    // Cancellation can resume a handler's catch/finally in microtasks. Only
    // acknowledge after those drain, so a runaway continuation cannot clear
    // the host watchdog before blocking this worker's event loop.
    setImmediate(() => parentPort.postMessage({ type: 'aborted', invocation: message.invocation }));
    return;
  }
  if (message.type === 'invoke') {
    // This timer runs outside the mod realm. It cannot fire while plugin code
    // blocks the worker, including after starting an unawaited host request.
    const heartbeat = setInterval(() => parentPort.postMessage({ type: 'heartbeat', invocation: message.invocation }), Math.max(1, Math.min(1000, Math.floor(message.meta.budget / 4))));
    heartbeat.unref();
    Promise.resolve(api.invoke(message.index, message.invocation, JSON.stringify(message.input), JSON.stringify(message.meta), JSON.stringify(workerData.plugin), JSON.stringify(workerData.methods)))
      .then(encoded => parentPort.postMessage({ type: 'result', id: message.invocation, ...JSON.parse(encoded) }))
      .catch(error => parentPort.postMessage({ type: 'result', id: message.invocation, error: String(error?.message ?? error) }))
      .finally(() => clearInterval(heartbeat));
  }
});
(async () => {
  for (const [id, file] of Object.entries(workerData.compiled.files)) {
    context.__install = api.install;
    new vm.Script('__install(' + JSON.stringify(id) + ',' + JSON.stringify(JSON.stringify(file.imports)) + ', function(exports, require, module) {\n' + file.code + '\n});', { filename: id }).runInContext(context, { timeout: 1000 });
    delete context.__install;
  }
  const hooks = JSON.parse(await api.initialize(workerData.compiled.entry, JSON.stringify(workerData.options)));
  parentPort.postMessage({ type: 'ready', hooks, token: api.token });
})().catch(error => parentPort.postMessage({ type: 'failed', error: String(error?.message ?? error) }));
`
