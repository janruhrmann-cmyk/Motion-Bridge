/**
 * Keeps designs in Figma in step with After Effects.
 *
 * A frame built from a composition remembers where it came from (its "link",
 * plugin data on the frame): the project, the composition, the template
 * options that became variant properties, the still pose. That is all After
 * Effects needs to read the composition again the same way. Copies of the
 * frame carry the link with them, so a design duplicated five times - once per
 * market, say - is five linked designs, and one update reaches them all.
 *
 * An update rebuilds a design in place:
 *
 *  - The frame itself stays: same node, same place, same name, whatever it
 *    sits in. The new layers are built into it and the old ones removed.
 *
 *  - What a designer did to it in Figma is carried over where it has a clear
 *    meaning: a variant switched on an instance, and text that was edited.
 *    To tell those from what After Effects set, the frame keeps a snapshot of
 *    both as they were built; only what differs from the snapshot is a
 *    designer's change. Anything else done by hand inside the frame is
 *    replaced by what After Effects has now.
 *
 *  - A design that would come out the same is not touched at all, and a
 *    component that still shows what After Effects has is kept - with its
 *    instances elsewhere and everything done to it in Figma. Components no
 *    design uses any more are removed; one that is still used somewhere stays.
 */
import { isBridgeDoc, rootName } from '../../../shared/format.ts';
import type { BridgeDoc } from '../../../shared/format.ts';
import type { BuildReport, DesignLink, FrameReport } from '../../../shared/protocol.ts';
import { buildDocument, designSignature, hashText, imageHashes, madeHere, newShared, rehouse } from './builder.ts';
import type { Rehoused } from './builder.ts';
import { loadFonts } from './fonts.ts';

const LINK = 'mbridgeLink';
const BUILT = 'mbridgeBuilt';
/** Plugin data has a size limit; a snapshot larger than this is not kept (and nothing is carried over next time). */
const MAX_SNAPSHOT = 90000;

export interface StoredLink {
  v: 1;
  project: string | null;
  compId: string;
  /** The composition's name when the design was built. The frame follows a rename unless it was renamed in Figma. */
  comp: string;
  options: string[];
  poster: number;
  /** Whether it was built as components (the plugin's switch at the time). */
  components: boolean;
  /** What was built (designSignature), to tell whether anything has changed since. */
  hash: string;
  /** The composition's background, so a fill chosen in Figma is only replaced when After Effects' changed. */
  bg: string;
}

export interface Design {
  frame: FrameNode;
  link: StoredLink;
  key: string;
}

const failure = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** The name designs built the same way from one composition share. The panel gets it and hands it back. */
export function designKey(link: Pick<StoredLink, 'project' | 'compId' | 'options' | 'poster'>): string {
  return hashText([link.project ?? '', link.compId, [...link.options].sort().join('\n'), Math.round(link.poster * 1000)].join('|'));
}

function readLink(node: SceneNode): StoredLink | null {
  try {
    const raw = node.getPluginData(LINK);
    if (!raw) return null;
    const link = JSON.parse(raw) as Partial<StoredLink>;
    if (link.v !== 1 || typeof link.compId !== 'string' || !Array.isArray(link.options)) return null;
    return {
      v: 1,
      project: typeof link.project === 'string' ? link.project : null,
      compId: link.compId,
      comp: String(link.comp ?? ''),
      options: link.options.map(String),
      poster: typeof link.poster === 'number' && isFinite(link.poster) ? link.poster : 0,
      components: link.components !== false,
      hash: String(link.hash ?? ''),
      bg: String(link.bg ?? ''),
    };
  } catch {
    return null;
  }
}

function backgroundOf(doc: BridgeDoc): string {
  const bg = doc.comps[doc.rootCompId]?.background;
  return bg ? [bg.r, bg.g, bg.b, bg.a].map((n) => Math.round(n * 1000)).join(',') : '';
}

function linkFor(doc: BridgeDoc, components: boolean, hash: string): StoredLink | null {
  // Without the link a document cannot be read again the same way (a transfer from an older panel).
  if (!doc.link) return null;
  return {
    v: 1,
    project: doc.source.project ?? null,
    compId: doc.link.compId,
    comp: rootName(doc),
    options: [...doc.link.options],
    poster: doc.posterTime,
    components,
    hash,
    bg: backgroundOf(doc),
  };
}

