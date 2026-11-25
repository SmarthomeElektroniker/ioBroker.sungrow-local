'use strict';

const assert = require('node:assert');
const { Plausibility, allZero, limits } = require('../../lib/plausibility');

const block = { regType: 'inputRegs', deviceId: 2, start: 10720, count: 29 };
const zeros = Buffer.alloc(58);
const data = Buffer.alloc(58);
data.writeUInt16BE(868, 46);

describe('plausibility of read answers', () => {
    it('allZero', () => {
        assert.strictEqual(allZero(Buffer.alloc(4), 4), true);
        assert.strictEqual(allZero(Buffer.from([0, 0, 0, 1]), 4), false);
        assert.strictEqual(allZero(Buffer.alloc(0), 0), false);
    });

    it('holds back a sudden all-zero answer and takes it over the third time in a row', () => {
        const p = new Plausibility();
        assert.deepStrictEqual(p.checkBlock(block, data).hold, false);
        assert.deepStrictEqual(p.checkBlock(block, zeros), { hold: true, row: 1, need: 3 });
        // a normal answer in between starts the count again
        assert.strictEqual(p.checkBlock(block, data).hold, false);
        assert.strictEqual(p.checkBlock(block, zeros).row, 1);
        assert.strictEqual(p.checkBlock(block, zeros).hold, true);
        const third = p.checkBlock(block, zeros);
        assert.strictEqual(third.hold, false);
        assert.strictEqual(third.accepted, true);
        // further zero answers pass at once, without "accepted" again
        assert.deepStrictEqual(p.checkBlock(block, zeros), { hold: false, row: 0, need: 3 });
    });

    it('an all-zero FIRST answer is suspicious as well; blocks are counted separately', () => {
        const p = new Plausibility();
        assert.strictEqual(p.checkBlock(block, zeros).hold, true);
        const other = { ...block, start: 13000 };
        assert.strictEqual(p.checkBlock(other, zeros).row, 1);
        assert.strictEqual(p.checkBlock(block, zeros).row, 2);
    });

    it('small blocks (one register becoming 0), holding registers and confirm <= 1 are not checked', () => {
        const p = new Plausibility();
        assert.strictEqual(p.checkBlock({ ...block, regType: 'holdingRegs' }, zeros).hold, false);
        assert.strictEqual(p.checkBlock({ ...block, count: 1 }, Buffer.alloc(2)).hold, false);
        assert.strictEqual(p.checkBlock({ ...block, count: 3 }, Buffer.alloc(6)).hold, false);
        const off = new Plausibility({ confirm: 1 });
        assert.strictEqual(off.checkBlock(block, zeros).hold, false);
        assert.strictEqual(off.checkValue({ id: 'x', unit: '%' }, 150).hold, false);
        assert.strictEqual(new Plausibility({ confirm: 0 }).checkBlock(block, zeros).hold, false);
    });

    it('limits: own min/max first, otherwise 0 … 100 for %', () => {
        assert.deepStrictEqual(limits({ unit: '%' }), { min: 0, max: 100 });
        assert.deepStrictEqual(limits({ unit: '%', min: 0 }), { min: 0, max: undefined });
        assert.deepStrictEqual(limits({ unit: 'W' }), {});
        assert.deepStrictEqual(limits({ unit: 'V', min: 100, max: 500 }), { min: 100, max: 500 });
    });

    it('a value outside its limits is held back until it comes three times in a row', () => {
        const p = new Plausibility();
        const reg = { id: 'inputRegisters.2.40744_Battery_level', unit: '%' };
        assert.strictEqual(p.checkValue(reg, 86.8).hold, false);
        assert.deepStrictEqual(p.checkValue(reg, 6553.5), { hold: true, row: 1, need: 3, min: 0, max: 100 });
        assert.strictEqual(p.checkValue(reg, 87).hold, false);
        assert.strictEqual(p.checkValue(reg, 6553.5).row, 1);
        assert.strictEqual(p.checkValue(reg, 6553.5).hold, true);
        assert.strictEqual(p.checkValue(reg, 6553.5).hold, false);
        assert.strictEqual(p.checkValue(reg, 6553.5).hold, false);
        // strings and values without limits are not checked
        assert.strictEqual(p.checkValue({ id: 's', unit: '%' }, 'SBH').hold, false);
        assert.strictEqual(p.checkValue({ id: 'w', unit: 'W' }, -99999).hold, false);
        p.reset();
        assert.strictEqual(p.checkValue(reg, 6553.5).row, 1);
    });
});
