/**
 * The Python kernel, embedded as a string.
 *
 * Why embedded and not a `.py` file next to this one: `build.mjs` configures
 * esbuild with only `.ts`/`.tsx` loaders, and `package.json#files` ships only
 * `dist/`, `native/` and `scripts/`. A sibling `.py` would resolve in
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
# Independent limits: one chart must not consume another chart's retries.
# The outer limits still bound unusually large batches and repeated displays.
_CHART_MAX_AUDITS = 32
_CHART_MAX_REPAIR_FIGURES = 16
_chart_audits_left = 0
_chart_repair_figures_left = 0
_chart_limit_hit = False
_chart_cache = {}
_chart_notes = {}
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


def _chart_boxes(fig, renderer):
    """Bounded snapshot of ordinary subplot labels, in the actual PNG draw.

    No extra draw, private matplotlib layout API, or changes to live text.
    Uncertain geometry is skipped: a false alarm can cause needless redraws.
    """
    from copy import copy
    from math import cos, sin, radians, isfinite
    from matplotlib.axis import Axis, Tick, XTick
    from matplotlib.axes import Axes
    from matplotlib.text import Text
    from matplotlib.colors import to_rgba

    if len(fig.axes) > 16:
        return None
    boxes, visited = [], 0
    stack = [(fig, False)]
    title_ids = {id(ax.title) for ax in fig.axes}
    while stack:
        artist, label = stack.pop()
        visited += 1
        if visited > 2048 or len(boxes) >= 256:
            return None
        if not artist.get_visible():
            continue
        if isinstance(artist, Axes) and artist.name != "rectilinear":
            continue
        if isinstance(artist, Axis):
            if not artist.axes.axison:
                continue
            label = True
        if isinstance(artist, Tick):
            axis = artist.axes.xaxis if isinstance(artist, XTick) else artist.axes.yaxis
            lo, hi = sorted(axis.get_view_interval())
            if not lo <= artist.get_loc() <= hi:
                continue
        if type(artist) is Text:
            if not (label or id(artist) in title_ids):
                continue
            value = artist.get_text()
            if not value.strip() or len(value) > 1000 or artist.get_wrap() or artist.get_usetex():
                continue
            if to_rgba(artist.get_color(), artist.get_alpha())[3] == 0:
                continue
            # A detached shallow copy lets us measure unrotated dimensions
            # without changing the user's rotation or marking their axes stale.
            text = copy(artist)
            text.stale_callback = None
            box = text.get_window_extent(renderer)
            if not all(isfinite(v) for v in box.extents) or box.width <= 0 or box.height <= 0:
                continue
            if text.get_clip_on():
                if text.get_clip_path() is not None:
                    continue
                clip = text.get_clip_box()
                if clip is not None and not (clip.contains(box.x0, box.y0) and clip.contains(box.x1, box.y1)):
                    continue
            angle = radians(text.get_rotation())
            ux, uy = cos(angle), sin(angle)
            text.set_transform_rotates_text(False)
            text.set_rotation(0)
            flat = text.get_window_extent(renderer)
            w, h = flat.width, flat.height
            # Wrapping/custom transforms may not form this rotated rectangle.
            if abs(abs(ux) * w + abs(uy) * h - box.width) > 0.5 or abs(abs(uy) * w + abs(ux) * h - box.height) > 0.5:
                continue
            name = " ".join(value.split())[:40]
            boxes.append((box.x0, box.y0, box.x1, box.y1, (box.x0 + box.x1) / 2,
                          (box.y0 + box.y1) / 2, ux, uy, w / 2, h / 2, name))
            continue
        children = artist.get_children()
        if len(children) + visited + len(stack) > 2048:
            return None
        stack.extend((child, label) for child in reversed(children))
    return boxes


def _chart_collisions(boxes):
    """Sweep by x, then test oriented rectangles; fixed work/output limits."""
    if boxes is None:
        return None
    boxes = sorted(boxes, key=lambda b: (b[0], b[1], b[10]))
    hits, comparisons = [], 0
    tolerance = 2.0  # Pixels in the fixed 110-DPI PNG, not machine/display DPI.
    for i, a in enumerate(boxes):
        for j in range(i + 1, len(boxes)):
            b = boxes[j]
            if b[0] >= a[2] - tolerance:
                break
            comparisons += 1
            if comparisons > 4096:
                return None
            if min(a[3], b[3]) - max(a[1], b[1]) <= tolerance:
                continue
            dx, dy = b[4] - a[4], b[5] - a[5]
            for x, y in ((a[6], a[7]), (-a[7], a[6]), (b[6], b[7]), (-b[7], b[6])):
                ra = a[8] * abs(a[6] * x + a[7] * y) + a[9] * abs(-a[7] * x + a[6] * y)
                rb = b[8] * abs(b[6] * x + b[7] * y) + b[9] * abs(-b[7] * x + b[6] * y)
                if ra + rb - abs(dx * x + dy * y) <= tolerance:
                    break
            else:
                hits.append((a[10], b[10]))
                if len(hits) == 16:
                    return hits
    return hits


def _chart_layout_state(fig):
    """Only adjust a simple subplot grid; custom/inset/twin layouts keep theirs."""
    axes = fig.axes
    if not 1 <= len(axes) <= 16:
        return None
    specs = []
    points = 0
    for ax in axes:
        if ax.name != "rectilinear" or not ax.axison or not ax.get_in_layout() or ax.get_axes_locator() is not None or ax.child_axes:
            return None
        spec = ax.get_subplotspec()
        if spec is None or spec.get_topmost_subplotspec() != spec:
            return None
        if specs and spec.get_gridspec() is not specs[0].get_gridspec():
            return None
        for other in specs:
            if (spec.rowspan.start < other.rowspan.stop and other.rowspan.start < spec.rowspan.stop
                    and spec.colspan.start < other.colspan.stop and other.colspan.start < spec.colspan.stop):
                return None
        specs.append(spec)
        if len(ax.lines) + len(ax.collections) > 128:
            return None
        for line in ax.lines:
            points += len(line.get_xdata())
        for collection in ax.collections:
            paths = collection.get_paths()
            if len(paths) > 256:
                return None
            points += len(collection.get_offsets()) + sum(len(path.vertices) for path in paths)
        if points > 100_000 or any(image.get_array().size > 2_000_000 for image in ax.images):
            return None
    size = tuple(fig.get_size_inches())
    # Extra renders must not multiply the cost of a poster-sized figure.
    if size[0] * size[1] * 110 * 110 > 2_000_000:
        return None
    params = {key: getattr(fig.subplotpars, key) for key in ("left", "bottom", "right", "top", "wspace", "hspace")}
    positions = [(ax, ax.get_position().frozen(), ax.get_position(original=True).frozen(), ax.get_in_layout()) for ax in axes]
    return size, params, positions


def _record_chart_note(value, note):
    if note and (id(value) in _chart_notes or len(_chart_notes) < _CHART_MAX_AUDITS):
        _chart_notes[id(value)] = note
    else:
        _chart_notes.pop(id(value), None)


def _save_chart_png(value):
    """Repair ordinary label collisions in memory before any image is emitted.

    All output still uses the existing PNG path. Diagnostics are advisory and
    never alter tool success, prompt/schema bytes, or previous result blocks.
    """
    global _chart_audits_left, _chart_repair_figures_left, _chart_limit_hit
    import warnings
    module = sys.modules.get("matplotlib.figure")
    eligible = module is not None and type(value) is module.Figure
    canvas, connection = None, None
    boxes, draws = None, 0
    original = None

    def on_draw(event):
        nonlocal boxes, draws
        boxes = None
        draws += 1
        if draws <= 4:
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    boxes = _chart_boxes(value, event.renderer)
            except Exception:
                pass

    def render():
        nonlocal boxes, draws
        boxes, draws = None, 0
        buf = io.BytesIO()
        value.savefig(buf, format="png", dpi=110, bbox_inches="tight")
        try:
            hits = _chart_collisions(boxes)
        except Exception:
            hits = None
        return buf.getvalue(), hits

    audit_allowed = eligible and _chart_audits_left > 0
    if audit_allowed:
        _chart_audits_left -= 1
        try:
            canvas = value.canvas
            connection = canvas.mpl_connect("draw_event", on_draw)
        except Exception:
            pass
    try:
        original, hits = render()
        if not eligible:
            return original
        # Repeated display(fig) / trailing fig / automatic capture must return
        # the same repair without spending another figure's allowance.
        import hashlib
        key = hashlib.sha256(original).digest()
        if key in _chart_cache:
            best, note = _chart_cache[key]
            _record_chart_note(value, note)
            return best
        if connection is None:
            if not audit_allowed:
                _chart_limit_hit = True
            return original
        best = original
        if hits and _chart_repair_figures_left <= 0:
            _chart_limit_hit = True
        if hits and _chart_repair_figures_left > 0:
            state = None
            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    state = _chart_layout_state(value)
                    if state is not None:
                        _chart_repair_figures_left -= 1
                        from matplotlib.layout_engine import TightLayoutEngine
                        engine = value.get_layout_engine()
                        # At most two attempts for THIS figure, independent of
                        # attempts already used by other figures in the cell.
                        for grow in (False, True):
                            if grow:
                                value.set_size_inches(state[0][0] * 1.4, state[0][1] * 1.4, forward=False)
                            if engine is None:
                                TightLayoutEngine(pad=1.2).execute(value)
                            candidate, candidate_hits = render()
                            # A partial improvement can trade one collision for
                            # another. Publish a repair only when the bounded
                            # inspection completed and found no collisions.
                            if candidate_hits == []:
                                best, hits = candidate, candidate_hits
                            if not hits:
                                break
            except Exception:
                # Keep the successfully rendered original (or verified repair).
                pass
            finally:
                if state is not None:
                    restores = [(value.set_size_inches, (state[0],), {"forward": False}),
                                (value.subplotpars.update, (), state[1])]
                    for ax, active, original_position, in_layout in state[2]:
                        restores.extend(((ax.set_position, (original_position,), {"which": "original"}),
                                         (ax.set_position, (active,), {"which": "active"}),
                                         (ax.set_in_layout, (in_layout,), {})))
                    for restore, args, kwargs in restores:
                        try:
                            restore(*args, **kwargs)
                        except Exception:
                            pass
        note = ""
        if hits:
            pairs = "; ".join(json.dumps(a, ensure_ascii=True) + " / " + json.dumps(b, ensure_ascii=True) for a, b in hits[:3])
            note = "[chart layout] Possible label overlap: " + pairs + ". Check and correct unintended overlap before presenting this chart."
        _record_chart_note(value, note)
        if len(_chart_cache) < _CHART_MAX_AUDITS and len(best) + sum(len(entry[0]) for entry in _chart_cache.values()) <= 8_000_000:
            _chart_cache[key] = (best, note)
        return best
    except Exception:
        if original is not None:
            return original
        raise
    finally:
        if connection is not None:
            try:
                canvas.mpl_disconnect(connection)
            except Exception:
                pass


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
        try:
            return "image/png", base64.b64encode(_save_chart_png(value)).decode("ascii")
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
        figure = None
        try:
            figure = pyplot.figure(number)
            raw = _save_chart_png(figure)
            _emit(
                {
                    "type": "display",
                    "id": _current_id,
                    "mime": "image/png",
                    "data": base64.b64encode(raw).decode("ascii"),
                }
            )
        except Exception:
            continue
        finally:
            if figure is not None:
                pyplot.close(figure)


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


def _pip_command(argv):
    """pip for this kernel's own interpreter, whatever made its environment.

    A venv made by uv has no pip unless asked for, so "python -m pip" fails
    there: use "uv pip ... --python <this interpreter>" when uv is on PATH,
    else bootstrap pip from the standard library first."""
    import importlib.util
    import shutil

    if importlib.util.find_spec("pip") is not None:
        return [sys.executable, "-m", "pip"] + argv
    uv = shutil.which("uv")
    if uv and argv and argv[0] in ("install", "uninstall", "list", "show", "freeze"):
        return [uv, "pip", argv[0], "--python", sys.executable] + argv[1:]
    boot = subprocess.run(
        [sys.executable, "-m", "ensurepip", "--upgrade"],
        capture_output=True,
        text=True,
    )
    if boot.returncode != 0:
        sys.stderr.write(
            "pip is not installed for " + sys.executable + " and could not be bootstrapped "
            "(install uv, or run: " + sys.executable + " -m ensurepip).\n" + (boot.stderr or "")
        )
        return None
    return [sys.executable, "-m", "pip"] + argv


def _pip(args):
    command = _pip_command(args.split())
    if command is None:
        return 1
    proc = subprocess.run(command, capture_output=True, text=True)
    sys.stdout.write(proc.stdout or "")
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr or "")
        return proc.returncode
    # A freshly installed package must not stay shadowed by a failed earlier
    # import cached as None in sys.modules, nor hidden by stale finder caches.
    for name in [m for m, mod in list(sys.modules.items()) if mod is None]:
        sys.modules.pop(name, None)
    import importlib

    importlib.invalidate_caches()
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
    global _current_id, _exec_count, _chart_audits_left, _chart_repair_figures_left, _chart_limit_hit
    _current_id = str(request.get("id", ""))
    code = request.get("code") or ""
    cancelled = False
    ok = True
    _chart_audits_left = _CHART_MAX_AUDITS
    _chart_repair_figures_left = _CHART_MAX_REPAIR_FIGURES
    _chart_limit_hit = False
    _chart_cache.clear()
    _chart_notes.clear()

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
        # One bounded, model-only note. Sampling details must not silently
        # imply that all other figures were inspected or successfully repaired.
        notes = list(dict.fromkeys(note for note in _chart_notes.values() if note))
        details = notes[:3]
        if len(notes) > 3:
            details.append("[chart layout] Additional charts may have overlapping labels; inspect the remaining charts before presenting them.")
        if _chart_limit_hit:
            details.append("[chart layout] Automatic layout checks or repairs reached this cell's safety limit. Inspect remaining charts, or render them in smaller batches.")
        if details:
            _emit_status("chart_layout", "\n".join(details))
    finally:
        _chart_cache.clear()
        _chart_notes.clear()
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
