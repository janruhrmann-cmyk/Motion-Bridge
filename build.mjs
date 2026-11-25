/**
 * Builds both halves into dist/:
 *   dist/ae-panel      the After Effects (CEP) extension
 *   dist/figma-plugin  the Figma plugin, as a folder of its own
 *
 * The two source folders are made complete as well, because they are the ones a person reaches
 * for first - they carry the obvious names and already hold a manifest:
 *   ae-panel/main.js                 so that a copy of ae-panel/ is a working extension. Without
 *                                    it such a copy keeps whatever main.js was installed before:
 *                                    a new panel on top of old logic, and nothing says so.
 *   figma-plugin/dist/code.js, ui.html   which is where figma-plugin/manifest.json looks for
 *                                    them, so either manifest.json can be imported in Figma.
 *                                    Without them Figma only says "Unable to load code".
 * These copies are build output like dist/ (see .gitignore); the sources stay in src/.
 *
 *   node build.mjs           build once
 *   node build.mjs --watch   rebuild when a source file changes
 */
import { build } from 'esbuild';
import { watch as watchDir } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const at = (...parts) => path.join(root, ...parts);

// The After Effects panel shows the logo in its header. (The Figma window has none: Figma's own
// window bar shows the plugin's icon and name.)
const LOGO = 'ae-panel/assets/logo.svg';

async function copy(from, to) {
  await mkdir(path.dirname(at(to)), { recursive: true });
  await cp(at(from), at(to));
}

async function buildAePanel() {
  await build({
    entryPoints: [at('ae-panel/src/main.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    // AE 2021 ships CEP 10, which is Chromium 74.
    target: 'chrome74',
    outfile: at('dist/ae-panel/main.js'),
    logLevel: 'warning',
  });
  await copy('ae-panel/index.html', 'dist/ae-panel/index.html');
  await copy('ae-panel/style.css', 'dist/ae-panel/style.css');
  await copy('ae-panel/host/host.jsx', 'dist/ae-panel/host/host.jsx');
  await copy('ae-panel/CSXS/manifest.xml', 'dist/ae-panel/CSXS/manifest.xml');
  await copy('ae-panel/.debug', 'dist/ae-panel/.debug');
  await copy(LOGO, 'dist/ae-panel/assets/logo.svg');
  // The script index.html asks for, next to the index.html in the source folder too.
  await copy('dist/ae-panel/main.js', 'ae-panel/main.js');
}

async function buildFigmaPlugin() {
  await build({
    entryPoints: [at('figma-plugin/src/code.ts')],
    bundle: true,
    format: 'iife',
    // Figma's plugin sandbox is conservative about newer syntax.
    target: 'es2017',
    outfile: at('dist/figma-plugin/code.js'),
    logLevel: 'warning',
  });
  // Figma wants the UI as one HTML file, so the script is inlined.
  const ui = await build({
    entryPoints: [at('figma-plugin/src/ui.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    write: false,
    logLevel: 'warning',
  });
  const script = ui.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const html = await readFile(at('figma-plugin/ui.html'), 'utf8');
  if (!html.includes('/*__SCRIPT__*/')) throw new Error('figma-plugin/ui.html has lost its /*__SCRIPT__*/ marker.');
  await mkdir(at('dist/figma-plugin'), { recursive: true });
  await writeFile(at('dist/figma-plugin/ui.html'), html.replace('/*__SCRIPT__*/', () => script));

  // figma-plugin/manifest.json names its files in a dist folder beside it, and gets them there.
  // In dist/figma-plugin they lie next to the manifest, so that copy names them without a folder.
  const manifest = JSON.parse(await readFile(at('figma-plugin/manifest.json'), 'utf8'));
  for (const [key, file] of [['main', 'code.js'], ['ui', 'ui.html']]) {
    if (manifest[key] !== `dist/${file}`) {
      throw new Error(`figma-plugin/manifest.json: "${key}" has to be "dist/${file}", not "${manifest[key]}".`);
    }
    await copy(`dist/figma-plugin/${file}`, `figma-plugin/dist/${file}`);
    manifest[key] = file;
  }
  await writeFile(at('dist/figma-plugin/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
}

async function buildAll() {
  const started = Date.now();
  await Promise.all([buildAePanel(), buildFigmaPlugin()]);
  console.log(`Built dist/ae-panel and dist/figma-plugin in ${Date.now() - started} ms`);
}

await buildAll();

if (process.argv.includes('--watch')) {
  let timer = null;
  let running = false;
  const rebuild = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (running) return rebuild();
      running = true;
      try {
        await buildAll();
      } catch (err) {
        console.error(err.message ?? err);
      }
      running = false;
    }, 150);
  };
  for (const dir of ['ae-panel', 'figma-plugin', 'shared']) {
    watchDir(at(dir), { recursive: true }, (_event, file) => {
      // What the build writes into the source folders itself is not a reason to build again.
      const name = String(file ?? '');
      if (dir === 'figma-plugin' && /^dist([\\/]|$)/.test(name)) return;
      if (dir === 'ae-panel' && name === 'main.js') return;
      rebuild();
    });
  }
  console.log('Watching for changes…');
}