/**
 * Makes a freshly built frame a linked design: it remembers where it came
 * from and what it was built as. Returns whether it could.
 */
export function linkDesign(frame: FrameNode, doc: BridgeDoc, components: boolean, hashes: Map<string, string>): boolean {
  const link = linkFor(doc, components, designSignature(doc, hashes, components));
  if (!link) return false;
  try {
    frame.setPluginData(LINK, JSON.stringify(link));
    storeSnapshot(frame, takeSnapshot(frame.children));
    return true;
  } catch {
    return false;
  }
}

/** Every linked design on the current page. */
export function findDesigns(): Design[] {
  let frames: SceneNode[];
  try {
    frames = figma.currentPage.findAllWithCriteria({ types: ['FRAME'], pluginData: { keys: [LINK] } });
  } catch {
    frames = figma.currentPage.findAll((n) => n.type === 'FRAME');
  }
  const designs: Design[] = [];
  for (const frame of frames) {
    if (frame.type !== 'FRAME' || frame.removed) continue;
    const link = readLink(frame);
    if (link) designs.push({ frame, link, key: designKey(link) });
  }
  return designs;
}

/** The designs as the panel hears of them: one entry for all frames built the same way. */
export function describeDesigns(designs: Design[]): DesignLink[] {
  const byKey = new Map<string, DesignLink>();
  for (const d of designs) {
    const known = byKey.get(d.key);
    if (known) known.frames++;
    else byKey.set(d.key, { key: d.key, project: d.link.project, compId: d.link.compId, comp: d.link.comp, options: d.link.options, poster: d.link.poster, frames: 1 });
  }
  return [...byKey.values()];
}

// ------------------------------------------------- what a designer changed

/** What was built, by where it is in the frame: variant choices of instances, and (a hash of) texts. */
type Snapshot = Record<string, { p?: Record<string, string>; t?: string }>;

interface Edit {
  /** Variant properties that were switched, with their new values. */
  props?: Record<string, string>;
  /** Text as it was edited. */
  text?: string;
}

/**
 * Goes through nodes and everything below them, parents first. Each node gets
 * a path made of the names on the way to it; nodes of the same name next to
 * each other are numbered. `visit` says whether to go on below the node, and
 * may change the node first (what is below it is looked up afterwards).
 */
async function walk(nodes: readonly SceneNode[], prefix: string, visit: (node: SceneNode, path: string) => boolean | Promise<boolean>): Promise<void> {
  const seen = new Map<string, number>();
  for (const node of [...nodes]) {
    if (node.removed) continue;
    const nth = seen.get(node.name) ?? 0;
    seen.set(node.name, nth + 1);
    const path = `${prefix}/${node.name}${nth ? `#${nth}` : ''}`;
    if ((await visit(node, path)) && 'children' in node) await walk(node.children, path, visit);
  }
}

/** The same walk for when nothing has to be waited for. */
function walkNow(nodes: readonly SceneNode[], prefix: string, visit: (node: SceneNode, path: string) => boolean): void {
  const seen = new Map<string, number>();
  for (const node of nodes) {
    if (node.removed) continue;
    const nth = seen.get(node.name) ?? 0;
    seen.set(node.name, nth + 1);
    const path = `${prefix}/${node.name}${nth ? `#${nth}` : ''}`;
    if (visit(node, path) && 'children' in node) walkNow(node.children, path, visit);
  }
}

function variantChoices(node: InstanceNode): Record<string, string> | null {
  try {
    const props = node.componentProperties;
    const out: Record<string, string> = {};
    let any = false;
    for (const name of Object.keys(props)) {
      const prop = props[name]!;
      if (prop.type !== 'VARIANT') continue;
      out[name] = String(prop.value);
      any = true;
    }
    return any ? out : null;
  } catch {
    return null;
  }
}

function takeSnapshot(roots: readonly SceneNode[]): Snapshot {
  const snap: Snapshot = {};
  walkNow(roots, '', (node, path) => {
    if (node.type === 'INSTANCE') {
      const p = variantChoices(node);
      if (p) snap[hashText(path)] = { p };
    } else if (node.type === 'TEXT') {
      snap[hashText(path)] = { t: hashText(node.characters) };
    }
    return true;
  });
  return snap;
}

function storeSnapshot(frame: FrameNode, snap: Snapshot): void {
  try {
    const json = JSON.stringify(snap);
    frame.setPluginData(BUILT, json.length <= MAX_SNAPSHOT ? json : '');
  } catch {
    // Without it the next update carries nothing over.
  }
}

