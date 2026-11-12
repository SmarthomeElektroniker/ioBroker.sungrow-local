'use strict';

/*
 * Migration to 0.4.0 (template version 3): writing is released per holding register (allowWrite).
 * Existing instances keep what they could do; IDs and all other settings stay.
 */

const assert = require('node:assert');
const R = require('../../lib/registers');
const { CATALOG, mergeCatalog } = require('../../lib/catalog');
const ioPackage = require('../../io-package.json');

/** @returns {Record<string, any>} Configuration of a 0.3.0 instance (template v2, no allowWrite) */
function v2Native() {
    const n = JSON.parse(JSON.stringify(ioPackage.native));
    n.templateVersion = 2;
    n.host = '192.168.30.40';
    n.readOnly = false;
    for (const r of n.holdingRegs) {
        delete r.allowWrite;
    }
    // a 0.3.0 instance has only the template rows of v2 (rows of v3 would come with the migration)
    return n;
}

describe('migration 0.3.0 -> 0.4.0 (template v3)', () => {
    it('the template version is 3 or higher', () => {
        assert.ok(CATALOG.version >= 3);
    });

    it('ticked holding rows stay writable, unticked template rows are not released', () => {
        const before = v2Native();
        const { changed, native } = mergeCatalog(before);
        assert.ok(changed);
        for (const r of native.holdingRegs) {
            assert.strictEqual(typeof r.allowWrite, 'boolean', `${r._address} has allowWrite`);
            if (before.holdingRegs.some(b => b._address === r._address && b.enabled !== false)) {
                assert.strictEqual(r.allowWrite, true, `${r._address} was ticked -> stays writable`);
            } else {
                assert.strictEqual(r.allowWrite, false, `${r._address} unticked -> not released`);
            }
        }
        // the state IDs and the "write" flag of the registers do not change for ticked rows
        const old = R.normalise('holdingRegs', before.holdingRegs).regs;
        const now = R.normalise('holdingRegs', native.holdingRegs).regs;
        for (const o of old) {
            const m = now.find(x => x.id === o.id);
            assert.ok(m, `${o.id} still exists`);
            assert.strictEqual(m.write, o.write, `${o.id} write flag unchanged`);
        }
    });

    it('all other settings are kept (host, readOnly, groups, intervals)', () => {
        const before = v2Native();
        before.groups.find(g => g.name === 'live').interval = 7;
        const { native } = mergeCatalog(before);
        assert.strictEqual(native.host, '192.168.30.40');
        assert.strictEqual(native.readOnly, false);
        assert.strictEqual(native.groups.find(g => g.name === 'live').interval, 7);
        assert.strictEqual(native.templateVersion, CATALOG.version);
    });

    it('an explicit allowWrite of the user is kept', () => {
        const before = v2Native();
        before.holdingRegs[0].allowWrite = false;
        const { native } = mergeCatalog(before);
        assert.strictEqual(native.holdingRegs[0].allowWrite, false);
    });

    it('runs once: a migrated configuration is not changed again', () => {
        const once = mergeCatalog(v2Native()).native;
        assert.strictEqual(mergeCatalog(once).changed, false);
    });
});

describe('registers: write release', () => {
    const row = { _address: 53050, deviceId: 1, name: 'EMS', type: 'uint16be', poll: true, group: 'steuerung' };
    it('allowWrite false -> not writable, true -> writable, missing (old rows) -> writable', () => {
        assert.strictEqual(R.normalise('holdingRegs', [{ ...row, allowWrite: false }]).regs[0].write, false);
        assert.strictEqual(R.normalise('holdingRegs', [{ ...row, allowWrite: true }]).regs[0].write, true);
        assert.strictEqual(R.normalise('holdingRegs', [{ ...row }]).regs[0].write, true);
        assert.strictEqual(
            R.normalise('inputRegs', [{ ...row, _address: 35000, allowWrite: true }]).regs[0].write,
            false,
        );
    });

    it('new installations: no holding register of the defaults is released for writing', () => {
        for (const r of ioPackage.native.holdingRegs) {
            assert.strictEqual(r.allowWrite, false, `${r._address}`);
        }
    });
});

