# How Motion Bridge works

Notes for contributors: the data flow, where to start reading, how the tests
work, and what the code assumes about Figma and After Effects that hasn't been
confirmed in the real apps yet. For installing and using Motion Bridge, see the
[README](../README.md).

## The two halves

| | Where | What it does |
|---|---|---|
| **After Effects panel** | `ae-panel/` (CEP extension) | Reads compositions and serves them on a local bridge; builds compositions from the frames Figma sends. |
| **Figma plugin** | `figma-plugin/` | Picks a transfer up and rebuilds it with Motion keyframes; reads the selected frames for After Effects. |

Transfers never go through the Figma REST API or the internet. The Figma plugin
uses Figma's Plugin API for Motion, which is in beta.

## After Effects → Figma

```
After Effects                                         Figma
host.jsx ──▶ panel (convert) ──▶ local bridge ◀── plugin UI ──▶ plugin (build)
 raw read     shared/ae-convert    localhost:38473    fetch        figma-plugin/src/build
```

- `ae-panel/host/host.jsx`: ExtendScript (ES3). Reads After Effects. While
  reading, the only thing it ever changes is a template option or a nested
  composition's control, for the length of one read (`setTemp` /
  `closeChanges`). Its last part builds compositions from a plan
  (`buildFromFile`).
- `shared/ae-convert.ts`: turns After Effects' speed/influence handles into
  cubic beziers, its shape groups into elements, and the different readings of
  a template into sets of versions.
- `shared/anim.ts`: keyframe maths, including `fitSamples`, which turns sampled
  motion back into eased keys.
- `shared/format.ts`: the transfer format both directions speak. **Start here.**
- `ae-panel/src/bridge-server.ts`: the local server. Loopback only, refuses
  ordinary web pages, and wants the pairing code.
- `figma-plugin/src/build/builder.ts`: rebuilds the document. The comment at
  the top explains pivot frames, rigs, ghost frames, components and masks.
  `arrange` at the end decides where everything goes on the page.
- `figma-plugin/src/build/prepare.ts`: carries keys from a composition's own
  time onto the timeline (start offsets, time remapping).
- `figma-plugin/src/build/motion.ts`: every write to Figma's Motion API.
- `figma-plugin/src/build/sync.ts`: updating designs that are already built:
  the link a frame keeps, what is carried over from Figma, which components
  stay and which go. The comment at the top is the place to start.

Several compositions travel as one transfer: a bundle of documents (one per
composition) that share their images. The Figma plugin builds them one after
the other and lays them out together.

Components are told apart by what they show, not by their names or ids. The
builder puts a composition's layers, timing, nested compositions and images
into a short signature (`Signer` in the builder), and whatever has the same
signature and the same place on the timeline is the same component. Still
components carry their signature as plugin data, which is how a later transfer
finds them again on the page.

A component is built for the place it's used at: its keyframes already carry
the start time and time remapping of the layer that shows it, so an instance
needs no offset on the timeline. Each one is built as a top-level frame first
and then turned into a component, the way it's done by hand in Figma.

Expression-driven motion isn't left as one key per frame. Stretches where
nothing moves become holds, and each move is described by one cubic-bezier ease
where one fits. For anything an eased keyframe or an easing expression produced,
that is exact, so a rig's `0.78, 0, 0, 1` ease arrives as that curve.

### Updates

An update travels the same way as a transfer, with two additions. The plugin
tells the panel which linked designs its page holds (`POST /designs`), which is
what the panel lists. Either side can start: the panel by reading and
publishing a transfer marked as an update, the plugin by asking the panel to
do that (`POST /update`). Each document of an update names the designs it was
read for. Whether a design has changed is decided in Figma, by comparing the
signature of what would be built with the one stored on the frame. After
Effects has no cheap way to tell, so it always reads.

## Figma → After Effects

```
Figma                                                After Effects
reader ──▶ plugin UI ──▶ local bridge ──▶ panel (plan) ──▶ host.jsx (build)
 frames     POST /push    localhost:38473   shared/ae-build   buildFromFile
```

- `figma-plugin/src/read/reader.ts`: reads frames into the same transfer
  format. The comment at the top says how nesting becomes parenting, when a
  frame has to become a nested composition, and what arrives as a picture.
- `shared/ae-build.ts`: `ae-convert.ts` the other way round. It turns a document
  into a build plan in After Effects' own units (cubic beziers back into speed
  and influence per key side). The plan is what `host.jsx` carries out, step by
  step.
- The bridge stays a server inside the panel, so Figma always calls and After
  Effects answers. The plugin posts pictures, then frames (`/push`), and asks
  for the open composition (`/pull`). When After Effects wants the selection
  (*Pull from Figma*), it says so in the answer to the plugin's poll (`want`).
  What was built comes back the same way (`pushed`).

## The settings window

The settings window of a panel made small is a second extension in
`CSXS/manifest.xml` (`com.motionbridge.settings`, type *Modeless*, no menu
entry) that loads the same `index.html`. `main.ts` tells which of the two it is
by its extension id. The window has no script, no server and no Node.js of its
own. The panel sends it what it knows as CEP events (the long lists separately
from the rest, and each only when it has changed), and the window sends back
what was chosen or pressed, which the panel then does.

## Tests

The tests can't run After Effects or Figma, so they use stand-ins
(`tests/mock-ae.ts`, `tests/sim.ts`). The Figma stand-in *plays the written
keyframes back* following Figma's Motion reference and compares every layer's
corners and opacity with the After Effects transform maths. That is what keeps
pivots, parenting, timing and sign conventions honest.

- `tests/template.test.ts`: templates, meaning options, components, mattes,
  time remapping, and that After Effects is left as it was.
