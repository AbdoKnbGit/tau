/**
 * The Python kernel, embedded as a string.
 *
 * Why embedded and not a `.py` file next to this one: `build.mjs` configures
 * esbuild with only `.ts`/`.tsx` loaders, and `package.json#files` ships only
 * `dist/`, `native/`, `scripts/` and `docs/`. A sibling `.py` would resolve in
 * a dev checkout and silently vanish from the npm tarball. Embedding keeps one
 * source of truth that behaves identically in both. `runnerCache.ts` writes it
 * to a hashed path under the OS temp dir once per content hash.
 *
 * Editing rules: the literal is `String.raw`, so a Python `"\n"` or a regex
 * `\s` passes through unchanged — do NOT double the backslashes. A backtick or
 * a `${` inside the Python would terminate or interpolate the template;
 * neither appears, and `evalTool.test.ts` asserts it stays that way.
 */
export const PYTHON_KERNEL_SOURCE: string = String.raw`
"""Persistent Python kernel for Tau's Eval tool.

Protocol: NDJSON over stdin/stdout, one JSON object per line, UTF-8.

  host -> kernel   {"type":"exec","id":str,"code":str}
                   {"type":"reset","id":str}
                   {"type":"exit"}

  kernel -> host   {"type":"ready","cancelPort":int,"version":str}
                   {"type":"stdout","id":str,"data":str}
                   {"type":"stderr","id":str,"data":str}
                   {"type":"display","id":str,"mime":str,"data":str}
                   {"type":"result","id":str,"text":str}
                   {"type":"error","id":str,"ename":str,"evalue":str,"traceback":str}
                   {"type":"status","id":str,"op":str,"detail":str}
                   {"type":"done","id":str,"ok":bool,"count":int,"cancelled":bool}

Cancellation does NOT use signals. The kernel opens a loopback socket at
startup and reports its port in the ready frame; the host connects and sends
the shared token to interrupt the running cell. This is the whole reason the
tool is usable on Windows, where Node's child.kill(signal) is documented to
ignore the signal and terminate the process outright -- there is no way to
raise KeyboardInterrupt in a child from Node on that platform. A daemon
thread blocked in accept() calls _thread.interrupt_main(), which behaves
identically on every platform.

Requests are dispatched strictly one at a time. On Windows a thread parked in
a blocking stdin read deadlocks native-extension imports under a pipe-backed
child (numpy#24290): the DLL load and the pending read wedge each other. We
never read stdin while a cell is running, so that cannot happen here.
"""

import ast
import base64
import io
import json
import linecache
import os
import re
import socket
import subprocess
import sys
import threading
import traceback
import _thread

KERNEL_VERSION = "1"

os.environ.setdefault("MPLBACKEND", "Agg")
os.environ.setdefault("PYTHONIOENCODING", "utf-8")

_emit_lock = threading.Lock()
_raw_stdout = sys.stdout
_current_id = ""
_exec_count = 0
_cancel_token = os.environ.get("TAU_EVAL_CANCEL_TOKEN", "")
# Set only while a cell is executing. A cancel racing a cell that already
# finished must not raise KeyboardInterrupt in the main read loop and take
# the whole kernel down with it.
_cell_running = threading.Event()

USER_NS = {"__name__": "__tau_eval__", "__builtins__": __builtins__}


def _emit(obj):
    line = json.dumps(obj, ensure_ascii=False, default=str)
    with _emit_lock:
        _raw_stdout.write(line + "\n")
        _raw_stdout.flush()


def _emit_status(op, detail=""):
    _emit({"type": "status", "id": _current_id, "op": op, "detail": str(detail)})


class _StreamProxy(io.TextIOBase):
    """Buffers writes and emits them as frames, flushing on newline or size."""

    def __init__(self, kind):
        self._kind = kind
        self._buf = []
        self._len = 0

    def writable(self):
        return True

    def write(self, text):
        if not isinstance(text, str):
            text = str(text)
        if not text:
            return 0
        self._buf.append(text)
        self._len += len(text)
        if "\n" in text or self._len >= 8192:
            self.flush()
        return len(text)

    def flush(self):
        if not self._buf:
            return
        data = "".join(self._buf)
        self._buf = []
        self._len = 0
        _emit({"type": self._kind, "id": _current_id, "data": data})

    def isatty(self):
        return False


def _start_cancel_server():
    """Listen on loopback; an authenticated connection interrupts the cell."""
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 0))
    srv.listen(8)
    port = srv.getsockname()[1]

    def loop():
        while True:
            try:
                conn, _addr = srv.accept()
            except OSError:
                return
            try:
                conn.settimeout(2.0)
                payload = conn.recv(512).decode("utf-8", "replace").strip()
                if not _cancel_token or payload != _cancel_token:
                    conn.sendall(b"no\n")
                elif _cell_running.is_set():
                    conn.sendall(b"ok\n")
                    _thread.interrupt_main()
                else:
                    # Nothing to interrupt. Answering idle is not just
                    # tidier: interrupting here would land in the main
                    # loop's readline and kill the kernel.
                    conn.sendall(b"idle\n")
            except Exception:
                pass
            finally:
                try:
                    conn.close()
                except Exception:
                    pass

    threading.Thread(target=loop, name="tau-eval-cancel", daemon=True).start()
    return port


class ToolBridgeError(RuntimeError):
    """Raised when a host tool invoked through tool.<name>() fails."""


def _bridge_config():
    base = os.environ.get("TAU_EVAL_BRIDGE_URL")
    token = os.environ.get("TAU_EVAL_BRIDGE_TOKEN")
    session = os.environ.get("TAU_EVAL_BRIDGE_SESSION")
    if not base or not token or not session:
        raise ToolBridgeError("the tool bridge is not available in this kernel")
    return base.rstrip("/"), token, session


def _bridge_post(path, payload):
    import urllib.error
    import urllib.request

    base, token, session = _bridge_config()
    body = dict(payload)
    body["session"] = session
    body["run"] = _current_id
    encoded = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        base + path,
        data=encoded,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + token,
        },
    )
    # A proxy must never be consulted for a host-owned loopback endpoint.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        raw = exc.read()
    except OSError as exc:
        raise ToolBridgeError("tool bridge unreachable: " + str(exc)) from None
    try:
        data = json.loads(raw)
    except ValueError:
        raise ToolBridgeError("tool bridge returned non-JSON: " + repr(raw[:200])) from None
    if not isinstance(data, dict) or not data.get("ok"):
        message = data.get("error") if isinstance(data, dict) else None
        raise ToolBridgeError(message or "tool bridge call failed")
    return data.get("value")


class _ToolCallable:
    __slots__ = ("_name",)

    def __init__(self, name):
        self._name = name

    def __repr__(self):
        return "<tool." + self._name + ">"

    def __call__(self, args=None, **kwargs):
        if args is None:
            merged = {}
        elif isinstance(args, dict):
            merged = dict(args)
        else:
            raise TypeError(
                "tool." + self._name + "(...) takes a dict of arguments or keyword arguments"
            )
        merged.update(kwargs)
        return _bridge_post("/v1/tool", {"name": self._name, "args": merged})


class _ToolProxy:
    __slots__ = ()

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return _ToolCallable(name)

    def __getitem__(self, name):
        return _ToolCallable(name)

    def list(self):
        """Names of the host tools this kernel is allowed to call."""
        return _bridge_post("/v1/tools", {})

    def __repr__(self):
        return "<tau tool bridge>"


def _image_payload(value):
    """Image bundle for a value, or None. Cheap: renders no text."""
    for attr, mime in (("_repr_png_", "image/png"), ("_repr_jpeg_", "image/jpeg")):
        hook = getattr(value, attr, None)
        if callable(hook):
            try:
                raw = hook()
            except Exception:
                raw = None
            if raw:
                if isinstance(raw, str):
                    return mime, raw
                return mime, base64.b64encode(raw).decode("ascii")

    savefig = getattr(value, "savefig", None)
    if callable(savefig):
        buf = io.BytesIO()
        try:
            savefig(buf, format="png", dpi=110, bbox_inches="tight")
            return "image/png", base64.b64encode(buf.getvalue()).decode("ascii")
        except Exception:
            pass

    if callable(getattr(value, "save", None)) and hasattr(value, "mode") and hasattr(value, "size"):
        buf = io.BytesIO()
        try:
            image = value if value.mode in ("RGB", "RGBA", "L") else value.convert("RGB")
            image.save(buf, format="PNG")
            return "image/png", base64.b64encode(buf.getvalue()).decode("ascii")
        except Exception:
            pass
    return None


def _display_payload(value):
    """Map a Python value to (mime, data) for the host, or None."""
    image = _image_payload(value)
    if image is not None:
        return image

    to_string = getattr(value, "to_string", None)
    if callable(to_string) and type(value).__name__ in ("DataFrame", "Series"):
        try:
            return "text/plain", to_string()
        except Exception:
            pass

    if isinstance(value, (dict, list)):
        try:
            return "application/json", json.dumps(value, ensure_ascii=False, default=str)
        except Exception:
            pass
    return None


def display(value):
    """Render a figure, image, dataframe or object in the transcript."""
    payload = _display_payload(value)
    if payload is None:
        _emit({"type": "display", "id": _current_id, "mime": "text/plain", "data": repr(value)})
        return
    mime, data = payload
    _emit({"type": "display", "id": _current_id, "mime": mime, "data": data})


def _capture_pyplot_figures():
    """Emit and close every open matplotlib figure after a cell."""
    pyplot = sys.modules.get("matplotlib.pyplot")
    if pyplot is None:
        return
    try:
        numbers = list(pyplot.get_fignums())
    except Exception:
        return
    for number in numbers:
        try:
            figure = pyplot.figure(number)
            buf = io.BytesIO()
            figure.savefig(buf, format="png", dpi=110, bbox_inches="tight")
            _emit(
                {
                    "type": "display",
                    "id": _current_id,
                    "mime": "image/png",
                    "data": base64.b64encode(buf.getvalue()).decode("ascii"),
                }
            )
            pyplot.close(figure)
        except Exception:
            continue


def _read(path, offset=1, limit=None):
    """Read a file straight from disk. No line cap -- this is the data path."""
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        text = handle.read()
    if offset > 1 or limit is not None:
        lines = text.splitlines(keepends=True)
        start = max(0, int(offset) - 1)
        end = start + int(limit) if limit else len(lines)
        text = "".join(lines[start:end])
    _emit_status("read", str(path))
    return text


def _write(path, content):
    """Write through the host Write tool.

    Deliberately not open(path, "w"). The host tracks a read-before-edit
    timestamp per file (FileStateCache); a direct write from here would leave
    that cache stale and the agent's next Edit on the same file would fail
    with "File has been modified since read". Routing through the tool keeps
    permissions, deny rules and that cache all correct.
    """
    _bridge_post("/v1/tool", {"name": "Write", "args": {"file_path": str(path), "content": content}})
    _emit_status("write", str(path))
    return str(path)


def _env(key=None, value=None):
    if key is None:
        return dict(os.environ)
    if value is None:
        return os.environ.get(key)
    os.environ[key] = str(value)
    return str(value)


def _log(message):
    _emit_status("log", message)


def _sh(command):
    proc = subprocess.run(command, shell=True, capture_output=True, text=True)
    if proc.stdout:
        sys.stdout.write(proc.stdout)
    if proc.stderr:
        sys.stderr.write(proc.stderr)
    return proc.stdout.rstrip("\n").splitlines()


def _pip(args):
    proc = subprocess.run(
        [sys.executable, "-m", "pip"] + args.split(),
        capture_output=True,
        text=True,
    )
    sys.stdout.write(proc.stdout or "")
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr or "")
        return proc.returncode
    # A freshly installed package must not stay shadowed by a failed earlier
    # import cached as None in sys.modules.
    for name in [m for m, mod in list(sys.modules.items()) if mod is None]:
        sys.modules.pop(name, None)
    return 0


def _cd(path):
    os.chdir(os.path.expanduser(str(path)))
    _emit_status("cd", os.getcwd())
    return os.getcwd()


def _ls(path="."):
    return sorted(os.listdir(os.path.expanduser(str(path))))


def _who(verbose=False):
    """Names the user defined, so the model can see what survived a restart."""
    hidden = set(_prelude()) | {"__name__", "__builtins__"}
    names = sorted(n for n in USER_NS if not n.startswith("_") and n not in hidden)
    if not verbose:
        return names
    rows = []
    for name in names:
        value = USER_NS[name]
        kind = type(value).__name__
        try:
            size = len(value)
            detail = kind + " len=" + str(size)
        except Exception:
            detail = kind
        rows.append(name + ": " + detail)
    return rows


def _reset_namespace():
    global USER_NS, _exec_count
    USER_NS = {"__name__": "__tau_eval__", "__builtins__": __builtins__}
    USER_NS.update(_prelude())
    _exec_count = 0


def _prelude():
    return {
        "tool": _ToolProxy(),
        "ToolBridgeError": ToolBridgeError,
        "display": display,
        "read": _read,
        "write": _write,
        "env": _env,
        "log": _log,
        "__tau_sh": _sh,
        "__tau_pip": _pip,
        "__tau_cd": _cd,
        "__tau_ls": _ls,
        "__tau_who": _who,
        "__tau_reset": _reset_namespace,
    }


_MAGIC_LINE = re.compile(r"^(\s*)(?:([A-Za-z_]\w*)\s*=\s*)?([%!])(.+)$")


def _rewrite_magics(source):
    """Rewrite IPython-style magics to plain calls, line by line.

    Line-level on purpose: a full AST-aware transform is not worth the surface
    area here. A "%" or "!" beginning a line inside a triple-quoted string
    would be rewritten incorrectly; that is the known and documented limit.
    """
    out = []
    in_block = False
    for line in source.split("\n"):
        # Toggle on parity, not on startswith. A line that opens and
        # closes its own triple quote must not flip the state and leave
        # every later magic un-rewritten, which turned a valid %pip into
        # a SyntaxError.
        ticks = line.count('"""') + line.count("'''")
        was_in_block = in_block
        if ticks % 2 == 1:
            in_block = not in_block
        if was_in_block or in_block or ticks:
            out.append(line)
            continue
        match = _MAGIC_LINE.match(line)
        if match is None:
            out.append(line)
            continue
        indent, target, sigil, rest = match.groups()
        rest = rest.strip()
        if sigil == "!":
            call = "__tau_sh(" + repr(rest) + ")"
        else:
            name, _, argument = rest.partition(" ")
            argument = argument.strip()
            if name == "pip":
                call = "__tau_pip(" + repr(argument) + ")"
            elif name == "cd":
                call = "__tau_cd(" + repr(argument or "~") + ")"
            elif name == "pwd":
                call = "__import__('os').getcwd()"
            elif name == "ls":
                call = "__tau_ls(" + repr(argument or ".") + ")"
            elif name == "reset":
                call = "__tau_reset()"
            elif name == "who":
                call = "__tau_who()"
            elif name == "whos":
                call = "__tau_who(True)"
            elif name == "env":
                call = "env(" + (repr(argument) if argument else "") + ")"
            else:
                out.append(line)
                continue
        out.append(indent + (target + " = " + call if target else call))
    return "\n".join(out)


def _exec_compiled(code_object, evaluate=False):
    import inspect

    result = eval(code_object, USER_NS) if evaluate else exec(code_object, USER_NS)
    # With PyCF_ALLOW_TOP_LEVEL_AWAIT the code object is a coroutine; drive it
    # to completion so the cell behaves as if await were synchronous.
    if inspect.iscoroutine(result):
        import asyncio

        try:
            loop = asyncio.get_event_loop_policy().get_event_loop()
            if loop.is_closed():
                raise RuntimeError("closed")
        except Exception:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
        result = loop.run_until_complete(result)
    return result


# Every cell compiles under its own filename, and its source is registered in
# linecache so a traceback can show the offending line -- with the column caret
# Python 3.11+ draws under the exact subexpression -- and name the cell the
# frame came from.
#
# The filename MUST be unique per cell. linecache keys on the filename and
# keeps one source per key, so a shared "<cell>" would hand back the NEWEST
# cell's text for an OLDER cell's frame: a confident, wrong source line with a
# caret under innocent code. That is worse than no source line, and it is the
# common case rather than an edge one, because the prompt tells the model to
# define helpers in one cell and call them from later cells.
#
# Monotonic and never reset. A reset clears the namespace, but reusing a
# number would resurrect exactly the collision this exists to prevent.
_cell_seq = 0

# Retained cell sources. Evicting the oldest degrades its frames back to "no
# source line", which is the previous behaviour -- never a wrong one.
_MAX_CACHED_CELLS = 50
_cached_cells = []


def _register_cell(name, code):
    """Make this cell's source retrievable by the traceback machinery.

    mtime None is deliberate: linecache.checkcache() skips entries whose mtime
    is None instead of dropping them, which is how a synthetic file survives a
    cache sweep.
    """
    linecache.cache[name] = (len(code), None, code.splitlines(keepends=True), name)
    _cached_cells.append(name)
    while len(_cached_cells) > _MAX_CACHED_CELLS:
        linecache.cache.pop(_cached_cells.pop(0), None)


def _run_cell(code):
    """Compile and run one cell; return the last expression value, if any."""
    global _cell_seq
    _cell_seq += 1
    name = "<cell-" + str(_cell_seq) + ">"
    _register_cell(name, code)

    flags = getattr(ast, "PyCF_ALLOW_TOP_LEVEL_AWAIT", 0)
    tree = ast.parse(code, filename=name, mode="exec")
    if not tree.body:
        return None

    last = tree.body[-1]
    if isinstance(last, ast.Expr):
        head = ast.Module(body=tree.body[:-1], type_ignores=[])
        tail = ast.Expression(body=last.value)
        if head.body:
            _exec_compiled(compile(head, name, "exec", flags))
        return _exec_compiled(compile(tail, name, "eval", flags), evaluate=True)
    _exec_compiled(compile(tree, name, "exec", flags))
    return None


# A PREFIX, because each cell compiles under "<cell-N>". Matching the whole
# "<cell>" would drop every user frame and leave the bare exception message.
CELL_FILE_MARKER = 'File "<cell-'


def _user_traceback(exc):
    """Render a traceback containing only the user's own frames.

    The rule is positional, not name-based: user code is compiled with a
    filename of the form "<cell-N>", so any frame from another file is kernel
    plumbing and means nothing to whoever reads the error.

    An earlier version dropped frames by function name (_run_cell,
    _exec_compiled) and therefore leaked whatever else happened to be on the
    stack -- Lib/ast.py for a SyntaxError, because the raise happens inside
    ast.parse, and two tau_kernel.py frames for a ToolBridgeError, because the
    raise happens inside the bridge helper. Filtering on the filename covers
    every such case, including ones not yet written.
    """
    frames = traceback.format_exception(type(exc), exc, exc.__traceback__)
    if not frames:
        return ""
    header, message = frames[0], frames[-1]

    # A frame is not always one list element. An ordinary frame carries its
    # source inline, but a SyntaxError splits the location, the offending line
    # and the caret across three elements, and only the first names the file.
    # So track the last file seen and let continuation lines inherit it --
    # dropping them is how the caret, the single most useful part of a
    # SyntaxError, went missing.
    body = []
    keeping = False
    for frame in frames[1:-1]:
        if frame.lstrip().startswith('File "'):
            keeping = CELL_FILE_MARKER in frame
        if keeping:
            body.append(frame)

    if not body:
        # Nothing of the user's is on the stack: raised entirely inside the
        # prelude, or before any frame existed. The message alone is the whole
        # story, and a "Traceback:" header above nothing is just noise.
        return message
    return "".join([header, *body, message])


def _handle_exec(request):
    global _current_id, _exec_count
    _current_id = str(request.get("id", ""))
    code = request.get("code") or ""
    cancelled = False
    ok = True

    proxy_out = _StreamProxy("stdout")
    proxy_err = _StreamProxy("stderr")
    saved_out, saved_err = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = proxy_out, proxy_err
    _cell_running.set()
    try:
        try:
            source = _rewrite_magics(code)
        except Exception:
            source = code
        try:
            value = _run_cell(source)
            _exec_count += 1
            if value is not None:
                # Only probe for an image here. The full display mapper
                # would render an entire DataFrame to text and then throw
                # it away in favour of repr().
                payload = _image_payload(value)
                if payload is not None:
                    _emit({"type": "display", "id": _current_id, "mime": payload[0], "data": payload[1]})
                else:
                    _emit({"type": "result", "id": _current_id, "text": repr(value)})
        except KeyboardInterrupt:
            cancelled = True
            ok = False
            _emit(
                {
                    "type": "error",
                    "id": _current_id,
                    "ename": "KeyboardInterrupt",
                    "evalue": "cell interrupted",
                    "traceback": "",
                }
            )
        except SystemExit as exc:
            ok = False
            _emit(
                {
                    "type": "error",
                    "id": _current_id,
                    "ename": "SystemExit",
                    "evalue": str(exc),
                    "traceback": "",
                }
            )
        except BaseException as exc:
            ok = False
            _emit(
                {
                    "type": "error",
                    "id": _current_id,
                    "ename": type(exc).__name__,
                    "evalue": str(exc),
                    "traceback": _user_traceback(exc),
                }
            )
        try:
            _capture_pyplot_figures()
        except Exception:
            pass
    finally:
        _cell_running.clear()
        proxy_out.flush()
        proxy_err.flush()
        sys.stdout, sys.stderr = saved_out, saved_err

    _emit(
        {
            "type": "done",
            "id": _current_id,
            "ok": ok,
            "count": _exec_count,
            "cancelled": cancelled,
        }
    )
    _current_id = ""


def main():
    port = _start_cancel_server()
    USER_NS.update(_prelude())
    cwd = os.environ.get("TAU_EVAL_CWD")
    if cwd and os.path.isdir(cwd):
        os.chdir(cwd)
        if cwd not in sys.path:
            sys.path.insert(0, cwd)
    _emit({"type": "ready", "cancelPort": port, "version": KERNEL_VERSION})

    while True:
        try:
            line = sys.stdin.readline()
        except KeyboardInterrupt:
            # A cancel that lost its race with a finishing cell. There is
            # nothing to interrupt; keep serving instead of dying.
            continue
        if not line:
            return
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except ValueError:
            continue
        kind = request.get("type")
        if kind == "exit":
            return
        if kind == "reset":
            _reset_namespace()
            _emit({"type": "done", "id": str(request.get("id", "")), "ok": True, "count": 0, "cancelled": False})
            continue
        if kind == "exec":
            rid = str(request.get("id", ""))
            try:
                _handle_exec(request)
            except BaseException as exc:
                _emit({"type": "error", "id": rid, "ename": type(exc).__name__, "evalue": str(exc), "traceback": ""})
                _emit({"type": "done", "id": rid, "ok": False, "count": _exec_count, "cancelled": False})


if __name__ == "__main__":
    main()
`
