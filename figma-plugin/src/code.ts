/**
 * Motion Bridge - Figma plugin, main thread.
 *
 * The UI (ui.ts) talks to the After Effects panel and hands finished
 * transfers over to this file, which is the only place allowed to touch the
 * Figma document. For the way back it reads the selected frames here
 * (read/reader.ts) and hands them to the UI to send.
 */
import { FORMAT_VERSION, isBridgeDoc, rootName } from '../../shared/format.ts';
import type { BuildReport, DesignLink, FrameReport } from '../../shared/protocol.ts';
import { arrange, buildDocument, imageHashes, newShared, occupied } from './build/builder.ts';
import type { BuildOutput } from './build/builder.ts';
import { loadFonts } from './build/fonts.ts';
import { describeDesigns, findDesigns, linkDesign, updateDesigns } from './build/sync.ts';
import { pushable, readFrames } from './read/reader.ts';

type UiMessage =
  | { type: 'init' }
  | { type: 'save-code'; code: string }
  | { type: 'save-components'; on: boolean }
  /** The window is as large as what it shows. `compact`: folded down to its three tiles. */
  | { type: 'resize'; height: number; width?: number; compact?: boolean }
  | { type: 'save-compact'; on: boolean }
  | { type: 'focus' }
  | { type: 'open-installer' }
  | { type: 'scan' }
  /** Read the selected frames for After Effects. `request`: After Effects asked for them. */
  | { type: 'read'; request?: string }
  | { type: 'notify'; text: string; error?: boolean }
  | {
      type: 'build';
      id: string;
      docs: unknown[];
      images: Record<string, Uint8Array>;
      components: boolean;
      /** 'update' rebuilds the designs the documents were read for; `scope` narrows that to these frames. */
      mode?: 'update';
      scope?: string[] | null;
    };

/** The install steps for the After Effects panel, with the link to the latest release (README.md, "Install"). */
const INSTALLER_URL = 'https://github.com/janruhrmann-cmyk/motion-bridge#install';

const CODE_KEY = 'pairingCode';
const COMPONENTS_KEY = 'buildComponents';
/** The window was folded down to its three tiles when it was last open. */
const COMPACT_KEY = 'compactWindow';
const WIDTH = 320;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 620;
/** Folded, the window is three tiles: as small as they stay easy to hit (Figma's own limit is 70 wide). */
const COMPACT_WIDTH = 180;
const COMPACT_HEIGHT = 64;

// Shown once it is known whether it starts folded (see 'init'), so it does not open large and jump small.
figma.showUI(__html__, { width: WIDTH, height: 300, themeColors: true, visible: false });

/** What the last transfer built, so the UI can bring it back into view. */
let lastBuilt: string[] = [];
let working = false;

const failure = (err: unknown): string => (err instanceof Error ? err.message : String(err));
/** Lets Figma repaint and deliver messages between two compositions. */
const breathe = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

