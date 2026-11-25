/**
 * Updating designs that are already built: the frame stays the frame it was,
 * what a designer changed in Figma is carried over, and components are kept,
 * rebuilt or removed according to what After Effects has now.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BridgeDoc, Comp, Layer } from '../shared/format.ts';
import { arrange, buildDocument, imageHashes, newShared, occupied } from '../figma-plugin/src/build/builder.ts';
import { describeDesigns, findDesigns, linkDesign, updateDesigns } from '../figma-plugin/src/build/sync.ts';
import type { MockNode } from './sim.ts';
import { compOf, docOf, findNode, installMockFigma, solidLayer, transform, vec, vecKeys } from './sim.ts';

interface Shape {
  /** Width of the mark inside each logo version: changing it changes the logo set. */
  mark?: number;
  headline?: string;
  /** Where the box starts its move. */
  boxX?: number;
  /** Adds a layer the first version did not have. */
  sticker?: boolean;
  name?: string;
  size?: [number, number];
  background?: number;
}

/**
 * A small template: a centred headline, a logo with two brands (a component
 * set), an animated badge (a component), a moving box and a background.
 */
function socialDoc(shape: Shape = {}): BridgeDoc {
  const [w, h] = shape.size ?? [800, 600];
  const logos = [0, 1].map((i) => compOf(`logo${i}`, [solidLayer('1', `Mark ${i}`, shape.mark ?? 120, 80, { position: vec(10, 10) })], 3, 400, 300));
  const badge = compOf('badge', [solidLayer('1', 'Dot', 40, 40, { position: vecKeys([{ t: 0, v: { x: 0, y: 0 } }, { t: 1, v: { x: 60, y: 0 } }]) })], 3, 200, 200);
  const layers: Layer[] = [
    {
      id: '1', name: 'Headline', inPoint: 0, outPoint: 3,
      transform: transform({ position: vec(400, 100) }),
      content: { type: 'text', text: shape.headline ?? 'Deals of the week', fontFamily: 'Inter', fontStyle: 'Regular', fontSize: 40, align: 'center', tracking: 0, lineHeight: 48, firstBaseline: { x: 0, y: 0 } },
    },
    {
      id: '2', name: 'Logo', inPoint: 0, outPoint: 3,
      transform: transform({ position: vec(100, 200) }),
      content: { type: 'comp', compId: 'logo0', width: 400, height: 300, startTime: 0, setId: 'setLogo' },
    },
    {
      id: '3', name: 'Badge', inPoint: 0, outPoint: 3,
      transform: transform({ position: vec(550, 350) }),
      content: { type: 'comp', compId: 'badge', width: 200, height: 200, startTime: 0 },
    },
    solidLayer('4', 'Box', 100, 100, { position: vecKeys([{ t: 0, v: { x: shape.boxX ?? 0, y: 500 } }, { t: 2, v: { x: 300, y: 500 } }]) }),
    solidLayer('5', 'BG', w, h, {}),
  ];
  if (shape.sticker) layers.unshift(solidLayer('6', 'Sticker', 50, 50, { position: vec(700, 20) }));
  const main: Comp = { ...compOf('100', layers, 3, w, h), name: shape.name ?? 'Social 4x5' };
  if (shape.background !== undefined) main.background = { r: shape.background, g: 0, b: 0, a: 1 };
  const doc = docOf([main, ...logos, badge]);
  doc.sets = {
    setLogo: { id: 'setLogo', name: 'Logo', props: [{ name: 'Brand', values: ['Brand 0', 'Brand 1'] }], variants: logos.map((l, i) => ({ compId: l.id, choice: [i] })) },
  };
  doc.source.project = 'Template.aep';
  doc.link = { compId: '100', options: ['GUIDE/Brand'] };
  return doc;
}

/** What the plugin does with a transfer of new frames (code.ts). */
function send(docs: BridgeDoc[], components = true): MockNode[] {
  const taken = occupied();
  const shared = newShared(components);
  const builds = docs.map((doc) => {
    const hashes = imageHashes(doc, {});
    const out = buildDocument({ doc, images: {}, hashes, fonts: new Map(), components, shared });
    linkDesign(out.frame, doc, components, hashes);
    return out;
  });
  return arrange(builds, taken).frames as unknown as MockNode[];
}

/** What the panel does for "Update designs": the same composition read again, for the designs with these keys. */
function reread(shape: Shape, keys: string[]): BridgeDoc {
  return { ...socialDoc(shape), update: keys };
}

