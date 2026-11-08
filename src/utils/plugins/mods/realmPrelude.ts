// The web APIs a hooks module has (Claude Code's declared globals): URL,
// URLSearchParams, TextEncoder/TextDecoder, AbortController/AbortSignal,
// atob/btoa, structuredClone, crypto and performance.now.
//
// They are built inside the module's realm, so no host object ever reaches
// plugin code: a host function or object there would hand out the host's
// Function constructor, and with it everything outside the realm. What the
// realm cannot compute itself (URL parsing, UTF-8, hashes, randomness, the
// clock, a timer) it asks of `__web`, a table of host helpers this script
// captures and deletes before any plugin code runs. Every helper takes and
// returns primitives, or fills a typed array the realm made; none throws.
export const MOD_REALM_PRELUDE = String.raw`
(function (web) {
  'use strict';
  delete globalThis.__web;
  const parse = JSON.parse, define = Object.defineProperty, freeze = Object.freeze;
  const named = (name, message) => { const error = new Error(message); error.name = name; return error; };
  const call = (text) => {
    const reply = parse(text);
    if (!reply.ok) throw new TypeError(reply.message);
    return reply.value;
  };

  // AbortController / AbortSignal: the signals a mod makes, and AbortSignal.any
  // over those and next.signal.
  const signals = new WeakMap();
  const CREATE = {};
  const fire = (signal, reason) => {
    const state = signals.get(signal);
    if (!state || state.aborted) return;
    state.aborted = true;
    state.reason = reason === undefined ? named('AbortError', 'This operation was aborted') : reason;
    const listeners = state.listeners;
    state.listeners = [];
    const event = freeze({ type: 'abort', target: signal });
    for (const listener of listeners) {
      try { listener.call(signal, event); } catch (error) { web.debug('an abort listener threw: ' + String(error && error.message !== undefined ? error.message : error)); }
    }
    if (typeof state.onabort === 'function') {
      try { state.onabort.call(signal, event); } catch (error) { web.debug('onabort threw: ' + String(error && error.message !== undefined ? error.message : error)); }
    }
  };
  class AbortSignal {
    constructor(token) {
      if (token !== CREATE) throw new TypeError('Illegal constructor');
      signals.set(this, { aborted: false, reason: undefined, listeners: [], onabort: null });
    }
    get aborted() { return signals.get(this).aborted; }
    get reason() { return signals.get(this).reason; }
    get onabort() { return signals.get(this).onabort; }
    set onabort(value) { signals.get(this).onabort = typeof value === 'function' ? value : null; }
    throwIfAborted() { const state = signals.get(this); if (state.aborted) throw state.reason; }
    addEventListener(type, listener, options) {
      const state = signals.get(this);
      if (type !== 'abort' || typeof listener !== 'function' || state.aborted) return;
      if (state.listeners.includes(listener)) return;
      if (options && typeof options === 'object' && options.once) {
        const once = (...args) => { this.removeEventListener('abort', once); listener.apply(this, args); };
        state.listeners.push(once);
      } else state.listeners.push(listener);
    }
    removeEventListener(type, listener) {
      const state = signals.get(this);
      if (type === 'abort') state.listeners = state.listeners.filter(item => item !== listener);
    }
    static abort(reason) {
      const signal = new AbortSignal(CREATE);
      fire(signal, reason);
      return signal;
    }
    static timeout(ms) {
      if (typeof ms !== 'number' || !(ms >= 0) || ms > 2147483647) throw new TypeError('AbortSignal.timeout takes a delay in milliseconds');
      const signal = new AbortSignal(CREATE);
      web.after(Math.floor(ms), () => fire(signal, named('TimeoutError', 'The operation timed out')));
      return signal;
    }
    static any(list) {
      const signal = new AbortSignal(CREATE);
      for (const source of Array.from(list)) {
        if (!source || typeof source.addEventListener !== 'function') throw new TypeError('AbortSignal.any takes signals');
        if (source.aborted) { fire(signal, source.reason); return signal; }
      }
      for (const source of Array.from(list)) source.addEventListener('abort', () => fire(signal, source.reason), { once: true });
      return signal;
    }
  }
  class AbortController {
    #signal = new AbortSignal(CREATE);
    get signal() { return this.#signal; }
    abort(reason) { fire(this.#signal, reason); }
  }

  // TextEncoder / TextDecoder: UTF-8.
  const bytesOf = (value, what) => {
    if (value === undefined) return new Uint8Array(0);
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    throw new TypeError(what + ' takes an ArrayBuffer or a view of one');
  };
  class TextEncoder {
    get encoding() { return 'utf-8'; }
    encode(input = '') {
      const text = String(input);
      const out = new Uint8Array(web.utf8Length(text));
      web.utf8Write(text, out);
      return out;
    }
    encodeInto(input, destination) {
      if (!(destination instanceof Uint8Array)) throw new TypeError('encodeInto writes into a Uint8Array');
      const reply = call(web.utf8Into(String(input), destination));
      return { read: reply[0], written: reply[1] };
    }
  }
  class TextDecoder {
    #fatal; #ignoreBOM;
    constructor(label = 'utf-8', options) {
      const name = String(label).trim().toLowerCase();
      if (name !== 'utf-8' && name !== 'utf8' && name !== 'unicode-1-1-utf-8')
        throw new RangeError('TextDecoder here decodes utf-8 only, not ' + String(label));
      this.#fatal = !!(options && options.fatal);
      this.#ignoreBOM = !!(options && options.ignoreBOM);
    }
    get encoding() { return 'utf-8'; }
    get fatal() { return this.#fatal; }
    get ignoreBOM() { return this.#ignoreBOM; }
    decode(input, options) {
      return call(web.utf8Read(bytesOf(input, 'TextDecoder.decode'), this.#fatal, this.#ignoreBOM));
    }
  }

  // URLSearchParams: application/x-www-form-urlencoded, linked to a URL's
  // search when it came from one.
  const formEncode = text => encodeURIComponent(text)
    .replace(/[!'()~]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()).replace(/%20/g, '+');
  const formDecode = text => {
    const spaced = text.replace(/\+/g, ' ');
    try { return decodeURIComponent(spaced); } catch { return call(web.percentDecode(spaced)); }
  };
  const PARAMS = new WeakMap();
  class URLSearchParams {
    constructor(init = '') {
      const state = { list: [], update: null };
      PARAMS.set(this, state);
      if (init instanceof URLSearchParams) state.list = PARAMS.get(init).list.map(pair => [pair[0], pair[1]]);
      else if (init && typeof init === 'object') {
        if (typeof init[Symbol.iterator] === 'function') {
          for (const pair of init) {
            const items = Array.from(pair);
            if (items.length !== 2) throw new TypeError('A URLSearchParams pair has a name and a value');
            state.list.push([String(items[0]), String(items[1])]);
          }
        } else for (const name of Object.keys(init)) state.list.push([name, String(init[name])]);
      } else state.list = URLSearchParams.parse(String(init));
    }
    static parse(text) {
      const query = text.startsWith('?') ? text.slice(1) : text;
      const list = [];
      for (const part of query.split('&')) {
        if (!part) continue;
        const at = part.indexOf('=');
        list.push(at < 0 ? [formDecode(part), ''] : [formDecode(part.slice(0, at)), formDecode(part.slice(at + 1))]);
      }
      return list;
    }
    #changed() { const state = PARAMS.get(this); if (state.update) state.update(this.toString()); }
    get size() { return PARAMS.get(this).list.length; }
    append(name, value) { PARAMS.get(this).list.push([String(name), String(value)]); this.#changed(); }
    delete(name, value) {
      const state = PARAMS.get(this), key = String(name);
      state.list = state.list.filter(pair => pair[0] !== key || (value !== undefined && pair[1] !== String(value)));
      this.#changed();
    }
    get(name) { const pair = PARAMS.get(this).list.find(item => item[0] === String(name)); return pair ? pair[1] : null; }
    getAll(name) { return PARAMS.get(this).list.filter(item => item[0] === String(name)).map(item => item[1]); }
    has(name, value) { return PARAMS.get(this).list.some(item => item[0] === String(name) && (value === undefined || item[1] === String(value))); }
    set(name, value) {
      const state = PARAMS.get(this), key = String(name);
      const at = state.list.findIndex(item => item[0] === key);
      if (at < 0) state.list.push([key, String(value)]);
      else state.list = state.list.filter((item, index) => index === at || item[0] !== key).map((item, index) => index === at ? [key, String(value)] : item);
      this.#changed();
    }
    sort() {
      const state = PARAMS.get(this);
      state.list = state.list.map((pair, index) => [pair, index])
        .sort((a, b) => a[0][0] < b[0][0] ? -1 : a[0][0] > b[0][0] ? 1 : a[1] - b[1]).map(item => item[0]);
      this.#changed();
    }
    forEach(callback, thisArg) { for (const [name, value] of PARAMS.get(this).list.slice()) callback.call(thisArg, value, name, this); }
    keys() { return PARAMS.get(this).list.map(pair => pair[0])[Symbol.iterator](); }
    values() { return PARAMS.get(this).list.map(pair => pair[1])[Symbol.iterator](); }
    entries() { return PARAMS.get(this).list.map(pair => [pair[0], pair[1]])[Symbol.iterator](); }
    [Symbol.iterator]() { return this.entries(); }
    toString() { return PARAMS.get(this).list.map(pair => formEncode(pair[0]) + '=' + formEncode(pair[1])).join('&'); }
  }
  const linkParams = (params, list, update) => { const state = PARAMS.get(params); state.list = list; state.update = update; };

  // URL: the host's WHATWG parser reads and rewrites the href; the realm
  // keeps only strings.
  const parseURL = (url, base) => call(web.url(String(url), base === undefined ? '' : String(base), base !== undefined));
  class URL {
    #parts; #params = null;
    constructor(url, base) { this.#parts = parseURL(url, base); }
    static canParse(url, base) {
      return parse(web.url(String(url), base === undefined ? '' : String(base), base !== undefined)).ok;
    }
    #relink() {
      if (this.#params) linkParams(this.#params, URLSearchParams.parse(this.#parts.search), text => this.#set('search', text));
    }
    #set(part, value) {
      this.#parts = call(web.urlSet(this.#parts.href, part, String(value)));
      this.#relink();
    }
    get href() { return this.#parts.href; }
    set href(value) { this.#parts = parseURL(value); this.#relink(); }
    get protocol() { return this.#parts.protocol; }
    set protocol(value) { this.#set('protocol', value); }
    get username() { return this.#parts.username; }
    set username(value) { this.#set('username', value); }
    get password() { return this.#parts.password; }
    set password(value) { this.#set('password', value); }
    get host() { return this.#parts.host; }
    set host(value) { this.#set('host', value); }
    get hostname() { return this.#parts.hostname; }
    set hostname(value) { this.#set('hostname', value); }
    get port() { return this.#parts.port; }
    set port(value) { this.#set('port', value); }
    get pathname() { return this.#parts.pathname; }
    set pathname(value) { this.#set('pathname', value); }
    get search() { return this.#parts.search; }
    set search(value) { this.#set('search', value); }
    get hash() { return this.#parts.hash; }
    set hash(value) { this.#set('hash', value); }
    get origin() { return this.#parts.origin; }
    get searchParams() {
      if (!this.#params) {
        this.#params = new URLSearchParams();
        this.#relink();
      }
      return this.#params;
    }
    toString() { return this.#parts.href; }
    toJSON() { return this.#parts.href; }
  }

  // atob / btoa: Latin-1 strings and base64.
  const atob = data => {
    const text = String(data).replace(/[\t\n\f\r ]/g, '');
    if (text.length % 4 === 1 || /[^A-Za-z0-9+/=]/.test(text) || /=[^=]/.test(text) || /={3,}$/.test(text))
      throw named('InvalidCharacterError', 'The string to be decoded is not correctly encoded.');
    return call(web.atob(text));
  };
  const btoa = data => {
    const text = String(data);
    for (let index = 0; index < text.length; index++)
      if (text.charCodeAt(index) > 255) throw named('InvalidCharacterError', 'The string to be encoded contains characters outside of the Latin1 range.');
    return call(web.btoa(text));
  };

  // structuredClone: the values the HTML clone algorithm takes.
  const cloneError = what => named('DataCloneError', what + ' could not be cloned.');
  const clone = (value, seen) => {
    if (typeof value === 'function') throw cloneError('A function');
    if (typeof value === 'symbol') throw cloneError('A symbol');
    if (value === null || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);
    let out;
    if (Array.isArray(value)) {
      out = new Array(value.length);
      seen.set(value, out);
      for (const key of Object.keys(value)) out[key] = clone(value[key], seen);
      return out;
    }
    if (value instanceof Date) out = new Date(value.getTime());
    else if (value instanceof RegExp) out = new RegExp(value.source, value.flags);
    else if (value instanceof ArrayBuffer) out = value.slice(0);
    else if (value instanceof DataView) out = new DataView(value.buffer.slice(0), value.byteOffset, value.byteLength);
    else if (ArrayBuffer.isView(value)) out = new value.constructor(value);
    else if (value instanceof Boolean || value instanceof Number || value instanceof String) out = Object(value.valueOf());
    else if (value instanceof Error) {
      const Kind = [EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError].find(item => value instanceof item) || Error;
      out = new Kind(value.message);
      if (value.name !== Kind.name) out.name = String(value.name);
      if (typeof value.stack === 'string') out.stack = value.stack;
    } else if (value instanceof Map) {
      out = new Map();
      seen.set(value, out);
      for (const [key, item] of value) out.set(clone(key, seen), clone(item, seen));
      return out;
    } else if (value instanceof Set) {
      out = new Set();
      seen.set(value, out);
      for (const item of value) out.add(clone(item, seen));
      return out;
    } else if (value instanceof Promise || value instanceof WeakMap || value instanceof WeakSet || value instanceof WeakRef)
      throw cloneError('#<' + value.constructor.name + '>');
    else {
      out = {};
      seen.set(value, out);
      for (const key of Object.keys(value)) out[key] = clone(value[key], seen);
      return out;
    }
    seen.set(value, out);
    return out;
  };
  const structuredClone = value => clone(value, new Map());

  // crypto: randomness and digests.
  const INTEGER_ARRAYS = [Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, BigInt64Array, BigUint64Array];
  const DIGESTS = { 'sha-1': 'sha1', 'sha-256': 'sha256', 'sha-384': 'sha384', 'sha-512': 'sha512' };
  const crypto = freeze({
    randomUUID: () => web.uuid(),
    getRandomValues(array) {
      if (!INTEGER_ARRAYS.some(Kind => array instanceof Kind)) throw named('TypeMismatchError', 'getRandomValues takes an integer typed array');
      if (array.byteLength > 65536) throw named('QuotaExceededError', 'getRandomValues fills at most 65536 bytes');
      call(web.random(new Uint8Array(array.buffer, array.byteOffset, array.byteLength)));
      return array;
    },
    subtle: freeze({
      async digest(algorithm, data) {
        const name = String(algorithm && typeof algorithm === 'object' ? algorithm.name : algorithm).toLowerCase();
        const hash = DIGESTS[name];
        if (!hash) throw named('NotSupportedError', 'Unrecognized algorithm name');
        const hex = call(web.digest(hash, bytesOf(data, 'crypto.subtle.digest')));
        const out = new Uint8Array(hex.length / 2);
        for (let index = 0; index < out.length; index++) out[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
        return out.buffer;
      },
    }),
  });
  const performance = freeze({ now: () => web.now(), timeOrigin: web.timeOrigin() });

  for (const [name, value] of Object.entries({
    AbortController, AbortSignal, TextEncoder, TextDecoder, URL, URLSearchParams, atob, btoa, structuredClone, crypto, performance,
  })) define(globalThis, name, { value, writable: true, configurable: true, enumerable: false });
})(globalThis.__web);
`
