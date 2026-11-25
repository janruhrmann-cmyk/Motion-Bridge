/**
 * The local bridge between the After Effects panel (server) and the Figma
 * plugin (client). Everything stays on this machine: the server only listens
 * on the loopback interface and every call except `/hello` needs the pairing
 * code shown in the After Effects panel.
 */

export const BRIDGE_PORT = 38473;
export const BRIDGE_ORIGIN = `http://localhost:${BRIDGE_PORT}`;
export const BRIDGE_APP = 'motion-bridge';
export const BRIDGE_VERSION = '1.0.0';

/** How long the server keeps a poll request open before answering "nothing new". */
export const POLL_HOLD_MS = 20000;

/** GET /hello */
export interface HelloResponse {
  app: typeof BRIDGE_APP;
  version: string;
  host: string;
  /** Sequence number of the newest transfer or notice. */
  seq: number;
  /** True while the newest transfer has not been picked up yet. */
  pending: boolean;
  /** The panel can bring designs up to date (/designs and /update). */
  sync?: boolean;
  /** The panel can build compositions from Figma frames, and be asked for the composition that is open (/push and /pull). */
  push?: boolean;
}

/** GET /poll?k=CODE&after=SEQ */
export type PollResponse =
  | { type: 'none'; seq: number }
  /** `kind: 'update'` rebuilds designs that are already there; `request` names the plugin's own request, if it asked. */
  | { type: 'transfer'; seq: number; id: string; name: string; count?: number; kind?: 'update'; request?: string }
  /** An update the plugin asked for ended without a transfer (cancelled, nothing found, an error). */
  | { type: 'notice'; seq: number; message: string; level: 'info' | 'error'; request?: string }
  /** How far After Effects is with reading. Only sent to a plugin that is waiting; the sequence number does not move. */
  | { type: 'progress'; seq: number; text: string; fraction: number }
  /** After Effects asks for the frames that are selected in Figma. The plugin answers with a push that names `request`. */
  | { type: 'want'; seq: number; request: string }
  /** What After Effects made of the frames the plugin pushed. */
  | { type: 'pushed'; seq: number; report: PushReport };

/**
 * Designs on the Figma page that were built from one composition in the same
 * way (same template options, same still pose). They are updated together, so
 * they travel as one entry. `key` is the plugin's name for the group; the
 * panel hands it back in the document it reads for them (BridgeDoc.update).
 */
export interface DesignLink {
  key: string;
  /** The After Effects project file's name when the design was built. */
  project: string | null;
  compId: string;
  /** The composition's name when the design was built. */
  comp: string;
  /** The template options that became variant properties, each as "layer/name". */
  options: string[];
  /** The time whose look is the static design. */
  poster: number;
  /** How many frames on the page belong to it. */
  frames: number;
}

/** POST /designs?k=CODE: what the Figma page holds that After Effects can update. */
export interface DesignsReport {
  page: string;
  designs: DesignLink[];
  /** The names of the frames that are selected: what "Pull from Figma" would bring to After Effects. */
  selection?: string[];
}

/** The answer to /designs: what "Pull from After Effects" would bring to Figma right now, if anything. */
export interface DesignsAnswer {
  ok: boolean;
  /** The name of the composition that is open in After Effects (or "3 compositions"). */
  open?: string | null;
}

/** POST /update?k=CODE: the plugin asks After Effects to read these designs again. */
export interface UpdateRequest {
  /** Made up by the plugin, and handed back with the transfer or notice that answers it. */
  request: string;
  keys: string[];
}

export interface UpdateAnswer {
  ok: boolean;
  error?: string;
}

/**
 * POST /pull?k=CODE: the plugin asks for the composition that is open in After
 * Effects. It arrives like any transfer, marked with `request`.
 */
export interface PullRequest {
  /** Made up by the plugin, and handed back with the transfer or notice that answers it. */
  request: string;
}

export interface PullAnswer {
  ok: boolean;
  error?: string;
  /** What is being read: a composition's name, or "3 compositions". */
  name?: string;
}

/**
 * Figma -> After Effects. The plugin first uploads the images, each with
 * POST /push/ID/asset/ASSET?k=CODE (the body is the file), then the frames
 * with POST /push/ID?k=CODE (this, as text/plain). After Effects builds a
 * composition per frame and says how it went in a `pushed` poll answer.
 */
export interface PushBody {
  /** When After Effects asked for the frames (`want`): its request. */
  request?: string;
  /** One document, or a bundle of them (see packDocs in format.ts). Left out when there was nothing to send. */
  docs?: unknown;
  /** Why nothing is sent, when After Effects asked and there was nothing to read. */
  error?: string;
}

export interface PushAnswer {
  ok: boolean;
  error?: string;
}

/** What After Effects built from one pushed frame. */
export interface CompReport {
  name: string;
  ok: boolean;
  error?: string;
  layers: number;
  /** Compositions made for frames inside the frame. */
  precomps: number;
  keyframes: number;
  warnings: string[];
}

export interface PushReport {
  /** The push's id. */
  id: string;
  ok: boolean;
  error?: string;
  comps: CompReport[];
  layers: number;
  precomps: number;
  keyframes: number;
  images: number;
  warnings: string[];
}

/** What became of one composition of a transfer, or of one design of an update. */
export interface FrameReport {
  name: string;
  ok: boolean;
  error?: string;
  nodes: number;
  tracks: number;
  components: number;
  /** Components that were already there (made for another frame, or by an earlier transfer) and are used again. */
  reused?: number;
  /** In an update: whether the design was rebuilt or was already as After Effects has it. */
  state?: 'updated' | 'unchanged';
  /** What Figma had to say while building (the converter's own notes travel in the document). */
  warnings: string[];
}

/** POST /result?k=CODE  (body is JSON sent as text/plain) */
export interface BuildReport {
  id: string;
  ok: boolean;
  error?: string;
  frameName?: string;
  /** One entry per composition, in the order they were sent. In an update: one per design. */
  frames?: FrameReport[];
  nodes: number;
  tracks: number;
  /** Components and component sets created next to the frame. */
  components?: number;
  /** Components used again instead of being built a second time. */
  reused?: number;
  motionAvailable: boolean;
  warnings: string[];
  kind?: 'update';
  /** In an update: designs rebuilt, and designs that needed nothing. */
  updated?: number;
  unchanged?: number;
  /** Variant choices and text edits made in Figma that were carried over, and the ones that had no place to go. */
  kept?: number;
  lost?: number;
  /** Components no design uses any more, removed from the page. */
  retired?: number;
}

export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
