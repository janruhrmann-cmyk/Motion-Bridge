/**
 * Motion Bridge - After Effects panel.
 *
 * Towards Figma: reads the chosen compositions through host.jsx, converts
 * each to a bridge document, loads the images they need and hands everything
 * to the local bridge server, where the Figma plugin picks it up.
 *
 * From Figma: takes the frames the plugin pushes (or asks it for the ones
 * that are selected), plans each as a composition (shared/ae-build.ts), puts
 * their pictures on disk and has host.jsx build the plans.
 */
import type * as Fs from 'node:fs';
import type * as Http from 'node:http';
import type * as Os from 'node:os';
import type * as Path from 'node:path';
import type { RawController, RawDump, RawState } from '../../shared/ae-raw.ts';
import { planBuild, planText } from '../../shared/ae-build.ts';
import { convertAeDump, mergeDump } from '../../shared/ae-convert.ts';
import type { AssetRequest } from '../../shared/ae-convert.ts';
import { renderNotes } from '../../shared/dom/notes-view.ts';
import { FORMAT_VERSION, packDocs, rootName } from '../../shared/format.ts';
import type { BridgeDoc } from '../../shared/format.ts';
import type { Note } from '../../shared/notes.ts';
import { BRIDGE_PORT } from '../../shared/protocol.ts';
import type { BuildReport, CompReport, DesignLink, DesignsReport, PullAnswer, PullRequest, PushAnswer, PushReport, UpdateAnswer, UpdateRequest } from '../../shared/protocol.ts';
import { BridgeServer } from './bridge-server.ts';
import type { BridgeAsset, Pushed } from './bridge-server.ts';
import {
  SETTINGS_ID,
  callHost,
  closeThisExtension,
  extensionId,
  hostPanelColor,
  inCep,
  loadHost,
  nodeRequire,
  onEvent,
  onHostThemeChange,
  openExtension,
  sendEvent,
  setWindowTitle,
} from './cep.ts';

interface Status {
  ae: string;
  project: string | null;
  /** Number of items in the project; changes when compositions come and go. */
  items: number;
  comp: { id: string; name: string; w: number; h: number; layers: number; duration: number; time: number } | null;
  /** The compositions picked in the Project panel. */
  picked?: Array<{ id: string; name: string; w: number; h: number; layers: number; duration: number }>;
}

/** What host.jsx says it built from one plan. */
interface HostBuilt {
  id: string | null;
  name: string;
  comps: number;
  layers: number;
  keys: number;
  images: number;
  warnings: Array<{ comp?: string; layer?: string; message: string }>;
}

interface CompInfo {
  id: string;
  name: string;
  w: number;
  h: number;
  duration: number;
  layers: number;
  /** Used inside another composition: a building block, not a deliverable. */
  nested: number;
  folder: string;
}

/** A template option as the panel offers it: the same control found in one or more of the chosen compositions. */
interface Option {
  key: string;
  name: string;
  layer: string;
  kind: 'menu' | 'checkbox';
  settings: number;
  byComp: Map<string, RawController>;
}

/**
 * Designs on the Figma page that come from one composition of this project,
 * read the same way: what one row of "Designs in Figma" stands for, and what
 * is read in one go when they are updated.
 */
interface DesignGroup {
  id: string;
  comp: CompInfo;
  /** The plugin's names for the designs (DesignLink.key). */
  keys: string[];
  /** The template options that are variant properties in Figma, each as "layer/name". */
  options: string[];
  poster: number;
  frames: number;
}

/** One composition to read: with which options in every setting, and for what. */
interface Part {
  comp: CompInfo;
  /** The options to read in every setting: their ids in the composition, and as "layer/name". */
  ids: string[];
  options: string[];
  versions: number;
  /** For an update: the still pose the design was built with, and the designs it is read for. */
  poster?: number;
  update?: string[];
  /** For an update: options the design had that the composition no longer has. */
  gone?: string[];
}

type Mode = 'open' | 'several';
type Kind = 'info' | 'ok' | 'error';

class Cancelled extends Error {}

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const app = el('app');
const figmaChip = el<HTMLButtonElement>('figma-status');
const figmaLabel = el('figma-label');
const pairingBox = el('pairing');
const pairingTitle = el('pairing-title');
const pairingHint = el('pairing-hint');
const codeBox = el('code');
const copyButton = el<HTMLButtonElement>('copy-code');
const newCodeButton = el<HTMLButtonElement>('new-code');
const modeOpen = el<HTMLButtonElement>('mode-open');
const modeSeveral = el<HTMLButtonElement>('mode-several');
const openView = el('open-view');
const severalView = el('several-view');
const compName = el('comp-name');
const compMeta = el('comp-meta');
const filterInput = el<HTMLInputElement>('filter');
const nestedBox = el<HTMLInputElement>('show-nested');
const compList = el('comp-list');
const compCount = el('comp-count');
const tickAll = el<HTMLButtonElement>('tick-all');
const tickNone = el<HTMLButtonElement>('tick-none');
const optionsBox = el('options');
const optionBadge = el('option-badge');
const optionList = el('option-list');
const optionHint = el('option-hint');
const resultBox = el('result');
const resultTitle = el('result-title');
const resultMeta = el('result-meta');
const notesBox = el<HTMLDetailsElement>('notes');
const notesSummary = el('notes-summary');
const noteList = el('note-list');
const progressBox = el('progress');
const progressBar = el('bar');
const message = el('message');
const designsBox = el('designs');
const designBadge = el('design-badge');
const designList = el('design-list');
const designHint = el('design-hint');
const updateButton = el<HTMLButtonElement>('update');
const sendButton = el<HTMLButtonElement>('send');
const sendLabel = el('send-label');
const pullButton = el<HTMLButtonElement>('pull');
const pullLabel = el('pull-label');
const saveButton = el<HTMLButtonElement>('save');
const cancelButton = el<HTMLButtonElement>('cancel');
const cancelLabel = el('cancel-label');
const settingsButton = el<HTMLButtonElement>('settings');
const settingsDot = el('settings-dot');
const waitingText = el('waiting-text');

const CODE_KEY = 'motionbridge.pairingCode';
/** The options ticked last time, by layer and name, so every size of a template starts with the same choice. */
const OPTIONS_KEY = 'motionbridge.options';
const MODE_KEY = 'motionbridge.mode';
const NESTED_KEY = 'motionbridge.showNested';
/** More versions than this make a component set unwieldy (and the read slow). */
const MAX_VERSIONS = 64;
/** ... and this many in one go, over all compositions. */
const MAX_TOTAL = 256;
/** Rough time After Effects needs to read one version of a template. */
const SECONDS_PER_VERSION = 2.2;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** How long the panel waits for the frames it asked Figma for (large frames take a while to read). */
const FIGMA_WAIT_MS = 180000;
/**
 * A panel smaller than this has no room for its settings: it is the three
 * tiles and nothing else (style.css, data-compact), and the settings open in
 * a window of their own.
 */
const COMPACT_BELOW = { width: 200, height: 240 };
/** The file endings of the pictures Figma sends. */
const IMAGE_ENDINGS: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };
/** Formats a browser can decode, so the file is sent as it is. Everything else is rendered by After Effects. */
const DIRECT_IMAGES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/**
 * This page is the settings window of a panel that is docked too small to
 * show them (see "the settings window" below): it reads and sends nothing
 * itself.
 */
const mirror = inCep && extensionId() === SETTINGS_ID;
let server: BridgeServer | null = null;
/** In the settings window: the panel's bridge server is running. */
let serverUp = false;
let busy = false;
let cancelRequested = false;
let connected = false;
/** null: shown while Figma is not connected. true / false: the user opened or closed it. */
let pairingOpen: boolean | null = null;
let mode: Mode = localStorage.getItem(MODE_KEY) === 'several' ? 'several' : 'open';
let status: Status | null = null;
let hostBusy = false;
let comps: CompInfo[] = [];
let listedFor = '';
let ticked = new Set<string>();
let showNested = localStorage.getItem(NESTED_KEY) === '1';
let filter = '';
let optionsOn = rememberedOptions();
const controllerCache = new Map<string, RawController[]>();
/** Compositions whose options should be looked up again; the old answer is shown until the new one is in. */
const staleControllers = new Set<string>();
let notice: { text: string; kind: Kind } | null = null;
let pendingId: string | null = null;
/** The transfer Figma is working on is an update of designs, not new frames. */
let pendingUpdate = false;
let lastDocs: BridgeDoc[] = [];
let ticking = false;
/** Outside After Effects the panel only shows sample content. */
let previewing = false;
/** What the Figma plugin says its page holds that can be updated from here. */
let designs: DesignLink[] = [];
/** The designs (by group id) that were unticked: left alone by "Update designs in Figma". */
const designsOff = new Set<string>();
/** Set while an update is read. `request`: the Figma plugin's request, when it was the one to ask. */
let updating: { request: string | null } | null = null;
/** The names of the frames that are selected in Figma, as the plugin last said: what "Pull from Figma" brings. */
let figmaSelection: string[] = [];
/** Set while the panel waits for the frames it asked Figma for. */
let wanted: { request: string; arrived: (push: Pushed) => void } | null = null;
/** The Figma plugin's request for the open composition that is being read, so the plugin hears how far it is. */
let pulling: string | null = null;
/** Compositions are being built from Figma frames (rather than sent to Figma). */
let building = false;
const drawn = { comps: '', options: '', designs: '' };
/** What the result card shows, if it shows anything. */
interface Result {
  kind: 'ok' | 'error' | 'note';
  title: string;
  meta: string;
  notes: Note[];
}
let lastResult: Result | null = null;

