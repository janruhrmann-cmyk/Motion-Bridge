/** Talks to the real bridge server over HTTP, the way the Figma plugin does. */
import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { BridgeServer } from '../ae-panel/src/bridge-server.ts';
import type { Pushed } from '../ae-panel/src/bridge-server.ts';
import type { BuildReport, DesignLink, DesignsAnswer, DesignsReport, HelloResponse, PollResponse, PullAnswer, PullRequest, PushAnswer, PushReport, UpdateAnswer, UpdateRequest } from '../shared/protocol.ts';
import { packDocs, unpackDocs } from '../shared/format.ts';
import { compOf, docOf, solidLayer } from './sim.ts';

const PORT = 38911;
const BASE = `http://127.0.0.1:${PORT}`;
const CODE = 'ABC234';

const events: { connected: boolean[]; delivered: string[]; results: BuildReport[]; designs: DesignsReport[]; updates: UpdateRequest[]; pulls: PullRequest[]; pushes: Pushed[] } = {
  connected: [], delivered: [], results: [], designs: [], updates: [], pulls: [], pushes: [],
};
/** The composition that is open in After Effects, as far as the panel tells the plugin. */
let openComp: string | null = 'Social 4x5';
/** What the panel answers to the plugin's "Update designs": it may be in the middle of something. */
let panelBusy = false;
const server = new BridgeServer(
  http,
  CODE,
  'After Effects (test)',
  {
    onConnection: (c) => events.connected.push(c),
    onDelivered: (id) => events.delivered.push(id),
    onResult: (r) => events.results.push(r),
    onDesigns: (d) => events.designs.push(d),
    onUpdateRequest: (u) => {
      events.updates.push(u);
      return panelBusy ? { ok: false, error: 'busy' } : { ok: true };
    },
    onPullRequest: (r) => {
      events.pulls.push(r);
      if (panelBusy) return { ok: false, error: 'busy' };
      return openComp ? { ok: true, name: openComp } : { ok: false, error: 'No composition is open.' };
    },
    onPush: (push) => {
      events.pushes.push(push);
      return panelBusy ? { ok: false, error: 'busy' } : { ok: true };
    },
    openName: () => openComp,
  },
  PORT,
);

before(() => server.start());
after(() => server.stop());

