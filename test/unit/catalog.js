'use strict';

/*
 * Register template (catalog) and its migration into existing instances.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../../lib/registers');
const { CATALOG, mergeCatalog, span } = require('../../lib/catalog');

const ioPackage = require('../../io-package.json');
const fixtures = path.join(__dirname, '..', 'fixtures');
const fixtureIds = fs
    .readFileSync(path.join(fixtures, 'modbus-state-ids.txt'), 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .sort();

/**
 * @param {Record<string, any>} native Configuration
 * @returns {string[]} State IDs that the adapter would create (sorted)
 */
function activeIds(native) {
    const ids = [];
    for (const t of /** @type {('inputRegs'|'holdingRegs')[]} */ (['inputRegs', 'holdingRegs'])) {
        const { regs, problems } = R.normalise(t, native[t]);
        assert.deepStrictEqual(problems, [], `${t}: ${problems.join('; ')}`);
        ids.push(...regs.map(r => r.id));
    }
    return ids.sort();
}

/** @returns {Record<string, any>} Configuration of a 0.2.x instance (no enabled flags, no template) */
function oldNative() {
    const n = JSON.parse(JSON.stringify(ioPackage.native));
    for (const t of ['inputRegs', 'holdingRegs']) {
        n[t] = n[t]
            .filter(r => !r.source)
            .map(r => {
                const { enabled, ...rest } = r;
                void enabled;
                return rest;
            });
    }
    n.groups = n.groups.filter(g => g.name !== 'info');
    return n;
}

describe('catalog: register template', () => {
    it('has 100 rows (74 input, 26 holding) with valid types, unique IDs and a source', () => {
        assert.strictEqual(CATALOG.inputRegs.length, 74);
        assert.strictEqual(CATALOG.holdingRegs.length, 26);
        for (const t of /** @type {('inputRegs'|'holdingRegs')[]} */ (['inputRegs', 'holdingRegs'])) {
            const rows = CATALOG[t].map(r => ({ ...r, enabled: true }));
            const { regs, problems } = R.normalise(t, rows);
            assert.deepStrictEqual(problems, []);
            assert.strictEqual(regs.length, rows.length);
            for (const r of CATALOG[t]) {
                assert.strictEqual(r.enabled, false, `${r._address} must be unticked`);
                assert.ok(r.source && r.note.startsWith(r.source), `${r._address} has a source`);
                assert.ok(['live', 'energie', 'steuerung', 'akku', 'info'].includes(r.group), r.group);
            }
        }
    });

    it('never overlaps a default register (no register is read twice, no ID changes)', () => {
        for (const t of /** @type {('inputRegs'|'holdingRegs')[]} */ (['inputRegs', 'holdingRegs'])) {
            const used = new Set();
            for (const r of ioPackage.native[t].filter(x => !x.source)) {
                span(r, t).forEach(a => used.add(`${r.deviceId}:${a}`));
            }
            for (const c of CATALOG[t]) {
                for (const a of span(c, t)) {
                    assert.ok(!used.has(`${c.deviceId}:${a}`), `${t} ${c._address} overlaps`);
                    used.add(`${c.deviceId}:${a}`);
                }
            }
        }
    });

    it('io-package defaults: exactly the 77 known IDs are ticked, the template rows are not', () => {
        assert.deepStrictEqual(activeIds(ioPackage.native), fixtureIds);
        // no template version as a default: "iobroker upload" copies new default keys into existing instances
        assert.strictEqual(ioPackage.native.templateVersion, undefined);
        assert.strictEqual(ioPackage.native.catalogVersion, undefined);
        const ticked = [...ioPackage.native.inputRegs, ...ioPackage.native.holdingRegs].filter(r => r.enabled);
        assert.strictEqual(ticked.length, 77);
    });

    it('Sungrow conventions: 32-bit values low word first, writable rows with plain text or limits', () => {
        for (const r of [...CATALOG.inputRegs, ...CATALOG.holdingRegs]) {
            assert.ok(!/32(be|le|sb)$/.test(r.type), `${r._address}: ${r.type}`);
        }
        for (const r of CATALOG.holdingRegs) {
            assert.strictEqual(r.role, 'level');
            assert.ok(r.states || r.min !== '' || r.max !== '', `${r._address} has states or limits`);
        }
        const device = CATALOG.inputRegs.find(r => r._address === 35000);
        assert.ok(device && R.parseStates(device.states)['3622'] === 'SH20T', 'device type code 0x0E26 = SH20T');
    });
});

