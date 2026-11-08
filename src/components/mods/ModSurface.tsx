import * as React from 'react';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { Box, Link, Text, useInput } from '../../ink.js';
import ScrollBox, { type ScrollBoxHandle } from '../../ink/components/ScrollBox.js';
import type { DOMElement } from '../../ink/dom.js';
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js';
import type { ClickEvent } from '../../ink/events/click-event.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { Markdown } from '../Markdown.js';
import { HighlightedCode } from '../HighlightedCode.js';
import { useRegisterOverlay } from '../../context/overlayContext.js';
import { editInput, inputWindow } from './inputEditing.js';
import measureElement from '../../ink/measure-element.js';
import {
  drawModClient,
  getModClientGeneration,
  getModClientKeyboard,
  inputModClient,
  mountModClient,
  pressModClient,
  releaseModClient,
  setModClientKeyboard,
  subscribeModClientKeyboard,
  subscribeModClients,
  type ModClientInstance,
} from '../../utils/plugins/mods/clientHost.js';
import { closeModPane, hasModEvent, applyModControl, moveModRing, scrollModSite } from '../../utils/plugins/mods/manager.js';
import {
  focusModPane,
  getFocusedModPane,
  closeModToolCall,
  getModDraft,
  getModFocusKey,
  getModRasterCells,
  getModToolNotice,
  modLinkTarget,
  openModToolCall,
  focusModBand,
  getModPanes,
  getModSite,
  getModScroller,
  getShownModPane,
  isModBandCollapsed,
  isModBandFocused,
  isModToastHold,
  isModHovered,
  setModHover,
  placeModPanes,
  registerModScroller,
  resizeModPane,
  showModPane,
  toggleModBand,
  getModStatuses,
  getModUiVersion,
  modControls,
  requestModSite,
  setModDraft,
  setModFocusKey,
  subscribeModUi,
  type ModPane,
  type ModUiNode,
} from '../../utils/plugins/mods/uiState.js';

// What mods draw in the terminal: their status lines under the prompt, the
// band above it, and their panes. Every value in a tree is the mod's, so each
// prop is checked here and an unknown one is drawn as if it were left out.

type Element = Exclude<ModUiNode, string>;
type Rec = Record<string, unknown>;
const BAND_ROWS = 8;

function useModUi(): number {
  return useSyncExternalStore(subscribeModUi, getModUiVersion);
}

const ANSI = new Set(['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']);
const THEME = new Set(['claude', 'permission', 'planMode', 'warning', 'error', 'success', 'suggestion', 'inactive', 'subtle', 'text']);
/** A mod's color as Tau's Ink takes it, or undefined (the default color). */
function color(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) return value;
  if (/^rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\)$/.test(value)) return value.replace(/\s+/g, '');
  if (/^ansi256\(\d{1,3}\)$/.test(value)) return value;
  if (value === 'gray' || value === 'grey') return 'ansi:blackBright';
  const bright = value.endsWith('Bright') ? value.slice(0, -6) : value;
  if (ANSI.has(bright)) return `ansi:${value}`;
  if (value === 'accent') return 'claude';
  return THEME.has(value) ? value : undefined;
}

// Spacing steps, across and down, as the terminal draws them.
const STEPS: Record<string, [number, number]> = { xs: [1, 0], sm: [1, 0], md: [2, 1], lg: [3, 1], xl: [4, 2] };
function cells(value: unknown, axis: 0 | 1): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.min(Math.floor(value), 200);
  if (typeof value === 'string' && STEPS[value]) return STEPS[value]![axis];
  return undefined;
}
function size(value: unknown): number | string | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.min(Math.floor(value), 1000);
  if (typeof value === 'string' && /^\d{1,3}(?:\.\d+)?%$/.test(value)) return value;
  return undefined;
}
const pick = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : undefined;
const BORDERS = ['single', 'double', 'round', 'bold', 'singleDouble', 'doubleSingle', 'classic', 'arrow', 'dashed'] as const;

