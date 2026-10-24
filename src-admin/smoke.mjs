// Smoke test of the admin components (npm run test:admin):
// 1. the built files in admin/custom are complete (remote entry, manifest, every referenced chunk)
// 2. the translations of the components exist in all 11 languages with the same placeholders
// 3. every custom component referenced in admin/jsonConfig.json is exported
// 4. every component renders server side without error (needs src-admin/node_modules)
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const custom = path.join(here, '..', 'admin', 'custom');
const LANGS = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];
let checks = 0;
const ok = msg => {
    checks++;
    console.log(`  ✔ ${msg}`);
};

// 1. build output
const entry = path.join(custom, 'customComponents.js');
assert.ok(fs.existsSync(entry), 'admin/custom/customComponents.js missing - run "npm run build:admin"');
const manifest = JSON.parse(fs.readFileSync(path.join(custom, 'mf-manifest.json'), 'utf8'));
assert.strictEqual(manifest.name, 'ConfigCustomSungrowLocalSet');
assert.ok(
    manifest.shared.some(s => s.name === '@iobroker/gui-components'),
    'gui-components (GUI API 2) shared',
);
assert.ok(!manifest.shared.some(s => s.name === '@iobroker/adapter-react-v5'), 'no legacy library');
const exposed = manifest.exposes.find(e => e.name === 'Components');
assert.ok(exposed, 'exposes ./Components');
for (const f of exposed.assets.js.sync) {
    assert.ok(fs.existsSync(path.join(custom, f)), `missing ${f}`);
}
const seen = new Set();
const queue = ['customComponents.js'];
while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    assert.ok(fs.existsSync(path.join(custom, rel)), `missing chunk ${rel}`);
    const text = fs.readFileSync(path.join(custom, rel), 'utf8');
    for (const m of text.matchAll(/["'`](\.{1,2}\/[^"'`]+?\.js)["'`]/g)) {
        queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
    }
}
ok(`build complete: ${seen.size} scripts, shares ${manifest.shared.map(s => s.name).join(', ')}`);

// 2. translations
if (!process.argv.includes('--skip-i18n')) {
    const en = JSON.parse(fs.readFileSync(path.join(custom, 'i18n', 'en.json'), 'utf8'));
    const count = s => (String(s).match(/%s/g) || []).length;
    for (const l of LANGS) {
        const file = path.join(custom, 'i18n', `${l}.json`);
        assert.ok(fs.existsSync(file), `i18n ${l} missing`);
        const t = JSON.parse(fs.readFileSync(file, 'utf8'));
        const missing = Object.keys(en).filter(k => !t[k]);
        assert.deepStrictEqual(missing, [], `${l}: missing texts`);
        const bad = Object.keys(en).filter(k => count(en[k]) !== count(t[k]));
        assert.deepStrictEqual(bad, [], `${l}: placeholders differ`);
    }
    ok(`translations: ${Object.keys(en).length} texts in ${LANGS.length} languages`);
}

// 3. jsonConfig references
const src = fs.readFileSync(path.join(here, 'src', 'Components.tsx'), 'utf8');
const names = (src.match(/export default \{([^}]+)\}/) || ['', ''])[1]
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
const jsonConfig = JSON.parse(fs.readFileSync(path.join(here, '..', 'admin', 'jsonConfig.json'), 'utf8'));
const used = [];
const walk = o => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === 'object') {
        if (o.type === 'custom') {
            used.push(o);
        }
        Object.values(o).forEach(walk);
    }
};
walk(jsonConfig);
assert.ok(used.length >= 4);
for (const u of used) {
    const [set, file, comp] = u.name.split('/');
    assert.strictEqual(set, 'ConfigCustomSungrowLocalSet');
    assert.strictEqual(file, 'Components');
    assert.ok(names.includes(comp), `${comp} is exported`);
    assert.strictEqual(u.url, 'custom/customComponents.js');
    assert.strictEqual(u.i18n, true);
}
ok(`jsonConfig: ${used.map(u => u.name.split('/')[2]).join(', ')} exported`);

// 4. server side rendering
// rendered when the development dependencies of src-admin are installed (npm run build:admin) or with --render
if (process.argv.includes('--render') || fs.existsSync(path.join(here, 'node_modules', 'vite'))) {
    const { createServer } = await import('vite');
    const server = await createServer({
        root: here,
        configFile: path.join(here, 'vite.harness.config.ts'),
        server: { middlewareMode: true, hmr: false },
        appType: 'custom',
        logLevel: 'error',
        ssr: { noExternal: [/@iobroker\//, /@mui\//, /@dnd-kit\//] },
    });
    // a DOM for the libraries that touch window/document at import time (after vite started: it needs node timers)
    const { GlobalRegistrator } = await import('@happy-dom/global-registrator');
    GlobalRegistrator.register({ url: 'http://localhost/' });
    try {
        const mod = await server.ssrLoadModule('/src/smokeRender.tsx');
        for (const host of ['', '192.168.30.40']) {
            const html = mod.renderAll(host);
            for (const [name, h] of Object.entries(html)) {
                assert.ok(h.length > 200, `${name} rendered (${h.length} chars)`);
            }
            if (!host) {
                assert.ok(/Setup wizard/.test(html.Overview), `wizard shown without address: ${html.Overview.replace(/<[^>]+>/g, ' ').slice(0, 300)}`);
            }
            assert.ok(/Bus load/.test(html.Catalog), 'catalog shows the bus load');
        }
        ok(`render: ${Object.keys(mod.renderAll('x')).join(', ')} render without error`);
    } finally {
        await GlobalRegistrator.unregister();
        await server.close();
    }
}
console.log(`${checks} checks passed`);