/** There is a bridge to send over (outside After Effects the sample content pretends). */
const canSend = (): boolean => !!server || serverUp || previewing;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const count = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en')} ${n === 1 ? one : many}`;

function newCode(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

function showCode(code: string): void {
  codeBox.textContent = `${code.slice(0, 3)}-${code.slice(3)}`;
  queueSync();
}

function rememberedOptions(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

// ----------------------------------------------------------------- what to send

function targets(): CompInfo[] {
  if (mode === 'open') {
    const c = status?.comp;
    return c ? [{ id: c.id, name: c.name, w: c.w, h: c.h, duration: c.duration, layers: c.layers, nested: 0, folder: '' }] : [];
  }
  return comps.filter((c) => ticked.has(c.id));
}

const optionKey = (c: RawController): string => `${c.layer}/${c.name}`;

/** The template options of the chosen compositions. The same control in several of them is one option. */
function options(list: CompInfo[]): Option[] {
  const found = new Map<string, Option>();
  for (const comp of list) {
    for (const c of controllerCache.get(comp.id) ?? []) {
      const key = optionKey(c);
      let option = found.get(key);
      if (!option) {
        option = { key, name: c.name, layer: c.layer, kind: c.kind === 'checkbox' ? 'checkbox' : 'menu', settings: 0, byComp: new Map() };
        found.set(key, option);
      }
      option.settings = Math.max(option.settings, c.max - c.min + 1);
      option.byComp.set(comp.id, c);
    }
  }
  return [...found.values()];
}

interface Plan {
  parts: Part[];
  total: number;
  /** Why this cannot be sent, if it cannot. */
  problem: string;
}

function plan(list: CompInfo[] = targets()): Plan {
  const chosen = options(list).filter((o) => optionsOn.has(o.key));
  let worst = 0;
  const parts = list.map((comp): Part => {
    const mine = chosen.map((o) => o.byComp.get(comp.id)).filter((c): c is RawController => !!c);
    const versions = mine.reduce((n, c) => n * (c.max - c.min + 1), 1);
    worst = Math.max(worst, versions);
    return { comp, ids: mine.map((c) => c.id), options: mine.map(optionKey), versions };
  });
  const total = parts.reduce((n, p) => n + p.versions, 0);
  let problem = '';
  if (worst > MAX_VERSIONS) problem = `${worst} versions of one composition are too many (the limit is ${MAX_VERSIONS}). Untick an option.`;
  else if (total > MAX_TOTAL) problem = `${total} versions in one go are too many (the limit is ${MAX_TOTAL}). Untick an option or a composition.`;
  return { parts, total, problem };
}

function duration(seconds: number): string {
  if (seconds < 50) return `${Math.max(5, Math.round(seconds / 5) * 5)} seconds`;
  const minutes = Math.round(seconds / 60);
  return minutes <= 1 ? 'a minute' : `${minutes} minutes`;
}

// ------------------------------------------------------- designs in Figma

/**
 * The composition a design was built from. A project is saved under new
 * names and compositions are renamed, so either the project or the name may
 * have changed - but not both, unless the name still points to one
 * composition only.
 */
function compOfDesign(link: DesignLink): CompInfo | null {
  const byId = comps.find((c) => c.id === link.compId);
  if (byId && (byId.name === link.comp || link.project === (status?.project ?? null))) return byId;
  const named = comps.filter((c) => c.name === link.comp);
  return named.length === 1 ? named[0]! : null;
}

/** The designs on the Figma page, by what has to be read for them. `strangers`: the ones that are not from this project. */
function designGroups(list: DesignLink[] = designs): { groups: DesignGroup[]; strangers: DesignLink[] } {
  const groups = new Map<string, DesignGroup>();
  const strangers: DesignLink[] = [];
  for (const link of list) {
    const comp = compOfDesign(link);
    if (!comp) {
      strangers.push(link);
      continue;
    }
    const wanted = [...link.options].sort();
    const id = `${comp.id}|${wanted.join('\n')}|${Math.round(link.poster * 1000)}`;
    const group = groups.get(id);
    if (group) {
      group.keys.push(link.key);
      group.frames += link.frames;
    } else {
      groups.set(id, { id, comp, keys: [link.key], options: wanted, poster: link.poster, frames: link.frames });
    }
  }
  return { groups: [...groups.values()], strangers };
}

/** What reading a group takes: its options as the composition has them now. */
function partOf(group: DesignGroup): Part {
  const known = controllerCache.get(group.comp.id) ?? [];
  const found: RawController[] = [];
  const gone: string[] = [];
  for (const key of group.options) {
    const c = known.find((k) => optionKey(k) === key);
    if (c) found.push(c);
    else gone.push(key.slice(key.lastIndexOf('/') + 1));
  }
  return {
    comp: group.comp,
    ids: found.map((c) => c.id),
    options: found.map(optionKey),
    versions: found.reduce((n, c) => n * (c.max - c.min + 1), 1),
    poster: group.poster,
    update: group.keys,
    gone,
  };
}

// -------------------------------------------------------------------- drawing

function setMessage(text: string, kind: Kind = 'info'): void {
  notice = text ? { text, kind } : null;
  drawFooter();
}

function drawPairing(): void {
  figmaChip.dataset.on = connected ? '1' : '0';
  figmaLabel.textContent = connected ? 'Figma connected' : 'Figma not connected';
  const open = pairingOpen ?? !connected;
  pairingBox.hidden = !open;
  figmaChip.setAttribute('aria-expanded', String(open));
  if (connected) {
    pairingTitle.textContent = 'Figma is connected';
    pairingHint.textContent = 'Transfers go straight into the Figma file that has the plugin open.';
  } else {
    pairingTitle.textContent = 'Connect the Figma plugin';
    pairingHint.innerHTML = 'In Figma, run <b>Plugins › Motion Bridge</b> and type this code. You only do this once.';
  }
  queueSync();
}

function drawSource(): void {
  queueSync();
  modeOpen.setAttribute('aria-selected', String(mode === 'open'));
  modeSeveral.setAttribute('aria-selected', String(mode === 'several'));
  openView.hidden = mode !== 'open';
  severalView.hidden = mode !== 'several';

  if (mode === 'open') {
    const c = status?.comp;
    compName.dataset.empty = c ? '0' : '1';
    if (hostBusy) {
      compName.textContent = 'After Effects is busy';
      compMeta.textContent = '';
    } else if (c) {
      compName.textContent = c.name;
      compName.title = c.name;
      compMeta.textContent = `${c.w} × ${c.h} · ${c.duration.toFixed(1)} s · ${count(c.layers, 'layer')} · still pose from ${c.time.toFixed(2)} s`;
    } else {
      compName.textContent = 'No composition is active';
      compName.title = '';
      compMeta.textContent = 'Click into the timeline of the composition you want to send.';
    }
    return;
  }

  const activeId = status?.comp?.id ?? null;
  const needle = filter.trim().toLowerCase();
  const visible = comps.filter(
    (c) => (showNested || !c.nested || ticked.has(c.id) || c.id === activeId) && (!needle || c.name.toLowerCase().indexOf(needle) !== -1),
  );
  const signature = JSON.stringify([visible.map((c) => [c.id, c.name, c.w, c.h, c.duration, c.nested, c.folder]), [...ticked], activeId, busy, !listedFor]);
  if (signature !== drawn.comps) {
    drawn.comps = signature;
    compList.textContent = '';
    for (const c of visible) {
      const row = document.createElement('label');
      row.className = 'row';
      row.dataset.nested = c.nested ? '1' : '0';
      row.title = [c.name, c.folder ? `in “${c.folder}”` : '', `${c.duration.toFixed(1)} s, ${count(c.layers, 'layer')}`].filter(Boolean).join('\n');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = ticked.has(c.id);
      box.disabled = busy;
      box.addEventListener('change', () => {
        if (box.checked) ticked.add(c.id);
        else ticked.delete(c.id);
        selectionChanged();
      });
      // Name above, facts below: the name gets the whole width, whatever the panel's size.
      const text = document.createElement('span');
      text.className = 'text';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = c.name;
      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = `${c.w} × ${c.h} · ${c.duration.toFixed(1)} s${c.folder ? ` · in ${c.folder}` : ''}`;
      if (c.id === activeId) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'active';
        sub.appendChild(tag);
      }
      text.append(name, sub);
      row.append(box, text);
      compList.appendChild(row);
    }
    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = !listedFor
        ? 'Looking through the project…'
        : !comps.length
          ? 'This project has no compositions yet.'
        : needle
          ? 'No composition matches the filter.'
          : 'Every composition is used inside another one. Tick “Precomps” to list them.';
      compList.appendChild(empty);
    }
  }
  compCount.textContent = ticked.size ? `${ticked.size} ticked` : 'None ticked';
  tickAll.disabled = busy || !visible.length;
  tickNone.disabled = busy || !ticked.size;
}

