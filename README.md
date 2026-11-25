<p align="center">
  <img src="brand/icon-512.png" width="96" height="96" alt="Motion Bridge logo">
</p>

<h1 align="center">Motion Bridge</h1>

<p align="center">
  <b>Move animations between After Effects and Figma Motion, keyframes included.</b><br>
  A free, open-source After Effects panel and Figma plugin that work as a pair.
</p>

<p align="center">
  <a href="https://github.com/janruhrmann-cmyk/motion-bridge/releases/latest/download/Motion-Bridge.zxp"><b>Download the After Effects panel (.zxp)</b></a>
  ·
  <a href="https://www.figma.com/community/plugin/1707505113413005385">Get the Figma plugin</a>
  ·
  <a href="#install">Install guide</a>
</p>

---

Motion Bridge sends an After Effects composition to Figma **with its motion**:
layers become Figma layers, and keyframes become editable Figma Motion
keyframes with their easing. It works the other way too: frames you select in
Figma become After Effects compositions with their layers, text, pictures and
keyframes.

- **After Effects → Figma.** Send the active composition, or several at once.
  Position, scale, rotation, opacity, shape properties, track mattes, precomps,
  time remapping and even expression-driven motion arrive as real keyframes.
- **Templates become components.** Menus and checkboxes a motion designer built
  into a template (market, language, logo, …) become variant properties that
  designers switch in Figma, without going back to After Effects.
- **Keep designs up to date.** Changed the composition? *Update designs*
  rebuilds the frames in Figma where they are, and keeps the variants and text
  that designers changed in Figma.
- **Figma → After Effects.** Push selected frames into the open project as
  compositions with shape layers, editable text, pictures and keyframes.
- **Local and private.** The two halves talk over `localhost` on your own
  computer. There's no account, no cloud and no tracking.

> **Note:** Figma's Plugin API for Motion is in beta. Motion Bridge needs
> Figma Motion to be available in your Figma account.

## Contents