const update = (docs: BridgeDoc[], scope?: string[]) => updateDesigns({ id: 'update', docs, images: {}, scope });
const keysOnPage = (): string[] => describeDesigns(findDesigns()).map((d) => d.key);
const names = (node: MockNode): string[] => node.children.map((c) => `${c.type} ${c.name}`);
const sections = (page: MockNode): MockNode[] => page.children.filter((c) => c.type === 'SECTION');

test('a built frame knows where it came from, and the panel hears of it once per way of building', () => {
  installMockFigma();
  const [a, b] = send([socialDoc(), socialDoc()]);
  const designs = findDesigns();
  assert.deepEqual(designs.map((d) => d.frame as unknown), [a, b]);
  assert.deepEqual(describeDesigns(designs), [
    { key: designs[0]!.key, project: 'Template.aep', compId: '100', comp: 'Social 4x5', options: ['GUIDE/Brand'], poster: 0, frames: 2 },
  ]);

  // A transfer from a panel that does not say how it read the composition cannot be read again: no link.
  const plain = socialDoc();
  delete plain.link;
  send([plain]);
  assert.equal(findDesigns().length, 2);
});

test('an update rebuilds a design in place: same frame, same spot, new layers', async () => {
  const mock = installMockFigma();
  const [frame] = send([socialDoc()]);
  // Where a designer put it.
  frame!.x = 4000;
  frame!.y = 300;
  const before = [...frame!.children];
  assert.deepEqual(names(frame!), ['RECTANGLE BG', 'RECTANGLE Box', 'INSTANCE Badge', 'INSTANCE Logo', 'TEXT Headline']);
  const loose = mock.currentPage.children.length;

  const { report, frames } = await update([reread({ boxX: 150, sticker: true }, keysOnPage())]);
  assert.equal(report.ok, true, report.error);
  assert.deepEqual([report.kind, report.updated, report.unchanged], ['update', 1, 0]);
  assert.deepEqual(frames as unknown, [frame], 'it is still the same frame');
  assert.deepEqual([frame!.x, frame!.y], [4000, 300]);
  assert.deepEqual(names(frame!), ['RECTANGLE BG', 'RECTANGLE Box', 'INSTANCE Badge', 'INSTANCE Logo', 'TEXT Headline', 'RECTANGLE Sticker']);
  assert.ok(before.every((n) => n.removed), 'nothing of the old layers is left');
  assert.equal(mock.currentPage.children.length, loose, 'and nothing new lies around on the page');

  // The new layers carry the new motion, on the frame's own timeline.
  const box = findNode(frame!, 'Box', 'RECTANGLE')!;
  assert.equal(box.x, 150);
  assert.ok(box.tracks.size > 0);
  // Nothing in the components changed, so they were not built again.
  assert.equal(report.components, 0);
  assert.equal(report.retired, 0);
  assert.equal(sections(mock.currentPage).length, 1);

  // The same reading once more: the design is as After Effects has it, and is not touched.
  const now = [...frame!.children];
  const again = await update([reread({ boxX: 150, sticker: true }, keysOnPage())]);
  assert.deepEqual([again.report.ok, again.report.updated, again.report.unchanged], [true, 0, 1]);
  assert.deepEqual(frame!.children, now);
  assert.equal(again.report.frames![0]!.state, 'unchanged');
});

