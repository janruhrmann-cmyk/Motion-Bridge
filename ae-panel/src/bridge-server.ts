/**
 * The local bridge server. It lives inside the After Effects panel and is the
 * only thing the Figma plugin talks to - in both directions: the plugin
 * fetches what After Effects publishes (compositions), and it posts what
 * Figma sends (frames, see /push). The server never calls out; when After
 * Effects wants something from Figma it says so in the answer to the plugin's
 * poll (`want`).
 *
 * Safety: it listens on the loopback interface only, answers browsers only
 * when they come from an opaque origin (which is what a Figma plugin iframe
 * has - ordinary web pages are turned away), and wants the pairing code on
 * every call except /hello.
 */
import type * as Http from 'node:http';
import { packDocs, rootName, unpackDocs } from '../../shared/format.ts';
import type { BridgeDoc } from '../../shared/format.ts';
import { BRIDGE_APP, BRIDGE_PORT, BRIDGE_VERSION, POLL_HOLD_MS, normalizeCode } from '../../shared/protocol.ts';
import type {
  BuildReport,
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

export interface BridgeAsset {
  bytes: Uint8Array;
  mime: string;
}

/** Frames the Figma plugin sent to become compositions, with their pictures. */
export interface Pushed {
  id: string;
  /** Set when After Effects asked for them (see BridgeServer.want). */
  request?: string;
  docs: BridgeDoc[];
  assets: Map<string, BridgeAsset>;
  /** Why there are no documents, when After Effects asked and Figma had nothing to send. */
  error?: string;
}

export interface BridgeEvents {
  /** The Figma plugin started or stopped listening. */
  onConnection(connected: boolean): void;
  /** Figma has fetched the document. */
  onDelivered(id: string): void;
  /** Figma has finished building. */
  onResult(report: BuildReport): void;
  /** The Figma plugin says which designs on its page can be updated. */
  onDesigns(report: DesignsReport): void;
  /** The Figma plugin asks for designs to be read again. The answer only says whether reading starts. */
  onUpdateRequest(request: UpdateRequest): UpdateAnswer;
  /** The Figma plugin asks for the composition that is open. The answer only says whether reading starts. */
  onPullRequest(request: PullRequest): PullAnswer;
  /** The Figma plugin sent frames to build. The answer only says whether building starts. */
  onPush(push: Pushed): PushAnswer;
  /** What a pull would bring to Figma right now: the open composition's name, or null. */
  openName(): string | null;
}

interface Transfer {
  id: string;
  seq: number;
  name: string;
  count: number;
  kind?: 'update';
  request?: string;
  json: string;
  assets: Map<string, BridgeAsset>;
  delivered: boolean;
  createdAt: number;
}

interface Waiter {
  res: Http.ServerResponse;
  timer: ReturnType<typeof setTimeout>;
}

const MAX_BODY = 2 * 1024 * 1024;
/** Frames from Figma carry every outline of every vector, and their pictures come as files. */
const MAX_PUSH = 64 * 1024 * 1024;
/** How long uploaded pictures wait for the frames they belong to. */
const UPLOAD_FOR_MS = 10 * 60 * 1000;
/** A question to Figma is only worth answering while After Effects is still waiting. */
const WANT_FOR_MS = 15000;
const PENDING_FOR_MS = 120000;
const MAX_WRONG_CODES = 30;
/** A waiting plugin hears about progress at most this often. */
const PROGRESS_EVERY_MS = 400;

export class BridgeServer {
  private readonly http: typeof Http;
  private readonly events: BridgeEvents;
  private readonly hostLabel: string;
  private readonly port: number;
  private code: string;
  private servers: Http.Server[] = [];
  private transfers: Transfer[] = [];
  private waiters = new Set<Waiter>();
  private seq = 0;
  private lastSeen = 0;
  private connected = false;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private wrongCodes = 0;
  private lockedUntil = 0;
  private lastNotice: Extract<PollResponse, { type: 'notice' | 'pushed' }> | null = null;
  private lastWant: { answer: Extract<PollResponse, { type: 'want' }>; at: number } | null = null;
  private lastProgress = 0;
  /** Pictures of pushes whose frames have not arrived yet, by push id. */
  private uploads = new Map<string, { assets: Map<string, BridgeAsset>; at: number }>();

  constructor(http: typeof Http, code: string, hostLabel: string, events: BridgeEvents, port: number = BRIDGE_PORT) {
    this.http = http;
    this.code = normalizeCode(code);
    this.hostLabel = hostLabel;
    this.events = events;
    this.port = port;
  }

  setCode(code: string): void {
    this.code = normalizeCode(code);
    this.wrongCodes = 0;
    this.lockedUntil = 0;
  }

  /** Starts listening. Rejects when the port is taken (usually a second After Effects). */
  start(): Promise<void> {
    const listen = (host: string, required: boolean): Promise<void> =>
      new Promise((resolve, reject) => {
        const server = this.http.createServer((req, res) => this.handle(req, res));
        server.once('error', (err: Error) => (required ? reject(err) : resolve()));
        server.listen(this.port, host, () => {
          this.servers.push(server);
          resolve();
        });
      });
    // "localhost" may resolve to either address family, so serve both.
    return listen('127.0.0.1', true)
      .then(() => listen('::1', false))
      .then(() => {
        this.watchdog = setInterval(() => this.checkConnection(), 1000);
      });
  }

  stop(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.res.end();
    }
    this.waiters.clear();
    for (const s of this.servers) s.close();
    this.servers = [];
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Makes one or several compositions available to Figma and wakes up a
   * waiting plugin. As an update (`kind`), the designs named in each document
   * are rebuilt instead of new frames being made; `request` is the plugin's
   * own request, when it was the one to ask.
   */
  publish(docs: BridgeDoc[], assets: Map<string, BridgeAsset>, as: { kind?: 'update'; request?: string } = {}): string {
    this.seq++;
    const id = `t${Date.now().toString(36)}${this.seq}`;
    const name = docs.length === 1 ? rootName(docs[0]!) : `${docs.length} compositions`;
    const transfer: Transfer = {
      id,
      seq: this.seq,
      name,
      count: docs.length,
      json: JSON.stringify(packDocs(docs)),
      assets,
      delivered: false,
      createdAt: Date.now(),
    };
    if (as.kind) transfer.kind = as.kind;
    if (as.request) transfer.request = as.request;
    this.transfers.push(transfer);
    while (this.transfers.length > 2) this.transfers.shift();
    this.answerWaiters(this.describe(transfer));
    return id;
  }

  /** Tells the plugin that an update it asked for ended without a transfer. */
  notice(message: string, level: 'info' | 'error', request?: string): void {
    this.seq++;
    this.lastNotice = { type: 'notice', seq: this.seq, message, level };
    if (request) this.lastNotice.request = request;
    this.answerWaiters(this.lastNotice);
  }

  /** Lets a waiting plugin show how far After Effects is. Not kept: a plugin that is not waiting misses it. */
  progress(text: string, fraction: number): void {
    const now = Date.now();
    if (!this.waiters.size || now - this.lastProgress < PROGRESS_EVERY_MS) return;
    this.lastProgress = now;
    this.lastSeen = now;
    this.answerWaiters({ type: 'progress', seq: this.seq, text, fraction: Math.max(0, Math.min(1, fraction)) });
  }

  /**
   * Asks the Figma plugin for the frames that are selected there. They arrive
   * as a push that names `request`. False when no plugin is listening.
   */
  want(request: string): boolean {
    if (!this.connected && !this.waiters.size) return false;
    this.seq++;
    this.lastWant = { answer: { type: 'want', seq: this.seq, request }, at: Date.now() };
    this.answerWaiters(this.lastWant.answer);
    return true;
  }

  /** Tells the plugin what became of the frames it pushed. */
  pushed(report: PushReport): void {
    this.seq++;
    this.lastNotice = { type: 'pushed', seq: this.seq, report };
    this.answerWaiters(this.lastNotice);
  }

  private describe(t: Transfer): PollResponse {
    const answer: Extract<PollResponse, { type: 'transfer' }> = { type: 'transfer', seq: t.seq, id: t.id, name: t.name, count: t.count };
    if (t.kind) answer.kind = t.kind;
    if (t.request) answer.request = t.request;
    return answer;
  }

  private answerWaiters(answer: PollResponse): void {
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      this.json(w.res, 200, answer);
    }
    this.waiters.clear();
  }

  private latest(): Transfer | undefined {
    return this.transfers[this.transfers.length - 1];
  }

  private checkConnection(): void {
    const now = this.waiters.size > 0 || Date.now() - this.lastSeen < 4000;
    if (now !== this.connected) {
      this.connected = now;
      this.events.onConnection(now);
    }
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Private-Network': 'true',
      'Cache-Control': 'no-store',
      ...extra,
    };
  }

  private json(res: Http.ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, this.headers({ 'Content-Type': 'application/json; charset=utf-8' }));
    res.end(text);
  }

  private handle(req: Http.IncomingMessage, res: Http.ServerResponse): void {
    try {
      // A Figma plugin iframe has the opaque origin "null"; non-browser clients send none.
      const origin = req.headers.origin;
      if (origin !== undefined && origin !== 'null') {
        res.writeHead(403);
        res.end();
        return;
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, this.headers());
        res.end();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const parts = url.pathname.split('/').filter(Boolean);
      const route = parts[0] ?? '';

      if (req.method === 'GET' && route === 'hello') {
        const latest = this.latest();
        const hello: HelloResponse = {
          app: BRIDGE_APP,
          version: BRIDGE_VERSION,
          host: this.hostLabel,
          seq: this.seq,
          // Only the very newest thing can be waiting: with a notice after it, the plugin starts behind both.
          pending: !!latest && latest.seq === this.seq && !latest.delivered && Date.now() - latest.createdAt < PENDING_FOR_MS,
          sync: true,
          push: true,
        };
        this.json(res, 200, hello);
        return;
      }

      if (Date.now() < this.lockedUntil) {
        this.json(res, 429, { error: 'locked' });
        return;
      }
      if (normalizeCode(url.searchParams.get('k') ?? '') !== this.code || !this.code) {
        if (++this.wrongCodes >= MAX_WRONG_CODES) {
          this.wrongCodes = 0;
          this.lockedUntil = Date.now() + 60000;
        }
        this.json(res, 401, { error: 'pairing' });
        return;
      }
      this.wrongCodes = 0;
      this.lastSeen = Date.now();
      this.checkConnection();

      if (req.method === 'GET' && route === 'poll') {
        this.poll(Number(url.searchParams.get('after') ?? '0'), req, res);
      } else if (req.method === 'GET' && route === 'transfer' && parts[1]) {
        const t = this.transfers.find((x) => x.id === parts[1]);
        if (!t) {
          this.json(res, 404, { error: 'gone' });
          return;
        }
        t.delivered = true;
        res.writeHead(200, this.headers({ 'Content-Type': 'application/json; charset=utf-8' }));
        res.end(t.json);
        this.events.onDelivered(t.id);
      } else if (req.method === 'GET' && route === 'asset' && parts[1] && parts[2]) {
        const asset = this.transfers.find((x) => x.id === parts[1])?.assets.get(parts[2]);
        if (!asset) {
          this.json(res, 404, { error: 'gone' });
          return;
        }
        res.writeHead(200, this.headers({ 'Content-Type': asset.mime, 'Content-Length': String(asset.bytes.byteLength) }));
        res.end(asset.bytes);
      } else if (req.method === 'POST' && route === 'push' && parts[1] && parts[2] === 'asset' && parts[3]) {
        // One picture of a push. The frames follow in a request of their own.
        const pushId = parts[1];
        const assetId = parts[3];
        this.readBytes(req, MAX_PUSH, (bytes) => {
          if (bytes === null) {
            this.json(res, 413, { error: 'too large' });
            return;
          }
          this.forgetUploads();
          let upload = this.uploads.get(pushId);
          if (!upload) {
            upload = { assets: new Map(), at: Date.now() };
            this.uploads.set(pushId, upload);
          }
          upload.assets.set(assetId, { bytes, mime: mimeOf(bytes) });
          this.json(res, 200, { ok: true });
        });
      } else if (req.method === 'POST' && route === 'push' && parts[1] && !parts[2]) {
        const pushId = parts[1];
        this.readBody(
          req,
          (body) => {
            const assets = this.uploads.get(pushId)?.assets ?? new Map<string, BridgeAsset>();
            this.uploads.delete(pushId);
            if (body === null) {
              this.json(res, 413, { error: 'too large' });
              return;
            }
            let parsed: Partial<PushBody>;
            try {
              parsed = (JSON.parse(body) ?? {}) as Partial<PushBody>;
            } catch {
              this.json(res, 400, { error: 'bad json' });
              return;
            }
            const docs = parsed.docs === undefined ? [] : unpackDocs(parsed.docs);
            const error = typeof parsed.error === 'string' && parsed.error ? parsed.error : undefined;
            if (!docs || (!docs.length && !error)) {
              this.json(res, 200, { ok: false, error: 'These are not frames from Motion Bridge.' } satisfies PushAnswer);
              return;
            }
            const push: Pushed = { id: pushId, docs, assets };
            if (typeof parsed.request === 'string' && parsed.request) push.request = parsed.request;
            if (error) push.error = error;
            try {
              this.json(res, 200, this.events.onPush(push));
            } catch {
              this.json(res, 500, { error: 'server' });
            }
          },
          MAX_PUSH,
        );
      } else if (req.method === 'POST' && (route === 'result' || route === 'designs' || route === 'update' || route === 'pull')) {
        this.readBody(req, (body) => {
          if (body === null) {
            this.json(res, 413, { error: 'too large' });
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(body);
          } catch {
            this.json(res, 400, { error: 'bad json' });
            return;
          }
          try {
            if (route === 'result') {
              this.events.onResult(parsed as BuildReport);
              this.json(res, 200, { ok: true });
            } else if (route === 'designs') {
              const report = (parsed ?? {}) as Partial<DesignsReport>;
              const selection = Array.isArray(report.selection) ? report.selection.filter((n): n is string => typeof n === 'string') : [];
              this.events.onDesigns({ page: String(report.page ?? ''), designs: Array.isArray(report.designs) ? report.designs : [], selection });
              this.json(res, 200, { ok: true, open: this.events.openName() } satisfies DesignsAnswer);
            } else if (route === 'pull') {
              const request = (parsed ?? {}) as Partial<PullRequest>;
              this.json(res, 200, this.events.onPullRequest({ request: String(request.request ?? '') }));
            } else {
              const request = (parsed ?? {}) as Partial<UpdateRequest>;
              const keys = Array.isArray(request.keys) ? request.keys.filter((k): k is string => typeof k === 'string') : [];
              this.json(res, 200, this.events.onUpdateRequest({ request: String(request.request ?? ''), keys }));
            }
          } catch {
            this.json(res, 500, { error: 'server' });
          }
        });
      } else {
        this.json(res, 404, { error: 'unknown' });
      }
    } catch {
      try {
        this.json(res, 500, { error: 'server' });
      } catch {
        // The connection is already gone.
      }
    }
  }

  private poll(after: number, req: Http.IncomingMessage, res: Http.ServerResponse): void {
    const latest = this.latest();
    // A client that knows a higher number than ours is talking about a previous run of the panel.
    if (!isFinite(after) || after > this.seq) {
      this.json(res, 200, { type: 'none', seq: this.seq } satisfies PollResponse);
      return;
    }
    if (latest && latest.seq > after) {
      this.json(res, 200, this.describe(latest));
      return;
    }
    if (this.lastNotice && this.lastNotice.seq > after) {
      this.json(res, 200, this.lastNotice);
      return;
    }
    if (this.lastWant && this.lastWant.answer.seq > after && Date.now() - this.lastWant.at < WANT_FOR_MS) {
      this.json(res, 200, this.lastWant.answer);
      return;
    }
    const waiter: Waiter = {
      res,
      timer: setTimeout(() => {
        this.waiters.delete(waiter);
        this.lastSeen = Date.now();
        this.json(res, 200, { type: 'none', seq: this.seq } satisfies PollResponse);
      }, POLL_HOLD_MS),
    };
    this.waiters.add(waiter);
    req.on('close', () => {
      if (this.waiters.delete(waiter)) {
        clearTimeout(waiter.timer);
        this.lastSeen = Date.now();
      }
    });
  }

  /** Pictures whose frames never came are not kept for ever. */
  private forgetUploads(): void {
    const now = Date.now();
    for (const [id, upload] of this.uploads) {
      if (now - upload.at > UPLOAD_FOR_MS) this.uploads.delete(id);
    }
    while (this.uploads.size > 4) this.uploads.delete(this.uploads.keys().next().value as string);
  }

  private readBody(req: Http.IncomingMessage, done: (body: string | null) => void, limit: number = MAX_BODY): void {
    this.readBytes(req, limit, (bytes) => done(bytes === null ? null : new TextDecoder().decode(bytes)));
  }

  /** The request's body; null when it is larger than `limit`. */
  private readBytes(req: Http.IncomingMessage, limit: number, done: (bytes: Uint8Array | null) => void): void {
    const chunks: Uint8Array[] = [];
    let total = 0;
    let finished = false;
    req.on('data', (chunk: Uint8Array) => {
      if (finished) return;
      total += chunk.byteLength;
      if (total > limit) {
        finished = true;
        done(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (finished) return;
      finished = true;
      const all = new Uint8Array(total);
      let at = 0;
      for (const c of chunks) {
        all.set(c, at);
        at += c.byteLength;
      }
      done(all);
    });
  }
}

/** What kind of picture a file is, by how it starts. */
export function mimeOf(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57 && bytes[9] === 0x45) return 'image/webp';
  return 'image/png';
}
