/**
 * Links dist/ae-panel into After Effects' extension folder, so the panel shows
 * up under Window > Extensions and always runs the latest build.
 *
 *   node scripts/install-ae.mjs            create the link
 *   node scripts/install-ae.mjs --remove   remove it again
 *
 * Unsigned extensions only load with Adobe's PlayerDebugMode switched on.
 */
import { existsSync, lstatSync, mkdirSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'dist', 'ae-panel');
const extensions =
  process.platform === 'win32'
    ? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Adobe', 'CEP', 'extensions')
    : path.join(os.homedir(), 'Library', 'Application Support', 'Adobe', 'CEP', 'extensions');
const link = path.join(extensions, 'Motion Bridge');

function existingLink() {
  try {
    return lstatSync(link);
  } catch {
    return null;
  }
}

function removeLink() {
  const stat = existingLink();
  if (!stat) return false;
  if (!stat.isSymbolicLink()) {
    throw new Error(`"${link}" is a real folder, not a link made by this script. Remove it by hand if it is no longer needed.`);
  }
  try {
    unlinkSync(link);
  } catch {
    rmdirSync(link);
  }
  return true;
}

try {
  if (process.argv.includes('--remove')) {
    console.log(removeLink() ? `Removed ${link}` : 'Nothing to remove.');
  } else {
    if (!existsSync(source)) throw new Error('dist/ae-panel does not exist yet. Run "npm run build" first.');
    mkdirSync(extensions, { recursive: true });
    removeLink();
    symlinkSync(source, link, process.platform === 'win32' ? 'junction' : 'dir');
    console.log(`Linked\n  ${link}\n  -> ${source}\nRestart After Effects, then open Window > Extensions > Motion Bridge.`);
  }
} catch (err) {
  console.error(err.message ?? err);
  process.exit(1);
}