async function runBuild(id: string, docs: unknown[], images: Record<string, Uint8Array>, components: boolean): Promise<BuildReport> {
  const report: BuildReport = { id, ok: false, nodes: 0, tracks: 0, components: 0, motionAvailable: true, warnings: [], frames: [] };
  try {
    if (!docs.length) throw new Error('The transfer is empty.');
    // Ask before building: everything new goes clear of what is on the page now.
    const taken = occupied();
    // One register for the whole transfer, so compositions that use the same picker or precomp
    // share one component - including still ones an earlier transfer left on this page.
    const shared = newShared(components);
    const builds: BuildOutput[] = [];

    for (let i = 0; i < docs.length; i++) {
      const doc = docs[i];
      const part: FrameReport = { name: isBridgeDoc(doc) ? rootName(doc) : `Composition ${i + 1}`, ok: false, nodes: 0, tracks: 0, components: 0, warnings: [] };
      report.frames!.push(part);
      figma.ui.postMessage({ type: 'progress', done: i, total: docs.length, name: part.name });
      await breathe();
      try {
        if (!isBridgeDoc(doc)) throw new Error('This is not a Motion Bridge transfer.');
        if (doc.version > FORMAT_VERSION) {
          throw new Error('This transfer was made by a newer Motion Bridge. Please update the Figma plugin.');
        }
        const fontNotes: string[] = [];
        const imageNotes: string[] = [];
        const fonts = await loadFonts(doc, (message) => fontNotes.push(message));
        const hashes = imageHashes(doc, images, imageNotes);
        const out = buildDocument({ doc, images, hashes, fonts, components, shared });
        builds.push(out);
        // From here on the frame knows where it came from, and "Update designs" can bring it up to date.
        linkDesign(out.frame, doc, components, hashes);
        part.ok = true;
        part.nodes = out.nodes;
        part.tracks = out.motion.tracks;
        part.components = out.components.length;
        part.reused = out.reused;
        part.warnings = [...imageNotes, ...fontNotes, ...out.warnings, ...out.motion.problems];
        if (out.motion.available === false) report.motionAvailable = false;
      } catch (err) {
        part.error = failure(err);
      }
    }

    const built = report.frames!.filter((f) => f.ok);
    if (!builds.length) throw new Error(report.frames![0]?.error ?? 'Nothing could be built.');

    const placed = arrange(builds, taken);
    figma.currentPage.selection = placed.frames;
    figma.viewport.scrollAndZoomIntoView(placed.frames);
    lastBuilt = placed.frames.map((f) => f.id);

    report.ok = true;
    report.frameName = builds[0]!.frame.name;
    report.nodes = built.reduce((n, f) => n + f.nodes, 0);
    report.tracks = built.reduce((n, f) => n + f.tracks, 0);
    report.components = built.reduce((n, f) => n + f.components, 0);
    report.reused = built.reduce((n, f) => n + (f.reused ?? 0), 0);
    report.warnings = [...placed.warnings];
    for (const f of report.frames!) {
      if (f.error) report.warnings.push(`"${f.name}" could not be built: ${f.error}`);
    }
    if (!report.motionAvailable) {
      report.warnings.unshift('Figma Motion is not available for this account or file, so only the static design was built.');
    }
    const what = builds.length === 1 ? `"${report.frameName}"` : `${builds.length} frames`;
    figma.notify(
      report.motionAvailable
        ? `Built ${what} with ${report.tracks} animated properties.`
        : `Built ${what} without motion (Figma Motion is not available here).`,
    );
  } catch (err) {
    report.error = failure(err);
    figma.notify(`Motion Bridge: ${report.error}`, { error: true });
  }
  return report;
}

/** Brings the designs an update was read for up to date, in place (see build/sync.ts). */
async function runUpdate(id: string, docs: unknown[], images: Record<string, Uint8Array>, scope: string[] | null): Promise<BuildReport> {
  for (const doc of docs) {
    if (isBridgeDoc(doc) && doc.version > FORMAT_VERSION) {
      const error = 'This update was made by a newer Motion Bridge. Please update the Figma plugin.';
      figma.notify(`Motion Bridge: ${error}`, { error: true });
      return { id, ok: false, error, nodes: 0, tracks: 0, motionAvailable: true, warnings: [], kind: 'update' };
    }
  }
  const { report, frames } = await updateDesigns({
    id,
    docs,
    images,
    scope,
    progress: async (done, total, name) => {
      figma.ui.postMessage({ type: 'progress', done, total, name, update: true });
      await breathe();
    },
  });
  if (!report.ok) {
    figma.notify(`Motion Bridge: ${report.error ?? 'The designs could not be updated.'}`, { error: true });
    return report;
  }
  if (frames.length) {
    figma.currentPage.selection = frames;
    lastBuilt = frames.map((f) => f.id);
    // Only where something changed is worth jumping to.
    if (report.updated) figma.viewport.scrollAndZoomIntoView(frames);
  }
  const updated = report.updated ?? 0;
  figma.notify(
    updated
      ? `Updated ${updated === 1 ? `"${report.frameName}"` : `${updated} designs`} from After Effects.`
      : 'The designs are already as After Effects has them.',
  );
  return report;
}

/** Selects what the last transfer built and scrolls to it. */
async function showLastBuilt(): Promise<void> {
  // An updated design may sit inside a section; what counts is that it is somewhere on this page.
  const onThisPage = (node: BaseNode): boolean => {
    for (let p: BaseNode | null = node; p; p = p.parent) if (p === figma.currentPage) return true;
    return false;
  };
  const nodes: SceneNode[] = [];
  for (const nodeId of lastBuilt) {
    const node = await figma.getNodeByIdAsync(nodeId);
    if (node && node.type !== 'DOCUMENT' && node.type !== 'PAGE' && !node.removed && onThisPage(node)) nodes.push(node as SceneNode);
  }
  if (!nodes.length) {
    figma.notify('The frames are no longer on this page.');
    return;
  }
  figma.currentPage.selection = nodes;
  figma.viewport.scrollAndZoomIntoView(nodes);
}

/**
 * Tells the UI which designs on this page After Effects can update, and
 * which of them the selection is in. The UI passes the list on to the panel.
 */
