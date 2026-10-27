// Kept as source so the shipped CLI needs no extra worker file or runtime compiler.
// A separate worker lets the host terminate synchronous or asynchronous runaway code.
export const MOD_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const vm = require('node:vm');
const pending = new Map();
let sequence = 0;
const context = vm.createContext(Object.create(null), {
  codeGeneration: { strings: false, wasm: false },
});
const bridge = (invocation, method, encoded) => new Promise((resolve, reject) => {
  const id = ++sequence;
  pending.set(id, { resolve, reject, invocation });
  parentPort.postMessage({ type: 'call', id, invocation, method, args: JSON.parse(encoded) });
});
context.__bridge = bridge;
const api = new vm.Script(
  '(' + function(bridge) {
    'use strict';
    delete globalThis.__bridge;
    const factories = Object.create(null), modules = Object.create(null), hooks = [];
    const signals = new Map(), budgets = new Map();
    // Plugin globals are mutable. Keep transport serialization independent of
    // anything a handler returns or assigns to JSON.stringify/JSON.parse.
    const parse = JSON.parse, stringify = JSON.stringify, create = Object.create;
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
      return stringify(envelope);
    };
    const encode = value => stringify(value, (_key, val) => val instanceof RegExp
      ? { __tauRegexp: val.source, flags: val.flags } : val);
    const matches = (filter, value) => {
      if (Array.isArray(filter)) return filter.some(candidate => matches(candidate, value));
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
    function on(event, matcher, handler) {
      if (!registering) throw new Error('on() may only be called during register()');
      if (typeof matcher === 'function') { handler = matcher; matcher = undefined; }
      if (typeof event !== 'string' || typeof handler !== 'function') throw new Error('Invalid mod registration');
      const hook = { event, matcher, handler };
      hooks.push(hook);
      return { catch(fn) { if (!registering || typeof fn !== 'function') throw new Error('Invalid catch handler'); hook.catch = fn; } };
    }
    function load(id) {
      if (id === 'claude-code') return Object.freeze({});
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
    const call = async (invocation, method, args) => {
      if (method === 'store.set' && stringify(args[1]) === undefined) throw new Error('store.set requires JSON data');
      const budget = budgets.get(invocation);
      if (budget && budget.waiting++ === 0) budget.paused = Date.now();
      try {
        const reply = read(await bridge(invocation, method, stringify(args)));
        if (reply.error) throw new Error(reply.error);
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
        const api = { plugin: freeze(read(plugin)) };
        const invokeCall = async (method, args) => {
          signal.throwIfAborted();
          return call(invocation, method, args);
        };
        for (const method of read(methods)) {
          const [namespace, name] = method.split('.');
          api[namespace] ??= {};
          api[namespace][name] = (...args) => {
            const pending = invokeCall(method, args);
            // ui.log is a synchronous API; report failures without unhandled rejections.
            if (method === 'ui.log') { pending.catch(() => {}); return; }
            return pending;
          };
        }
        const next = async event => freeze(await invokeCall('next', [event]));
        Object.assign(next, {
          signal, origin: freeze(meta.origin), called: meta.called,
          ...(meta.error ? { error: freeze(meta.error) } : {}),
          budget: Object.freeze({ ms: meta.budget, get remainingMs() { return Math.max(0, budget.deadline - (budget.waiting ? budget.paused : Date.now())); } }),
        });
        try {
          const result = await Promise.race([
            (meta.error ? hook.catch : hook.handler)(freeze(api), input, Object.freeze(next)),
            cancelled,
          ]);
          return encodeResult(true, result);
        } finally { signals.delete(invocation); budgets.delete(invocation); }
      },
      abort(invocation) {
        const cancel = signals.get(invocation);
        signals.delete(invocation);
        budgets.delete(invocation);
        cancel?.();
      },
    };
  }.toString() + ')(__bridge)',
).runInContext(context, { timeout: 1000 });
parentPort.on('message', message => {
  if (message.type === 'reply') {
    const request = pending.get(message.id);
    pending.delete(message.id);
    request?.resolve(JSON.stringify({ value: message.value, error: message.error }));
    return;
  }
  if (message.type === 'abort') {
    api.abort(message.invocation);
    for (const [id, request] of pending) {
      if (request.invocation !== message.invocation) continue;
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
  parentPort.postMessage({ type: 'ready', hooks });
})().catch(error => parentPort.postMessage({ type: 'failed', error: String(error?.message ?? error) }));
`