describe('migration to template v4: value tables (states) of writable registers', () => {
    const { META } = require('../../lib/catalog');

    it('every register with a value table has it translated into all 11 languages', () => {
        const langs = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];
        const withStates = Object.entries(META.registers).filter(([, m]) => m.states);
        assert.ok(withStates.length >= 20, String(withStates.length));
        for (const [key, m] of withStates) {
            // 0.5.1: also the operating state 43000 and the output type 35002 (input registers)
            assert.ok(key.startsWith('holdingRegs:') || ['inputRegs:1:43000', 'inputRegs:1:35002'].includes(key), key);
            assert.deepStrictEqual(Object.keys(m.states), Object.keys(R.parseStates(m.statesDefault)), key);
            for (const texts of Object.values(m.states)) {
                for (const l of langs) {
                    assert.ok(texts[l], `${key} ${l}`);
                }
            }
        }
        // EMS mode with an explanation per mode
        const ems = META.registers['holdingRegs:1:53050'];
        assert.strictEqual(ems.states['0'].de, 'Eigenverbrauch');
        assert.strictEqual(ems.states['2'].de, 'Zwangsmodus (Laden/Entladen)');
        assert.ok(ems.statesHelp['2'].de.includes('13051'));
    });

    it('an empty states column gets the template table, an own text of the user stays', () => {
        const before = v2Native();
        const ems = before.holdingRegs.find(r => r._address === 53050);
        ems.states = '';
        const off = before.holdingRegs.find(r => r._address === 53075);
        off.states = '170:Notstrom an;85:Notstrom aus';
        const { native } = mergeCatalog(before);
        assert.strictEqual(
            native.holdingRegs.find(r => r._address === 53050).states,
            META.registers['holdingRegs:1:53050'].statesDefault,
        );
        assert.strictEqual(
            native.holdingRegs.find(r => r._address === 53075).states,
            '170:Notstrom an;85:Notstrom aus',
        );
    });

    it('the write check names the allowed values', () => {
        const reg = R.normalise('holdingRegs', [
            {
                _address: 53050,
                deviceId: 1,
                name: 'EMS',
                type: 'uint16be',
                poll: true,
                states: '0:Self-consumption;2:Forced',
            },
        ]).regs[0];
        assert.strictEqual(R.checkWriteValue(reg, 2), '');
        assert.match(
            R.checkWriteValue(reg, 5),
            /5 is not an allowed value - allowed: 0 = Self-consumption, 2 = Forced/,
        );
    });
});

describe('migration to template v5: nearly constant values into the group info', () => {
    /** @returns {Record<string, any>} 0.3.0 configuration with the old default groups */
    function old() {
        const n = v2Native();
        for (const a of [35001, 43024, 43039]) {
            n.inputRegs.find(r => r._address === a).group = 'energie';
        }
        return n;
    }

    it('SoH, capacity and nominal power move to info when the row still has the default group', () => {
        const { native, fixed } = mergeCatalog(old());
        for (const a of [35001, 43024, 43039]) {
            assert.strictEqual(native.inputRegs.find(r => r._address === a).group, 'info', String(a));
        }
        assert.ok(fixed.includes('43024 group energie -> info'));
    });

    it('a row the user moved himself stays in his group', () => {
        const n = old();
        n.inputRegs.find(r => r._address === 43024).group = 'live';
        const { native } = mergeCatalog(n);
        assert.strictEqual(native.inputRegs.find(r => r._address === 43024).group, 'live');
    });
});