/** A request with full control over headers (fetch does not let a script set Origin). */
function raw(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${BASE}${path}`, { headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('hello needs no code and identifies the bridge', async () => {
  const res = await raw('/hello', { Origin: 'null' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  const hello = JSON.parse(res.body) as HelloResponse;
  assert.equal(hello.app, 'motion-bridge');
  assert.equal(hello.pending, false);
});

test('ordinary web pages and wrong codes are turned away', async () => {
  assert.equal((await raw('/hello', { Origin: 'https://example.com' })).status, 403);
  assert.equal((await raw(`/poll?k=${CODE}&after=0`, { Origin: 'https://example.com' })).status, 403);
  assert.equal((await raw('/poll?after=0')).status, 401);
  assert.equal((await raw('/poll?k=WRONG1&after=0')).status, 401);
  assert.equal((await raw('/transfer/anything?k=WRONG1')).status, 401);
});

test('a waiting plugin receives a transfer, its images, and reports back', async () => {
  const doc = docOf([compOf('Main', [solidLayer('1', 'Box', 10, 10, {})])]);
  doc.assets.img1 = { id: 'img1', name: 'pic.png', width: 2, height: 2 };
  const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);

  const waiting = fetch(`${BASE}/poll?k=abc-234&after=0`).then((r) => r.json() as Promise<PollResponse>);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(server.isConnected, true, 'a held poll counts as connected');

  const id = server.publish([doc], new Map([['img1', { bytes, mime: 'image/png' }]]));
  const poll = await waiting;
  assert.deepEqual(poll, { type: 'transfer', seq: 1, id, name: 'Main', count: 1 });

  const hello = (await (await fetch(`${BASE}/hello`)).json()) as HelloResponse;
  assert.equal(hello.pending, true, 'not fetched yet');

  const got = await (await fetch(`${BASE}/transfer/${id}?k=${CODE}`)).json();
  assert.deepEqual(got, doc);
  assert.deepEqual(events.delivered, [id]);

  const asset = await fetch(`${BASE}/asset/${id}/img1?k=${CODE}`);
  assert.equal(asset.headers.get('content-type'), 'image/png');
  assert.deepEqual(new Uint8Array(await asset.arrayBuffer()), bytes);
  assert.equal((await fetch(`${BASE}/asset/${id}/nope?k=${CODE}`)).status, 404);

  const report: BuildReport = { id, ok: true, frameName: 'Main', nodes: 2, tracks: 0, motionAvailable: true, warnings: [] };
  const posted = await fetch(`${BASE}/result?k=${CODE}`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(report) });
  assert.equal(posted.status, 200);
  assert.deepEqual(events.results, [report]);
});

test('a plugin that remembers an older run of the panel is put back in step', async () => {
  const started = Date.now();
  const poll = (await (await fetch(`${BASE}/poll?k=${CODE}&after=99`)).json()) as PollResponse;
  assert.deepEqual(poll, { type: 'none', seq: 1 });
  assert.ok(Date.now() - started < 2000, 'answered at once instead of holding the request');
  // A transfer it has not seen yet is delivered straight away.
  const next = (await (await fetch(`${BASE}/poll?k=${CODE}&after=0`)).json()) as PollResponse;
  assert.equal(next.type, 'transfer');
});

test('a new pairing code locks the old one out', async () => {
  server.setCode('ZZZ999');
  assert.equal((await fetch(`${BASE}/poll?k=${CODE}&after=1`)).status, 401);
  const ok = await fetch(`${BASE}/transfer/none?k=zzz-999`);
  assert.equal(ok.status, 404, 'the new code is accepted (and the transfer simply does not exist)');
});

test('several compositions travel as one transfer', async () => {
  const a = docOf([compOf('Wide', [solidLayer('1', 'Box', 10, 10, {})])]);
  const b = docOf([compOf('Tall', [solidLayer('1', 'Box', 10, 10, {})])]);
  const id = server.publish([a, b], new Map());
  const poll = (await (await fetch(`${BASE}/poll?k=zzz999&after=1`)).json()) as PollResponse;
  assert.deepEqual(poll, { type: 'transfer', seq: 2, id, name: '2 compositions', count: 2 });
  const got = await (await fetch(`${BASE}/transfer/${id}?k=zzz999`)).json();
  assert.deepEqual(unpackDocs(got), [a, b]);
});

// ------------------------------------------------------- updating designs

const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${BASE}${path}?k=zzz999`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) });

test('the plugin tells the panel which designs its page holds, and may ask for an update', async () => {
  const hello = (await (await fetch(`${BASE}/hello`)).json()) as HelloResponse;
  assert.equal(hello.sync, true, 'the plugin can tell that this panel updates designs');

  const design: DesignLink = { key: 'k1', project: 'Template.aep', compId: '12', comp: 'Social 4x5', options: ['GUIDE/Market'], poster: 2.4, frames: 2 };
  assert.equal((await post('/designs', { page: 'Page 1', designs: [design] })).status, 200);
  assert.deepEqual(events.designs, [{ page: 'Page 1', designs: [design], selection: [] }]);
  assert.equal((await fetch(`${BASE}/designs?k=WRONG1`, { method: 'POST', body: '{}' })).status, 401, 'not without the pairing code');

  const answer = (await (await post('/update', { request: 'r1', keys: ['k1', 7] })).json()) as UpdateAnswer;
  assert.deepEqual(answer, { ok: true });
  assert.deepEqual(events.updates, [{ request: 'r1', keys: ['k1'] }], 'only what can be a key is passed on');

  panelBusy = true;
  assert.deepEqual(await (await post('/update', { request: 'r2', keys: ['k1'] })).json(), { ok: false, error: 'busy' }, 'the panel says why it cannot start');
  panelBusy = false;
});