function readSnapshot(frame: FrameNode): Snapshot {
  try {
    const raw = frame.getPluginData(BUILT);
    const snap = raw ? (JSON.parse(raw) as Snapshot) : {};
    return snap && typeof snap === 'object' ? snap : {};
  } catch {
    return {};
  }
}

/** What differs, in the layers a design holds now, from what was built. */
function findEdits(roots: readonly SceneNode[], snap: Snapshot): Map<string, Edit> {
  const edits = new Map<string, Edit>();
  walkNow(roots, '', (node, path) => {
    const was = snap[hashText(path)];
    if (node.type === 'INSTANCE') {
      const now = variantChoices(node);
      if (!was?.p || !now) return true;
      const props: Record<string, string> = {};
      for (const name of Object.keys(now)) {
        if (was.p[name] !== undefined && was.p[name] !== now[name]) props[name] = now[name]!;
      }
      if (!Object.keys(props).length) return true;
      edits.set(path, { props });
      // Below a switched instance everything differs from what was built, without being anyone's edit.
      return false;
    }
    if (node.type === 'TEXT' && was?.t !== undefined && hashText(node.characters) !== was.t) edits.set(path, { text: node.characters });
    return true;
  });
  return edits;
}

/** Sets a text the way an edit in Figma would: the fonts are loaded first, and the text stays pinned where its alignment pins it. */
async function setText(node: TextNode, text: string): Promise<boolean> {
  try {
    const fonts = node.characters.length && typeof node.getRangeAllFontNames === 'function' ? node.getRangeAllFontNames(0, node.characters.length) : [node.fontName as FontName];
    for (const font of fonts) await figma.loadFontAsync(font);
    const pin = (): number => {
      const align = node.textAlignHorizontal;
      return align === 'CENTER' ? node.x + node.width / 2 : align === 'RIGHT' ? node.x + node.width : node.x;
    };
    const before = pin();
    node.characters = text;
    const turned = Math.abs(node.relativeTransform[0][1]) > 1e-6;
    if (!turned && node.textAutoResize === 'WIDTH_AND_HEIGHT' && Math.abs(pin() - before) > 0.01) {
      try {
        node.x += before - pin();
      } catch {
        // Inside an instance the text cannot be moved; it grows from its left edge.
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Puts a designer's changes onto freshly built layers. Returns how many found their place, and how many did not. */
async function applyEdits(roots: readonly SceneNode[], edits: Map<string, Edit>): Promise<{ kept: number; lost: number }> {
  let kept = 0;
  let lost = 0;
  if (!edits.size) return { kept, lost };
  const open = new Map(edits);
  await walk(roots, '', async (node, path) => {
    const edit = open.get(path);
    if (!edit) return true;
    if (edit.props && node.type === 'INSTANCE') {
      open.delete(path);
      for (const name of Object.keys(edit.props)) {
        try {
          if (!(name in node.componentProperties)) throw new Error('gone');
          node.setProperties({ [name]: edit.props[name]! });
          kept++;
        } catch {
          // The option, or this setting of it, is no longer there.
          lost++;
        }
      }
    } else if (edit.text !== undefined && node.type === 'TEXT') {
      open.delete(path);
      if (node.characters === edit.text || (await setText(node, edit.text))) kept++;
      else lost++;
    }
    return true;
  });
  for (const edit of open.values()) lost += edit.props ? Object.keys(edit.props).length : 1;
  return { kept, lost };
}

// ------------------------------------------------------------ components

type Unit = ComponentNode | ComponentSetNode;

/** What lies on the page for a component: the set it is a variant of, or the component itself. */
function unitOf(main: ComponentNode): Unit {
  return main.parent && main.parent.type === 'COMPONENT_SET' ? main.parent : main;
}

/** Every component that nodes show through instances - also the components those are built from. */
async function componentsIn(roots: readonly SceneNode[]): Promise<Set<ComponentNode>> {
  const found = new Set<ComponentNode>();
  const queue: SceneNode[] = [...roots];
  while (queue.length) {
    const node = queue.pop()!;
    if (node.removed) continue;
    const instances: InstanceNode[] = node.type === 'INSTANCE' ? [node] : [];
    if ('findAllWithCriteria' in node) instances.push(...node.findAllWithCriteria({ types: ['INSTANCE'] }));
    for (const instance of instances) {
      let main: ComponentNode | null = null;
      try {
        main = await instance.getMainComponentAsync();
      } catch {
        main = null;
      }
      if (!main || main.removed || found.has(main)) continue;
      found.add(main);
      queue.push(main);
    }
  }
  return found;
}

/**
 * Removes the components that nothing shows any more, of the ones the updated
 * designs were using. A set goes as a whole or not at all, and one that is
 * still shown anywhere in the file - by the updated designs, by another
 * design, by a designer's own layers - stays. Returns how many went.
 */
async function retire(units: Set<Unit>): Promise<number> {
  const left = new Set([...units].filter((u) => !u.removed && madeHere(u)));
  let retired = 0;
  // Several rounds: a component only becomes free once the component that contains an instance of it is gone.
  for (let round = 0; round < 12 && left.size; round++) {
    let changed = false;
    for (const unit of [...left]) {
      if (unit.removed) {
        left.delete(unit);
        continue;
      }
      const parts = unit.type === 'COMPONENT_SET' ? unit.children.filter((c): c is ComponentNode => c.type === 'COMPONENT') : [unit];
      let used = false;
      for (const part of parts) {
        let instances: InstanceNode[];
        try {
          instances = await part.getInstancesAsync();
        } catch {
          // Not knowing means keeping.
          used = true;
          break;
        }
        if (instances.some((i) => !i.removed)) {
          used = true;
          break;
        }
      }
      if (used) continue;
      try {
        unit.remove();
        retired++;
        changed = true;
      } catch {
        // Stays; harmless.
      }
      left.delete(unit);
    }
    if (!changed) break;
  }
  return retired;
}

/** The section most of these components are in, if any. */
function homeOf(units: Set<Unit>): SectionNode | null {
  const votes = new Map<SectionNode, number>();
  for (const unit of units) {
    const parent = unit.removed ? null : unit.parent;
    if (parent && parent.type === 'SECTION' && madeHere(unit)) votes.set(parent, (votes.get(parent) ?? 0) + 1);
  }
  let best: SectionNode | null = null;
  for (const [section, n] of votes) if (!best || n > votes.get(best)!) best = section;
  return best;
}

// ----------------------------------------------------------------- update

export interface UpdateInput {
  id: string;
  docs: unknown[];
  images: Record<string, Uint8Array>;
  /** Only these frames (node ids), when the update was asked for a selection. */
  scope?: string[] | null;
  /** Called before each design, so the window can say how far it is. */
  progress?: (done: number, total: number, name: string) => void | Promise<void>;
}

export interface UpdateOutput {
  report: BuildReport;
  /** The designs the update was for, rebuilt or not. */
  frames: FrameNode[];
}

/** Rebuilds the designs an update transfer was read for. */
export async function updateDesigns(input: UpdateInput): Promise<UpdateOutput> {
  const report: BuildReport = {
    id: input.id, ok: false, nodes: 0, tracks: 0, components: 0, reused: 0, motionAvailable: true, warnings: [], frames: [],
    kind: 'update', updated: 0, unchanged: 0, kept: 0, lost: 0, retired: 0,
  };
  const frames: FrameNode[] = [];
  try {
    const scope = input.scope && input.scope.length ? new Set(input.scope) : null;
    const designs = findDesigns().filter((d) => !scope || scope.has(d.frame.id));
    const jobs: Array<{ doc: BridgeDoc; targets: Design[] }> = [];
    for (const doc of input.docs) {
      if (!isBridgeDoc(doc)) continue;
      const keys = new Set(doc.update ?? []);
      jobs.push({ doc, targets: designs.filter((d) => keys.has(d.key)) });
    }
    const total = jobs.reduce((n, j) => n + j.targets.length, 0);
    if (!total) throw new Error('The designs this update was read for are not on this page any more.');

    // Every component a transfer left on the page may serve again, as long as it still shows what After Effects has.
    const shared = newShared(true, true);
    const before = new Set<Unit>();
    const housing: Rehoused[] = [];
    let done = 0;

    for (const { doc, targets } of jobs) {
      if (!targets.length) continue;
      const fontNotes: string[] = [];
      const imageNotes: string[] = [];
      let fonts: Map<string, FontName> | null = null;
      const hashes = imageHashes(doc, input.images, imageNotes);

      for (const target of targets) {
        const { frame, link } = target;
        const part: FrameReport = { name: frame.name, ok: false, nodes: 0, tracks: 0, components: 0, warnings: [] };
        report.frames!.push(part);
        frames.push(frame);
        await input.progress?.(done++, total, frame.name);
        try {
          const hash = designSignature(doc, hashes, link.components);
          const next = linkFor(doc, link.components, hash) ?? { ...link, hash };
          if (hash === link.hash) {
            part.ok = true;
            part.state = 'unchanged';
            report.unchanged!++;
            continue;
          }
          fonts ??= await loadFonts(doc, (message) => fontNotes.push(message));
          const snap = readSnapshot(frame);
          const used = new Set([...(await componentsIn(frame.children))].map(unitOf));
          for (const unit of used) before.add(unit);

          const out = buildDocument({ doc, images: input.images, hashes, fonts, components: link.components, shared, into: frame });
          const old = new Set(out.replaced);
          const fresh = frame.children.filter((c) => !old.has(c));
          const built = takeSnapshot(fresh);
          const carried = await applyEdits(fresh, findEdits(out.replaced, snap));
          for (const node of out.replaced) {
            try {
              if (!node.removed) node.remove();
            } catch {
              // Already gone together with its parent.
            }
          }

          // The frame follows the composition's name and background, unless a designer chose another.
          if (frame.name === link.comp && next.comp) frame.name = next.comp;
          if (next.bg !== link.bg) {
            const bg = doc.comps[doc.rootCompId]!.background;
            const clamp = (n: number): number => Math.max(0, Math.min(1, n));
            frame.fills = [{ type: 'SOLID', color: { r: clamp(bg.r), g: clamp(bg.g), b: clamp(bg.b) }, opacity: clamp(bg.a) }];
          }
          frame.setPluginData(LINK, JSON.stringify(next));
          storeSnapshot(frame, built);
          if (out.components.length) housing.push({ name: frame.name, nodes: out.components, home: homeOf(used) });

          part.ok = true;
          part.state = 'updated';
          part.name = frame.name;
          part.nodes = out.nodes;
          part.tracks = out.motion.tracks;
          part.components = out.components.length;
          part.reused = out.reused;
          part.warnings = [...imageNotes, ...fontNotes, ...out.warnings, ...out.motion.problems];
          if (carried.lost) {
            part.warnings.push(
              carried.lost === 1
                ? 'One change made in Figma (a variant choice or an edited text) had no place in the updated design.'
                : `${carried.lost} changes made in Figma (variant choices or edited text) had no place in the updated design.`,
            );
          }
          if (out.motion.available === false) report.motionAvailable = false;
          report.updated!++;
          report.kept! += carried.kept;
          report.lost! += carried.lost;
        } catch (err) {
          part.error = failure(err);
        }
      }
    }

    // What the old layers were using and nothing shows any more goes; new components move in where the old ones
    // were. A section that neither lost nor gained anything is left exactly as it is arranged.
    const held = new Map<SectionNode, number>();
    for (const unit of before) {
      if (!unit.removed && unit.parent && unit.parent.type === 'SECTION') held.set(unit.parent, unit.parent.children.length);
    }
    report.retired = await retire(before);
    for (const [home, count] of held) {
      if (home.removed || home.children.length === count || housing.some((h) => h.home === home)) continue;
      housing.push({ name: home.name, nodes: [], home });
    }
    report.warnings.push(...rehouse(housing));

    const good = report.frames!.filter((f) => f.ok);
    if (!good.length) throw new Error(report.frames![0]?.error ?? 'Nothing could be updated.');
    const rebuilt = good.filter((f) => f.state === 'updated');
    report.ok = true;
    report.frameName = (rebuilt[0] ?? good[0])!.name;
    report.nodes = rebuilt.reduce((n, f) => n + f.nodes, 0);
    report.tracks = rebuilt.reduce((n, f) => n + f.tracks, 0);
    report.components = rebuilt.reduce((n, f) => n + f.components, 0);
    report.reused = rebuilt.reduce((n, f) => n + (f.reused ?? 0), 0);
    for (const f of report.frames!) {
      if (f.error) report.warnings.push(`"${f.name}" could not be updated: ${f.error}`);
    }
    if (!report.motionAvailable) {
      report.warnings.unshift('Figma Motion is not available for this account or file, so only the static design was updated.');
    }
  } catch (err) {
    report.error = failure(err);
  }
  return { report, frames: frames.filter((f) => !f.removed) };
}
