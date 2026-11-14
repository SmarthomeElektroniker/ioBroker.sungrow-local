'use strict';

/*
 * 0.6.0: write commands with the current device value are not sent ("skip unchanged writes", default on),
 * write counters per register and a warning above N commands per day.
 */

const assert = require('node:assert');
const { loadMain, settle, NS } = require('../fakeAdapter');
const R = require('../../lib/registers');
const { registerWriteKey } = require('../../lib/diagnostics');
const ioPackage = require('../../io-package.json');

const createAdapter = loadMain();

/** @returns {any} Max SOC (factor 0.1, polled in group control) */
function maxSoc() {
    return R.normalise('holdingRegs', [
        { _address: 73031, name: 'Max SOC', type: 'uint16be', factor: 0.1, poll: true, group: 'control', allowWrite: true },
    ]).regs[0];
}

/**
 * @param {Record<string, any>} [config] Adapter configuration
 * @returns {Promise<{a: any, reg: any, id: string, sent: any[]}>} Adapter with a writable register (device value 50)
 */
async function setup(config = {}) {
    const a = createAdapter();
    a.config = { ...config };
    const reg = maxSoc();
    const id = `${NS}.${reg.id}`;
    a.regsById.set(id, reg);
    a.groupInterval.set('control', 60000);
    a.lastVal.set(id, 50);
    a.lastValAt.set(id, Date.now());
    const sent = [];
    a.poller = { write: (r, v) => sent.push([r.id, v]) };
    await a.createDiagnostics([], [reg]);
    return { a, reg, id, sent };
}

describe('writes: skip unchanged values', () => {
    it('defaults: on, warning above 50 commands per day', () => {
        assert.strictEqual(ioPackage.native.skipUnchangedWrites, true);
        assert.strictEqual(ioPackage.native.writeWarnPerDay, 50);
    });

    it('same value (also after rounding to the raw value) is not sent, but confirmed with ack=true', async () => {
        const { a, id, sent } = await setup();
        a.onStateChange(id, { val: 50, ack: false });
        a.onStateChange(id, { val: 50.04, ack: false }); // raw 500 like 50
        await settle();
        assert.deepStrictEqual(sent, []);
        assert.deepStrictEqual({ val: a.states[id].val, ack: a.states[id].ack }, { val: 50, ack: true });
        // the write log has ONE entry with a counter instead of one entry per command
        assert.strictEqual(a.writeLog.length, 1);
        assert.strictEqual(a.writeLog[0].result, 'unchanged');
    });

    it('a different value is sent', async () => {
        const { a, id, reg, sent } = await setup();
        a.onStateChange(id, { val: 60, ack: false });
        await settle();
        assert.deepStrictEqual(sent, [[reg.id, 60]]);
    });

    it('setting off: the same value is sent', async () => {
        const { a, id, reg, sent } = await setup({ skipUnchangedWrites: false });
        a.onStateChange(id, { val: 50, ack: false });
        await settle();
        assert.deepStrictEqual(sent, [[reg.id, 50]]);
    });

    it('old device value (older than two poll intervals) or unknown value: sent', async () => {
        const { a, id, reg, sent } = await setup();
        a.lastValAt.set(id, Date.now() - 3 * 60000);
        a.onStateChange(id, { val: 50, ack: false });
        a.lastVal.clear();
        a.onStateChange(id, { val: 50, ack: false });
        await settle();
        assert.deepStrictEqual(sent, [
            [reg.id, 50],
            [reg.id, 50],
        ]);
    });

    it('register not polled (no recent device value): sent', async () => {
        const { a, id, reg, sent } = await setup();
        reg.poll = false;
        a.onStateChange(id, { val: 50, ack: false });
        await settle();
        assert.strictEqual(sent.length, 1);
    });

    it('sameRaw compares the raw words after factor, offset and type', () => {
        const reg = maxSoc();
        assert.strictEqual(R.sameRaw(reg, 50, 50.04), true);
        assert.strictEqual(R.sameRaw(reg, 50, 50.1), false);
        assert.strictEqual(R.sameRaw(reg, '50', 50), true);
        assert.strictEqual(R.sameRaw(reg, 'x', 50), false);
        assert.strictEqual(R.sameRaw(reg, null, 50), false);
    });
});

describe('writes: counters per register', () => {
    it('counts commands (also skipped ones) and confirmed writes; objects below info.write.registers', async () => {
        const { a, id, reg } = await setup();
        const key = registerWriteKey(reg.id);
        assert.strictEqual(key, 'write.registers.holdingRegisters_1_73031_Max_SOC');
        assert.ok(a.objects[`${NS}.info.${key}.commandsToday`]);
        assert.ok(a.objects[`${NS}.info.${key}.writtenTotal`]);
        a.onStateChange(id, { val: 50, ack: false }); // skipped
        a.onStateChange(id, { val: 60, ack: false }); // sent
        await settle();
        // the confirmation read reports the written value
        const { EventEmitter } = require('node:events');
        const p = new EventEmitter();
        a.wirePoller(p, false);
        p.emit('readback', { reg, val: 60, requested: 60, written: true });
        await settle();
        assert.strictEqual(a.states[`${NS}.info.${key}.commandsToday`].val, 2);
        assert.strictEqual(a.states[`${NS}.info.${key}.commandsTotal`].val, 2);
        assert.strictEqual(a.states[`${NS}.info.${key}.writtenToday`].val, 1);
        assert.strictEqual(a.states[`${NS}.info.${key}.writtenTotal`].val, 1);
    });

    it('one warning when a register gets more than N commands a day', async () => {
        const { a, id, reg } = await setup({ writeWarnPerDay: 3 });
        for (let i = 0; i < 6; i++) {
            a.onStateChange(id, { val: 50, ack: false });
            await settle();
        }
        const w = a.logsOf('warn').filter(m => m.includes('write commands today'));
        assert.strictEqual(w.length, 1, w.join('\n'));
        assert.ok(w[0].startsWith(`${reg.id}: more than 3 write commands today`));
    });

    it('limit 0: no warning', async () => {
        const { a, id } = await setup({ writeWarnPerDay: 0 });
        for (let i = 0; i < 60; i++) {
            a.onStateChange(id, { val: 50, ack: false });
        }
        await settle();
        assert.strictEqual(a.logsOf('warn').filter(m => m.includes('write commands today')).length, 0);
    });

    it('registers not released for writing get no counters; counters of a register no longer released go away', async () => {
        const { a, reg } = await setup();
        const ch = `${NS}.info.${registerWriteKey(reg.id)}`;
        assert.ok(a.objects[ch]);
        await a.createDiagnostics([], []);
        assert.strictEqual(a.objects[ch], undefined);
        assert.strictEqual(a.objects[`${ch}.commandsToday`], undefined);
        assert.strictEqual(a.objects[`${NS}.info.write.registers`], undefined);
    });
});
