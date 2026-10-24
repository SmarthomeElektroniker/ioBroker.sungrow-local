// Copies the module federation build into ../admin/custom (only the files reachable from the remote
// entry - the development harness stays out) plus the translations.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const build = path.join(here, 'build');
const target = path.join(here, '..', 'admin', 'custom');

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(path.join(target, 'assets'), { recursive: true });
fs.mkdirSync(path.join(target, 'i18n'), { recursive: true });

const seen = new Set();
const queue = ['customComponents.js'];
while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) {
        continue;
    }
    seen.add(rel);
    const src = path.join(build, rel);
    if (!fs.existsSync(src)) {
        throw new Error(`missing build file ${rel}`);
    }
    const text = fs.readFileSync(src, 'utf8');
    fs.copyFileSync(src, path.join(target, rel));
    const dir = path.posix.dirname(rel);
    for (const m of text.matchAll(/["'`](\.{1,2}\/[^"'`]+?\.js)["'`]/g)) {
        queue.push(path.posix.normalize(path.posix.join(dir, m[1])));
    }
}
fs.copyFileSync(path.join(build, 'mf-manifest.json'), path.join(target, 'mf-manifest.json'));
for (const f of fs.readdirSync(path.join(here, 'src', 'i18n'))) {
    fs.copyFileSync(path.join(here, 'src', 'i18n', f), path.join(target, 'i18n', f));
}
console.log(`admin/custom: ${seen.size} scripts, mf-manifest.json, ${fs.readdirSync(path.join(target, 'i18n')).length} translations`);