test('a variant switched and a text edited in Figma stay; changed components are replaced, unchanged ones kept', async () => {
  const mock = installMockFigma();
  const [frame] = send([socialDoc()]);
  const section = sections(mock.currentPage)[0]!;
  const oldSet = section.children.find((c) => c.type === 'COMPONENT_SET')!;
  const badge = section.children.find((c) => c.type === 'COMPONENT')!;
  const sectionAt = [section.x, section.y];

  // The designer's work: another brand, another headline.
  findNode(frame!, 'Logo', 'INSTANCE')!.setProperties({ Brand: 'Brand 1' });
  findNode(frame!, 'Headline', 'TEXT')!.characters = 'Angebote der Woche';

  // In After Effects the logos were redrawn and the headline reworded.
  const { report } = await update([reread({ mark: 200, headline: 'Deals of the month' }, keysOnPage())]);
  assert.equal(report.ok, true, report.error);
  assert.deepEqual(report.frames![0]!.warnings, []);

  const logo = findNode(frame!, 'Logo', 'INSTANCE')!;
  const newSet = logo.mainComponent!.parent!;
  assert.equal(logo.mainComponent!.name, 'Brand=Brand 1', 'the brand chosen in Figma, in the redrawn set');
  assert.notEqual(newSet, oldSet);
  assert.equal(findNode(newSet, 'Mark 1', 'RECTANGLE')!.width, 200);
  assert.equal(oldSet.removed, true, 'the set nothing shows any more is gone');
  assert.deepEqual([report.components, report.retired], [1, 1]);

  // The new set took the old one's place: same section, still where it was, nothing sticking out.
  assert.deepEqual(sections(mock.currentPage), [section]);
  assert.equal(newSet.parent, section);
  assert.deepEqual([section.x, section.y], sectionAt);
  for (const c of section.children) {
    assert.ok(c.x >= 0 && c.y >= 0 && c.x + c.width <= section.width && c.y + c.height <= section.height, `"${c.name}" lies inside the section`);
  }
  // The badge was not touched in After Effects: it is the very same component, animation and all.
  assert.equal(findNode(frame!, 'Badge', 'INSTANCE')!.mainComponent, badge);
  assert.equal(badge.removed, false);

  // The headline keeps the designer's words - and stays centred where After Effects centres it.
  const headline = findNode(frame!, 'Headline', 'TEXT')!;
  assert.equal(headline.characters, 'Angebote der Woche');
  assert.ok(Math.abs(headline.x + headline.width / 2 - 400) < 1e-6);
  assert.equal(report.kept, 2);
  assert.equal(report.lost, 0);

  // What stays a designer's change the next time too, although the frame was rebuilt in between.
  const next = await update([reread({ mark: 200, headline: 'Deals of the month', boxX: 40 }, keysOnPage())]);
  assert.equal(next.report.updated, 1);
  assert.equal(findNode(frame!, 'Logo', 'INSTANCE')!.mainComponent!.name, 'Brand=Brand 1');
  assert.equal(findNode(frame!, 'Headline', 'TEXT')!.characters, 'Angebote der Woche');
  assert.equal(findNode(frame!, 'Logo', 'INSTANCE')!.mainComponent!.parent, newSet, 'and this time the logo set had not changed');
});

test('a choice that has no place in the updated design is reported, not guessed', async () => {
  installMockFigma();
  const [frame] = send([socialDoc()]);
  findNode(frame!, 'Logo', 'INSTANCE')!.setProperties({ Brand: 'Brand 1' });

  // The template lost its second brand.
  const doc = reread({ mark: 150 }, keysOnPage());
  doc.sets!.setLogo!.props[0]!.values = ['Brand 0', 'Solo'];
  const { report } = await update([doc]);
  assert.equal(report.ok, true, report.error);
  assert.equal(findNode(frame!, 'Logo', 'INSTANCE')!.mainComponent!.name, 'Brand=Brand 0', 'what After Effects shows');
  assert.deepEqual([report.kept, report.lost], [0, 1]);
  assert.ok(report.frames![0]!.warnings.some((w) => w.includes('had no place')));
});

test('copies of a design are updated together - or only the selected ones, sharing what they can', async () => {
  const mock = installMockFigma();
  // Two frames of one transfer share their components, like a frame and its duplicate.
  const [a, b] = send([socialDoc(), socialDoc()]);
  const section = sections(mock.currentPage)[0]!;
  assert.equal(sections(mock.currentPage).length, 1);
  const oldSet = section.children.find((c) => c.type === 'COMPONENT_SET')!;
  const keys = keysOnPage();
  assert.equal(keys.length, 1, 'built the same way, they are one entry for After Effects');
  const untouched = [...b!.children];

  // Only the first is selected.
  const first = await update([reread({ mark: 200 }, keys)], [a!.id]);
  assert.deepEqual([first.report.updated, first.report.unchanged, first.report.retired], [1, 0, 0]);
  assert.deepEqual(b!.children, untouched, 'the other copy is left alone');
  assert.equal(oldSet.removed, false, 'and still has the components it shows');
  const newSet = findNode(a!, 'Logo', 'INSTANCE')!.mainComponent!.parent!;
  assert.notEqual(newSet, oldSet);
  assert.equal(newSet.parent, section);
  assert.equal(keysOnPage().length, 1, 'they still belong together');

  // Now all of them: the first is up to date, the second catches up and uses what the first got.
  const second = await update([reread({ mark: 200 }, keysOnPage())]);
  assert.deepEqual([second.report.updated, second.report.unchanged], [1, 1]);
  assert.equal(second.report.components, 0, 'nothing had to be built twice');
  assert.equal(findNode(b!, 'Logo', 'INSTANCE')!.mainComponent!.parent, newSet);
  assert.equal(oldSet.removed, true);
  assert.equal(second.report.retired, 1);
  assert.deepEqual(section.children.map((c) => c.type).sort(), ['COMPONENT', 'COMPONENT_SET']);
});

