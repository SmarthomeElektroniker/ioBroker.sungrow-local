'use strict';

/*
 * 0.6.0 (template v8): Sungrow wallbox - reading through the WiNet forwarding (unit 3 as default) and the EMS
 * registers of the inverter (33539-33549). Experimental: unticked, writing locked twice (release per register
 * and the switch "wallbox EMS").
 */

const assert = require('node:assert');
const { CATALOG, META, mergeCatalog } = require('../../lib/catalog');
const R = require('../../lib/registers');
const { loadMain, settle, NS } = require('../fakeAdapter');
const ioPackage = require('../../io-package.json');

const createAdapter = loadMain();

describe('wallbox (template v8)', () => {
    it('template version 8 with the wallbox rows, all unticked and not released', () => {
        assert.ok(CATALOG.version >= 8);
        const input = CATALOG.inputRegs.filter(r => r.deviceId === 3);
        const holding = CATALOG.holdingRegs.filter(r => r._address >= 73540 && r._address <= 73550);
        assert.deepStrictEqual(
            input.map(r => r._address),
            [51300, 51302, 51303, 51304, 51305, 51306, 51307, 51308, 51310, 51314, 51317],
        );
        assert.deepStrictEqual(
            holding.map(r => r._address),
            [73540, 73541, 73542, 73543, 73545, 73546, 73548, 73550],
        );
        for (const r of [...input, ...holding]) {
            assert.strictEqual(r.enabled, false, `${r._address}`);
            assert.ok(/not tested|experimental/.test(r.note), `${r._address} note`);
        }
        for (const r of holding) {
            assert.strictEqual(r.allowWrite, false, `${r._address}`);
        }
        assert.strictEqual(ioPackage.native.wallboxEms, false);
    });

    it('charging mode and status have value tables in 11 languages; the mode shows the hex code', () => {
        const mode = META.registers['holdingRegs:1:73541'];
        assert.deepStrictEqual(Object.keys(mode.states), ['160', '161', '162', '163']);
        assert.strictEqual(mode.states['161'].de, 'PV-Überschuss');
        const { statesIn, templateStates } = require('../../lib/catalog');
        assert.strictEqual(statesIn(templateStates('holdingRegs', 1, 73541, ''), 'de')['161'], 'PV-Überschuss (0xA1)');
        const status = META.registers['inputRegs:3:51317'];
        assert.strictEqual(status.states['3'].en, 'Charging');
        assert.strictEqual(Object.keys(status.states['3']).length, 11);
    });

    it('the 32-bit times are raw values (low word first) and say that the format is not clarified', () => {
        for (const a of [73543, 73546, 73548]) {
            const r = CATALOG.holdingRegs.find(x => x._address === a);
            assert.strictEqual(r.type, 'uint32sw');
            assert.match(r.description, /time format not clarified/);
        }
    });

    it('existing instances get the rows once with the migration (unticked)', () => {
        const before = JSON.parse(JSON.stringify(ioPackage.native));
        before.templateVersion = 7;
        before.inputRegs = before.inputRegs.filter(r => r.deviceId !== 3);
        before.holdingRegs = before.holdingRegs.filter(r => !(r._address >= 73540 && r._address <= 73550));
        const { changed, native } = mergeCatalog(before);
        assert.ok(changed);
        assert.strictEqual(native.inputRegs.filter(r => r.deviceId === 3 && r.enabled === false).length, 11);
        assert.strictEqual(native.templateVersion, CATALOG.version);
    });

    it('writing an EMS register of the wallbox needs the switch "wallbox EMS" in addition to the release', async () => {
        const row = { ...CATALOG.holdingRegs.find(x => x._address === 73541), enabled: true, allowWrite: true };
        const reg = R.normalise('holdingRegs', [row]).regs[0];
        assert.strictEqual(reg.write, true);
        for (const [cfg, expected] of [
            [{}, 0],
            [{ wallboxEms: true }, 1],
        ]) {
            const a = createAdapter();
            a.config = { ...cfg };
            const id = `${NS}.${reg.id}`;
            a.regsById.set(id, reg);
            const sent = [];
            a.poller = { write: (r, v) => sent.push(v) };
            a.onStateChange(id, { val: 161, ack: false });
            await settle();
            assert.strictEqual(sent.length, expected, JSON.stringify(cfg));
            if (!expected) {
                assert.ok(a.logsOf('warn').some(m => m.includes('wallbox EMS control is switched off')));
            }
        }
    });
});
