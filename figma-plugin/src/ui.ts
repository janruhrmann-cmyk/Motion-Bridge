/**
 * Motion Bridge - Figma plugin, UI thread.
 *
 * Runs in the plugin's iframe, which is the only part of a Figma plugin that
 * may use the network. It waits for transfers from the After Effects panel
 * (a local server on this machine), downloads the documents and their images
 * and passes them to the main thread to build. The other way round it takes
 * the frames the main thread read and posts them to the panel, pictures
 * first.
 */
import { renderNotes } from '../../shared/dom/notes-view.ts';
import { packDocs, rootName, unpackDocs } from '../../shared/format.ts';
import type { BridgeDoc } from '../../shared/format.ts';
import type { Note } from '../../shared/notes.ts';
import { BRIDGE_APP, BRIDGE_ORIGIN, normalizeCode } from '../../shared/protocol.ts';
import type {
  BuildReport,
  DesignLink,
  DesignsAnswer,
  DesignsReport,
  HelloResponse,
  PollResponse,
  PullAnswer,
  PullRequest,
  PushAnswer,
  PushBody,
  PushReport,
  UpdateAnswer,
  UpdateRequest,
} from '../../shared/protocol.ts';

type State = 'offline' | 'pair' | 'connected' | 'busy';

/** Figma refuses images larger than this on either side. */
const MAX_IMAGE_SIDE = 4096;

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const content = el('content');
const footer = document.querySelector('footer') as HTMLElement;
const tiles = el('tiles');
const unfoldButton = el<HTMLButtonElement>('unfold');
const miniProgress = el('mini-progress');
const miniBar = el('mini-bar');
const statusBox = el('status');
const statusText = el('status-text');
const statusHint = el('status-hint');
const aboutBox = el('about');
const aboutToggle = el<HTMLButtonElement>('about-toggle');
const setupBox = el('setup');
const getPanelButton = el<HTMLButtonElement>('get-panel');
const pairBox = el('pair');
const pairError = el('pair-error');
const pairHelp = el('pair-help');
const pairButton = el<HTMLButtonElement>('pair-go');
const codeInput = el<HTMLInputElement>('code');
const workBox = el('work');
const workTitle = el('work-title');
const workHint = el('work-hint');
const progress = el('progress');
const bar = el('bar');
const resultBox = el('result');
const resultTitle = el('result-title');
const resultStats = el('result-stats');
const resultMeta = el('result-meta');
const showButton = el<HTMLButtonElement>('show');
const notesBox = el<HTMLDetailsElement>('notes');
const notesSummary = el('notes-summary');
const resultNotes = el('result-notes');
const veil = el('veil');
const fileInput = el<HTMLInputElement>('file');
const componentsBox = el<HTMLInputElement>('components');
const designsBox = el('designs');
const designsTitle = el('designs-title');
const designsHint = el('designs-hint');
const updateButton = el<HTMLButtonElement>('update');
const updateAllButton = el<HTMLButtonElement>('update-all');
const pullButton = el<HTMLButtonElement>('pull');
const pushButton = el<HTMLButtonElement>('push');

/** The window's two sizes: folded it is the three tiles, unfolded it is this wide. */
const WIDE = 320;
const NARROW = 180;

/** The designs on the current page that After Effects can update (from the main thread). */
interface PageDesigns {
  page: string;
  designs: DesignLink[];
  /** Every linked frame, with the entry of `designs` it belongs to. */
  frames: Array<{ id: string; key: string }>;
  /** The linked frames the selection is in. */
  selected: string[];
  /** The names of the selected frames: what "Push to After Effects" sends. */
  selection: string[];
}

let code = '';
let seq: number | null = null;
let state: State = 'offline';
let hostLabel = 'After Effects';
let building: { id: string; docs: BridgeDoc[]; fromBridge: boolean } | null = null;
let hasResult = false;
/** Folded: the window is its three tiles, tucked into a corner. The settings tile unfolds it. */
let compact = false;
/** Folded only because the user said so: pairing unfolds the window without forgetting that. */
let preferCompact = false;
/** Something went wrong while the window was folded: the dot on the settings tile says so until it is looked at. */
let alerted = false;
let page: PageDesigns = { page: '', designs: [], frames: [], selected: [], selection: [] };
/** The panel is new enough to update designs. */
let canSync = false;
/** The panel is new enough to build compositions from frames, and to be asked for its composition. */
let canPush = false;
/** The composition that is open in After Effects (what a pull brings); null when none is, undefined while unknown. */
let openName: string | null | undefined;
/** Frames on their way to After Effects: being read, sent, or built there. `request`: After Effects asked for them. */
interface Push {
  id: string;
  request?: string;
  docs: BridgeDoc[];
  title: string;
  /** After Effects has the frames and is building. */
  sent: boolean;
}
let pushing: Push | null = null;
/** What the panel was last told about this page, and when. */
let told = { body: '', at: 0 };
/** An update or a pull this window asked After Effects for and has not heard back about. `scope`: only these frames. */
let waiting: { request: string; scope: string[] | null; title: string; kind: 'update' | 'pull' } | null = null;