function drawOptions(p: Plan): void {
  const list = options(p.parts.map((part) => part.comp));
  optionsBox.hidden = list.length === 0;
  if (!list.length) {
    drawn.options = '';
    return;
  }
  const several = p.parts.length > 1;
  const signature = JSON.stringify([list.map((o) => [o.key, o.settings, o.byComp.size]), [...optionsOn], p.parts.length, busy]);
  if (signature !== drawn.options) {
    drawn.options = signature;
    optionList.textContent = '';
    for (const o of list) {
      const row = document.createElement('label');
      row.className = 'row';
      row.title = `“${o.name}” on layer “${o.layer}”`;
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = optionsOn.has(o.key);
      box.disabled = busy;
      box.addEventListener('change', () => {
        if (box.checked) optionsOn.add(o.key);
        else optionsOn.delete(o.key);
        localStorage.setItem(OPTIONS_KEY, JSON.stringify([...optionsOn]));
        selectionChanged();
      });
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = o.name;
      const side = document.createElement('span');
      side.className = 'side';
      const settings = o.kind === 'checkbox' ? 'on / off' : `${o.settings} settings`;
      side.textContent = several && o.byComp.size < p.parts.length ? `${settings} · in ${o.byComp.size} of ${p.parts.length}` : settings;
      row.append(box, name, side);
      optionList.appendChild(row);
    }
  }
  const extra = p.total - p.parts.length;
  optionBadge.hidden = extra <= 0;
  optionBadge.textContent = count(p.total, 'version');
  optionBadge.dataset.kind = p.problem ? 'error' : 'info';
  optionHint.dataset.kind = p.problem ? 'error' : 'info';
  if (p.problem) optionHint.textContent = p.problem;
  else if (extra > 0) optionHint.textContent = `Each ticked option becomes a property in Figma. Reading takes about ${duration(p.total * SECONDS_PER_VERSION)}.`;
  else optionHint.textContent = 'Tick what designers should be able to switch in Figma. Nothing ticked: sent as it is set up now.';
}

/** "Designs in Figma": what the Figma page holds that was built from this project, and the button that updates it. */
function drawDesigns(): void {
  designsBox.hidden = !connected || !designs.length;
  queueSync();
  if (designsBox.hidden) {
    drawn.designs = '';
    return;
  }
  const { groups, strangers } = designGroups();
  const parts = groups.map(partOf);
  const activeId = status?.comp?.id ?? null;
  const signature = JSON.stringify([groups.map((g, i) => [g.id, g.comp.name, g.frames, parts[i]!.options]), [...designsOff], activeId, busy]);
  if (signature !== drawn.designs) {
    drawn.designs = signature;
    designList.textContent = '';
    groups.forEach((g, i) => {
      const row = document.createElement('label');
      row.className = 'row';
      const names = parts[i]!.options.map((key) => key.slice(key.lastIndexOf('/') + 1));
      row.title = [g.comp.name, count(g.frames, 'frame') + ' on the Figma page', names.length ? `Variant properties: ${names.join(', ')}` : ''].filter(Boolean).join('\n');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !designsOff.has(g.id);
      box.disabled = busy;
      box.addEventListener('change', () => {
        if (box.checked) designsOff.delete(g.id);
        else designsOff.add(g.id);
        drawDesigns();
        if (mirror) tell({ set: choices() });
      });
      const text = document.createElement('span');
      text.className = 'text';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = g.comp.name;
      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = [count(g.frames, 'frame'), ...names].join(' · ');
      if (g.comp.id === activeId) {
        const mark = document.createElement('span');
        mark.className = 'tag';
        mark.textContent = 'active';
        sub.appendChild(mark);
      }
      text.append(name, sub);
      row.append(box, text);
      designList.appendChild(row);
    });
  }

  const chosen = groups.map((g, i) => ({ g, part: parts[i]! })).filter((x) => !designsOff.has(x.g.id));
  const frames = chosen.reduce((n, x) => n + x.g.frames, 0);
  const versions = chosen.reduce((n, x) => n + x.part.versions, 0);
  designBadge.textContent = groups.length ? count(groups.reduce((n, g) => n + g.frames, 0), 'frame') : '';
  updateButton.disabled = busy || !chosen.length || !canSend();
  updateButton.textContent = frames === 1 ? 'Update design in Figma' : 'Update designs in Figma';

  const elsewhere = strangers.reduce((n, s) => n + s.frames, 0);
  let hint: string;
  if (!groups.length) {
    const from = strangers[0]?.project;
    hint = !listedFor
      ? 'Looking through the project…'
      : `The designs on the Figma page were built from another project${from ? ` (“${from}”)` : ''}. Open it to update them.`;
  } else {
    hint = `Reads the ticked compositions again${versions > chosen.length ? ` (about ${duration(versions * SECONDS_PER_VERSION)})` : ''} and rebuilds their frames in place. Variants switched and text edited in Figma stay.`;
    if (elsewhere) hint += ` ${count(elsewhere, 'more frame')} ${elsewhere === 1 ? 'comes' : 'come'} from another project.`;
  }
  designHint.textContent = hint;
}

function drawFooter(p: Plan = plan()): void {
  const n = p.parts.length;
  // Short enough to stand next to "Pull from Figma" in a narrow panel.
  sendLabel.textContent = n > 1 ? `Send ${n} comps` : 'Send to Figma';
  const blocked = !n || !!p.problem;
  sendButton.disabled = busy || blocked || !canSend();
  saveButton.disabled = busy || blocked;
  saveButton.hidden = busy;
  // Made small, the panel shows the tiles without their words: the tooltip says what a press sends.
  let sends: string;
  if (!n) sends = mode === 'several' ? 'Tick the compositions to send first (in the settings).' : 'Click into the timeline of the composition you want to send.';
  else if (p.problem) sends = p.problem;
  else if (n > 1) sends = `Sends the ${n} ticked compositions to Figma${p.total > n ? `, ${count(p.total, 'version')} in all` : ''}.`;
  else sends = `Sends “${p.parts[0]!.comp.name}” to Figma${p.total > 1 ? ` in ${count(p.total, 'version')}` : ''}.`;
  sendButton.title = `Send to Figma\n${sends}`;
  sendButton.setAttribute('aria-label', sendLabel.textContent);

  // The other direction: the frames that are selected in Figma become compositions here.
  const frames = figmaSelection.length;
  pullLabel.textContent = frames > 1 ? `Pull ${frames} frames` : 'Pull from Figma';
  pullButton.disabled = busy || !connected || !frames || !canSend();
  let pulls: string;
  if (!connected) pulls = 'Open the Motion Bridge plugin in Figma first.';
  else if (!frames) pulls = 'Select the frames in Figma that should become compositions here.';
  else if (frames === 1) pulls = `Builds “${figmaSelection[0]}”, the frame selected in Figma, as a composition in this project.`;
  else pulls = `Builds the ${frames} frames selected in Figma as compositions in this project:\n${figmaSelection.slice(0, 12).join('\n')}${frames > 12 ? '\n…' : ''}`;
  pullButton.title = `Pull from Figma\n${pulls}`;
  pullButton.setAttribute('aria-label', pullLabel.textContent);
  // The arrow of the tile that is at work keeps travelling: out to Figma, or in from it.
  sendButton.dataset.running = busy && !building ? '1' : '0';
  pullButton.dataset.running = busy && building ? '1' : '0';
  cancelButton.hidden = !busy;
  progressBox.hidden = !busy;
  document.documentElement.dataset.busy = busy ? '1' : '0';

  let text = notice?.text ?? '';
  let kind: Kind = notice?.kind ?? 'info';
  if (!busy && !notice && mode === 'several' && !n) text = 'Tick the compositions you want to send.';
  if (!busy && !notice && p.problem) {
    text = p.problem;
    kind = 'error';
  }
  message.textContent = text;
  message.dataset.kind = kind;

  // What a panel made small cannot spell out is on its settings tile: a dot, and the words as its tooltip.
  const wrong = kind === 'error' || lastResult?.kind === 'error';
  settingsDot.dataset.kind = busy ? 'busy' : wrong ? 'error' : connected ? 'on' : 'off';
  const said = text || (lastResult ? [lastResult.title, lastResult.meta].filter(Boolean).join('\n') : '');
  settingsButton.title = `Settings\n${said || (connected ? 'Figma is connected.' : 'Figma is not connected.')}`;
  cancelButton.title = text ? `Cancel\n${text}` : 'Cancel';
  queueSync();
}