test('an update travels as a transfer that says so, with the request it answers', async () => {
  const doc = docOf([compOf('Social 4x5', [solidLayer('1', 'Box', 10, 10, {})])]);
  doc.update = ['k1'];
  const hello = (await (await fetch(`${BASE}/hello`)).json()) as HelloResponse;

  const waiting = fetch(`${BASE}/poll?k=zzz999&after=${hello.seq}`).then((r) => r.json() as Promise<PollResponse>);
  await new Promise((resolve) => setTimeout(resolve, 100));
  // While After Effects reads, a waiting plugin hears how far it is - without the sequence moving.
  server.progress('Reading “Social 4x5” · version 3 of 21…', 0.25);
  assert.deepEqual(await waiting, { type: 'progress', seq: hello.seq, text: 'Reading “Social 4x5” · version 3 of 21…', fraction: 0.25 });

  const again = fetch(`${BASE}/poll?k=zzz999&after=${hello.seq}`).then((r) => r.json() as Promise<PollResponse>);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const id = server.publish([doc], new Map(), { kind: 'update', request: 'r1' });
  assert.deepEqual(await again, { type: 'transfer', seq: hello.seq + 1, id, name: 'Social 4x5', count: 1, kind: 'update', request: 'r1' });
  const got = unpackDocs(await (await fetch(`${BASE}/transfer/${id}?k=zzz999`)).json());
  assert.deepEqual(got?.[0]?.update, ['k1'], 'the document names the designs it was read for');
});

test('an update that ends without a transfer is told to the plugin that asked', async () => {
  const hello = (await (await fetch(`${BASE}/hello`)).json()) as HelloResponse;
  const waiting = fetch(`${BASE}/poll?k=zzz999&after=${hello.seq}`).then((r) => r.json() as Promise<PollResponse>);
  await new Promise((resolve) => setTimeout(resolve, 100));
  server.notice('The update was cancelled in After Effects.', 'info', 'r3');
  const notice: PollResponse = { type: 'notice', seq: hello.seq + 1, message: 'The update was cancelled in After Effects.', level: 'info', request: 'r3' };
  assert.deepEqual(await waiting, notice);
  // A plugin that was not listening at that moment still hears it on its next poll, once.
  assert.deepEqual(await (await fetch(`${BASE}/poll?k=zzz999&after=${hello.seq}`)).json(), notice);
  const after = (await (await fetch(`${BASE}/hello`)).json()) as HelloResponse;
  assert.equal(after.pending, false, 'a notice is not a transfer waiting to be fetched');
});

// ------------------------------------------- frames from Figma, and pulling

test('the plugin can tell that this panel takes frames, and hears what a pull would bring', async () => {
  const hello = (await (await fetch(`${BASE}/hello`)).json()) as HelloResponse;
  assert.equal(hello.push, true);
  // Reporting its page, the plugin also says what is selected - and learns which composition is open.
  const answer = (await (await post('/designs', { page: 'Page 1', designs: [], selection: ['Hero', 'Card', 7] })).json()) as DesignsAnswer;
  assert.deepEqual(answer, { ok: true, open: 'Social 4x5' });
  assert.deepEqual(events.designs[events.designs.length - 1], { page: 'Page 1', designs: [], selection: ['Hero', 'Card'] });
  openComp = null;
  assert.deepEqual(await (await post('/designs', { page: 'Page 1', designs: [] })).json(), { ok: true, open: null });
  openComp = 'Social 4x5';
});

test('pulling asks the panel for the open composition, which arrives as a transfer with the request', async () => {
  const answer = (await (await post('/pull', { request: 'p1' })).json()) as PullAnswer;
  assert.deepEqual(answer, { ok: true, name: 'Social 4x5' });
  assert.deepEqual(events.pulls, [{ request: 'p1' }]);
  assert.equal((await fetch(`${BASE}/pull?k=WRONG1`, { method: 'POST', body: '{}' })).status, 401);

  const hello = (await (await fetch(`${BASE}/hello`)).json()) as HelloResponse;
  const id = server.publish([docOf([compOf('Social 4x5', [solidLayer('1', 'Box', 10, 10, {})])])], new Map(), { request: 'p1' });
  const poll = (await (await fetch(`${BASE}/poll?k=zzz999&after=${hello.seq}`)).json()) as PollResponse;
  assert.deepEqual(poll, { type: 'transfer', seq: hello.seq + 1, id, name: 'Social 4x5', count: 1, request: 'p1' });

  openComp = null;
  assert.deepEqual(await (await post('/pull', { request: 'p2' })).json(), { ok: false, error: 'No composition is open.' });
  openComp = 'Social 4x5';
});