const newId = (prefix: string): string => `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
/** What the work card says while this window waits for After Effects. */
const waitingPhase = (): string => (waiting?.kind === 'pull' ? 'Pulling…' : 'Updating…');
const waitingHint = (): string => (waiting?.kind === 'pull' ? 'After Effects is reading the composition.' : 'After Effects is reading the compositions.');

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const number = (n: number): string => n.toLocaleString('en');

function toMain(message: unknown, transfer?: Transferable[]): void {
  parent.postMessage({ pluginMessage: message }, '*', transfer);
}

/** Keeps the plugin window exactly as tall as what it shows. */
let lastHeight = 0;
let lastWidth = 0;
function fit(): void {
  const rest = compact ? 0 : content.getBoundingClientRect().height + footer.getBoundingClientRect().height;
  const height = Math.ceil(tiles.getBoundingClientRect().height + rest);
  const width = compact ? NARROW : WIDE;
  if (Math.abs(height - lastHeight) < 2 && width === lastWidth) return;
  lastHeight = height;
  lastWidth = width;
  toMain({ type: 'resize', width, height, compact });
}

/** Folds the window down to its tiles, or unfolds it. `remember`: the user chose it, so the next start is the same. */
function setCompact(on: boolean, remember: boolean): void {
  compact = on;
  if (remember) {
    preferCompact = on;
    toMain({ type: 'save-compact', on });
  }
  document.body.classList.toggle('compact', on);
  unfoldButton.setAttribute('aria-expanded', String(!on));
  if (!on) setAlert(false);
  drawTiles();
  fit();
}

function setAlert(on: boolean): void {
  alerted = on;
  tiles.dataset.alert = on ? '1' : '0';
}

function setState(next: State, text?: string, hint?: string): void {
  const entering = next !== state;
  state = next;
  statusBox.dataset.state = next;
  tiles.dataset.state = next;
  const texts: Record<State, string> = {
    offline: 'Looking for After Effects…',
    pair: `${hostLabel} found`,
    connected: `Connected to ${hostLabel}`,
    busy: 'Working…',
  };
  const hints: Record<State, string> = {
    offline: 'Open Window › Extensions › Motion Bridge in After Effects.',
    pair: 'Enter the pairing code to connect.',
    connected: hasResult ? 'Ready for the next transfer.' : 'Ready. Keep this window open while you work.',
    busy: '',
  };
  statusText.textContent = text ?? texts[next];
  statusHint.textContent = hint ?? hints[next];
  statusHint.hidden = !statusHint.textContent;
  setupBox.hidden = next !== 'offline';
  pairBox.hidden = next !== 'pair';
  workBox.hidden = next !== 'busy';
  miniProgress.hidden = next !== 'busy';
  // The pairing code cannot be typed into a folded window.
  if (next === 'pair' && compact) setCompact(false, false);
  else if (next === 'connected' && entering && preferCompact && !compact && !alerted) setCompact(true, false);
  if (next === 'pair' && entering) codeInput.focus();
  drawTiles();
  drawDesigns();
  fit();
}

/**
 * The two ways across, as tiles: push the selected frames out, pull the open
 * composition in. What a press would do is in their tooltips, and the arrow
 * of the one that is at work keeps travelling.
 */
function drawTiles(): void {
  const ready = state === 'connected' && canPush;
  let why = '';
  if (state === 'offline') why = 'Open the Motion Bridge panel in After Effects first.';
  else if (state === 'pair') why = 'Enter the pairing code first.';
  else if (state === 'busy') why = 'A transfer is running.';
  else if (!canPush) why = 'The After Effects panel is too old for this. Update it.';

  let pull = why;
  if (ready) {
    if (openName) pull = `Builds ${/^\d+ compositions$/.test(openName) ? openName : `“${openName}”`} on this page.`;
    else if (openName === null) pull = 'Open a composition in After Effects first.';
    else pull = 'Builds the composition that is open in After Effects on this page.';
  }
  const n = page.selection.length;
  let push = why;
  if (ready) {
    if (!n) push = 'Select the frames that should become compositions.';
    else push = n === 1 ? `“${page.selection[0]}” becomes a composition.` : `The ${n} selected frames become compositions.`;
  }
  pullButton.disabled = !ready;
  pushButton.disabled = !ready || !n;
  pullButton.title = `Pull from After Effects\n${pull}`;
  pushButton.title = `Push to After Effects\n${push}`;
  // Frames on their way out are a push; everything else that keeps the window busy comes in.
  const out = state === 'busy' && !!pushing;
  pushButton.dataset.running = out ? '1' : '0';
  pullButton.dataset.running = state === 'busy' && !out ? '1' : '0';

  const status = `${statusText.textContent ?? ''}${statusHint.textContent ? `\n${statusHint.textContent}` : ''}`;
  unfoldButton.title = compact ? `Settings and details\n${alerted ? resultTitle.textContent ?? status : status}` : 'Fold the window down to its three buttons';
}

/** The card that offers to bring this page's designs up to date. Only there when there is something to update. */
function drawDesigns(): void {
  const total = page.frames.length;
  designsBox.hidden = state !== 'connected' || !canSync || !total;
  if (designsBox.hidden) return;
  const picked = page.selected.length;
  designsTitle.textContent = total === 1 ? '1 design on this page comes from After Effects' : `${total} designs on this page come from After Effects`;
  designsHint.textContent = 'Changed something in After Effects? Update the designs here. Variants you switched and text you edited in Figma stay.';
  if (picked) updateButton.textContent = picked === 1 ? 'Update selected design' : `Update ${picked} selected designs`;
  else updateButton.textContent = total === 1 ? 'Update design' : 'Update designs';
  updateAllButton.hidden = !picked || picked === total;
  updateAllButton.textContent = `Update all ${total} instead`;
}

/** Passes the list of designs on to the After Effects panel, which offers the same update from its side. */
async function tellPanel(): Promise<void> {
  if (seq === null || !code || !canSync) return;
  const report: DesignsReport = { page: page.page, designs: page.designs, selection: page.selection };
  const body = JSON.stringify(report);
  // Again every few seconds even when nothing changed: a panel that was reopened has forgotten,
  // and the answer says which composition is open there now.
  if (body === told.body && Date.now() - told.at < 3000) return;
  told = { body, at: Date.now() };
  try {
    const res = await fetch(`${BRIDGE_ORIGIN}/designs?k=${code}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body });
    const answer = res.ok ? ((await res.json()) as DesignsAnswer) : null;
    if (answer && answer.open !== undefined && answer.open !== openName) {
      openName = answer.open;
      drawTiles();
    }
  } catch {
    told = { body: '', at: 0 };
  }
}