test('a component a designer uses elsewhere is not taken away', async () => {
  const mock = installMockFigma();
  const [frame] = send([socialDoc()]);
  const oldSet = sections(mock.currentPage)[0]!.children.find((c) => c.type === 'COMPONENT_SET')!;
  // An instance of the logo in a layout of the designer's own.
  const own = mock.createFrame();
  own.name = 'My layout';
  own.appendChild(oldSet.children[0]!.createInstance());

  const { report } = await update([reread({ mark: 200 }, keysOnPage())]);
  assert.equal(report.ok, true, report.error);
  assert.equal(oldSet.removed, false);
  assert.equal(report.retired, 0);
  assert.equal(own.children[0]!.mainComponent!.parent, oldSet, 'the layout shows what it showed');
  assert.notEqual(findNode(frame!, 'Logo', 'INSTANCE')!.mainComponent!.parent, oldSet, 'while the design has the new logo');
});

test('the frame follows the composition: its size, its background, and its name unless it was renamed in Figma', async () => {
  installMockFigma();
  const [frame] = send([socialDoc()]);
  const fills = frame!.fills;

  await update([reread({ name: 'Social 4x5 v2', size: [1000, 600] }, keysOnPage())]);
  assert.equal(frame!.name, 'Social 4x5 v2');
  assert.deepEqual([frame!.width, frame!.height], [1000, 600]);
  assert.equal(frame!.fills, fills, 'a background that did not change in After Effects is not set again');

  frame!.name = 'Hero';
  frame!.fills = [{ type: 'SOLID', color: { r: 0, g: 0, b: 1 } }];
  const mine = frame!.fills;
  await update([reread({ name: 'Social 4x5 v3', size: [1000, 600] }, keysOnPage())]);
  assert.equal(frame!.name, 'Hero', 'a name given in Figma stays');
  assert.equal(frame!.fills, mine, 'and so does a fill chosen there');
  assert.equal(findDesigns()[0]!.link.comp, 'Social 4x5 v3', 'the link knows the new name all the same');

  await update([reread({ name: 'Social 4x5 v3', size: [1000, 600], background: 0.5 }, keysOnPage())]);
  assert.deepEqual(frame!.fills, [{ type: 'SOLID', color: { r: 0.5, g: 0, b: 0 }, opacity: 1 }], 'a new background in After Effects arrives');
});

test('a design built without components is updated without components', async () => {
  const mock = installMockFigma();
  const [frame] = send([socialDoc()], false);
  assert.equal(sections(mock.currentPage).length, 0);
  const { report } = await update([reread({ mark: 200 }, keysOnPage())]);
  assert.equal(report.updated, 1);
  assert.equal(mock.currentPage.children.length, 1, 'still one frame and nothing else');
  assert.equal(findNode(frame!, 'Mark 0', 'RECTANGLE')!.width, 200);
  assert.equal(findNode(frame!, 'Logo', 'INSTANCE'), undefined);
});

test('an update that fails leaves the design as it was', async () => {
  const mock = installMockFigma();
  const [frame] = send([socialDoc()]);
  const before = [...frame!.children];
  const onPage = [...mock.currentPage.children];
  const hash = findDesigns()[0]!.link.hash;

  mock.createRectangle = () => {
    throw new Error('Figma said no');
  };
  const { report } = await update([reread({ boxX: 150 }, keysOnPage())]);
  assert.equal(report.ok, false);
  assert.match(report.error ?? '', /Figma said no/);
  assert.deepEqual(frame!.children, before);
  assert.ok(before.every((n) => !n.removed));
  assert.deepEqual(mock.currentPage.children, onPage, 'nothing half-built is left behind');
  assert.equal(findDesigns()[0]!.link.hash, hash, 'and it still counts as out of date');
});

test('an update for designs that are gone says so', async () => {
  installMockFigma();
  const [frame] = send([socialDoc()]);
  const keys = keysOnPage();
  frame!.remove();
  const { report } = await update([reread({ boxX: 150 }, keys)]);
  assert.equal(report.ok, false);
  assert.match(report.error ?? '', /not on this page any more/);
});