describe('catalog: migration of an existing instance (0.2.x -> 0.3.0)', () => {
    it('adds the template unticked, ticks the existing rows, adds the group info - same 77 IDs', () => {
        const before = oldNative();
        assert.deepStrictEqual(activeIds(before), fixtureIds);
        const { changed, native, added } = mergeCatalog(before);
        assert.ok(changed);
        assert.strictEqual(added, 100);
        assert.deepStrictEqual(activeIds(native), fixtureIds, 'the same registers are read as before');
        assert.ok(native.inputRegs.slice(0, 68).every(r => r.enabled === true));
        assert.strictEqual(native.inputRegs.length, 68 + 74);
        assert.strictEqual(native.holdingRegs.length, 9 + 26);
        assert.ok(native.groups.some(g => g.name === 'info' && g.interval === 3600));
        assert.strictEqual(native.templateVersion, CATALOG.version);
        // the input is not modified
        assert.strictEqual(before.inputRegs[0].enabled, undefined);
    });

    it('a new installation (defaults already contain the template) adds nothing and only marks the version', () => {
        const { changed, native, added } = mergeCatalog(JSON.parse(JSON.stringify(ioPackage.native)));
        assert.ok(changed);
        assert.strictEqual(added, 0);
        assert.strictEqual(native.inputRegs.length, ioPackage.native.inputRegs.length);
        assert.strictEqual(native.groups.filter(g => g.name === 'info').length, 1);
        assert.deepStrictEqual(activeIds(native), fixtureIds);
    });

    it('a stray default key catalogVersion (copied by "iobroker upload") does not stop the migration', () => {
        const n = { ...oldNative(), catalogVersion: 1 };
        const { changed, native, added } = mergeCatalog(n);
        assert.ok(changed);
        assert.strictEqual(added, 100);
        assert.strictEqual(native.catalogVersion, undefined);
    });

    it('runs only once per template version', () => {
        const once = mergeCatalog(oldNative()).native;
        const again = mergeCatalog(once);
        assert.strictEqual(again.changed, false);
        assert.strictEqual(again.native, once);
    });

    it('own rows win: a configured register at a template address keeps its name, nothing is added twice', () => {
        const n = oldNative();
        n.inputRegs.push({ _address: 35242, deviceId: 1, name: 'My frequency', type: 'uint16be', factor: 0.01 });
        n.holdingRegs.push({ enabled: false, _address: 53058, deviceId: 1, name: 'Old max SOC', type: 'uint16be' });
        const { native } = mergeCatalog(n);
        assert.strictEqual(native.inputRegs.filter(r => r._address === 35242).length, 1);
        assert.strictEqual(native.inputRegs.find(r => r._address === 35242).name, 'My frequency');
        const h = native.holdingRegs.filter(r => r._address === 53058);
        assert.strictEqual(h.length, 1);
        assert.strictEqual(h[0].enabled, false, 'an unticked own row stays unticked');
    });

    it('a 32-bit own row blocks a template row on its second register', () => {
        const n = oldNative();
        n.inputRegs.push({ _address: 35213, deviceId: 1, name: 'Battery power own', type: 'int32sw' });
        const { native } = mergeCatalog(n);
        // template 35214 "Battery power signed" (5213, two registers) overlaps 35213 + 35214
        assert.ok(!native.inputRegs.some(r => r._address === 35214));
    });

    it('a ticked template row is read in the block of its group (bundled, no extra request)', () => {
        const { native } = mergeCatalog(oldNative());
        const groupBlocks = rows => {
            const { regs } = R.normalise('inputRegs', rows);
            return R.buildBlocks(regs.filter(r => r.group === 'akku' && r.deviceId === 2));
        };
        const before = groupBlocks(native.inputRegs);
        const ticked = native.inputRegs.map(r =>
            r.deviceId === 2 && (r._address === 40742 || r._address === 40743) ? { ...r, enabled: true } : r,
        );
        const after = groupBlocks(ticked);
        assert.strictEqual(before.length, 1);
        assert.strictEqual(after.length, 1, 'battery current and temperature join the existing request');
        assert.deepStrictEqual([after[0].start, after[0].count], [10740, 9]);
    });
});