/** Asks After Effects to read the designs' compositions again. The answer arrives as a transfer (or a notice) on the usual way. */
async function requestUpdate(everything: boolean): Promise<void> {
  if (building || waiting || pushing || state !== 'connected') return;
  const scope = !everything && page.selected.length ? [...page.selected] : null;
  const frames = scope ? page.frames.filter((f) => scope.indexOf(f.id) !== -1) : page.frames;
  const keys = [...new Set(frames.map((f) => f.key))];
  if (!keys.length) return;
  const title = frames.length === 1 ? '1 design' : `${frames.length} designs`;
  const asked = { request: newId('u'), scope, title, kind: 'update' as const };
  waiting = asked;
  resultBox.hidden = true;
  setWork('Updating…', title, 'After Effects is reading the compositions.', null);
  try {
    const request: UpdateRequest = { request: asked.request, keys };
    const res = await fetch(`${BRIDGE_ORIGIN}/update?k=${code}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(request) });
    const answer: UpdateAnswer = res.ok ? ((await res.json()) as UpdateAnswer) : { ok: false, error: 'The After Effects panel did not take the request.' };
    if (!answer.ok) throw new Error(answer.error || 'After Effects could not start reading.');
  } catch (err) {
    if (waiting !== asked) return;
    waiting = null;
    showProblem('The designs were not updated', err instanceof Error && err.message ? err.message : 'After Effects could not be reached.');
    setState(idleState());
  }
}

/**
 * "Pull from After Effects": asks the panel to read the composition that is
 * open there. It arrives the way a transfer sent from After Effects does.
 */
async function requestPull(): Promise<void> {
  if (building || waiting || pushing || state !== 'connected') return;
  const asked = { request: newId('p'), scope: null, title: openName ? `“${openName}”` : 'After Effects', kind: 'pull' as const };
  waiting = asked;
  resultBox.hidden = true;
  setWork('Pulling…', asked.title, 'After Effects is reading the composition.', null);
  try {
    const request: PullRequest = { request: asked.request };
    const res = await fetch(`${BRIDGE_ORIGIN}/pull?k=${code}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(request) });
    const answer: PullAnswer = res.ok ? ((await res.json()) as PullAnswer) : { ok: false, error: 'The After Effects panel did not take the request.' };
    if (!answer.ok) throw new Error(answer.error || 'After Effects could not start reading.');
    if (answer.name && waiting === asked && !building) {
      asked.title = /^\d+ compositions$/.test(answer.name) ? answer.name : `“${answer.name}”`;
      setWork('Pulling…', asked.title, 'After Effects is reading the composition.', null);
    }
  } catch (err) {
    if (waiting !== asked) return;
    waiting = null;
    showProblem('Nothing was pulled', err instanceof Error && err.message ? err.message : 'After Effects could not be reached.');
    setState(idleState());
  }
}

/**
 * "Push to After Effects": the main thread reads the selected frames, then
 * they are sent (see sendFrames). `request`: After Effects asked for them
 * ("Pull from Figma" in its panel) and waits for an answer either way.
 */
