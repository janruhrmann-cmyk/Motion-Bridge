/**
 * Stages the After Effects panel for signing: copies dist/ae-panel to release/ae-panel without the
 * files that only belong on a developer's machine, then prints the ZXPSignCmd commands that turn it
 * into release/Motion-Bridge.zxp.
 *
 *   npm run release      (builds first, then runs this)
 *
 * Left out of the release:
 *   .debug   opens Chrome DevTools ports (8097, 8098) for the panel on every computer it is installed on.
 */
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'dist', 'ae-panel');
const target = path.join(root, 'release', 'ae-panel');
const zxp = path.join(root, 'release', 'Motion-Bridge.zxp');
const LEAVE_OUT = new Set(['.debug']);

if (!existsSync(source)) {
  console.error('dist/ae-panel does not exist yet. Run "npm run build" first.');
  process.exit(1);
}

rmSync(path.join(root, 'release'), { recursive: true, force: true });
cpSync(source, target, {
  recursive: true,
  filter: (file) => !LEAVE_OUT.has(path.basename(file)),
});

const manifest = readFileSync(path.join(target, 'CSXS', 'manifest.xml'), 'utf8');
const version = /ExtensionBundleVersion="([^"]+)"/.exec(manifest)?.[1] ?? '?';
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
if (pkg.version !== version) {
  console.warn(`Warning: package.json says ${pkg.version}, CSXS/manifest.xml says ${version}.`);
}

const rel = (p) => path.relative(root, p);
console.log(`Staged Motion Bridge ${version} in ${rel(target)}

Sign it with Adobe's ZXPSignCmd (https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD).
Once, to make a certificate (keep the .p12 and its password out of the repository):

  ZXPSignCmd -selfSignedCert <country> <state> <organisation> <common-name> <password> motion-bridge.p12

For every release:

  ZXPSignCmd -sign ${rel(target)} ${rel(zxp)} motion-bridge.p12 <password> -tsa http://timestamp.digicert.com
  ZXPSignCmd -verify ${rel(zxp)}

Then upload ${rel(zxp)} to the GitHub release under exactly that name: Motion-Bridge.zxp.`);