- [Install](#install)
- [Connect the two halves](#connect-the-two-halves)
- [Use it](#use-it)
- [What comes across](#what-comes-across)
- [Privacy](#privacy)
- [Troubleshooting](#troubleshooting)
- [Build from source](#build-from-source)
- [Releasing](#releasing)
- [License](#license)

## Install

You need both halves: the **panel** in After Effects and the **plugin** in Figma.

**Requirements**

- After Effects 2021 (18.0) or later, on Windows or macOS
- The Figma desktop app, on the same computer, for the live connection. Figma
  in a browser works with files instead (see *Save file…* below).

### 1. Figma plugin

Open the plugin's page in the [Figma Community](https://www.figma.com/community/plugin/1707505113413005385)
and click **Open in…** or **Save**. In a design file, run it from the
**Actions** menu (or *Plugins*) › **Motion Bridge**.

### 2. After Effects panel

1. Download **[Motion-Bridge.zxp](https://github.com/janruhrmann-cmyk/motion-bridge/releases/latest/download/Motion-Bridge.zxp)**
   from the [latest release](https://github.com/janruhrmann-cmyk/motion-bridge/releases/latest).
2. Install it with one of these:
   - **A ZXP installer app** (easiest): the free
     [ZXP Installer by aescripts](https://aescripts.com/learn/zxp-installer/) or
     [Anastasiy's Extension Manager](https://install.anastasiy.com/). Open the app
     and drop `Motion-Bridge.zxp` onto it.
   - **Adobe's own installer**, which comes with Creative Cloud. In PowerShell on Windows:

     ```powershell
     & "C:\Program Files\Common Files\Adobe\Adobe Desktop Common\RemoteComponents\UPI\UnifiedPluginInstallerAgent\UnifiedPluginInstallerAgent.exe" --install "$HOME\Downloads\Motion-Bridge.zxp"
     ```

     In Terminal on macOS:

     ```sh
     "/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent" --install ~/Downloads/Motion-Bridge.zxp
     ```
3. Restart After Effects and open **Window › Extensions › Motion Bridge**.

To update, install the newer `.zxp` the same way. To remove the panel, use the
installer app's *Remove* button. With Adobe's installer, run it with
`--list all` to find the extension's name, then with `--remove "<that name>"`.

## Connect the two halves

1. Open the panel in After Effects and the plugin in Figma.
2. The panel shows a **pairing code** such as `K7M-2QX`. Type it into the Figma
   plugin once. From then on they find each other on their own.

The panel's chip turns to *Figma connected*. Click it to see the code again or
make a new one, which means pairing again.

## Use it

Both halves are built around three buttons, so they can sit in a corner while
you work. The logo on each button shows where things end up. Hover a button to
see what it would send right now.

| | First button | Second button | Third button |
|---|---|---|---|
| **After Effects panel** | *Send to Figma* | *Pull from Figma* | Settings (in a small panel) |
| **Figma plugin** | *Push to After Effects* | *Pull from After Effects* | Settings: unfolds the window |

Make the After Effects panel smaller than about 200 × 240 px and it turns into
a strip of the three buttons that you can dock anywhere. The third button then
opens the settings in a floating window.

### After Effects → Figma

1. In the panel, choose what to send:
   - **Active comp**: the composition whose timeline is in front.
   - **Several comps**: tick any number of the project's compositions. Use the
     filter to narrow the list ("4x5", "6s", …). *Precomps* also lists
     compositions used inside others.
2. Under **Template options**, tick what designers should be able to switch in
   Figma (see [Templates](#templates)). Tick nothing to send the compositions as
   they are set up.
3. Press **Send to Figma**, or **Pull from After Effects** in the Figma plugin.
   Both do the same.

The frames are placed below what's already on the page and selected. Each
frame's components go into a **section** named after it, to the right of the
frames. The frame's still look is taken from where the playhead is parked, so
park it on the pose you want designers to see.

### Keeping designs up to date

Changed something in After Effects? Press **Update designs in Figma** in the
panel, or **Update designs** in the plugin. After Effects reads the
compositions again, and the frames built from them are rebuilt **in place**:

- The frame keeps its position, name, links and comments.
- **Changes made in Figma are kept** where they have a clear meaning: a
  **switched variant** (another market, another image) and **edited text**.
  Anything else inside the frame is replaced by what After Effects has now.
- A design that would come out the same isn't touched. Figma's undo takes an
  update back.
- Copies of a frame (for example one per market) are updated together. Select
  designs in Figma first to update only those.

### Figma → After Effects

Select frames in Figma and press **Push to After Effects** in the plugin, or
press **Pull from Figma** in the panel. Each frame becomes a composition in the
open project. Nested compositions and pictures go into a folder named after
it, and picture files are saved to *Motion Bridge Footage* next to the project
file. Each composition is one undo step.

Timing: Figma has no frame rate, so new compositions take the frame rate and
length from the composition that is open in After Effects. With none open, they
use what most of the project's compositions use.

### No live connection?

On another computer, or in Figma in a browser, press **Save file…** in the
panel. It writes a `.motionbridge` file with the pictures inside. Drop the file
onto the Figma plugin window, or use **Import file…** there.

### Templates

The panel lists a composition's **template options**: menus and checkboxes on a
layer's effects that other layers read through expressions, such as a *Market*
menu on a guide layer. For every option you tick, the composition is read once
per setting, and in Figma:

- The layers that react to the options become **one component set** with a
  variant property per option.
- A nested composition shown with different **Essential Properties** becomes a
  component set of its own.
- Settings are named after what they show: a menu that says `4` is named after
  the layer it switches on.
- **Image controllers** (a precomp with one picture per frame, picked by an
  expression) arrive with all their pictures as variants.

To read the other settings, the panel switches each option in After Effects for
a moment. Every value is put back afterwards and the change is removed from the
undo history, so your project is left exactly as it was. Each setting takes a
few seconds, and the panel tells you how long the whole read will take.

In the Figma plugin, **Build as components** can be switched off to build
everything into a single frame with the current settings.

## What comes across

### After Effects → Figma

| After Effects | Figma |
|---|---|
| Position, scale, rotation, opacity keyframes (also separate X/Y) | Motion tracks |
| Easy ease, custom speed & influence, linear, hold | Cubic-bezier, linear, hold |
| Anchor point (also animated), parenting, nulls | Pivot frames, nested frames |
| In and out points | Steps in the opacity track |
| Precomps: start offset, **time remapping**, freeze frames | Components or clipped frames, timing in the keyframes |
| **Track mattes** (alpha, luma) | A frame with the matte as its mask |
| **Template options, Essential Properties, image controllers** | Component sets with variant properties |
| Shape layers: rectangles, ellipses, stars, paths, fills, strokes, trim paths, round corners | Rectangles, ellipses, vectors with matching tracks |
| Compound shapes (letters and logos with holes), Merge Paths | One vector, holes stay holes |
| Animated size, roundness, fill and stroke color, stroke width | Matching tracks |
| Text layers: font, size, color, tracking, leading, alignment, box text | Editable text on the same baseline |
| Solids, stills (PNG, JPG, PSD, AI, …) | Rectangles, image fills |
| **Expressions**, curved motion paths, roving keys | Sampled, then fitted back into a few eased keys |
| Drop Shadow, blending modes | Drop shadow, blend modes |

Not transferred, and listed in the panel's notes: other effects (Gradient Ramp,
blurs, …), layer masks, inverted track mattes, text animators, other path
morphing, gradients, time stretch, 3D beyond a flat layer, cameras and lights,
repeaters and other shape modifiers. Video arrives as a still of the current
frame.

### Figma → After Effects

| Figma | After Effects |
|---|---|
| A top-level frame | A composition of its size, its fill as a background layer |
| Rectangles, ellipses, vectors, lines, stars, polygons, boolean groups | Shape layers with paths, fill, stroke, roundness |
| Text | Editable text layers placed on Figma's glyphs |
| Frames and groups | Parenting, nulls, or nested compositions where clipping or blending needs one |
| Masks | Track mattes |
| Image fills | Footage layers, cropped the way Figma shows them |
| Drop shadow, blend mode, opacity | Drop Shadow effect, blending mode, opacity |
| Motion keyframes, including springs and Figma's named eases | Keyframes with the same easing |
| Gradients, blurs, inner shadows | A picture of the layer (the notes say which) |

## Privacy

Motion Bridge doesn't use the internet.

- The panel runs a small server on `localhost:38473`. It only answers your own
  computer, refuses ordinary web pages and needs the pairing code.
- The Figma plugin may only reach `http://localhost:38473`, which its
  manifest declares.
- There's no account, no license check, no analytics and no telemetry.

## Troubleshooting

| Problem | What to do |
|---|---|
| *Motion Bridge* isn't under **Window › Extensions** | Restart After Effects after installing. Check that you have After Effects 2021 or later. |
| The plugin keeps saying *Looking for After Effects…* | Open the panel in After Effects. The live connection needs the Figma **desktop app** on the same computer; otherwise use *Save file…*. |
| *Port 38473 is already in use* | The panel is open in another After Effects. Close that one. *Save file…* still works. |
| Frames arrive without motion | Check that Figma Motion is available in your account. Switching **Build as components** off can help; the plugin's notes list every track Figma refused. |
| A font was substituted | Install the font on the computer that builds the result. The notes say which fonts were missing. |

Found a bug? [Open an issue](https://github.com/janruhrmann-cmyk/motion-bridge/issues)
and include the notes the panel or plugin showed.

## Build from source

You need [Node.js](https://nodejs.org/) 24 or later.

```sh
npm install
npm run build
```

This builds both halves into `dist/`:

| Folder | What it is |
|---|---|
| `dist/ae-panel` | The After Effects (CEP) extension |
| `dist/figma-plugin` | The Figma plugin |

**After Effects.** Unsigned extensions only load with Adobe's debug mode on. On
Windows, in PowerShell:

```powershell
foreach ($v in 9..12) { reg add "HKCU\Software\Adobe\CSXS.$v" /v PlayerDebugMode /t REG_SZ /d 1 /f }
```

In Terminal on macOS:

```sh
for v in 9 10 11 12; do defaults write com.adobe.CSXS.$v PlayerDebugMode 1; done
```

Newer After Effects versions may use a higher `CSXS` number. Then link the
build into After Effects' extensions folder and restart After Effects:

```sh
npm run install:ae
```

`npm run uninstall:ae` removes the link again.

**Figma.** In the desktop app, use *Plugins › Development › Import plugin from
manifest…* and choose `figma-plugin/manifest.json`.

After a rebuild, reopen the panel and rerun the plugin.

| Command | |
|---|---|
| `npm run watch` | Rebuild on every change |
| `npm run check` | ES3 check of `host.jsx`, type-check and tests |
| `npm test` | Tests only |
| `npm run release` | Build and stage a clean release (see below) |

Opened outside After Effects, `dist/ae-panel/index.html` shows sample content,
so you can work on the layout in a browser. Add `#several`, `#busy`, `#result`,
`#designs`, `#built`, `#offline` or `#light` to the address to see other states.
To debug the running panel, open `http://localhost:8097` in Chrome
(`http://localhost:8098` for its settings window).

How the pieces fit together, how the tests work and what still needs checking
against the real apps is in [docs/architecture.md](docs/architecture.md).

### Project layout

| Path | |
|---|---|
| `ae-panel/` | After Effects panel: `host/host.jsx` (ExtendScript), `src/` (panel UI and local bridge server) |
| `figma-plugin/` | Figma plugin: `src/build` (After Effects → Figma), `src/read` (Figma → After Effects) |
| `shared/` | The transfer format and conversions both sides use. Start with `format.ts`. |
| `tests/` | Tests with stand-ins for After Effects and Figma |
| `brand/` | Logo and icons |

## Releasing

1. Bump the version in `package.json`, `ae-panel/CSXS/manifest.xml`,
   `ae-panel/host/host.jsx` and `shared/protocol.ts`.
2. Run `npm run release`. It builds and copies the panel to `release/ae-panel`
   without the `.debug` file, which would open debug ports on users' computers.
3. Sign it with Adobe's
   [ZXPSignCmd](https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD).
   The script prints the exact commands. Keep the `.p12` certificate and its
   password out of the repository.
4. Upload the result to a GitHub release as **`Motion-Bridge.zxp`**. The
   download links in this README point to that file name.
5. Publish the Figma plugin from the desktop app (*Plugins › Development ›
   Manage plugins in development › Publish*). Use `brand/icon-128.png` as the
   icon.

## License

[MIT](LICENSE). Contributions are welcome. Please run `npm run check` before
opening a pull request.

Motion Bridge is an independent project and isn't affiliated with, endorsed by
or sponsored by Figma, Inc. or Adobe Inc. Figma and Figma Motion are trademarks
of Figma, Inc. Adobe and After Effects are trademarks of Adobe Inc.