function startPush(request?: string): void {
  if (building || waiting || pushing) {
    if (request) void refusePush(request, 'Figma is busy with another transfer. Try again when it has finished.');
    return;
  }
  const n = page.selection.length;
  const title = n === 1 ? `“${page.selection[0]}”` : n ? `${n} frames` : 'Selected frames';
  const push: Push = { id: newId('f'), docs: [], title, sent: false };
  if (request) push.request = request;
  pushing = push;
  resultBox.hidden = true;
  setWork('Reading…', title, 'Reading layers and keyframes.', null);
  toMain({ type: 'read', request });
}

const postToPanel = (path: string, body: BodyInit): Promise<Response> =>
  fetch(`${BRIDGE_ORIGIN}${path}?k=${code}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body });

/** After Effects asked for frames and there are none to send: it should not wait for nothing. */
async function refusePush(request: string, error: string): Promise<void> {
  try {
    const body: PushBody = { request, error };
    await postToPanel(`/push/${newId('f')}`, JSON.stringify(body));
  } catch {
    // The panel gives up waiting on its own.
  }
}

/** Sends what the main thread read: every picture, then the frames. After Effects says later what it built (`pushed`). */
async function sendFrames(docs: BridgeDoc[], images: Record<string, Uint8Array>, error?: string): Promise<void> {
  const push = pushing;
  if (!push) return;
  try {
    if (error || !docs.length) {
      if (push.request) await refusePush(push.request, error ?? 'Nothing is selected in Figma.');
      throw new Error(error ?? 'Select the frames that should become compositions first.');
    }
    push.docs = docs;
    push.title = describe(docs).replace('compositions', 'frames');
    const ids = Object.keys(images);
    for (let i = 0; i < ids.length; i++) {
      setWork('Sending…', push.title, `Image ${i + 1} of ${ids.length}`, i / ids.length);
      const res = await postToPanel(`/push/${push.id}/asset/${ids[i]}`, new Blob([images[ids[i]!]! as BlobPart]));
      if (!res.ok) throw new Error(res.status === 413 ? 'An image is too large to send.' : 'The After Effects panel did not take an image.');
    }
    setWork('Sending…', push.title, 'Handing the frames to After Effects.', null);
    const body: PushBody = { docs: packDocs(docs) };
    if (push.request) body.request = push.request;
    const res = await postToPanel(`/push/${push.id}`, JSON.stringify(body));
    const answer: PushAnswer = res.ok ? ((await res.json()) as PushAnswer) : { ok: false, error: res.status === 413 ? 'The frames are too large to send in one go. Send fewer at a time.' : 'The After Effects panel did not take the frames.' };
    if (!answer.ok) throw new Error(answer.error || 'After Effects could not start building.');
    push.sent = true;
    if (pushing === push) setWork('Building…', push.title, docs.length === 1 ? 'After Effects is building the composition.' : 'After Effects is building the compositions.', null);
  } catch (err) {
    if (pushing !== push) return;
    pushing = null;
    showProblem('Nothing was sent to After Effects', err instanceof Error && err.message ? err.message : 'After Effects could not be reached.');
    setState(idleState());
  }
}

/** What After Effects made of the frames. */
function showPushed(report: PushReport): void {
  if (!report.ok) {
    showProblem('After Effects could not build the frames', report.error ?? 'Unknown error.');
    return;
  }
  hasResult = true;
  resultBox.hidden = false;
  resultStats.textContent = '';
  resultBox.dataset.kind = 'ok';
  showButton.hidden = true;
  const built = report.comps.filter((c) => c.ok);
  resultTitle.textContent = built.length === 1 ? `Built “${built[0]!.name}” in After Effects` : `Built ${built.length} compositions in After Effects`;
  resultStats.hidden = false;
  resultStats.append(
    built.length > 1 ? stat(number(built.length), 'Comps', 'Compositions') : stat(number(report.layers), 'Layers'),
    stat(number(report.precomps), 'Precomps', 'Compositions made for frames inside a frame (where it clips, fades or holds a picture)'),
    stat(number(report.keyframes), 'Keyframes'),
  );
  resultMeta.textContent = report.images ? `${report.images === 1 ? '1 picture was' : `${number(report.images)} pictures were`} saved next to the After Effects project.` : '';
  resultMeta.hidden = !resultMeta.textContent;
  const notes: Note[] = report.warnings.map((text) => ({ where: '', text }));
  for (const c of report.comps) {
    for (const text of c.warnings) notes.push({ where: report.comps.length > 1 ? c.name : '', text });
  }
  const shown = renderNotes(resultNotes, notes);
  notesBox.hidden = shown === 0;
  notesBox.open = false;
  notesSummary.textContent = `${shown === 1 ? '1 note' : `${shown} notes`} on what was left out or changed`;
}

/** `fraction` null: no telling how long it takes, so the bar just keeps moving. */
function setWork(phase: string, title: string, hint: string, fraction: number | null): void {
  setAlert(false);
  setState('busy', phase, '');
  workTitle.textContent = title;
  workHint.textContent = hint;
  workHint.hidden = !hint;
  const width = fraction === null ? '' : `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
  for (const [box, fill] of [[progress, bar], [miniProgress, miniBar]] as const) {
    box.dataset.open = fraction === null ? '1' : '0';
    fill.style.width = width;
  }
  // Folded, the tooltip of the settings tile is the only place that says how far it is.
  unfoldButton.title = compact ? `${phase} ${title}${hint ? `\n${hint}` : ''}` : unfoldButton.title;
  fit();
}