function draw(): void {
  const p = plan();
  drawPairing();
  drawSource();
  drawOptions(p);
  drawDesigns();
  drawFooter(p);
}

/** The user changed what will be sent: an old result or error no longer describes it. */
function selectionChanged(): void {
  notice = null;
  draw();
  if (mirror) tell({ set: choices() });
  else void tick();
}

function hideResult(): void {
  lastResult = null;
  resultBox.hidden = true;
  queueSync();
}

function showResult(kind: Result['kind'], title: string, meta: string, notes: Note[]): void {
  lastResult = { kind, title, meta, notes };
  resultBox.hidden = false;
  resultBox.dataset.kind = kind;
  resultTitle.textContent = title;
  resultMeta.textContent = meta;
  const shown = renderNotes(noteList, notes);
  notesBox.hidden = shown === 0;
  notesBox.open = false;
  notesSummary.textContent = `${count(shown, 'note')} on what was left out or changed`;
  resultBox.scrollIntoView({ block: 'nearest' });
  drawFooter();
}

function setProgress(fraction: number, text: string): void {
  progressBar.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
  notice = { text, kind: 'info' };
  drawFooter();
  // A Figma plugin that asked for this (an update, or the open composition) shows the same line.
  const listener = updating?.request ?? pulling;
  if (listener) server?.progress(text, fraction);
}

// ----------------------------------------------------------- After Effects

/** Looks at After Effects: the active composition, the list of compositions, their template options. */
async function tick(force = false): Promise<void> {
  if (busy || ticking || !inCep || mirror) return;
  ticking = true;
  try {
    try {
      const next = await callHost<Status>('getStatus');
      if (status && next.project !== status.project) {
        // Another project: ids mean something else now.
        ticked = new Set();
        controllerCache.clear();
        staleControllers.clear();
        listedFor = '';
      }
      status = next;
      hostBusy = false;
    } catch {
      hostBusy = true;
      draw();
      return;
    }
    // The list of compositions is needed to choose several, and to find the ones the designs in Figma came from.
    if (mode === 'several' || designs.length) {
      const signature = `${status.project}|${status.items}`;
      if (force || signature !== listedFor) {
        const found = await callHost<{ active: string | null; comps: CompInfo[] }>('listComps');
        const first = listedFor === '' && !ticked.size;
        comps = found.comps;
        listedFor = signature;
        const known = new Set(comps.map((c) => c.id));
        ticked = new Set([...ticked].filter((id) => known.has(id)));
        if (first && found.active && known.has(found.active)) ticked.add(found.active);
      }
    }
    const linked = designGroups().groups.map((g) => g.comp);
    for (const comp of [...targets(), ...linked]) {
      if (controllerCache.has(comp.id) && !staleControllers.has(comp.id)) continue;
      try {
        const found = await callHost<{ controllers: RawController[] }>('listControllers', comp.id);
        controllerCache.set(comp.id, found.controllers);
      } catch {
        if (!controllerCache.has(comp.id)) controllerCache.set(comp.id, []);
      }
      staleControllers.delete(comp.id);
    }
    draw();
  } finally {
    ticking = false;
  }
}

/** Waits until a file After Effects is writing has stopped growing, then reads it. */
async function readWhenWritten(fs: typeof Fs, file: string): Promise<Uint8Array | null> {
  let lastSize = -1;
  for (let i = 0; i < 80; i++) {
    if (fs.existsSync(file)) {
      const size = fs.statSync(file).size;
      if (size > 0 && size === lastSize) return fs.readFileSync(file);
      lastSize = size;
    }
    await sleep(125);
  }
  return null;
}