- `tests/layout.test.ts`: holes in compound shapes, where things are put on the
  page, and transfers of several compositions.
- `tests/sync.test.ts`: updates. The frame staying in place, what is kept from
  Figma, components kept, rebuilt and removed, and that a failed update leaves
  the design as it was.
- `tests/ae-build.test.ts`: plans a document, lets the real `host.jsx` build it
  in a stand-in project and reads the result back with the same script. It has
  to be the document it started from, corner for corner at every sampled time.
- `tests/reader.test.ts`: builds a document into the stand-in Figma the way a
  transfer does and reads the frame back with the reader, which has to give the
  same motion. Then it checks how designs made in Figma become compositions
  (parenting, nested compositions, mattes, strokes, pictures, text).
- `tests/bridge.test.ts`: the bridge's requests over real HTTP.

`npm run check` also scans `host.jsx` for syntax that ExtendScript (ES3) can't
run (`scripts/check-host.mjs`).

## Assumptions to confirm in the real apps

These come from Figma's documentation, not from watching Figma do it:

1. Motion combines translate, then rotate, then scale, around the node's centre.
2. A width/height track grows a node from its top-left corner.
3. A track with a single keyframe is accepted as a constant (if not, the
   plugin retries with two).
4. Keyframes stay on a node when it is moved to another parent inside the same
   top-level frame.

With components (Figma documents animated components and instances, but not
these details):

5. Keyframes written inside a top-level frame survive turning that frame into a
   component, and joining components into a component set.
6. An instance plays its component's keyframes from the start of the host
   frame's timeline.
7. Switching a variant on an instance switches to that variant's animation.
8. A frame marked as a mask, with keyframes inside it, masks its siblings over
   time.
9. A vector whose path data holds several outlines treats them as one compound
   shape, so the winding rule cuts the holes. This is how Figma's own vectors
   work; it was only checked by drawing the same path data in a browser.
10. An instance of a still component can be scaled (the scale tool's kind of
    scaling) without changing what it shows.

With updates:

11. Layers built into a frame that already holds animated layers take keyframes
    like the first ones did, and removing the old layers afterwards takes their
    keyframes with them.
12. Plugin data on a frame is copied when the frame is duplicated. That is how
    a copy stays a linked design.
13. `setProperties` switches a variant on an instance, also on one inside
    another instance, and editing `characters` there becomes an override.
14. `getInstancesAsync` lists a component's instances in the whole file, and no
    longer lists the ones in layers that were just removed.

If 11 fails, updated designs lose motion and the plugin's notes list the
refused tracks. Sending the composition again still builds a fresh frame.

Two things the plugin checks for itself on every transfer:

- Whether an animated frame is still animated after it has moved into a
  section. It tries that with a throw-away frame first, and leaves the
  components on the page (laid out the same way) if Figma loses the animation.
- Where each component really ended up. It is moved to its place on the page
  first, handed to the section, and then measured on the page again and
  corrected. If Figma keeps a component out of the section, it still lies in
  the right place on top of it, and the notes say so.

With the way back. Checked against After Effects: a composition built from a
plan (shapes, text, a nested composition with a rounded matte, a picture,
shadow, trim, blend modes, keys with every kind of ease) was read back by the
same script and gave the same motion. Not yet seen in the real Figma; these
come from its plugin typings and documentation:

15. `node.animations` lists a node's tracks as the typings say: per property a
    list of tracks, each with `keyframeOperation` (`SET`, `OFFSET`, `SCALE`)
    and keyframes; `fills` / `strokes` by paint index. The reader takes a
    translation or rotation track as an offset from the node at rest and a
    scale track as a factor, the way they are written.
16. A node's `absoluteTransform` and size describe it at rest, whatever the
    Motion timeline's playhead shows.
17. A translation track of a node inside a group is counted in the space around
    the group (as its `x` and `y` are).
18. `absoluteRenderBounds` of an upright text without effects is the box of its
    glyphs. That is what text is placed by in After Effects.
19. `exportAsync` of a layer gives the picture of what `absoluteRenderBounds`
    covers, with the layer's own opacity in it.

If 15 doesn't hold, frames arrive without their motion (the layers are still
right). If 18 doesn't, text sits a few pixels off vertically.

With the three buttons. The layouts and the exchange between the panel and its
settings window were run in a browser against a stand-in for After Effects, not
in After Effects itself:

20. A CEP panel may be made as small as its `MinSize` (44 × 36) when docked or
    floating.
21. `requestOpenExtension` opens a *Modeless* extension that has no `Menu`
    entry, and brings it to the front when it's open already.
22. Events dispatched with scope `APPLICATION` reach the other extension of the
    bundle, with a few kilobytes of JSON as their data (a project with hundreds
    of compositions makes the list of them tens of kilobytes).
23. `setWindowTitle` names the settings window.
24. `figma.ui.resize` takes a window of 180 × 64.

If 21 or 22 doesn't hold, the third button of a small panel opens nothing or an
empty window. Make the panel larger and it shows its settings itself.

If any of these fails, switch **Build as components** off in the Figma plugin
to get the motion into one frame. The plugin's notes list every track Figma
refused.

## References

- Figma Motion types: https://developers.figma.com/docs/plugins/api/Motion/
- `figma.motion`: https://developers.figma.com/docs/plugins/api/figma-motion/
- Field semantics (additive / absolute, pivot, easing direction):
  https://github.com/figma/mcp-server-guide/tree/main/skills/figma-use-motion/references
- Animated components and instances:
  https://help.figma.com/hc/en-us/articles/41307940738967
- Plugin network access: https://developers.figma.com/docs/plugins/manifest/