function formatCode(raw: string): string {
  const c = normalizeCode(raw).slice(0, 6);
  return c.length > 3 ? `${c.slice(0, 3)}-${c.slice(3)}` : c;
}

async function getJson<T>(path: string, timeoutMs: number): Promise<{ status: number; data: T | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BRIDGE_ORIGIN}${path}`, { signal: controller.signal, cache: 'no-store' });
    const data = res.ok ? ((await res.json()) as T) : null;
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

/** Makes sure Figma will accept the image: a format it reads, no side over 4096 px. */
async function fitImage(bytes: Uint8Array, mime: string): Promise<Uint8Array> {
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime || 'image/png' }));
    const longest = Math.max(bitmap.width, bitmap.height);
    const readable = /^image\/(png|jpe?g|gif)$/i.test(mime);
    if (longest <= MAX_IMAGE_SIDE && readable) {
      bitmap.close();
      return bytes;
    }
    const k = Math.min(1, MAX_IMAGE_SIDE / longest);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * k));
    canvas.height = Math.max(1, Math.round(bitmap.height * k));
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : bytes;
  } catch {
    return bytes;
  }
}

const describe = (docs: BridgeDoc[]): string => (docs.length === 1 ? `“${rootName(docs[0]!)}”` : `${docs.length} compositions`);

/** `update`: the documents were read for designs that are already here; `scope` narrows them to these frames. */
function startBuild(id: string, docs: BridgeDoc[], images: Record<string, Uint8Array>, fromBridge: boolean, update?: { scope: string[] | null }): void {
  building = { id, docs, fromBridge };
  resultBox.hidden = true;
  if (update) {
    setWork('Updating…', describe(docs), 'Rebuilding the designs where they are.', null);
    toMain({ type: 'build', id, docs, images, components: componentsBox.checked, mode: 'update', scope: update.scope });
    return;
  }
  setWork('Building…', describe(docs), 'Creating layers and keyframes.', null);
  toMain({ type: 'build', id, docs, images, components: componentsBox.checked });
}

async function receive(id: string, name: string, count: number, update?: { scope: string[] | null }): Promise<void> {
  resultBox.hidden = true;
  const what = count > 1 ? name : `“${name}”`;
  setWork(update ? 'Updating…' : 'Receiving…', what, 'Downloading from After Effects.', null);
  const res = await getJson<unknown>(`/transfer/${id}?k=${code}`, 30000);
  const docs = unpackDocs(res.data);
  if (!docs) throw new Error('The transfer could not be read.');

  // An image used by several compositions has the same id in each and is fetched once.
  const wanted = new Set<string>();
  for (const doc of docs) for (const assetId of Object.keys(doc.assets)) wanted.add(assetId);
  const images: Record<string, Uint8Array> = {};
  let done = 0;
  for (const assetId of wanted) {
    setWork(update ? 'Updating…' : 'Receiving…', what, `Image ${done + 1} of ${wanted.size}`, done / wanted.size);
    try {
      const r = await fetch(`${BRIDGE_ORIGIN}/asset/${id}/${assetId}?k=${code}`, { cache: 'no-store' });
      if (r.ok) {
        const bytes = new Uint8Array(await r.arrayBuffer());
        images[assetId] = await fitImage(bytes, r.headers.get('content-type') ?? 'image/png');
      }
    } catch {
      // The builder shows a placeholder and reports the missing image.
    }
    done++;
  }
  startBuild(id, docs, images, true, update);
}

async function loop(): Promise<void> {
  for (;;) {
    try {
      if (building) {
        await sleep(300);
        continue;
      }
      if (seq === null) {
        const hello = await getJson<HelloResponse>('/hello', 4000);
        if (!hello.data || hello.data.app !== BRIDGE_APP) throw new Error('not the bridge');
        hostLabel = hello.data.host;
        canSync = hello.data.sync === true;
        canPush = hello.data.push === true;
        seq = hello.data.pending ? hello.data.seq - 1 : hello.data.seq;
      }
      if (!code) {
        if (state !== 'pair') setState('pair');
        await sleep(300);
        continue;
      }
      // The bridge holds this request open until there is something to fetch. A wrong
      // code is refused at once, so a request still open after a moment means: connected.
      const settled = setTimeout(() => {
        if (!building && !waiting && !pushing && state !== 'connected') setState('connected');
        void tellPanel();
      }, 600);
      let poll: { status: number; data: PollResponse | null };
      try {
        poll = await getJson<PollResponse>(`/poll?k=${code}&after=${seq}`, 35000);
      } finally {
        clearTimeout(settled);
      }
      if (poll.status === 401) {
        code = '';
        pairError.hidden = false;
        pairHelp.hidden = true;
        codeInput.setAttribute('aria-invalid', 'true');
        setState('pair');
        codeInput.select();
        continue;
      }
      if (poll.status === 429) {
        setState('pair', 'Too many wrong codes', 'Wait a minute, then try again.');
        await sleep(10000);
        continue;
      }
      if (!poll.data) throw new Error(`bridge answered ${poll.status}`);
      pairError.hidden = true;
      pairHelp.hidden = false;
      codeInput.removeAttribute('aria-invalid');
      toMain({ type: 'save-code', code });
      if (poll.data.type === 'progress') {
        // After Effects says how far it is with what this window is waiting for.
        if (waiting && !building) setWork(waitingPhase(), waiting.title, poll.data.text, poll.data.fraction);
        continue;
      }
      seq = poll.data.seq;
      if (poll.data.type === 'want') {
        // "Pull from Figma" was pressed in After Effects: it wants the frames that are selected here.
        startPush(poll.data.request);
      } else if (poll.data.type === 'pushed') {
        if (pushing && poll.data.report.id === pushing.id) {
          pushing = null;
          showPushed(poll.data.report);
          if (poll.data.report.ok) {
            const built = poll.data.report.comps.filter((c) => c.ok);
            toMain({ type: 'notify', text: built.length === 1 ? `Built “${built[0]!.name}” in After Effects.` : `Built ${built.length} compositions in After Effects.` });
          }
          setState('connected');
        }
      } else if (poll.data.type === 'notice') {
        if (waiting && poll.data.request === waiting.request) {
          const pull = waiting.kind === 'pull';
          waiting = null;
          if (pull) showProblem(poll.data.level === 'error' ? 'The composition could not be pulled' : 'Nothing was pulled', poll.data.message);
          else showProblem(poll.data.level === 'error' ? 'The designs could not be updated' : 'The designs were not updated', poll.data.message);
          setState('connected');
        }
      } else if (poll.data.type === 'transfer') {
        const transfer = poll.data;
        const asked = waiting && transfer.request === waiting.request ? waiting : null;
        if (asked) waiting = null;
        try {
          await receive(transfer.id, transfer.name, transfer.count ?? 1, transfer.kind === 'update' ? { scope: asked ? asked.scope : null } : undefined);
        } catch (err) {
          // Say what went wrong, here and in After Effects, instead of dropping the transfer silently.
          const report: BuildReport = {
            id: transfer.id,
            ok: false,
            error: err instanceof Error && err.message ? err.message : 'The transfer could not be fetched from After Effects.',
            nodes: 0,
            tracks: 0,
            motionAvailable: true,
            warnings: [],
          };
          if (transfer.kind === 'update') report.kind = 'update';
          showReport(report, []);
          void postResult(report);
          setState('connected');
        }
      } else if (!waiting && !pushing && state !== 'connected') setState('connected');
    } catch {
      seq = null;
      // Whatever was asked of After Effects is lost with the connection, and a panel that comes back has to be told again.
      waiting = null;
      told = { body: '', at: 0 };
      openName = undefined;
      if (pushing && pushing.sent) {
        // The frames are with After Effects; only its answer cannot arrive any more.
        pushing = null;
        showProblem('After Effects did not report back', 'The connection to its panel was lost while it was building. Have a look in After Effects.');
      }
      if (!building && !pushing && state !== 'offline') setState('offline');
      await sleep(2000);
    }
  }
}

function stat(value: string, label: string, title = ''): HTMLElement {
  const cell = document.createElement('div');
  cell.className = 'stat';
  cell.title = title;
  const b = document.createElement('b');
  b.textContent = value;
  const span = document.createElement('span');
  span.textContent = label;
  cell.append(b, span);
  return cell;
}

/**
 * Something went wrong before there was anything to report on. A folded
 * window has no room for it: the dot on the settings tile turns red and
 * Figma shows the message (`told`: it already has).
 */
function showProblem(title: string, message: string, told = false): void {
  if (compact) {
    setAlert(true);
    if (!told) toMain({ type: 'notify', text: `${title}. ${message}`, error: true });
  }
  hasResult = true;
  resultBox.hidden = false;
  resultStats.textContent = '';
  resultBox.dataset.kind = 'error';
  resultTitle.textContent = title;
  resultMeta.textContent = message;
  resultMeta.hidden = false;
  resultStats.hidden = true;
  showButton.hidden = true;
  notesBox.hidden = true;
}

/** Title, numbers and summary of an update: what was rebuilt, what needed nothing, what was kept. */
function showUpdated(report: BuildReport): void {
  const updated = report.updated ?? 0;
  const unchanged = report.unchanged ?? 0;
  const were = (n: number): string => (n === 1 ? 'was' : 'were');
  resultStats.hidden = !updated;
  if (!updated) {
    resultTitle.textContent = unchanged === 1 ? 'The design is up to date' : 'The designs are up to date';
    resultMeta.textContent = 'Nothing has changed in After Effects since it was built, so nothing was touched.';
    return;
  }
  resultTitle.textContent = updated === 1 ? `Updated “${report.frameName ?? ''}”` : `Updated ${updated} designs`;
  resultStats.append(
    updated > 1 ? stat(number(updated), 'Designs') : stat(number(report.nodes), 'Layers'),
    stat(number(report.components ?? 0), 'Rebuilt', 'Components and component sets that had changed and were built again'),
    stat(number(report.tracks), 'Animations', 'Animated properties (keyframe tracks)'),
  );
  const lines: string[] = [];
  if (!report.motionAvailable) lines.push('Figma Motion is not available here, so only the static design was updated.');
  if (unchanged) lines.push(`${number(unchanged)} ${were(unchanged)} already up to date.`);
  if (report.kept) lines.push(`${number(report.kept)} ${report.kept === 1 ? 'change' : 'changes'} you made in Figma ${were(report.kept)} kept.`);
  if (report.retired) lines.push(`${number(report.retired)} ${report.retired === 1 ? 'component' : 'components'} no design uses any more ${were(report.retired)} removed.`);
  resultMeta.textContent = lines.join(' ');
}

/** `told`: the main thread has already shown a failure as a Figma notification. */
function showReport(report: BuildReport, docs: BridgeDoc[], told = false): void {
  if (!report.ok) {
    showProblem(report.kind === 'update' ? 'The designs could not be updated' : 'The transfer could not be built', report.error ?? 'Unknown error.', told);
    return;
  }
  hasResult = true;
  resultBox.hidden = false;
  resultStats.textContent = '';
  const frames = report.frames ?? [];
  const built = frames.length ? frames.filter((f) => f.ok).length : 1;
  resultBox.dataset.kind = 'ok';
  showButton.hidden = false;
  if (report.kind === 'update') {
    showUpdated(report);
  } else {
    resultTitle.textContent = built === 1 ? `Built “${report.frameName ?? ''}”` : `Built ${built} frames`;
    resultStats.hidden = false;
    resultStats.append(
      built > 1 ? stat(number(built), 'Frames') : stat(number(report.nodes), 'Layers'),
      stat(number(report.components ?? 0), 'Components', 'Components and component sets'),
      stat(number(report.tracks), 'Animations', 'Animated properties (keyframe tracks)'),
    );
    const reused = report.reused ? ` ${report.reused === 1 ? '1 component that was already here is' : `${report.reused} components that were already here are`} used again.` : '';
    if (!report.motionAvailable) resultMeta.textContent = 'Figma Motion is not available here, so only the static design was built.';
    else if (report.components) {
      resultMeta.textContent = `${built === 1 ? 'The components are in a section to the right of the frame.' : 'The components are in sections to the right of the frames.'}${reused}`;
    } else resultMeta.textContent = reused.trim();
  }
  resultMeta.hidden = !resultMeta.textContent;

  const notes: Note[] = report.warnings.map((text) => ({ where: '', text }));
  for (const f of frames) {
    for (const text of f.warnings) notes.push({ where: frames.length > 1 ? f.name : '', text });
  }
  for (const doc of docs) {
    for (const w of doc.warnings) notes.push({ where: w.layer ?? w.comp ?? '', text: w.message });
  }
  const shown = renderNotes(resultNotes, notes);
  notesBox.hidden = shown === 0;
  notesBox.open = false;
  notesSummary.textContent = `${shown === 1 ? '1 note' : `${shown} notes`} on what was left out or changed`;
}

async function postResult(report: BuildReport): Promise<void> {
  try {
    await fetch(`${BRIDGE_ORIGIN}/result?k=${code}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(report),
    });
  } catch {
    // After Effects simply does not get the confirmation.
  }
}