async function loadAsset(req: AssetRequest): Promise<BridgeAsset | null> {
  const fs = nodeRequire<typeof Fs>('fs');
  const path = nodeRequire<typeof Path>('path');
  const os = nodeRequire<typeof Os>('os');

  if (req.file && req.still) {
    const mime = DIRECT_IMAGES[path.extname(req.file).toLowerCase()];
    if (mime && fs.existsSync(req.file)) return { bytes: fs.readFileSync(req.file), mime };
  }
  const dir = path.join(os.tmpdir(), 'motion-bridge');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${req.assetId}-${Date.now()}.png`);
  try {
    await callHost<{ path: string }>('renderFootage', req.footageId, req.time, out.replace(/\\/g, '/'));
    const bytes = await readWhenWritten(fs, out);
    return bytes ? { bytes, mime: 'image/png' } : null;
  } catch {
    return null;
  } finally {
    try {
      if (fs.existsSync(out)) fs.unlinkSync(out);
    } catch {
      // A leftover temp file is harmless.
    }
  }
}

function stopIfCancelled(): void {
  if (cancelRequested) throw new Cancelled('Cancelled.');
}

/**
 * Reads every chosen composition. Other settings of a template option are
 * read by switching it in After Effects for a moment; host.jsx puts every
 * value back before it answers.
 */
async function exportAll(parts: Part[] = plan().parts): Promise<{ docs: BridgeDoc[]; assets: Map<string, BridgeAsset> }> {
  const p = { parts, total: parts.reduce((n, part) => n + part.versions, 0) };
  const docs: BridgeDoc[] = [];
  const assets = new Map<string, BridgeAsset>();
  /** Images that could not be read, so each is only tried (and reported) once. */
  const failed = new Set<string>();
  let done = 0;

  for (let n = 0; n < p.parts.length; n++) {
    const part = p.parts[n]!;
    const which = p.parts.length > 1 ? `“${part.comp.name}” (${n + 1} of ${p.parts.length})` : `“${part.comp.name}”`;
    stopIfCancelled();
    setProgress(done / p.total, `Reading ${which}…`);
    // An update reads the pose the design was built with, wherever the playhead is now.
    const base = await callHost<RawDump>('beginExport', part.ids, part.comp.id, part.poster ?? null);
    const pending = base.pending ?? [];
    const states: RawState[] = [];
    try {
      done++;
      for (let i = 0; i < pending.length; i++) {
        stopIfCancelled();
        setProgress(done / p.total, `Reading ${which} · version ${i + 2} of ${pending.length + 1}…`);
        states.push(await callHost<RawState>('exportState', i));
        done++;
      }
    } finally {
      await callHost('endExport').catch(() => undefined);
    }
    const { doc, assets: requests } = convertAeDump(mergeDump(base, states));
    // What it takes to read this composition the same way again: Figma keeps it with the frame.
    doc.link = { compId: part.comp.id, options: part.options };
    if (part.update) doc.update = part.update;
    for (const name of part.gone ?? []) {
      doc.warnings.push({ level: 'warn', comp: part.comp.name, message: `The template option "${name}" is no longer in the composition, so the design loses that property.` });
    }

    let image = 0;
    for (const req of requests) {
      stopIfCancelled();
      image++;
      let asset = assets.get(req.assetId) ?? null;
      if (!asset && !failed.has(req.assetId)) {
        setProgress(done / p.total, `Preparing images for ${which} (${image} of ${requests.length})…`);
        asset = await loadAsset(req);
        if (asset) assets.set(req.assetId, asset);
        else failed.add(req.assetId);
      }
      const info = doc.assets[req.assetId];
      if (asset && info) info.mime = asset.mime;
      if (!asset) doc.warnings.push({ level: 'warn', message: `Image "${req.name}" could not be read and is replaced by a placeholder.` });
    }
    docs.push(doc);
  }
  return { docs, assets };
}

function docNotes(docs: BridgeDoc[]): Note[] {
  const notes: Note[] = [];
  for (const doc of docs) {
    for (const w of doc.warnings) notes.push({ where: w.layer ?? w.comp ?? '', text: w.message });
  }
  return notes;
}

function begin(): void {
  busy = true;
  cancelRequested = false;
  hideResult();
  cancelButton.disabled = false;
  cancelLabel.textContent = 'Cancel';
  progressBar.style.width = '0%';
  draw();
}

function end(): void {
  busy = false;
  draw();
  void tick();
}

function explain(err: unknown): void {
  if (err instanceof Cancelled) setMessage(updating ? 'Cancelled. The designs in Figma are as they were.' : building ? 'Cancelled. Nothing was built.' : 'Cancelled. Nothing was sent.');
  else setMessage(err instanceof Error ? err.message : String(err), 'error');
}

/**
 * What the Figma plugin's "Pull from After Effects" brings: the composition
 * whose timeline is in front, else the ones picked in the Project panel.
 */
function pullTargets(): CompInfo[] {
  const c = status?.comp;
  if (c) return [{ id: c.id, name: c.name, w: c.w, h: c.h, duration: c.duration, layers: c.layers, nested: 0, folder: '' }];
  return (status?.picked ?? []).map((item) => ({ ...item, nested: 0, folder: '' }));
}

const namesOf = (list: CompInfo[]): string => (list.length === 1 ? list[0]!.name : `${list.length} compositions`);

/** How these compositions are read: with the template options that are ticked, the way "Send to Figma" reads them. */
async function partsFor(list: CompInfo[]): Promise<Part[]> {
  for (const comp of list) {
    if (controllerCache.has(comp.id) && !staleControllers.has(comp.id)) continue;
    try {
      const found = await callHost<{ controllers: RawController[] }>('listControllers', comp.id);
      controllerCache.set(comp.id, found.controllers);
    } catch {
      if (!controllerCache.has(comp.id)) controllerCache.set(comp.id, []);
    }
    staleControllers.delete(comp.id);
  }
  const p = plan(list);
  if (p.problem) throw new Error(p.problem);
  return p.parts;
}

/**
 * "Send to Figma". With `pull`, the Figma plugin asked for it ("Pull from
 * After Effects"): the compositions it gets are named there, and the plugin
 * hears how reading went.
 */
async function send(pull?: { request: string; comps: CompInfo[] }): Promise<void> {
  if (busy || !server) return;
  begin();
  const bridge = server;
  pulling = pull ? pull.request : null;
  try {
    const { docs, assets } = await exportAll(pull ? await partsFor(pull.comps) : plan().parts);
    lastDocs = docs;
    pendingId = bridge.publish(docs, assets, pull ? { request: pull.request } : {});
    pendingUpdate = false;
    if (bridge.isConnected) {
      setMessage('Sent. Figma is building it…');
    } else {
      setMessage('');
      showResult('note', 'Waiting for Figma', 'The transfer is picked up as soon as the Motion Bridge plugin is open in Figma.', docNotes(docs));
    }
  } catch (err) {
    explain(err);
    if (pull) {
      if (err instanceof Cancelled) bridge.notice('Reading was cancelled in After Effects.', 'info', pull.request);
      else bridge.notice(err instanceof Error ? err.message : String(err), 'error', pull.request);
    }
  } finally {
    pulling = null;
    end();
  }
}

/** The Figma plugin's "Pull from After Effects". Reading starts unless the panel is in the middle of something. */
function onPullRequest(request: PullRequest): PullAnswer {
  if (busy) return { ok: false, error: 'After Effects is busy with another transfer. Try again when it has finished.' };
  const comps = pullTargets();
  if (!comps.length) {
    return { ok: false, error: 'No composition is open in After Effects. Click into the timeline of the one you want, or pick compositions in the Project panel.' };
  }
  void send({ request: request.request, comps });
  return { ok: true, name: namesOf(comps) };
}

// --------------------------------------------------------------- from Figma

/**
 * Puts the pictures of a push on disk - After Effects links to files - and
 * says where each one is. They go next to the project file (see
 * footageFolder in host.jsx).
 */
async function saveImages(push: Pushed): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  if (!push.assets.size) return files;
  const fs = nodeRequire<typeof Fs>('fs');
  const path = nodeRequire<typeof Path>('path');
  const folder = (await callHost<{ path: string }>('footageFolder')).path;
  fs.mkdirSync(folder, { recursive: true });
  const names = new Map<string, string>();
  for (const doc of push.docs) {
    for (const asset of Object.values(doc.assets)) if (!names.has(asset.id)) names.set(asset.id, asset.name);
  }
  for (const [id, asset] of push.assets) {
    const name = (names.get(id) ?? 'image').replace(/[^A-Za-z0-9 _-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) || 'image';
    const file = path.join(folder, `${name} ${id.replace(/[^A-Za-z0-9]/g, '').slice(0, 16)}${IMAGE_ENDINGS[asset.mime] ?? '.png'}`);
    // An id is a fingerprint of the picture: the same picture again is the same file, and the same footage.
    if (!fs.existsSync(file) || fs.statSync(file).size !== asset.bytes.byteLength) fs.writeFileSync(file, asset.bytes);
    files[id] = file.replace(/\\/g, '/');
  }
  return files;
}

function failedReport(id: string, err: unknown): PushReport {
  const error = err instanceof Cancelled ? 'Building was cancelled in After Effects.' : err instanceof Error ? err.message : String(err);
  return { id, ok: false, error, comps: [], layers: 0, precomps: 0, keyframes: 0, images: 0, warnings: [] };
}

/** What After Effects made of the frames: shown here, and told to the plugin. */
function showBuilt(report: PushReport, notes: Note[]): void {
  const built = report.comps.filter((c) => c.ok);
  const made = [count(report.layers, 'layer')];
  if (report.precomps) made.push(count(report.precomps, 'nested composition'));
  if (report.keyframes) made.push(count(report.keyframes, 'keyframe'));
  if (report.images) made.push(count(report.images, 'image'));
  const all: Note[] = [...report.warnings.map((text) => ({ where: '', text })), ...notes];
  const title = built.length === 1 ? `Built “${built[0]!.name}” from Figma` : `Built ${built.length} compositions from Figma`;
  showResult(built.length < report.comps.length ? 'note' : 'ok', title, made.join(' · '), all);
}

/**
 * Builds a composition from each frame of a push: plans it, writes the plan
 * to a file and has host.jsx carry it out. A frame that cannot be built does
 * not stop the others.
 */
async function buildDocs(push: Pushed, bridge: BridgeServer): Promise<void> {
  const fs = nodeRequire<typeof Fs>('fs');
  const path = nodeRequire<typeof Path>('path');
  const os = nodeRequire<typeof Os>('os');
  const docs = push.docs;
  if (docs.some((doc) => doc.version > FORMAT_VERSION)) {
    throw new Error('These frames were sent by a newer Motion Bridge. Please update the After Effects panel.');
  }
  setProgress(0.1, 'Preparing…');
  const defaults = await callHost<{ frameRate: number; duration: number }>('buildDefaults');
  const files = await saveImages(push);
  const scratch = path.join(os.tmpdir(), 'motion-bridge');
  fs.mkdirSync(scratch, { recursive: true });

  const report: PushReport = { id: push.id, ok: false, comps: [], layers: 0, precomps: 0, keyframes: 0, images: 0, warnings: [] };
  const notes: Note[] = [];
  const images = new Set<string>();
  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i]!;
    const name = rootName(doc);
    setProgress(0.15 + (0.85 * i) / docs.length, docs.length > 1 ? `Building “${name}” (${i + 1} of ${docs.length})…` : `Building “${name}”…`);
    const part: CompReport = { name, ok: false, layers: 0, precomps: 0, keyframes: 0, warnings: [] };
    report.comps.push(part);
    const file = path.join(scratch, `plan-${Date.now()}-${i}.json`);
    try {
      const { plan: steps, warnings } = planBuild(doc, { frameRate: defaults.frameRate, duration: defaults.duration, files });
      fs.writeFileSync(file, planText(steps));
      // The first composition is opened, so there is something to look at.
      const built = await callHost<HostBuilt>('buildFromFile', file.replace(/\\/g, '/'), i === 0 ? 1 : 0);
      part.ok = true;
      part.layers = built.layers;
      part.precomps = Math.max(0, built.comps - 1);
      part.keyframes = built.keys;
      for (const f of steps.footage) images.add(f.id);
      for (const w of [...doc.warnings, ...warnings, ...built.warnings]) {
        part.warnings.push(w.layer ? `${w.layer}: ${w.message}` : w.message);
        notes.push({ where: w.layer ?? (docs.length > 1 ? name : ''), text: w.message });
      }
    } catch (err) {
      part.error = err instanceof Error ? err.message : String(err);
    } finally {
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch {
        // A leftover plan in the temp folder is harmless.
      }
    }
  }

  const built = report.comps.filter((c) => c.ok);
  if (!built.length) throw new Error(report.comps[0]?.error ?? 'Nothing could be built.');
  report.ok = true;
  report.layers = built.reduce((n, c) => n + c.layers, 0);
  report.precomps = built.reduce((n, c) => n + c.precomps, 0);
  report.keyframes = built.reduce((n, c) => n + c.keyframes, 0);
  report.images = images.size;
  for (const c of report.comps) if (c.error) report.warnings.push(`“${c.name}” could not be built: ${c.error}`);
  bridge.pushed(report);
  setMessage('');
  showBuilt(report, notes);
}

/** Frames the Figma plugin pushed on its own ("Push to After Effects"). */
async function buildPushed(push: Pushed): Promise<void> {
  if (busy || !server) return;
  const bridge = server;
  begin();
  building = true;
  try {
    await buildDocs(push, bridge);
  } catch (err) {
    explain(err);
    bridge.pushed(failedReport(push.id, err));
  } finally {
    building = false;
    end();
  }
}

/**
 * "Pull from Figma": asks the plugin for the frames that are selected there
 * and builds them. The plugin answers with a push that names the request.
 */
async function pullFromFigma(): Promise<void> {
  if (busy || !server) return;
  const bridge = server;
  begin();
  building = true;
  let push: Pushed | null = null;
  try {
    const request = `w${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    setProgress(0, 'Asking Figma for the selected frames…');
    const arrived = new Promise<Pushed>((resolve) => {
      wanted = { request, arrived: resolve };
    });
    if (!bridge.want(request)) throw new Error('The Figma plugin is not connected. Open Motion Bridge in Figma first.');
    const started = Date.now();
    while (!push) {
      push = await Promise.race([arrived, sleep(200).then(() => null)]);
      if (push) break;
      stopIfCancelled();
      if (Date.now() - started > FIGMA_WAIT_MS) throw new Error('Figma did not answer. Is the Motion Bridge plugin still open?');
      if (Date.now() - started > 1200) setProgress(0.05, 'Figma is reading the frames…');
    }
    wanted = null;
    if (push.error || !push.docs.length) throw new Error(push.error || 'Figma had nothing to send.');
    await buildDocs(push, bridge);
  } catch (err) {
    explain(err);
    // The plugin sent frames and waits to hear what became of them.
    if (push && push.docs.length) bridge.pushed(failedReport(push.id, err));
  } finally {
    wanted = null;
    building = false;
    end();
  }
}

