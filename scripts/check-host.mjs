/**
 * Guards ae-panel/host/host.jsx against syntax After Effects' ExtendScript
 * (ES3) does not understand. It is a text scan, not a parser: it catches the
 * slips that are easy to make when the rest of the project is modern code.
 *
 *   node scripts/check-host.mjs
 */
import { readFileSync } from 'node:fs';

const file = new URL('../ae-panel/host/host.jsx', import.meta.url);
const source = readFileSync(file, 'utf8');

// Comments and string contents are not code.
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/\/\/.*$/gm, '')
  .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");

const RESERVED = [
  'abstract', 'boolean', 'byte', 'char', 'class', 'const', 'debugger', 'double', 'enum', 'export', 'extends',
  'final', 'float', 'goto', 'implements', 'import', 'int', 'interface', 'long', 'native', 'package', 'private',
  'protected', 'public', 'short', 'static', 'super', 'synchronized', 'throws', 'transient', 'volatile', 'let',
  'yield', 'await',
];

const problems = [];
const lineOf = (index) => code.slice(0, index).split('\n').length;
const scan = (regex, message) => {
  let m;
  while ((m = regex.exec(code))) problems.push(`line ${lineOf(m.index)}: ${message}`);
};

for (const word of RESERVED) {
  scan(new RegExp(`(?<![A-Za-z0-9_$])${word}(?![A-Za-z0-9_$])`, 'g'), `"${word}" is a reserved word in ES3`);
}
scan(/=>/g, 'arrow function');
scan(/`/g, 'template literal');
scan(/\.\.\./g, 'spread / rest');
scan(/,\s*[}\]]/g, 'trailing comma');
scan(/\?\./g, 'optional chaining');
scan(/\?\?/g, 'nullish coalescing');
scan(/\.(map|forEach|filter|reduce|indexOf|some|every|includes|find|trim|keys|isArray)\s*\(/g, 'method missing in ES3');
scan(/(?<![A-Za-z0-9_$.])JSON\./g, 'ExtendScript has no JSON object');

try {
  // ES3 is a subset of what Node parses, so a syntax error here is a syntax error there too.
  new Function(source);
} catch (err) {
  problems.push(`does not parse: ${err.message}`);
}

if (problems.length) {
  console.error(`host.jsx is not ES3-safe:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('host.jsx: no ES3 problems found');