const idleState = (): State => (seq === null ? 'offline' : code ? 'connected' : 'pair');

async function importFile(file: File): Promise<void> {
  if (building) return;
  try {
    const docs = unpackDocs(JSON.parse(await file.text()));
    if (!docs) throw new Error('This file is not a Motion Bridge transfer.');
    const images: Record<string, Uint8Array> = {};
    for (const doc of docs) {
      // A file always makes new frames.
      delete doc.update;
      for (const asset of Object.values(doc.assets)) {
        if (!asset.data) continue;
        const binary = atob(asset.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        images[asset.id] = await fitImage(bytes, asset.mime ?? 'image/png');
        delete asset.data;
      }
    }
    startBuild(`file-${Date.now()}`, docs, images, false);
  } catch (err) {
    showReport(
      { id: 'file', ok: false, error: err instanceof Error ? err.message : String(err), nodes: 0, tracks: 0, motionAvailable: true, warnings: [] },
      [],
    );
    setState(idleState());
  }
}

// ---------------------------------------------------------------- wiring

interface MainMessage {
  type: string;
  code?: string;
  components?: boolean;
  /** With 'init': the window was folded down to its tiles when it was last open. */
  compact?: boolean;
  report?: BuildReport;
  done?: number;
  total?: number;
  name?: string;
  /** With 'progress': the designs of an update are being rebuilt. */
  update?: boolean;
  /** With 'progress': frames are being read for After Effects. */
  reading?: boolean;
  /** With 'read-done': the frames that were read, and their pictures - or why there are none. */
  docs?: BridgeDoc[];
  images?: Record<string, Uint8Array>;
  error?: string;
  /** With 'designs': the names of the selected frames. */
  selection?: string[];
  /** With 'designs': what the page holds (see PageDesigns). */
  page?: string;
  designs?: DesignLink[];
  frames?: Array<{ id: string; key: string }>;
  selected?: string[];
}

window.onmessage = (event: MessageEvent) => {
  const msg = (event.data as { pluginMessage?: MainMessage }).pluginMessage;
  if (!msg) return;
  if (msg.type === 'init') {
    code = normalizeCode(msg.code ?? '');
    codeInput.value = formatCode(code);
    pairButton.disabled = code.length < 6;
    componentsBox.checked = msg.components !== false;
    preferCompact = msg.compact === true;
    // Without a pairing code there is something to type first.
    setCompact(preferCompact && code.length === 6, false);
    void loop();
  } else if (msg.type === 'designs') {
    page = { page: msg.page ?? '', designs: msg.designs ?? [], frames: msg.frames ?? [], selected: msg.selected ?? [], selection: msg.selection ?? [] };
    drawTiles();
    drawDesigns();
    fit();
    void tellPanel();
  } else if (msg.type === 'progress' && msg.reading) {
    const total = msg.total ?? 1;
    if (pushing && !pushing.sent) setWork('Reading…', `“${msg.name ?? ''}”`, total > 1 ? `Frame ${(msg.done ?? 0) + 1} of ${total}` : 'Reading layers and keyframes.', total > 1 ? (msg.done ?? 0) / total : null);
  } else if (msg.type === 'read-done') {
    void sendFrames(msg.docs ?? [], msg.images ?? {}, msg.error);
  } else if (msg.type === 'progress' && building) {
    const total = msg.total ?? 1;
    const done = msg.done ?? 0;
    if (msg.update) setWork('Updating…', `“${msg.name ?? ''}”`, total > 1 ? `Design ${done + 1} of ${total}` : 'Rebuilding the design where it is.', total > 1 ? done / total : null);
    else if (total > 1) setWork('Building…', `“${msg.name ?? ''}”`, `Composition ${done + 1} of ${total}`, done / total);
    else setWork('Building…', `“${msg.name ?? ''}”`, 'Creating layers and keyframes.', null);
  } else if (msg.type === 'built' && msg.report) {
    const done = building;
    building = null;
    showReport(msg.report, done?.docs ?? [], true);
    if (done?.fromBridge) void postResult(msg.report);
    // Another transfer came in between: what this window asked for is still on its way.
    if (waiting) setWork(waitingPhase(), waiting.title, waitingHint(), null);
    else setState(idleState());
  }
};

function submitCode(): void {
  const c = normalizeCode(codeInput.value);
  if (c.length < 6) return;
  pairError.hidden = true;
  pairHelp.hidden = false;
  codeInput.removeAttribute('aria-invalid');
  code = c;
}
codeInput.addEventListener('input', () => {
  codeInput.value = formatCode(codeInput.value);
  const complete = normalizeCode(codeInput.value).length === 6;
  pairButton.disabled = !complete;
  // Six characters make a whole code: no need to press anything.
  if (complete) submitCode();
});
pairButton.addEventListener('click', submitCode);
codeInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') submitCode();
});

