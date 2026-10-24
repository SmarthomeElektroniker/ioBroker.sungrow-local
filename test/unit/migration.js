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
