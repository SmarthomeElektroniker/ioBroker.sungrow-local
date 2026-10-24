// Builds ONE self-contained HTML file of the development harness (all scripts inline) - a clickable preview
// of the components with simulated values. Usage: node preview.mjs <target.html>
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] || path.join(here, 'build-harness', 'preview.html');
execSync('npx vite build -c vite.harness.config.ts', { cwd: here, stdio: 'inherit' });
const dir = path.join(here, 'build-harness');
let html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
html = html.replace(/<script type="module" crossorigin src="\.\/([^"]+)"><\/script>/g, (_m, f) => {
    const js = fs.readFileSync(path.join(dir, f), 'utf8').replace(/<\/script/g, '<\\/script');
    return `<script type="module">${js}</script>`;
});
html = html.replace(
    /<link rel="stylesheet" crossorigin href="\.\/([^"]+)">/g,
    (_m, f) => `<style>${fs.readFileSync(path.join(dir, f), 'utf8')}</style>`,
);
if (/src="\.\/assets/.test(html)) {
    throw new Error('not all scripts inlined');
}
fs.writeFileSync(target, html);
console.log(`${target}: ${(html.length / 1e6).toFixed(1)} MB`);