test('frames pushed from Figma reach the panel with their pictures, and the plugin hears what was built', async () => {
  const frames = [docOf([compOf('Hero', [solidLayer('1', 'Box', 10, 10, {})])]), docOf([compOf('Card', [solidLayer('1', 'Box', 10, 10, {})])])];
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9]);
  const upload = (asset: string, bytes: Uint8Array): Promise<Response> =>
    fetch(`${BASE}/push/f1/asset/${asset}?k=zzz999`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: bytes });
  assert.deepEqual(await (await upload('photo', jpeg)).json(), { ok: true });
  assert.deepEqual(await (await upload('logo', png)).json(), { ok: true });
  assert.equal((await fetch(`${BASE}/push/f1/asset/x?k=WRONG1`, { method: 'POST', body: png })).status, 401);

  const answer = (await (await post('/push/f1', { docs: packDocs(frames) })).json()) as PushAnswer;
  assert.deepEqual(answer, { ok: true });
  const push = events.pushes[events.pushes.length - 1]!;
  assert.equal(push.id, 'f1');
  assert.equal(push.request, undefined);
  assert.deepEqual(push.docs, frames);
  assert.deepEqual([...push.assets.keys()], ['photo', 'logo']);
  assert.deepEqual(push.assets.get('photo'), { bytes: jpeg, mime: 'image/jpeg' });
  assert.equal(push.assets.get('logo')!.mime, 'image/png');

  // Something that is not a transfer is turned away without bothering the panel.
  const before = events.pushes.length;
  assert.deepEqual(await (await post('/push/f2', { docs: { hello: 'world' } })).json(), { ok: false, error: 'These are not frames from Motion Bridge.' });
  assert.equal(events.pushes.length, before);
  panelBusy = true;
  assert.deepEqual(await (await post('/push/f3', { docs: frames[0] })).json(), { ok: false, error: 'busy' });
  panelBusy = false;

  // When After Effects has built them, the plugin that is listening hears how it went.
  const hello = (await (await fetch(`${BASE}/hello`)).json()) as HelloResponse;
  const waiting = fetch(`${BASE}/poll?k=zzz999&after=${hello.seq}`).then((r) => r.json() as Promise<PollResponse>);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const report: PushReport = { id: 'f1', ok: true, comps: [{ name: 'Hero', ok: true, layers: 3, precomps: 0, keyframes: 0, warnings: [] }], layers: 3, precomps: 0, keyframes: 0, images: 2, warnings: [] };
  server.pushed(report);
  assert.deepEqual(await waiting, { type: 'pushed', seq: hello.seq + 1, report });
  // And one that was busy sending still hears it on its next poll.
  assert.deepEqual(await (await fetch(`${BASE}/poll?k=zzz999&after=${hello.seq}`)).json(), { type: 'pushed', seq: hello.seq + 1, report });
});

test('After Effects can ask Figma for its selection, and Figma answers with a push or says there is nothing', async () => {
  const hello = (await (await fetch(`${BASE}/hello`)).json()) as HelloResponse;
  const waiting = fetch(`${BASE}/poll?k=zzz999&after=${hello.seq}`).then((r) => r.json() as Promise<PollResponse>);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(server.want('w1'), true, 'a plugin is listening');
  assert.deepEqual(await waiting, { type: 'want', seq: hello.seq + 1, request: 'w1' });

  const frame = docOf([compOf('Hero', [solidLayer('1', 'Box', 10, 10, {})])]);
  assert.deepEqual(await (await post('/push/f9', { request: 'w1', docs: frame })).json(), { ok: true });
  assert.equal(events.pushes[events.pushes.length - 1]!.request, 'w1');

  // Nothing selected in Figma: the panel is told why nothing comes.
  assert.deepEqual(await (await post('/push/f10', { request: 'w2', error: 'Nothing is selected in Figma.' })).json(), { ok: true });
  const empty = events.pushes[events.pushes.length - 1]!;
  assert.deepEqual([empty.request, empty.docs.length, empty.error], ['w2', 0, 'Nothing is selected in Figma.']);
});