/** Frames arrive from the Figma plugin. The answer only says whether building starts. */
function onPush(push: Pushed): PushAnswer {
  // The answer to this panel's own question.
  if (wanted && push.request === wanted.request) {
    wanted.arrived(push);
    return { ok: true };
  }
  if (push.request) return { ok: false, error: 'After Effects is no longer waiting for these frames.' };
  if (busy) return { ok: false, error: 'After Effects is busy with another transfer. Try again when it has finished.' };
  if (!push.docs.length) return { ok: false, error: 'There were no frames to build.' };
  void buildPushed(push);
  return { ok: true };
}

/**
 * "Update designs in Figma": reads the compositions the designs on the Figma
 * page were built from again - with the same template options and the same
 * still pose - and sends them as an update, which Figma builds into the
 * frames that are already there. `request` is set when the Figma plugin
 * asked (with the designs it wants in `keys`); it then hears how it ended.
 */
async function updateDesigns(request?: UpdateRequest): Promise<void> {
  if (busy || !server) return;
  begin();
  const asked = request ? request.request : null;
  updating = { request: asked };
  const bridge = server;
  try {
    setProgress(0, 'Looking up the designs…');
    // As the project is right now: the list the panel shows may be a moment old.
    const found = await callHost<{ active: string | null; comps: CompInfo[] }>('listComps');
    comps = found.comps;
    const wanted = request ? designs.filter((d) => request.keys.indexOf(d.key) !== -1) : designs;
    const { groups, strangers } = designGroups(wanted);
    const chosen = request ? groups : groups.filter((g) => !designsOff.has(g.id));
    if (!chosen.length) {
      const from = strangers[0]?.project;
      throw new Error(
        strangers.length
          ? `These designs were built from another After Effects project${from ? ` (“${from}”)` : ''}. Open it and update again.`
          : request
            ? 'The After Effects panel has not heard of these designs yet. Try again in a moment.'
            : 'There is no design to update. Tick one under “Designs in Figma”.',
      );
    }
    for (const g of chosen) {
      stopIfCancelled();
      const listed = await callHost<{ controllers: RawController[] }>('listControllers', g.comp.id);
      controllerCache.set(g.comp.id, listed.controllers);
    }
    const { docs, assets } = await exportAll(chosen.map(partOf));
    lastDocs = docs;
    pendingId = bridge.publish(docs, assets, { kind: 'update', request: asked ?? undefined });
    pendingUpdate = true;
    if (bridge.isConnected) {
      setMessage('Sent. Figma is updating the designs…');
    } else {
      setMessage('');
      showResult('note', 'Waiting for Figma', 'The designs are updated as soon as the Motion Bridge plugin is open in Figma.', docNotes(docs));
    }
  } catch (err) {
    explain(err);
    if (asked) {
      if (err instanceof Cancelled) bridge.notice('The update was cancelled in After Effects.', 'info', asked);
      else bridge.notice(err instanceof Error ? err.message : String(err), 'error', asked);
    }
  } finally {
    updating = null;
    end();
  }
}

/** The Figma plugin's "Update designs". Reading starts unless the panel is in the middle of something. */
function onUpdateRequest(request: UpdateRequest): UpdateAnswer {
  if (busy) return { ok: false, error: 'After Effects is busy with another transfer. Try again when it has finished.' };
  if (!request.keys.length) return { ok: false, error: 'There is no design to update.' };
  void updateDesigns(request);
  return { ok: true };
}

function onDesigns(report: DesignsReport): void {
  const selection = report.selection ?? [];
  if (selection.join('\n') !== figmaSelection.join('\n')) {
    figmaSelection = selection;
    drawFooter();
  }
  const next = report.designs.filter((d) => d && typeof d.key === 'string' && typeof d.compId === 'string' && Array.isArray(d.options));
  const changed = JSON.stringify(next) !== JSON.stringify(designs);
  designs = next;
  if (!changed) return;
  drawDesigns();
  // The compositions they came from may not be listed yet.
  void tick();
}

async function saveFile(): Promise<void> {
  if (busy) return;
  begin();
  try {
    const { docs, assets } = await exportAll();
    const Buf = nodeRequire<{ Buffer: typeof Buffer }>('buffer').Buffer;
    // An image used by several compositions is stored once; the plugin looks through all of them.
    const stored = new Set<string>();
    for (const doc of docs) {
      for (const id of Object.keys(doc.assets)) {
        const asset = assets.get(id);
        if (!asset || stored.has(id)) continue;
        doc.assets[id]!.data = Buf.from(asset.bytes).toString('base64');
        stored.add(id);
      }
    }
    const base = docs.length === 1 ? rootName(docs[0]!) : `${rootName(docs[0]!)} and ${docs.length - 1} more`;
    const picked = await callHost<{ path: string | null }>('pickSavePath', `${base.replace(/[\\/:*?"<>|]+/g, '_')}.motionbridge`);
    if (!picked.path) {
      setMessage('Saving was cancelled.');
      return;
    }
    nodeRequire<typeof Fs>('fs').writeFileSync(picked.path, JSON.stringify(packDocs(docs)));
    setMessage('');
    showResult('ok', 'Saved', 'Drop the file onto the Motion Bridge plugin in Figma.', docNotes(docs));
  } catch (err) {
    explain(err);
  } finally {
    end();
  }
}

/** What Figma made of an update: what was rebuilt, what needed nothing, what was kept. */
function showUpdated(report: BuildReport): void {
  const updated = report.updated ?? 0;
  const unchanged = report.unchanged ?? 0;
  const frames = report.frames ?? [];
  const notes: Note[] = report.warnings.map((text) => ({ where: '', text }));
  for (const f of frames) {
    for (const text of f.warnings) notes.push({ where: frames.length > 1 ? f.name : '', text });
  }
  notes.push(...docNotes(lastDocs));
  if (!updated) {
    showResult('ok', unchanged === 1 ? 'The design in Figma is up to date' : 'The designs in Figma are up to date', 'Nothing has changed here since it was built, so Figma was not touched.', notes);
    return;
  }
  const made = [count(report.nodes, 'layer')];
  if (report.components) made.push(count(report.components, 'new component'));
  made.push(count(report.tracks, 'animated property', 'animated properties'));
  if (unchanged) made.push(`${unchanged.toLocaleString('en')} already up to date`);
  if (report.kept) made.push(`${count(report.kept, 'change')} made in Figma kept`);
  if (report.retired) made.push(`${count(report.retired, 'unused component')} removed`);
  const failed = frames.some((f) => !f.ok);
  const title = updated === 1 ? `Updated “${report.frameName ?? ''}” in Figma` : `Updated ${updated} designs in Figma`;
  showResult(failed ? 'note' : 'ok', title, made.join(' · '), notes);
}

function onResult(report: BuildReport): void {
  if (report.id !== pendingId) return;
  pendingId = null;
  setMessage('');
  if (!report.ok) {
    showResult('error', report.kind === 'update' ? 'Figma could not update the designs' : 'Figma could not build it', report.error ?? 'Unknown error.', []);
    return;
  }
  if (report.kind === 'update') {
    showUpdated(report);
    return;
  }
  const frames = report.frames ?? [];
  const built = frames.length ? frames.filter((f) => f.ok).length : 1;
  const made = [count(report.nodes, 'layer')];
  if (report.components) made.push(count(report.components, 'component'));
  if (report.reused) made.push(`${count(report.reused, 'component')} used again`);
  made.push(count(report.tracks, 'animated property', 'animated properties'));

  const notes: Note[] = report.warnings.map((text) => ({ where: '', text }));
  for (const f of frames) {
    for (const text of f.warnings) notes.push({ where: frames.length > 1 ? f.name : '', text });
  }
  notes.push(...docNotes(lastDocs));
  const title = built === 1 ? `Built “${report.frameName ?? ''}” in Figma` : `Built ${built} frames in Figma`;
  showResult(built < Math.max(1, frames.length) ? 'note' : 'ok', title, made.join(' · '), notes);
}

function setFigma(now: boolean): void {
  connected = now;
  // Once Figma is there the code is no longer needed; it stays one click away.
  if (now) pairingOpen = null;
  // Without the plugin nobody knows what its page holds; it says so again when it is back.
  else {
    designs = [];
    figmaSelection = [];
  }
  drawPairing();
  drawDesigns();
  drawFooter();
}