describe('migration to template v7 (0.5.0): English names of the default poll groups', () => {
    const { renameDefaultGroups, GROUP_RENAMES, DEFAULT_GROUP_DESC, OLD_GROUP_DESC } = require('../../lib/catalog');
    const back = Object.fromEntries(Object.entries(GROUP_RENAMES).map(([o, n]) => [n, o]));

    /** @returns {Record<string, any>} Configuration of a 0.4.3 instance (old group names, German descriptions) */
    function v6Native() {
        const n = JSON.parse(JSON.stringify(ioPackage.native));
        n.templateVersion = 6;
        for (const t of ['inputRegs', 'holdingRegs']) {
            n[t] = n[t].map(r => ({ ...r, group: back[r.group] || r.group }));
        }
        n.groups = n.groups.map(g => ({
            ...g,
            name: back[g.name] || g.name,
            description: OLD_GROUP_DESC[back[g.name] || g.name] || g.description,
        }));
        return n;
    }

    it('the defaults of io-package use the English names and descriptions; no version key as default', () => {
        const names = ioPackage.native.groups.map(g => g.name);
        assert.deepStrictEqual(names, ['live', 'energy', 'control', 'battery', 'info']);
        for (const g of ioPackage.native.groups) {
            assert.strictEqual(g.description, DEFAULT_GROUP_DESC[g.name], g.name);
        }
        for (const t of ['inputRegs', 'holdingRegs']) {
            for (const r of [...ioPackage.native[t], ...CATALOG[t]]) {
                assert.ok(names.includes(r.group), `${t} ${r._address} ${r.group}`);
            }
        }
        // "iobroker upload" copies new default keys into existing instances - the migration would never run
        assert.ok(!('templateVersion' in ioPackage.native));
        assert.ok(CATALOG.version >= 7);
    });

    it('renames the groups and their rows, replaces only unchanged German descriptions', () => {
        const before = v6Native();
        before.groups.find(g => g.name === 'steuerung').description = 'Meine Steuerung';
        const { native, renamedGroups } = mergeCatalog(before);
        assert.deepStrictEqual(renamedGroups, [
            ['energie', 'energy'],
            ['steuerung', 'control'],
            ['akku', 'battery'],
        ]);
        const g = Object.fromEntries(native.groups.map(x => [x.name, x]));
        assert.deepStrictEqual(Object.keys(g), ['live', 'energy', 'control', 'battery', 'info']);
        assert.strictEqual(g.live.description, DEFAULT_GROUP_DESC.live);
        assert.strictEqual(g.energy.description, DEFAULT_GROUP_DESC.energy);
        assert.strictEqual(g.battery.description, DEFAULT_GROUP_DESC.battery);
        assert.strictEqual(g.control.description, 'Meine Steuerung');
        // interval/timeout/pause stay
        assert.strictEqual(g.battery.interval, 120);
        assert.strictEqual(g.battery.pauseAfter, 5000);
        for (const t of ['inputRegs', 'holdingRegs']) {
            for (const r of native[t]) {
                assert.ok(!Object.keys(GROUP_RENAMES).includes(r.group), `${t} ${r._address} ${r.group}`);
            }
        }
        // the state IDs do not change (the group is not part of a register ID)
        const ids = n => R.normalise('inputRegs', n.inputRegs).regs.map(r => r.id);
        assert.deepStrictEqual(ids(native), ids(before));
        assert.ok(!before.groups.some(x => x.name === 'battery'), 'input not modified');
    });

    it('own groups are not touched; no rename when a group with the new name exists already', () => {
        const before = v6Native();
        before.groups.push({ enabled: true, name: 'battery', interval: 30, timeout: 10000, pauseAfter: 0 });
        before.groups.push({ enabled: true, name: 'Akku2', interval: 30, timeout: 10000, pauseAfter: 0 });
        before.inputRegs.find(r => r._address === 35017).group = 'Akku2';
        const { native, skippedGroups } = mergeCatalog(before);
        const names = native.groups.map(x => x.name);
        assert.ok(names.includes('akku') && names.includes('battery') && names.includes('Akku2'));
        assert.deepStrictEqual(skippedGroups, ['akku (a group "battery" exists already)']);
        assert.strictEqual(native.inputRegs.find(r => r._address === 40744 && r.deviceId === 2).group, 'akku');
        assert.strictEqual(native.inputRegs.find(r => r._address === 35017).group, 'Akku2');
        assert.ok(names.includes('energy') && names.includes('control'));
    });

    it('the template v5 move to info still works for 0.3.0 instances (fixes run before the rename)', () => {
        const before = v6Native();
        before.templateVersion = 4;
        before.inputRegs.find(r => r._address === 43024).group = 'energie';
        const { native } = mergeCatalog(before);
        assert.strictEqual(native.inputRegs.find(r => r._address === 43024).group, 'info');
    });

    it('runs once: a group the user names "akku" later is not renamed again', () => {
        const once = mergeCatalog(v6Native()).native;
        once.groups.push({ enabled: true, name: 'akku', interval: 30 });
        assert.strictEqual(mergeCatalog(once).changed, false);
    });

    it('renameDefaultGroups alone: description of a group without a German default stays', () => {
        const res = renameDefaultGroups(
            [
                { name: 'live', description: 'own' },
                { name: 'info', description: '' },
            ],
            {},
        );
        assert.deepStrictEqual(res.renamed, []);
        assert.deepStrictEqual(res.described, []);
        assert.strictEqual(res.groups[0].description, 'own');
    });
});