function boxProps(props: Rec): Rec {
  const out: Rec = {};
  const set = (name: string, value: unknown) => { if (value !== undefined) out[name] = value; };
  set('flexDirection', pick(props.flexDirection, ['row', 'column', 'row-reverse', 'column-reverse']));
  set('flexWrap', pick(props.flexWrap, ['wrap', 'nowrap', 'wrap-reverse']));
  set('alignItems', pick(props.alignItems, ['flex-start', 'center', 'flex-end', 'stretch']));
  set('alignSelf', pick(props.alignSelf, ['auto', 'flex-start', 'center', 'flex-end', 'stretch']));
  set('justifyContent', pick(props.justifyContent, ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly']));
  for (const name of ['flexGrow', 'flexShrink'])
    if (typeof props[name] === 'number' && Number.isFinite(props[name]) && (props[name] as number) >= 0) out[name] = props[name];
  set('flexBasis', size(props.flexBasis));
  for (const name of ['width', 'height', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight']) set(name, size(props[name]));
  // A step applies across and down at once; one-axis forms take their axis.
  for (const [name, across, down] of [['gap', 'columnGap', 'rowGap'], ['padding', 'paddingX', 'paddingY'], ['margin', 'marginX', 'marginY']] as const) {
    if (props[name] !== undefined) { set(across, cells(props[name], 0)); set(down, cells(props[name], 1)); }
  }
  for (const name of ['columnGap', 'paddingX', 'marginX', 'paddingLeft', 'paddingRight', 'marginLeft', 'marginRight']) set(name, cells(props[name], 0));
  for (const name of ['rowGap', 'paddingY', 'marginY', 'paddingTop', 'paddingBottom', 'marginTop', 'marginBottom']) set(name, cells(props[name], 1));
  if (props.borderStyle === 'quote') {
    // A bar down the left side and blank cells on the other three.
    Object.assign(out, { borderStyle: 'single', borderTop: false, borderRight: false, borderBottom: false });
  } else set('borderStyle', pick(props.borderStyle, BORDERS));
  set('borderColor', color(props.borderColor));
  if (props.borderDimColor === true) out.borderDimColor = true;
  set('backgroundColor', color(props.backgroundColor));
  set('overflow', pick(props.overflow, ['visible', 'hidden']));
  set('display', pick(props.display, ['flex', 'none']));
  return out;
}

function textProps(props: Rec): Rec {
  const out: Rec = {};
  const fg = color(props.color), bg = color(props.backgroundColor);
  if (fg) out.color = fg;
  if (bg) out.backgroundColor = bg;
  if (props.bold === true || props.weight === 'semibold' || props.weight === 'bold') out.bold = true;
  for (const name of ['italic', 'underline', 'strikethrough', 'dimColor', 'inverse'])
    if (props[name] === true) out[name] = true;
  const wrap = pick(props.wrap, ['wrap', 'end', 'middle', 'truncate', 'truncate-start', 'truncate-middle', 'truncate-end']);
  if (wrap) out.wrap = wrap;
  return out;
}

/** A control on a site's focus ring: its element, its address (`e.element`)
 * and its ring id, which tells apart controls that share an address. */
type Control = { node: Element; key: string; nth: number; id: string };

function controlsOf(tree: ModUiNode | null | undefined): Control[] {
  return modControls(tree).map(control => ({ ...control, id: `${control.nth}:${control.key}` }));
}

const drawnValue = (node: Element): string | undefined =>
  typeof node.props.value === 'string' ? node.props.value : undefined;
const optionsOf = (node: Element): Rec[] => Array.isArray(node.props.options) ? node.props.options as Rec[] : [];

/** An Input's text now: what the person typed, until the mod draws a value
 * other than the one it drew then (an echo of their typing keeps it). */
function inputText(site: string, control: Control): string {
  const drawn = drawnValue(control.node);
  const draft = getModDraft(site, control.id);
  if (draft?.text !== undefined && (draft.base === drawn || (drawn !== undefined && draft.typed?.includes(drawn)))) return draft.text;
  return drawn ?? '';
}

/** Where an Input's cursor stands: the person's, while their text shows. */
function inputCursor(site: string, control: Control, text: string): number {
  const draft = getModDraft(site, control.id);
  const length = Array.from(text).length;
  return draft?.text === text && draft.cursor !== undefined ? Math.min(draft.cursor, length) : length;
}
const inputRows = (node: Element): number =>
  Number.isInteger(node.props.rows) && (node.props.rows as number) > 1 ? Math.min(node.props.rows as number, 40) : 1;

/** A Select's value now: the person's pick, until the mod draws another. */
function selectValue(site: string, control: Control): string | undefined {
  const drawn = drawnValue(control.node);
  const draft = getModDraft(site, control.id);
  return draft?.pick !== undefined && (draft.base === drawn || draft.pick === drawn) ? draft.pick : drawn;
}

function selectHighlight(site: string, control: Control): number {
  const options = optionsOf(control.node);
  const held = getModDraft(site, control.id)?.highlight;
  if (held !== undefined && held < options.length) return held;
  return Math.max(0, options.findIndex(option => option.value === selectValue(site, control)));
}


/** A Raster: per cell a glyph, a foreground and a background, 32 bits each. */
function RasterView({ props, cells }: { props: Rec; cells: string }): React.ReactNode {
  const rows = useMemo(() => {
    const columns = props.columns as number, height = props.rows as number;
    const bytes = Buffer.from(cells, 'base64');
    const word = (index: number) => bytes.readUInt32LE(index * 4);
    const paint = (value: number) => (value & 0x01000000) !== 0 ? undefined : `#${(value & 0xffffff).toString(16).padStart(6, '0')}`;
    return Array.from({ length: height }, (_, row) => {
      const runs: Array<{ text: string; fg?: string; bg?: string }> = [];
      for (let column = 0; column < columns; column++) {
        const cell = (row * columns + column) * 3;
        const point = word(cell);
        // Control codes, surrogate halves and non-code-points draw blank.
        const drawable = point >= 0x20 && !(point >= 0x7f && point <= 0x9f) && !(point >= 0xd800 && point <= 0xdfff) && point <= 0x10ffff;
        const glyph = drawable ? String.fromCodePoint(point) : ' ';
        const fg = paint(word(cell + 1)), bg = paint(word(cell + 2));
        const last = runs.at(-1);
        if (last && last.fg === fg && last.bg === bg) last.text += glyph;
        else runs.push({ text: glyph, fg, bg });
      }
      return runs;
    });
  }, [props.columns, props.rows, cells]);
  return <Box flexDirection="column">{rows.map((runs, row) =>
    <Text key={row} wrap="truncate-end">{runs.map((run, index) =>
      <Text key={index} color={run.fg as never} backgroundColor={run.bg as never}>{run.text}</Text>)}</Text>)}</Box>;
}

type TreeState = {
  site: string;
  columns: number;
  controls: Map<Element, Control>;
  /** The ring id of the control holding the focus ring. */
  ring?: string;
  /** Measures a control outside a line of text, to keep it in view. */
  refFor?: (id: string) => (el: DOMElement | null) => void;
  /** Whose hover scope groups these are: the pane's plugin, or the band's. */
  group: string;
  /** Inside a Client: a Button there runs its handler in the Client's module. */
  client?: ModClientInstance;
};

const asRecord = (value: unknown): Rec | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Rec : undefined;

/** Whether a hover's overrides apply: its scope group is under the pointer,
 * or (with no scope) the nearest keyed Box around it is. */
function hoverLit(hover: Rec | undefined, scope: string | undefined, state: TreeState): boolean {
  if (!hover) return false;
  if (typeof hover.scope === 'string') return isModHovered(`${state.group}|scope:${hover.scope}`);
  return !!scope && isModHovered(scope);
}
const TEXT_HOVER = ['color', 'backgroundColor', 'dimColor', 'bold', 'italic', 'underline', 'strikethrough', 'inverse'];
const BOX_HOVER = ['display', 'backgroundColor', 'borderColor', 'borderStyle', 'borderDimColor'];
const pickKeys = (from: Rec, keys: string[]): Rec => Object.fromEntries(keys.filter(key => from[key] !== undefined).map(key => [key, from[key]]));

/** The pointer over an element of a scope group heats the group. */
function heat(state: TreeState, hover: Rec | undefined, own?: string) {
  const group = typeof hover?.scope === 'string' ? `${state.group}|scope:${hover.scope}` : undefined;
  if (!group && !own) return {};
  return {
    onMouseEnter: () => { if (own) setModHover(own, true); if (group) setModHover(group, true); },
    onMouseLeave: () => { if (own) setModHover(own, false); if (group) setModHover(group, false); },
  };
}

function Node({ node, state, inText, scope }: { node: ModUiNode; state: TreeState; inText?: boolean; scope?: string }): React.ReactNode {
  const control = typeof node === 'string' ? undefined : state.controls.get(node);
  const body = <NodeBody node={node} state={state} inText={inText} scope={scope} />;
  const hover = typeof node === 'string' || node.type === 'Box' ? undefined : asRecord(node.props.hover);
  // A Text or Button of a scope group, outside a line of text, heats it.
  const pointer = !inText && hover && typeof hover.scope === 'string' ? heat(state, hover) : {};
  const measured = control && !inText && state.refFor ? state.refFor(control.id) : undefined;
  // A Client's Button outside a line of text: a click runs its handler there.
  const press = state.client && !inText && typeof node !== 'string' && node.type === 'Button'
    ? clientHandler(node.props.onPress) : undefined;
  if (press !== undefined) {
    const instance = state.client!;
    const element = (node as Element).props.key ?? null;
    return <Box {...pointer} onClick={() => pressModClient(instance, press, [{ element }])}>{body}</Box>;
  }
  return measured || pointer.onMouseEnter
    ? <Box ref={measured as never} {...pointer}>{body}</Box>
    : body;
}

function NodeBody({ node, state, inText, scope }: { node: ModUiNode; state: TreeState; inText?: boolean; scope?: string }): React.ReactNode {
  if (typeof node === 'string') return inText ? node : <Text>{node}</Text>;
  const props = node.props as Rec;
  const control = state.controls.get(node);
  const focused = control !== undefined && control.id === state.ring;
  const hover = asRecord(props.hover);
  const lit = hoverLit(hover, scope, state);
  const inline = () => node.children.map((child, index) => <Node key={index} node={child} state={state} inText scope={scope} />);
  switch (node.type) {
    case 'Box': {
      // A keyed Box is a hover scope for what lies beneath it.
      const own = typeof props.key === 'string' && props.key ? `${state.site}|box:${props.key}` : undefined;
      const inner = own ?? scope;
      const shown = hover && hoverLit(hover, inner, state) ? { ...props, ...pickKeys(hover, BOX_HOVER) } : props;
      const children = node.children.map((child, index) => <Node key={index} node={child} state={state} scope={inner} />);
      return <Box {...boxProps(shown)} {...heat(state, hover, own)}>{children}</Box>;
    }
    case 'Text':
      return <Text {...textProps(lit ? { ...props, ...pickKeys(hover!, TEXT_HOVER) } : props)}>{inline()}</Text>;
    case 'Button': {
      const label = node.children.length ? inline() : String(props.label ?? '');
      const style = lit ? pickKeys(hover!, TEXT_HOVER) : {};
      const dim = (style.dimColor ?? props.dimColor) === true && !focused;
      const look = { bold: style.bold === true, italic: style.italic === true, underline: style.underline === true, strikethrough: style.strikethrough === true };
      const tint = color(style.color);
      if (props.plain === true) {
        // As a survey's row reads: the hotkey in the accent color, a colon, the label.
        const hotkey = typeof props.hotkey === 'string' ? props.hotkey : undefined;
        return <Text inverse={focused || style.inverse === true} dimColor={dim} color={tint as never} {...look}>{hotkey ? <><Text color="claude">{hotkey}</Text>: </> : null}{label}</Text>;
      }
      return <Text inverse={focused || style.inverse === true} color={(tint ?? (props.variant === 'primary' ? 'claude' : undefined)) as never} dimColor={dim} {...look}>[{label}]</Text>;
    }
    case 'Link': {
      const label = node.children.length ? inline() : typeof props.label === 'string' ? props.label : String(props.href ?? '');
      const target = modLinkTarget(props.href);
      return target ? <Link url={target}><Text color="claude">{label}</Text></Link> : <Text>{label}</Text>;
    }
    case 'Code': {
      const language = typeof props.language === 'string' ? props.language : props.format === 'diff' ? 'diff' : 'txt';
      const path = typeof props.path === 'string' ? props.path : `snippet.${language}`;
      return <HighlightedCode code={String(props.source)} filePath={path} width={state.columns} />;
    }
    case 'Markdown':
      return <Markdown dimColor={props.dimColor === true}>{String(props.text)}</Markdown>;
    case 'Input': {
      const text = control ? inputText(state.site, control) : drawnValue(node) ?? '';
      const placeholder = typeof props.placeholder === 'string' ? props.placeholder : '';
      const rows = inputRows(node);
      const cursor = focused && control ? inputCursor(state.site, control, text) : -1;
      // One row of the field: the cursor drawn inverse over its character,
      // or as a bar past the end.
      const row = (line: string, column: number) => {
        const chars = Array.from(line);
        if (column < 0) return <Text>{line || ' '}</Text>;
        return <Text>{chars.slice(0, column).join('')}{column < chars.length
          ? <Text inverse>{chars[column]}</Text> : '▏'}{chars.slice(column + 1).join('')}</Text>;
      };
      const label = typeof props.label === 'string' ? <Text>{props.label}</Text> : null;
      const hint = focused ? <Text dimColor>⏎ {typeof props.submitLabel === 'string' ? props.submitLabel : 'submit'}</Text> : null;
      if (!text && (!focused || rows === 1))
        return <Box flexDirection="row" gap={1}>{label}<Text>{focused ? '▏' : ''}<Text dimColor>{placeholder || (focused ? '' : ' ')}</Text></Text>{hint}</Box>;
      if (rows === 1) return <Box flexDirection="row" gap={1}>{label}{row(text, cursor)}{hint}</Box>;
      const view = inputWindow(text, Math.max(0, cursor), rows);
      return <Box flexDirection="column">
        {label || hint ? <Box flexDirection="row" gap={1}>{label}{hint}</Box> : null}
        <Box flexDirection="column" borderStyle="single" borderDimColor={!focused} paddingX={1}>
          {Array.from({ length: rows }, (_, index) => {
            const at = view.first + index;
            const line = view.lines[at];
            return <Box key={index}>{line === undefined ? <Text> </Text>
              : row(line, cursor >= 0 && at === view.cursorLine ? view.cursorColumn : -1)}</Box>;
          })}
        </Box>
      </Box>;
    }
    case 'Select': {
      const options = optionsOf(node);
      const value = control ? selectValue(state.site, control) : drawnValue(node);
      const name = (option: Rec) => typeof option.label === 'string' ? option.label : String(option.value);
      const label = typeof props.label === 'string' ? <Text>{props.label}</Text> : null;
      if (!focused || !control) {
        // At rest: the label, then the current value.
        const current = options.find(option => option.value === value);
        return <Box flexDirection="row" gap={1}>{label}<Text>{current ? name(current) : '-'} ▾</Text></Box>;
      }
      const highlight = selectHighlight(state.site, control);
      return <Box flexDirection="column">{label}{options.map((option, index) =>
        <Text key={index} inverse={index === highlight}>{option.value === value ? '● ' : '○ '}{name(option)}</Text>)}</Box>;
    }
    case 'Raster':
      return <RasterView props={props} cells={getModRasterCells(state.site, String(props.key)) ?? String(props.cells)} />;
    case 'Image':
      return <Text dimColor>[{typeof props.alt === 'string' ? props.alt : 'image'}]</Text>;
    case 'Client':
      return <ModClientRegion node={node} state={state} />;
    default:
      return null;
  }
}

/** The id of a handler a Client module drew (`{ __client: id }`). */
function clientHandler(value: unknown): number | undefined {
  const reference = asRecord(value);
  return reference && Number.isInteger(reference.__client) ? reference.__client as number : undefined;
}

// A region's size may follow what it draws; past this many changes it stays.
const MAX_RESIZES = 50;

/**
 * A `Client`: a region one of the plugin's Client modules draws, on this
 * thread, with its own state, timers and input. A click gives it the
 * keyboard (Esc gives it back); the pointer's clicks and crossings reach
 * its `onPointer` where the terminal reports them (fullscreen). One that
 * fails draws one dimmed line in its place.
 */
function ModClientRegion({ node, state }: { node: Element; state: TreeState }): React.ReactNode {
  const props = node.props as Rec;
  const key = typeof props.key === 'string' ? props.key : '';
  const module = typeof props.module === 'string' ? props.module : '';
  const site = state.site;
  const plugin = site.startsWith('Pane:') ? site.slice(5, site.lastIndexOf(':')) : getModSite(site)?.owners?.get(key) ?? '';
  // A reload of the mods ends every instance: this region mounts the new code.
  const generation = useSyncExternalStore(subscribeModClients, getModClientGeneration);
  const instance = useMemo(() => mountModClient(plugin, site, key, module), [plugin, site, key, module, generation]);
  useEffect(() => () => releaseModClient(instance), [instance]);
  useSyncExternalStore(instance.subscribe, () => instance.version);
  // Redrawn when the keyboard comes to it or leaves it.
  useSyncExternalStore(subscribeModClientKeyboard, () => getModClientKeyboard(site) === instance);
  const ref = React.useRef<DOMElement | null>(null);
  const [measured, setMeasured] = React.useState({ columns: 0, rows: 0 });
  const resizes = React.useRef(0);
  const last = React.useRef({ x: 0, y: 0 });
  useEffect(() => {
    if (!ref.current || resizes.current >= MAX_RESIZES) return;
    const { width, height } = measureElement(ref.current);
    if (width !== measured.columns || height !== measured.rows) {
      resizes.current++;
      setMeasured({ columns: width, rows: height });
    }
  });
  const columns = typeof props.width === 'number' ? props.width : measured.columns;
  const rows = typeof props.height === 'number' ? props.height : measured.rows;
  const drawn = drawModClient(instance, props.props, columns, rows);
  if (drawn.fault)
    return <Text dimColor wrap="truncate-end">{`${plugin}: Client ${module}: ${drawn.fault.reason}`}</Text>;
  const point = (type: string, x: number, y: number, button?: string) => {
    last.current = { x, y };
    if (instance.listens.pointer) inputModClient(instance, 'pointer', { type, x, y, ...(button ? { button } : {}) });
  };
  const inner: TreeState = {
    site: `${site}|client:${key}`, columns: columns || state.columns, controls: new Map(),
    group: `${state.group}|client:${key}`, client: instance,
  };
  return <Box
    ref={ref as never}
    flexDirection="column"
    width={size(props.width) as never}
    height={size(props.height) as never}
    flexGrow={typeof props.flexGrow === 'number' ? props.flexGrow : undefined}
    onClick={(event: ClickEvent) => {
      // The terminal reports a click whole: a press and its release. A click
      // gives a Client that listens for keys the keyboard, with the band or
      // the pane it sits in, so the keys reach it.
      if (instance.listens.key) {
        setModClientKeyboard(site, instance);
        if (site === 'AbovePrompt') focusModBand(true);
        else if (site.startsWith('Pane:')) focusModPane(site.slice(5, site.lastIndexOf(':')), site.slice(site.lastIndexOf(':') + 1));
      }
      point('down', event.localCol, event.localRow, 'left');
      point('up', event.localCol, event.localRow, 'left');
    }}
    onMouseEnter={() => point('enter', last.current.x, last.current.y)}
    onMouseLeave={() => point('leave', last.current.x, last.current.y)}
  >
    {drawn.tree ? <Node node={drawn.tree} state={inner} /> : null}
  </Box>;
}

type DrawingProps = { owner: string; tree: unknown; children: React.ReactNode };
type DrawingState = { tree?: unknown; failed?: string };

/**
 * A render failure inside a mod's tree would exit Tau (the Ink root's
 * componentDidCatch); here it costs one line, until the mod draws again.
 */
class ModDrawing extends React.Component<DrawingProps, DrawingState> {
  override state: DrawingState = {};

  static getDerivedStateFromError(error: unknown): DrawingState {
    return { failed: error instanceof Error ? error.message : String(error) };
  }

  static getDerivedStateFromProps(props: DrawingProps, state: DrawingState): DrawingState | null {
    return props.tree !== state.tree ? { tree: props.tree, failed: undefined } : null;
  }

  override render(): React.ReactNode {
    return this.state.failed === undefined
      ? this.props.children
      : <Text color="warning" wrap="truncate-end">{this.props.owner} could not be drawn: {this.state.failed}</Text>;
  }
}

function siteInput(component: string, requestId: string, columns: number, rows: number, props: Rec): Rec {
  return { surface: 'terminal', component, requestId, viewport: { columns, rows, isFullscreen: isFullscreenEnvEnabled() }, props };
}

const controlMap = (list: Control[]) => new Map(list.map(control => [control.node, control]));

/** Another pane's tab: an engine stop on the shown pane's ring. */
type TabStop = { id: string; plugin: string; pane: string };

/** Where a node sits in its scroll window: rows below the window's top. */
/** Long enough for the frame a commit drew to be laid out. */
const REVEAL_AFTER_MS = 40;

function rowsBelowScrollTop(el: DOMElement): { top: number; height: number } | undefined {
  let top = 0;
  for (let node: DOMElement | undefined = el; node; node = node.parentNode as DOMElement | undefined) {
    if (node !== el && 'scrollTop' in node) return { top, height: el.yogaNode?.getComputedHeight() ?? 1 };
    top += node.yogaNode?.getComputedTop() ?? 0;
  }
  return undefined;
}

/**
 * One scrollable site body: a window over the tree its hooks drew, the
 * focused control kept in view. Registers itself for ui.scroll and $.ui.scroll.
 */
function useSiteWindow(site: string) {
  const scrollRef = React.useRef<ScrollBoxHandle | null>(null);
  const elements = React.useRef(new Map<string, DOMElement>()).current;
  const refFor = React.useCallback((id: string) => (el: DOMElement | null) => {
    if (el) elements.set(id, el);
    else elements.delete(id);
  }, [elements]);
  const reveal = React.useCallback((id: string): boolean => {
    const box = scrollRef.current, el = elements.get(id);
    if (!box || !el) return false;
    const at = rowsBelowScrollTop(el);
    if (!at) return false;
    const top = box.getScrollTop(), viewport = box.getViewportHeight();
    if (at.top < top) box.scrollTo(at.top);
    else if (at.top + at.height > top + viewport) box.scrollTo(at.top + at.height - viewport);
    return true;
  }, [elements]);
  useEffect(() => registerModScroller(site, {
    scrollTo: row => scrollRef.current?.scrollTo(row),
    getScrollTop: () => scrollRef.current?.getScrollTop() ?? 0,
    getScrollHeight: () => scrollRef.current?.getScrollHeight() ?? 0,
    getViewportHeight: () => scrollRef.current?.getViewportHeight() ?? 0,
    reveal,
  }), [site, reveal]);
  const overflows = () => {
    const box = scrollRef.current;
    return !!box && box.getScrollHeight() > box.getViewportHeight();
  };
  return { scrollRef, refFor, reveal, overflows };
}

/**
 * The keys a site answers while it holds the keyboard (a pane, or the band):
 * Tab walks its controls (and the tabs of other panes), Enter or Space uses
 * one, Up and Down move between controls or scroll a body taller than its
 * window, the page keys scroll, a Button's hotkey presses it, Esc gives the
 * keys back (or closes a pane opened with closeOnEscape).
 */
function siteKeyHandler(args: {
  site: string;
  list: Control[];
  stops: TabStop[];
  ring: string | undefined;
  overflows: () => boolean;
  onEscape: () => void;
}): (e: KeyboardEvent) => void {
  const { site, list, stops, ring, overflows, onEscape } = args;
  const order = [...stops.map(stop => stop.id), ...list.map(control => control.id)];
  const person = { kind: 'person' };
  const land = (id: string) => {
    const control = list.find(item => item.id === id);
    void moveModRing(site, control ? { element: control.key, id } : { id }, person).catch(() => {});
  };
  const move = (step: number) => {
    if (!order.length) return;
    const at = ring === undefined ? -1 : order.indexOf(ring);
    land(order[at < 0 ? (step > 0 ? 0 : order.length - 1) : (at + step + order.length) % order.length]!);
  };
  const scroll = (move: { by?: number; to?: number }) => void scrollModSite(site, move, person).catch(() => {});
  const bodyRows = () => getModScroller(site)?.getViewportHeight() ?? 1;
  return (e: KeyboardEvent) => {
    const handled = () => e.preventDefault();
    // A Client a click gave the keyboard takes every key; Esc gives it back.
    const client = getModClientKeyboard(site);
    if (client) {
      handled();
      if (e.key === 'escape') setModClientKeyboard(site, undefined);
      else inputModClient(client, 'key', { key: e.key, ...(e.ctrl ? { ctrl: true } : {}), ...(e.shift ? { shift: true } : {}), ...(e.meta ? { meta: true } : {}) });
      return;
    }
    if (e.key === 'escape') { handled(); onEscape(); return; }
    if (e.key === 'tab') { handled(); move(e.shift ? -1 : 1); return; }
    const stop = stops.find(item => item.id === ring);
    if (stop && (e.key === 'return' || e.key === ' ')) { handled(); showModPane(stop.plugin, stop.pane); return; }
    const control = list.find(item => item.id === ring);
    const node = control?.node;
    if (control && node?.type === 'Input') {
      const text = inputText(site, control);
      const edit = editInput(text, inputCursor(site, control, text), e, inputRows(node));
      if (edit?.kind === 'edit') {
        handled();
        const sent = getModDraft(site, control.id)?.typed ?? [];
        setModDraft(site, control.id, { text: edit.text, cursor: edit.cursor, base: drawnValue(node), typed: [...sent, edit.text].slice(-64) });
        if (edit.text !== text) void applyModControl(site, control.key, 'change', edit.text, control.nth);
        return;
      }
      if (edit?.kind === 'cursor') {
        handled();
        const draft = getModDraft(site, control.id);
        setModDraft(site, control.id, { ...draft, text, cursor: edit.cursor, base: draft?.base ?? drawnValue(node), typed: draft?.typed ?? [] });
        return;
      }
      if (edit?.kind === 'submit') {
        handled();
        setModDraft(site, control.id, { text, cursor: inputCursor(site, control, text), base: drawnValue(node), typed: [] });
        void applyModControl(site, control.key, 'submit', text, control.nth);
        return;
      }
      if (edit?.kind === 'leave') { handled(); move(edit.step); return; }
    }
    if (control && node?.type === 'Select') {
      const options = optionsOf(node);
      const at = selectHighlight(site, control);
      if ((e.key === 'up' || e.key === 'down') && options.length) {
        handled();
        setModDraft(site, control.id, {
          ...getModDraft(site, control.id),
          highlight: (at + (e.key === 'up' ? -1 : 1) + options.length) % options.length,
        });
        return;
      }
      if ((e.key === 'return' || e.key === ' ') && options[at]) {
        handled();
        const value = String(options[at]!.value);
        setModDraft(site, control.id, { highlight: at, pick: value, base: drawnValue(node) });
        void applyModControl(site, control.key, 'select', value, control.nth);
        return;
      }
    }
    if (control && node?.type === 'Button' && (e.key === 'return' || e.key === ' ')) {
      handled();
      void applyModControl(site, control.key, 'press', undefined, control.nth);
      return;
    }
    if (e.key === 'up' || e.key === 'down') {
      handled();
      // A body taller than its window scrolls; one that fits walks controls.
      if (overflows()) scroll({ by: e.key === 'up' ? -1 : 1 });
      else move(e.key === 'up' ? -1 : 1);
      return;
    }
    if (e.key === 'pageup' || e.key === 'pagedown') { handled(); scroll({ by: (e.key === 'pageup' ? -1 : 1) * bodyRows() }); return; }
    if (e.key === 'home' || e.key === 'end') { handled(); scroll({ to: e.key === 'home' ? 0 : Number.MAX_SAFE_INTEGER }); return; }
    // A Button's hotkey (Shift+w is w) unless the ring is in a text field;
    // of two on one key, the later wins.
    if (node?.type !== 'Input' && !e.ctrl && !e.meta && e.key.length === 1) {
      const target = list.findLast(item => item.node.type === 'Button' && item.node.props.hotkey === e.key.toLowerCase());
      if (target) { handled(); void applyModControl(site, target.key, 'press', undefined, target.nth); }
    }
  };
}

function ModAction({ action, press }: { action: string; press: () => void }): null {
  useKeybinding(action, press, { context: 'Global' });
  return null;
}

/**
 * Buttons drawn with an `action`: the person's binding of that engine action
 * presses them, while their site is drawn and no engine handler of the action
 * is mounted (the first handler mounted answers an action).
 */
function ModActions({ site, list }: { site: string; list: Control[] }): React.ReactNode {
  return <>{list.filter(control => control.node.type === 'Button' && typeof control.node.props.action === 'string')
    .map(control => <ModAction key={control.id} action={String(control.node.props.action)}
      press={() => void applyModControl(site, control.key, 'press', undefined, control.nth)} />)}</>;
}

/** The ring of a site that holds the keyboard: one the person moved, else the
 * first control drawn with autoFocus, else nothing. */
function ringOf(site: string, focused: boolean, list: Control[], stops: TabStop[]): string | undefined {
  if (!focused) return undefined;
  const saved = getModFocusKey(site);
  if (saved !== undefined && (list.some(control => control.id === saved) || stops.some(stop => stop.id === saved))) return saved;
  return list.find(control => control.node.props.autoFocus === true)?.id;
}

/** Whether the shown pane sits beside the transcript: a fullscreen terminal
 * of 110 columns or more. */
export function useModDocked(): boolean {
  useModUi();
  const { columns } = useTerminalSize();
  const shown = getShownModPane();
  const pane = shown && getModPanes().find(item => item.plugin === shown.plugin && item.id === shown.id);
  return !!pane?.placed && isFullscreenEnvEnabled() && columns >= 110;
}

/** The width of the dock: what the pane asked, or the person set, at most
 * 45% of the terminal and at least 24. */
export function modDockColumns(columns: number): number {
  const shown = getShownModPane();
  const pane = shown && getModPanes().find(item => item.plugin === shown.plugin && item.id === shown.id);
  const wanted = pane?.sized?.columns ?? pane?.columns ?? Math.round(columns * 0.35);
  return Math.max(24, Math.min(Math.floor(columns * 0.45), wanted));
}

/**
 * The shown pane, framed; with several open, a row of tabs names them. The
 * pane holding the keyboard answers its keys. `placement` is where it sits:
 * beside the transcript, or above the prompt.
 */
function PaneView({ pane, focused, version, placement }: { pane: ModPane; focused: boolean; version: number; placement: 'dock' | 'inline' }): React.ReactNode {
  const { columns, rows } = useTerminalSize();
  const site = `Pane:${pane.plugin}:${pane.id}`;
  const others = getModPanes().filter(item => item.placed);
  const docked = placement === 'dock';
  const frameColumns = docked ? modDockColumns(columns) : columns;
  const bodyColumns = Math.max(10, Math.min(docked ? frameColumns : (pane.columns ?? columns), columns) - 4);
  const tabRow = others.length > 1 ? 1 : 0;
  const bodyRows = docked
    ? Math.max(1, rows - 2 - tabRow)
    : Math.max(1, Math.min(pane.sized?.rows ?? pane.rows ?? Math.floor(rows / 3), Math.max(3, rows - 10)));
  const input = siteInput('Pane', pane.id, columns, rows, {
    title: pane.title, isFocused: focused, bodyColumns, placement,
    scroll: { offset: getModScroller(site)?.getScrollTop() ?? 0, bodyRows }, view: {},
  });
  const inputKey = JSON.stringify({ ...input, props: { ...input.props as Rec, scroll: undefined } });
  useEffect(() => { if (hasModEvent('ui.render')) requestModSite(site, input); }, [site, inputKey, version]);
  const tree = getModSite(site)?.tree;
  const list = useMemo(() => controlsOf(tree), [tree]);
  const controls = useMemo(() => controlMap(list), [list]);
  const stops: TabStop[] = focused && others.length > 1
    ? others.filter(item => !(item.plugin === pane.plugin && item.id === pane.id))
      .map(item => ({ id: `tab:${item.plugin}:${item.id}`, plugin: item.plugin, pane: item.id }))
    : [];
  const ring = ringOf(site, focused, list, stops);
  const { scrollRef, refFor, reveal, overflows } = useSiteWindow(site);
  // The focused control stays in view.
  // After the frame lays out: a measure taken at commit reads the frame
  // before it (a body not drawn yet) and scrolls a visible control away.
  useEffect(() => {
    if (!ring || ring.startsWith('tab:')) return;
    const timer = setTimeout(() => reveal(ring), REVEAL_AFTER_MS);
    return () => clearTimeout(timer);
  }, [ring, tree, reveal]);
  const onKeyDown = siteKeyHandler({
    site, list, stops, ring, overflows,
    onEscape: () => {
      if (pane.closeOnEscape) void closeModPane(pane.plugin, pane.id, 'person').catch(() => {});
      else focusModPane(pane.plugin, null);
    },
  });
  const state: TreeState = { site, columns: bodyColumns, controls, ring, refFor, group: pane.plugin };
  const background = color(pane.backgroundColor);
  return <Box flexDirection="column" borderStyle="round" borderColor={focused ? 'claude' : undefined} borderDimColor={!focused}
    // Docked, the frame stretches to the room above the prompt (the row it
    // sits in); a height of the whole terminal pushed the prompt's own rows out.
    paddingX={1} width={docked ? frameColumns : undefined} overflow={docked ? 'hidden' : undefined}
    tabIndex={focused ? 0 : undefined} autoFocus={focused} onKeyDown={focused ? onKeyDown : undefined}>
    {tabRow || focused ? <Box flexDirection="row" justifyContent="space-between" gap={1}>
      {/* A row of tabs too long for the frame is cut short; the hint stays whole. */}
      <Box flexGrow={1} flexShrink={1} minWidth={0}>
        <Text wrap="truncate-end">{tabRow ? others.map((item, index) => {
          const current = item.plugin === pane.plugin && item.id === pane.id;
          const stop = `tab:${item.plugin}:${item.id}`;
          return <Text key={stop} bold={current} dimColor={!current} inverse={ring === stop}>{index ? '  ' : ''}{item.title}</Text>;
        }) : ''}</Text>
      </Box>
      {focused ? <Box flexShrink={0}><Text dimColor>{pane.closeOnEscape ? 'esc close' : 'esc back'}</Text></Box> : null}
    </Box> : null}
    <ModActions site={site} list={list} />
    <Box flexDirection="column" maxHeight={bodyRows} backgroundColor={background === 'transparent' ? undefined : background as never}>
      <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1} followOnGrow={false}>
        {tree !== undefined && tree !== null
          ? <ModDrawing owner={pane.plugin} tree={tree}><Node node={tree} state={state} /></ModDrawing>
          : null}
      </ScrollBox>
    </Box>
  </Box>;
}

/** The band's one row while the person has it collapsed. */
const COLLAPSED_BAND = '▸ plugin panel hidden · ctrl+x ctrl+a to show';

/**
 * The band above the prompt, the shown pane when it sits above the prompt and
 * does not hold the keyboard, and the keys a mod answers from the prompt: a
 * bare digit in an empty prompt presses a band Button with that hotkey, and
 * Esc at an empty idle prompt closes a pane opened with closeOnEscape.
 */
export function ModPromptSurface({ isWorking, promptEmpty }: { isWorking: boolean; promptEmpty?: boolean }): React.ReactNode {
  const version = useModUi();
  const { columns, rows } = useTerminalSize();
  const docked = useModDocked();
  // Waiting panes the terminal is now wide enough for are drawn.
  useEffect(() => { placeModPanes(columns); }, [columns, version]);
  const drawing = hasModEvent('ui.render');
  const collapsed = isModBandCollapsed();
  const bandFocused = isModBandFocused();
  const input = siteInput('AbovePrompt', 'AbovePrompt', columns, rows, {
    hasSurvey: false, isWorking, maxRows: BAND_ROWS, bodyColumns: Math.max(10, columns - 2),
    scroll: { offset: getModScroller('AbovePrompt')?.getScrollTop() ?? 0, bodyRows: BAND_ROWS }, view: {},
  });
  const inputKey = JSON.stringify({ ...input, props: { ...input.props as Rec, scroll: undefined } });
  useEffect(() => { if (drawing) requestModSite('AbovePrompt', input); }, [drawing, inputKey, version]);
  const band = drawing ? getModSite('AbovePrompt')?.tree : undefined;
  const list = useMemo(() => controlsOf(band), [band]);
  const controls = useMemo(() => controlMap(list), [list]);
  const ring = ringOf('AbovePrompt', bandFocused, list, []);
  const { scrollRef, refFor, reveal, overflows } = useSiteWindow('AbovePrompt');
  useEffect(() => {
    if (!ring) return;
    const timer = setTimeout(() => reveal(ring), REVEAL_AFTER_MS);
    return () => clearTimeout(timer);
  }, [ring, band, reveal]);
  const focusedPane = getFocusedModPane();
  const shown = getShownModPane();
  const pane = shown && !docked && !(focusedPane && focusedPane.plugin === shown.plugin && focusedPane.id === shown.id)
    ? getModPanes().find(item => item.plugin === shown.plugin && item.id === shown.id && item.placed)
    : undefined;
  // Keys taken from the prompt before it reads them.
  useInput((text, key, event) => {
    if (!promptEmpty || bandFocused || focusedPane) return;
    if (/^[0-9]$/.test(text) && !key.ctrl && !key.meta && !collapsed) {
      const target = list.findLast(item => item.node.type === 'Button' && item.node.props.hotkey === text);
      if (target) {
        event.stopImmediatePropagation();
        void applyModControl('AbovePrompt', target.key, 'press', undefined, target.nth);
      }
      return;
    }
    if (key.escape && !isWorking && shown) {
      const open = getModPanes().find(item => item.plugin === shown.plugin && item.id === shown.id);
      if (open?.closeOnEscape) {
        event.stopImmediatePropagation();
        void closeModPane(open.plugin, open.id, 'person').catch(() => {});
      }
    }
  });
  const onKeyDown = siteKeyHandler({
    site: 'AbovePrompt', list, stops: [], ring, overflows,
    onEscape: () => focusModBand(false),
  });
  const hasBand = band !== undefined && band !== null;
  if (!pane && !hasBand) return null;
  const state: TreeState = { site: 'AbovePrompt', columns, controls, ring, refFor, group: 'band' };
  return <Box flexDirection="column">
    {pane ? <PaneView key={`${pane.plugin}:${pane.id}`} pane={pane} focused={false} version={version} placement="inline" /> : null}
    {hasBand ? collapsed
      ? <Text dimColor>{COLLAPSED_BAND}</Text>
      : <Box flexDirection="column" maxHeight={BAND_ROWS} borderStyle={bandFocused ? 'round' : undefined} borderColor="claude"
          tabIndex={bandFocused ? 0 : undefined} autoFocus={bandFocused} onKeyDown={bandFocused ? onKeyDown : undefined}>
          <ModActions site="AbovePrompt" list={list} />
          <ScrollBox ref={scrollRef} flexDirection="column" flexGrow={1} followOnGrow={false}>
            <ModDrawing owner="A plugin's band" tree={band}><Node node={band} state={state} /></ModDrawing>
          </ScrollBox>
        </Box>
      : null}
  </Box>;
}

/** The pane holding the keys, drawn where the prompt was until it lets go
 * (beside the transcript when docked: ModDock draws it there). As an overlay
 * it keeps Esc from cancelling a running turn: Esc is the pane's. */
export function ModFocusedPane(): React.ReactNode {
  useRegisterOverlay('mod-pane', true);
  const version = useModUi();
  const docked = useModDocked();
  const focused = getFocusedModPane();
  const pane = focused && getModPanes().find(item => item.plugin === focused.plugin && item.id === focused.id && item.placed);
  if (docked) return <Text dimColor>A plugin pane holds the keyboard · esc gives it back</Text>;
  return pane ? <PaneView key={`${pane.plugin}:${pane.id}`} pane={pane} focused version={version} placement="inline" /> : null;
}

/** The shown pane beside the transcript, in a fullscreen terminal wide
 * enough for it. */
export function ModDock(): React.ReactNode {
  const version = useModUi();
  const docked = useModDocked();
  const shown = getShownModPane();
  const focused = getFocusedModPane();
  const pane = shown && getModPanes().find(item => item.plugin === shown.plugin && item.id === shown.id && item.placed);
  if (!docked || !pane) return null;
  const holds = !!focused && focused.plugin === pane.plugin && focused.id === pane.id;
  return <PaneView key={`${pane.plugin}:${pane.id}:dock`} pane={pane} focused={holds} version={version} placement="dock" />;
}

/**
 * The Ctrl+X chords of mods' panes and band, from anywhere: Ctrl+X Tab hands
 * the keyboard to the band (when it has controls) or the shown pane, then on;
 * Ctrl+X X closes the pane holding it; Ctrl+X Ctrl+A collapses or expands the
 * band; Ctrl+X and an arrow resize the pane holding the keyboard.
 */
export function ModKeys({ canFocus }: { canFocus: () => boolean }): React.ReactNode {
  useModUi();
  const { columns, rows } = useTerminalSize();
  const docked = useModDocked();
  const hasPanes = getModPanes().some(item => item.placed);
  const drawing = hasModEvent('ui.render');
  useKeybinding('modPane:focus', () => {
    const shown = getShownModPane();
    const bandControls = !isModBandCollapsed() && controlsOf(getModSite('AbovePrompt')?.tree).length > 0;
    const focused = getFocusedModPane();
    if (isModBandFocused()) {
      if (shown) focusModPane(shown.plugin, shown.id);
      else focusModBand(false);
      return;
    }
    if (focused) { focusModPane(focused.plugin, null); return; }
    if (!canFocus()) return;
    if (bandControls) focusModBand(true);
    else if (shown) focusModPane(shown.plugin, shown.id);
  }, { context: 'Global', isActive: hasPanes || drawing });
  useKeybinding('modPane:close', () => {
    const focused = getFocusedModPane();
    if (focused) void closeModPane(focused.plugin, focused.id, 'person').catch(() => {});
  }, { context: 'Global', isActive: hasPanes });
  useKeybinding('abovePrompt:toggle', () => toggleModBand(), { context: 'Global', isActive: drawing });
  const resize = (by: number) => {
    const focused = getFocusedModPane();
    const pane = focused && getModPanes().find(item => item.plugin === focused.plugin && item.id === focused.id);
    if (!pane) return;
    const current = docked ? modDockColumns(columns) : (pane.sized?.rows ?? pane.rows ?? Math.floor(rows / 3));
    resizeModPane(pane.plugin, pane.id, by, docked, docked ? Math.min(current, Math.floor(columns * 0.45)) : current);
  };
  useKeybinding('modPane:grow', () => resize(docked ? 4 : 2), { context: 'Global', isActive: hasPanes });
  useKeybinding('modPane:shrink', () => resize(docked ? -4 : -2), { context: 'Global', isActive: hasPanes });
  return null;
}

/** A line a mod put under a tool call's permission dialog (`$.ui.notice`):
 * the dialog being up is what makes the call open to one. */
export function ModToolNotice({ toolUseID }: { toolUseID: string }): React.ReactNode {
  useModUi();
  useEffect(() => {
    openModToolCall(toolUseID);
    return () => closeModToolCall(toolUseID);
  }, [toolUseID]);
  const notice = getModToolNotice(toolUseID);
  return notice ? <Box paddingX={2}><Text dimColor wrap="truncate-end">{notice.text}</Text></Box> : null;
}

/** Whether a mod's pane or the band holds the keyboard (the prompt yields). */
export function useModPaneFocused(): boolean {
  useModUi();
  return getFocusedModPane() !== null || isModBandFocused();
}

/** Whether toasts wait behind the shown pane (holdToasts). */
export function useModToastHold(): boolean {
  useModUi();
  return isModToastHold();
}

/** One line per plugin's `$.ui.status`, under the prompt. */
export function ModStatusLines(): React.ReactNode {
  useModUi();
  const statuses = [...getModStatuses()];
  if (!statuses.length) return null;
  return <Box flexDirection="column">{statuses.map(([plugin, text]) =>
    <Text key={plugin} color="warning" wrap="truncate-end">⚠ {plugin}: {text}</Text>)}</Box>;
}