function copyText(text: string): void {
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  try {
    document.execCommand('copy');
  } catch {
    // The code can still be typed by hand.
  }
  area.remove();
}

/** Takes After Effects' panel colour, so the panel matches every interface brightness. */
function applyTheme(): void {
  const c = hostPanelColor();
  if (!c) return;
  const light = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255 > 0.5;
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  document.documentElement.style.setProperty('--bg', `rgb(${c.r}, ${c.g}, ${c.b})`);
}

/** "Cancel": what is being read or built stops at the next step. */
function requestCancel(): void {
  if (!busy) return;
  cancelRequested = true;
  cancelButton.disabled = true;
  cancelLabel.textContent = 'Stopping…';
  queueSync();
}

function makeNewCode(): void {
  const fresh = newCode();
  localStorage.setItem(CODE_KEY, fresh);
  showCode(fresh);
  server?.setCode(fresh);
  setMessage('New pairing code. Enter it in the Figma plugin.');
}

/** Whether the panel has room for its settings, or is its three tiles only. */
function fitWindow(): void {
  const compact = !mirror && (window.innerWidth < COMPACT_BELOW.width || window.innerHeight < COMPACT_BELOW.height);
  document.documentElement.dataset.compact = compact ? '1' : '0';
}

// ------------------------------------------------------ the settings window

/**
 * A panel docked as a strip of three tiles has no room for its settings, so
 * its third tile opens them in a window of their own: a second extension of
 * this bundle (manifest.xml) that loads this same page. The two run in
 * separate processes and share nothing, so the panel tells the window what
 * it knows, and the window tells the panel what was chosen or pressed there.
 * Everything is still read, sent and built by the panel; without the panel
 * the window shows nothing.
 */
const TO_WINDOW = 'com.motionbridge.to-settings';
const TO_PANEL = 'com.motionbridge.to-panel';

/** What is chosen in the settings: which compositions, which options, which designs. */
interface Choices {
  mode: Mode;
  ticked: string[];
  optionsOn: string[];
  designsOff: string[];
}
type Command = 'send' | 'pull' | 'update' | 'save' | 'cancel' | 'new-code';
/** `from` and `n` number what one window did, so it can tell when the panel has caught up with it. */
type ToPanel = { kind: 'hello' } | { kind: 'act'; from: string; n: number; set?: Choices; run?: Command };
/** The long lists, which change rarely: the project's compositions and the template options of the ones in play. */
interface Base {
  comps: CompInfo[];
  controllers: Array<[string, RawController[]]>;
}
/** Everything else the settings show. */
interface View extends Choices {
  code: string;
  connected: boolean;
  status: Status | null;
  hostBusy: boolean;
  listedFor: string;
  designs: DesignLink[];
  figmaSelection: string[];
  busy: boolean;
  building: boolean;
  cancelling: boolean;
  serverUp: boolean;
  notice: { text: string; kind: Kind } | null;
  progress: string;
  result: Result | null;
  /** The last thing a settings window did that is part of this view. */
  ack: { from: string; n: number } | null;
}
type ToWindow = { kind: 'here' } | { kind: 'gone' } | { kind: 'base'; base: Base } | { kind: 'view'; view: View };

const choices = (): Choices => ({ mode, ticked: [...ticked], optionsOn: [...optionsOn], designsOff: [...designsOff] });

// In the panel:
/** A settings window is listening. */
let windowOpen = false;
/** What it was last told, so it only hears of changes. */
const told = { base: '', view: '' };
let acked: View['ack'] = null;
let syncQueued = false;

/** Something the settings show may have changed: tell the window, once things have settled. */
function queueSync(): void {
  if (mirror || !windowOpen || syncQueued) return;
  syncQueued = true;
  setTimeout(() => {
    syncQueued = false;
    sync();
  }, 40);
}

function sync(): void {
  const inPlay = new Set([...targets(), ...designGroups().groups.map((g) => g.comp)].map((c) => c.id));
  const base: Base = { comps, controllers: [...controllerCache].filter(([id]) => inPlay.has(id)) };
  const baseText = JSON.stringify(base);
  if (baseText !== told.base) {
    told.base = baseText;
    sendEvent(TO_WINDOW, { kind: 'base', base } satisfies ToWindow);
  }
  const view: View = {
    ...choices(),
    code: codeBox.textContent ?? '',
    connected,
    status,
    hostBusy,
    listedFor,
    designs,
    figmaSelection,
    busy,
    building,
    cancelling: busy && cancelRequested,
    serverUp: !!server,
    notice,
    progress: progressBar.style.width,
    result: lastResult,
    ack: acked,
  };
  const viewText = JSON.stringify(view);
  if (viewText !== told.view) {
    told.view = viewText;
    sendEvent(TO_WINDOW, { kind: 'view', view } satisfies ToWindow);
  }
}

function runCommand(what: Command): void {
  if (what === 'send') void send();
  else if (what === 'pull') void pullFromFigma();
  else if (what === 'update') void updateDesigns();
  else if (what === 'save') void saveFile();
  else if (what === 'cancel') requestCancel();
  else makeNewCode();
}

/** The settings window says hello, or what was chosen or pressed in it. */
function onWindowMessage(msg: ToPanel): void {
  windowOpen = true;
  if (msg.kind === 'hello') {
    // A window that just opened knows nothing yet.
    told.base = '';
    told.view = '';
    queueSync();
    return;
  }
  acked = { from: msg.from, n: msg.n };
  if (msg.set && !busy) {
    const before = JSON.stringify([mode, [...ticked], [...optionsOn]]);
    mode = msg.set.mode === 'several' ? 'several' : 'open';
    ticked = new Set(msg.set.ticked);
    optionsOn = new Set(msg.set.optionsOn);
    designsOff.clear();
    for (const id of msg.set.designsOff) designsOff.add(id);
    localStorage.setItem(MODE_KEY, mode);
    localStorage.setItem(OPTIONS_KEY, JSON.stringify([...optionsOn]));
    if (before !== JSON.stringify([mode, [...ticked], [...optionsOn]])) selectionChanged();
    else drawDesigns();
  }
  if (msg.run) runCommand(msg.run);
  queueSync();
}