componentsBox.addEventListener('change', () => toMain({ type: 'save-components', on: componentsBox.checked }));
showButton.addEventListener('click', () => toMain({ type: 'focus' }));
updateButton.addEventListener('click', () => void requestUpdate(false));
updateAllButton.addEventListener('click', () => void requestUpdate(true));
pullButton.addEventListener('click', () => void requestPull());
pushButton.addEventListener('click', () => {
  if (state === 'connected') startPush();
});
// Coming back to this window: ask at once which composition is open in After Effects now.
window.addEventListener('focus', () => {
  told = { body: '', at: 0 };
  void tellPanel();
});
// Frames come, go and get duplicated without the plugin being told: look again now and then.
setInterval(() => {
  if (state === 'connected' && !building) toMain({ type: 'scan' });
}, 3000);
getPanelButton.addEventListener('click', () => toMain({ type: 'open-installer' }));
unfoldButton.addEventListener('click', () => setCompact(!compact, true));
aboutToggle.addEventListener('click', () => {
  aboutBox.hidden = !aboutBox.hidden;
  aboutToggle.setAttribute('aria-expanded', String(!aboutBox.hidden));
  fit();
});
notesBox.addEventListener('toggle', fit);

el('pick').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) void importFile(file);
  fileInput.value = '';
});

// A file can be dropped anywhere on the window.
let dragDepth = 0;
window.addEventListener('dragenter', (event) => {
  event.preventDefault();
  dragDepth++;
  veil.hidden = false;
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) veil.hidden = true;
});
window.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  veil.hidden = true;
  const file = event.dataTransfer?.files[0];
  if (file) void importFile(file);
});

if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fit).observe(content);
setAlert(false);
setState('offline');
toMain({ type: 'init' });