function reportDesigns(): void {
  let designs: DesignLink[] = [];
  let frames: Array<{ id: string; key: string }> = [];
  const selected: string[] = [];
  try {
    const found = findDesigns();
    designs = describeDesigns(found);
    frames = found.map((d) => ({ id: d.frame.id, key: d.key }));
    const ids = new Set(frames.map((f) => f.id));
    for (const node of figma.currentPage.selection) {
      // A layer inside a design counts as that design.
      for (let n: BaseNode | null = node; n && n.type !== 'PAGE'; n = n.parent) {
        if (ids.has(n.id)) {
          if (selected.indexOf(n.id) === -1) selected.push(n.id);
          break;
        }
      }
    }
  } catch {
    // An empty list: nothing to update.
  }
  // What "Push to After Effects" would send: the selected frames, by name.
  let selection: string[] = [];
  try {
    selection = pushable(figma.currentPage.selection).map((n) => n.name);
  } catch {
    selection = [];
  }
  figma.ui.postMessage({ type: 'designs', page: figma.currentPage.name, designs, frames, selected, selection });
}

/** "Push to After Effects": reads the selected frames into documents and hands them to the UI, which sends them. */
async function runRead(request: string | undefined): Promise<void> {
  const done = (answer: { docs?: unknown[]; images?: Record<string, Uint8Array>; error?: string }): void => {
    figma.ui.postMessage({ type: 'read-done', request, ...answer });
  };
  if (working) {
    done({ error: 'Figma is busy with another transfer. Try again when it has finished.' });
    return;
  }
  const nodes = pushable(figma.currentPage.selection);
  if (!nodes.length) {
    done({ error: 'Nothing is selected in Figma. Select the frames that should become compositions.' });
    return;
  }
  working = true;
  try {
    const out = await readFrames(nodes, async (index, total, name) => {
      figma.ui.postMessage({ type: 'progress', done: index, total, name, reading: true });
      await breathe();
    });
    done({ docs: out.docs, images: out.images });
  } catch (err) {
    done({ error: `The frames could not be read: ${failure(err)}` });
  } finally {
    working = false;
  }
}

figma.ui.onmessage = async (msg: UiMessage) => {
  switch (msg.type) {
    case 'init': {
      const code = ((await figma.clientStorage.getAsync(CODE_KEY)) as string | undefined) ?? '';
      const components = ((await figma.clientStorage.getAsync(COMPONENTS_KEY)) as boolean | undefined) ?? true;
      // Never chosen: folded for someone who has paired before, open for someone who still has to.
      const compact = ((await figma.clientStorage.getAsync(COMPACT_KEY)) as boolean | undefined) ?? code.length === 6;
      if (compact && code.length === 6) figma.ui.resize(COMPACT_WIDTH, COMPACT_HEIGHT);
      figma.ui.show();
      figma.ui.postMessage({ type: 'init', code, components, compact });
      reportDesigns();
      break;
    }
    case 'save-code':
      await figma.clientStorage.setAsync(CODE_KEY, msg.code);
      break;
    case 'save-components':
      await figma.clientStorage.setAsync(COMPONENTS_KEY, msg.on);
      break;
    case 'resize':
      // The window is as tall as what it shows, so no space is wasted and nothing needs scrolling until it is long.
      if (msg.compact) figma.ui.resize(COMPACT_WIDTH, Math.round(Math.max(40, Math.min(COMPACT_HEIGHT + 16, msg.height))));
      else figma.ui.resize(WIDTH, Math.round(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, msg.height))));
      break;
    case 'save-compact':
      await figma.clientStorage.setAsync(COMPACT_KEY, msg.on);
      break;
    case 'focus':
      await showLastBuilt();
      break;
    case 'open-installer':
      figma.openExternal(INSTALLER_URL);
      break;
    case 'scan':
      if (!working) reportDesigns();
      break;
    case 'read':
      await runRead(msg.request);
      break;
    case 'notify':
      figma.notify(msg.text, msg.error ? { error: true } : undefined);
      break;
    case 'build': {
      working = true;
      let report: BuildReport;
      try {
        report = msg.mode === 'update' ? await runUpdate(msg.id, msg.docs, msg.images, msg.scope ?? null) : await runBuild(msg.id, msg.docs, msg.images, msg.components);
      } finally {
        working = false;
      }
      figma.ui.postMessage({ type: 'built', report });
      reportDesigns();
      break;
    }
  }
};

// The selection decides what "Update" means, so the UI hears of it at once.
figma.on('selectionchange', () => {
  if (!working) reportDesigns();
});
figma.on('currentpagechange', () => {
  if (!working) reportDesigns();
});