// In the settings window:
/** Names this window, so the panel's answers to another one are not taken for answers to this one. */
const session = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`;
/** How many things this window has told the panel. */
let actions = 0;
let panelSeen = false;

function tell(what: { set?: Choices; run?: Command }): void {
  actions++;
  sendEvent(TO_PANEL, { kind: 'act', from: session, n: actions, ...what } satisfies ToPanel);
}

/** A button of the settings window: the panel does what it stands for. */
const press = (what: Command, here: () => void) => (): void => {
  if (mirror) tell({ run: what });
  else here();
};

function onPanelMessage(msg: ToWindow): void {
  if (msg.kind === 'here') {
    // A panel that was just opened: it has not heard of this window, or of anything it did.
    actions = 0;
    sendEvent(TO_PANEL, { kind: 'hello' } satisfies ToPanel);
  } else if (msg.kind === 'gone') {
    closeThisExtension();
  } else if (msg.kind === 'base') {
    comps = msg.base.comps;
    controllerCache.clear();
    for (const [id, list] of msg.base.controllers) controllerCache.set(id, list);
    if (panelSeen) draw();
  } else {
    showView(msg.view);
  }
}

function showView(view: View): void {
  if (!panelSeen) {
    panelSeen = true;
    el('waiting').hidden = true;
    app.hidden = false;
  }
  // What was chosen here a moment ago stands until the panel has heard of it.
  if (!actions || (view.ack && view.ack.from === session && view.ack.n >= actions)) {
    mode = view.mode;
    ticked = new Set(view.ticked);
    optionsOn = new Set(view.optionsOn);
    designsOff.clear();
    for (const id of view.designsOff) designsOff.add(id);
  }
  codeBox.textContent = view.code;
  connected = view.connected;
  status = view.status;
  hostBusy = view.hostBusy;
  listedFor = view.listedFor;
  designs = view.designs;
  figmaSelection = view.figmaSelection;
  busy = view.busy;
  building = view.building;
  serverUp = view.serverUp;
  notice = view.notice;
  progressBar.style.width = view.progress;
  cancelButton.disabled = view.cancelling;
  cancelLabel.textContent = view.cancelling ? 'Stopping…' : 'Cancel';
  if (JSON.stringify(view.result) !== JSON.stringify(lastResult)) {
    if (view.result) showResult(view.result.kind, view.result.title, view.result.meta, view.result.notes);
    else hideResult();
  }
  draw();
}

/** The settings window starts: it waits for its panel and shows what the panel tells it. */
function startWindow(): void {
  setWindowTitle('Motion Bridge');
  waitingText.textContent = 'Connecting to the panel…';
  onEvent<ToWindow>(TO_WINDOW, onPanelMessage);
  const ask = (): void => sendEvent(TO_PANEL, { kind: 'hello' } satisfies ToPanel);
  ask();
  const asking = setInterval(() => {
    if (panelSeen) clearInterval(asking);
    else ask();
  }, 1500);
  setTimeout(() => {
    if (!panelSeen) waitingText.textContent = 'Open Window › Extensions › Motion Bridge first. This window shows the settings of that panel.';
  }, 4000);
}

function wire(): void {
  fitWindow();
  window.addEventListener('resize', fitWindow);
  settingsButton.addEventListener('click', () => {
    if (inCep) openExtension(SETTINGS_ID);
  });
  newCodeButton.addEventListener('click', press('new-code', makeNewCode));
  figmaChip.addEventListener('click', () => {
    pairingOpen = !!pairingBox.hidden;
    drawPairing();
  });
  copyButton.addEventListener('click', () => {
    copyText(codeBox.textContent ?? '');
    copyButton.textContent = 'Copied';
    setTimeout(() => (copyButton.textContent = 'Copy'), 1200);
  });
  const setMode = (next: Mode): void => {
    if (busy || mode === next) return;
    mode = next;
    localStorage.setItem(MODE_KEY, mode);
    selectionChanged();
  };
  modeOpen.addEventListener('click', () => setMode('open'));
  modeSeveral.addEventListener('click', () => setMode('several'));
  filterInput.addEventListener('input', () => {
    filter = filterInput.value;
    drawSource();
  });
  nestedBox.checked = showNested;
  nestedBox.addEventListener('change', () => {
    showNested = nestedBox.checked;
    localStorage.setItem(NESTED_KEY, showNested ? '1' : '0');
    drawSource();
  });
  tickAll.addEventListener('click', () => {
    for (const box of compList.querySelectorAll<HTMLInputElement>('input')) {
      if (!box.checked) box.click();
    }
  });
  tickNone.addEventListener('click', () => {
    ticked = new Set();
    selectionChanged();
  });
  sendButton.addEventListener('click', press('send', () => void send()));
  pullButton.addEventListener('click', press('pull', () => void pullFromFigma()));
  updateButton.addEventListener('click', press('update', () => void updateDesigns()));
  saveButton.addEventListener('click', press('save', () => void saveFile()));
  cancelButton.addEventListener('click', press('cancel', requestCancel));
}

/** Outside After Effects there is nothing to read: show sample content so the layout can be looked at. */
function preview(): void {
  previewing = true;
  const hash = location.hash;
  if (hash.indexOf('light') !== -1) {
    document.documentElement.dataset.theme = 'light';
    document.documentElement.style.setProperty('--bg', '#f0f0f0');
  }
  // The settings window while it waits for its panel: #waiting.
  if (hash.indexOf('waiting') !== -1) {
    waitingText.textContent = 'Connecting to the panel…';
    return;
  }
  el('waiting').hidden = true;
  app.hidden = false;
  showCode('K7M2QX');
  const sizes: Array<[string, number, number]> = [['4x5', 1080, 1350], ['1x1', 1080, 1080], ['9x16', 1080, 1920], ['16x9', 1920, 1080]];
  comps = sizes.map(([label, w, h], i) => ({ id: String(i + 1), name: `Launch - Social - ${label} - en-EN - 6s`, w, h, duration: 6, layers: 12, nested: 0, folder: 'Deliverables' }));
  comps.push({ id: '9', name: 'LOGO', w: 1080, h: 1920, duration: 9.4, layers: 18, nested: 1, folder: 'Precomps' });
  status = { ae: 'preview', project: 'Template.aep', items: 60, comp: { id: '1', name: comps[0]!.name, w: 1080, h: 1350, layers: 12, duration: 6, time: 2.4 } };
  const market: RawController = { id: '2.1.1', name: 'Market', layer: 'TEMPLATE CONTROLS', kind: 'menu', min: 1, max: 21, value: 10 };
  const language: RawController = { id: '2.2.1', name: 'Language', layer: 'TEMPLATE CONTROLS', kind: 'menu', min: 1, max: 2, value: 1 };
  const cta: RawController = { id: '2.5.1', name: 'CTA? (Generic only)', layer: 'TEMPLATE CONTROLS', kind: 'checkbox', min: 0, max: 1, value: 0 };
  for (const c of comps) controllerCache.set(c.id, c.nested ? [] : c.id === '4' ? [market, language] : [market, language, cta]);
  optionsOn = new Set([optionKey(market)]);
  if (hash.indexOf('several') !== -1) {
    mode = 'several';
    ticked = new Set(['1', '2', '3']);
  } else {
    mode = 'open';
  }
  connected = hash.indexOf('offline') === -1;
  // What is selected in Figma: #frames for several, #noframes for none.
  if (connected && hash.indexOf('noframes') === -1) figmaSelection = hash.indexOf('frames') !== -1 ? ['Offer 4x5', 'Offer 1x1', 'Offer 9x16'] : ['Offer 4x5'];
  if (hash.indexOf('built') !== -1) {
    showResult('ok', 'Built 3 compositions from Figma', '86 layers · 4 nested compositions · 12 keyframes · 5 images', [
      { where: 'Sky', text: 'It has a gradient as its fill, which After Effects has no shape for, so it arrives as a picture.' },
      { where: 'Legal copy', text: 'The text mixes several styles; After Effects gets the style of its first character.' },
    ]);
  }
  if (hash.indexOf('designs') !== -1) {
    // What the Figma page holds: two copies of one size with the market as a property, one of another, one from elsewhere.
    listedFor = 'preview';
    designs = [
      { key: 'a', project: 'Template.aep', compId: '1', comp: comps[0]!.name, options: [optionKey(market)], poster: 2.4, frames: 2 },
      { key: 'b', project: 'Template.aep', compId: '3', comp: comps[2]!.name, options: [], poster: 2.4, frames: 1 },
      { key: 'c', project: 'Older template.aep', compId: '77', comp: 'Launch - 16x9', options: [], poster: 0, frames: 1 },
    ];
    if (hash.indexOf('updated') !== -1) {
      showResult('ok', 'Updated 2 designs in Figma', '412 layers · 1 new component · 96 animated properties · 1 already up to date · 3 changes made in Figma kept', []);
    }
  }
  if (hash.indexOf('busy') !== -1) {
    busy = true;
    progressBar.style.width = '38%';
    notice = { text: 'Reading “Launch - Social - 1x1 - en-EN - 6s” (2 of 3) · version 5 of 21…', kind: 'info' };
  }
  if (hash.indexOf('result') !== -1) {
    showResult('ok', 'Built 3 frames in Figma', '1,452 layers · 15 components · 2,643 animated properties', [
      { where: 'PROMO BADGE', text: 'Gradient Ramp is not transferred.' },
      { where: 'Launch - Social - 4x5 - en-EN - 6s', text: 'Figma substituted the font "Brand Sans Display".' },
      { where: 'Launch - Social - 1x1 - en-EN - 6s', text: 'Figma substituted the font "Brand Sans Display".' },
      { where: 'Copy line 1', text: 'Text animators (typewriter) are not transferred; the text is shown complete.' },
      { where: 'Copy line 2', text: 'Text animators (typewriter) are not transferred; the text is shown complete.' },
    ]);
  }
  draw();
}

async function start(): Promise<void> {
  wire();
  if (!inCep) {
    preview();
    return;
  }
  applyTheme();
  onHostThemeChange(applyTheme);
  if (mirror) {
    startWindow();
    return;
  }

  el('waiting').hidden = true;
  app.hidden = false;
  // From here on a settings window may ask what the panel knows, and tell it what to do.
  onEvent<ToPanel>(TO_PANEL, onWindowMessage);
  sendEvent(TO_WINDOW, { kind: 'here' } satisfies ToWindow);

  let code = localStorage.getItem(CODE_KEY) ?? '';
  if (code.length !== 6) {
    code = newCode();
    localStorage.setItem(CODE_KEY, code);
  }
  showCode(code);
  draw();

  try {
    await loadHost();
  } catch (err) {
    setMessage(err instanceof Error ? err.message : String(err), 'error');
    return;
  }

  server = new BridgeServer(nodeRequire<typeof Http>('http'), code, 'After Effects', {
    onConnection: setFigma,
    onDelivered: () => setMessage(pendingUpdate ? 'Figma is updating the designs…' : 'Figma is building it…'),
    onResult,
    onDesigns,
    onUpdateRequest,
    onPullRequest,
    onPush,
    openName: () => {
      const list = pullTargets();
      return list.length ? namesOf(list) : null;
    },
  });
  try {
    await server.start();
  } catch {
    server = null;
    setMessage(`Port ${BRIDGE_PORT} is already in use - is the panel open in another After Effects? “Save file” still works.`, 'error');
  }

  await tick(true);
  setInterval(() => void tick(), 1500);
  window.addEventListener('focus', () => {
    // Compositions and options may have been added or renamed since the panel last looked.
    for (const id of controllerCache.keys()) staleControllers.add(id);
    void tick(true);
  });
  window.addEventListener('beforeunload', () => {
    // The settings window is nothing without its panel.
    sendEvent(TO_WINDOW, { kind: 'gone' } satisfies ToWindow);
    server?.stop();
  });
}

void start();
