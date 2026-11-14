'use strict';

/*
 * 0.6.0 (forum thread 85824, review by Bluefox):
 * 1. async work started without await never ends in an unhandled rejection (js-controller would restart the
 *    instance); while the adapter stops, such errors are only logged on debug level.
 * 2. objects of registers that are no longer configured are only deleted when they have no custom settings
 *    (history, InfluxDB, SQL); otherwise they stay, marked as orphaned, with a warning.
 */

const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { loadMain, settle, NS } = require('../fakeAdapter');
const { Poller } = require('../../lib/poller');
const R = require('../../lib/registers');

const createAdapter = loadMain();

/** Collects unhandled rejections while a test runs */
function trackUnhandled() {
    const seen = [];
    const handler = e => seen.push(e);
    process.on('unhandledRejection', handler);
    return {
        seen,
        stop: () => process.removeListener('unhandledRejection', handler),
    };
}

/** @returns {any} A live register and a writable holding register */
function regs() {
    return [
        ...R.normalise('inputRegs', [{ _address: 35017, name: 'Total DC Power', type: 'uint32sw', group: 'live' }]).regs,
        ...R.normalise('holdingRegs', [
            { _address: 73031, name: 'Max SOC', type: 'uint16be', factor: 0.1, poll: true, group: 'control' },
        ]).regs,
    ];
}

/** Emits every poller event main.js listens to */
function emitAll(p, [live, soc]) {
    p.emit('connection', false);
    p.emit('reconnect', { reason: 'test' });
    p.emit('values', { group: 'live', values: [{ reg: live, val: Math.random() }] });
    p.emit('request', { group: 'live', ok: true, ms: 5, block: 'x' });
    p.emit('request', { group: '_write', ok: false, error: 'x', block: 'x' });
    p.emit('skipped', { group: 'live' });
    p.emit('round', { group: 'live', ms: 5, blocks: 1, failed: 0 });
    p.emit('readback', { reg: soc, val: 50, requested: 50, written: true });
    p.emit('readbackFailed', { reg: soc, error: 'x' });
    p.emit('writeFailed', { reg: soc, requested: 50, error: 'x' });
}

describe('robustness: no unhandled rejections (Bluefox, forum 85824)', () => {
    it('setState rejecting during unload: no unhandled rejection, no error log, only debug', async () => {
        const track = trackUnhandled();
        try {
            const a = createAdapter();
            const list = regs();
            for (const r of list) {
                a.regsById.set(`${NS}.${r.id}`, r);
                a.lastVal.set(`${NS}.${r.id}`, 1);
            }
            a.diag.set('groups.live', { requestsToday: 0, skippedToday: 0 });
            a.diag.set('write', { okTotal: 0, failedTotal: 0 });
            const p = new EventEmitter();
            a.wirePoller(p, false);
            await new Promise(resolve => a.onUnload(resolve));
            a.failSetState = new Error('DB closed');
            emitAll(p, list);
            // commands that restore the device value (not released / read-only)
            a.onStateChange(`${NS}.${list[0].id}`, { val: 5, ack: false });
            await settle();
            assert.deepStrictEqual(track.seen, [], 'no unhandled rejection');
            assert.deepStrictEqual(a.logsOf('error'), [], 'no error log while stopping');
            assert.ok(
                a.logsOf('debug').some(m => m.includes('DB closed') && m.includes('stopping')),
                'logged on debug level',
            );
        } finally {
            track.stop();
        }
    });

    it('setState rejecting while running: logged as error, at most once per task and minute (no log storm)', async () => {
        const track = trackUnhandled();
        try {
            const a = createAdapter();
            const [live] = regs();
            const p = new EventEmitter();
            a.wirePoller(p, true);
            a.failSetState = new Error('DB closed');
            for (let i = 0; i < 20; i++) {
                p.emit('values', { group: 'live', values: [{ reg: live, val: i }] });
            }
            await settle();
            assert.deepStrictEqual(track.seen, []);
            const errors = a.logsOf('error');
            assert.strictEqual(errors.length, 1, errors.join('\n'));
            assert.ok(errors[0].includes('register values: DB closed'));
        } finally {
            track.stop();
        }
    });

    it('a failing start is logged and restarts the instance (no unhandled rejection)', async () => {
        const track = trackUnhandled();
        try {
            const a = createAdapter();
            a.failSetState = new Error('no states DB');
            a.emit('ready');
            await settle();
            assert.deepStrictEqual(track.seen, []);
            assert.ok(a.logsOf('error').some(m => m.startsWith('Start failed: no states DB')));
            assert.strictEqual(a.restarted, 1);
        } finally {
            track.stop();
        }
    });

    it('poller: rejections of connect/close in the background are caught (debug after stop)', async () => {
        const track = trackUnhandled();
        const logs = [];
        const log = { debug: m => logs.push(['debug', m]), info() {}, warn() {}, error: m => logs.push(['error', m]) };
        try {
            const p = new Poller({
                host: '127.0.0.1',
                port: 1,
                groups: [],
                createClient: () => {
                    throw new Error('no client');
                },
                timers: { setTimeout, clearTimeout },
                reconnectDelay: 100000,
                log,
            });
            const failed = [];
            p.on('connectFailed', e => failed.push(e));
            p.start();
            await settle();
            assert.strictEqual(failed.length, 1, 'a throwing client factory is a failed connect');
            assert.strictEqual(p.connecting, false, 'not stuck in "connecting"');
            await p.stop();
            // closing fails while the poller drops the connection after stop
            p._closeClient = () => Promise.reject(new Error('socket gone'));
            p._drop('test');
            await settle();
            assert.deepStrictEqual(track.seen, []);
            assert.ok(logs.some(([l, m]) => l === 'debug' && m.includes('socket gone')));
            assert.ok(!logs.some(([l]) => l === 'error'));
        } finally {
            track.stop();
        }
    });
});

describe('register clean-up keeps custom settings (Bluefox, forum 85824)', () => {
    const keepId = `${NS}.inputRegisters.1.35999_Old_with_history`;
    const delId = `${NS}.inputRegisters.1.35998_Old_without_custom`;

    /** @returns {any} Adapter with one configured register and two that are no longer configured */
    async function prepared() {
        const a = createAdapter();
        a.objects[keepId] = {
            _id: keepId,
            type: 'state',
            common: { name: 'old', custom: { 'history.0': { enabled: true } } },
            native: {},
        };
        a.objects[delId] = { _id: delId, type: 'state', common: { name: 'old' }, native: {} };
        await a.createRegisterObjects(regs());
        return a;
    }

    it('a register with custom settings stays, is marked as orphaned and a warning names it', async () => {
        const a = await prepared();
        const o = a.objects[keepId];
        assert.ok(o, 'object kept');
        assert.deepStrictEqual(o.common.custom, { 'history.0': { enabled: true } }, 'custom settings unchanged');
        assert.strictEqual(o.native.orphaned, true);
        assert.ok(o.native.orphanedSince);
        const w = a.logsOf('warn').find(m => m.includes(keepId));
        assert.ok(w, 'warning');
        assert.ok(w.includes('history.0') && w.includes('no longer configured'), w);
    });

    it('a register without custom settings is deleted as before', async () => {
        const a = await prepared();
        assert.strictEqual(a.objects[delId], undefined);
        assert.ok(a.logsOf('info').some(m => m.includes(`Removing ${delId}`)));
    });

    it('configured registers are untouched; the mark goes away when the register is configured again', async () => {
        const a = await prepared();
        const [live] = regs();
        assert.ok(a.objects[`${NS}.${live.id}`]);
        // the user ticks the old register again
        const again = R.normalise('inputRegs', [
            { _address: 35999, name: 'Old with history', type: 'uint16be', group: 'live' },
        ]).regs;
        assert.strictEqual(`${NS}.${again[0].id}`, keepId);
        await a.createRegisterObjects([...regs(), ...again]);
        const o = a.objects[keepId];
        assert.strictEqual(o.native.orphaned, undefined);
        assert.strictEqual(o.native.orphanedSince, undefined);
        assert.deepStrictEqual(o.common.custom, { 'history.0': { enabled: true } });
    });

    it('legacy ID: settings move to the new ID; when both have settings of the same instance the old one stays', async () => {
        const a = createAdapter();
        const oldId = `${NS}.holdingRegisters.1.53051_Charge/discharge_command`;
        const newId = `${NS}.holdingRegisters.1.53051_Charge_discharge_command`;
        a.objects[oldId] = {
            _id: oldId,
            type: 'state',
            common: { name: 'x', custom: { 'history.0': { enabled: true }, 'influxdb.0': { enabled: true } } },
            native: {},
        };
        a.objects[newId] = {
            _id: newId,
            type: 'state',
            common: { name: 'x', custom: { 'history.0': { enabled: true, own: 1 } } },
            native: {},
        };
        assert.strictEqual(await a.moveStateObject(oldId, newId, { enums: {} }), true);
        // influxdb moved (aliasId = old ID), the own history setting of the new object stays
        assert.deepStrictEqual(a.objects[newId].common.custom['influxdb.0'], { enabled: true, aliasId: oldId });
        assert.deepStrictEqual(a.objects[newId].common.custom['history.0'], { enabled: true, own: 1 });
        assert.ok(a.objects[oldId], 'old object with its own history setting stays');
        // without a conflict the old object is deleted
        const b = createAdapter();
        b.objects[oldId] = JSON.parse(JSON.stringify(a.objects[oldId]));
        delete b.objects[oldId].native.orphaned;
        assert.strictEqual(await b.moveStateObject(oldId, newId, { enums: {} }), true);
        assert.strictEqual(b.objects[oldId], undefined);
        assert.deepStrictEqual(b.objects[newId].common.custom['history.0'], { enabled: true, aliasId: oldId });
    });

    it('diagnostics of an inactive group: states with custom settings and their channel stay', async () => {
        const a = createAdapter();
        const ch = `${NS}.info.groups.old`;
        a.objects[ch] = { _id: ch, type: 'channel', common: { name: 'old' }, native: {} };
        a.objects[`${ch}.timeoutsToday`] = {
            _id: `${ch}.timeoutsToday`,
            type: 'state',
            common: { custom: { 'history.0': { enabled: true } } },
            native: {},
        };
        a.objects[`${ch}.errorsToday`] = { _id: `${ch}.errorsToday`, type: 'state', common: {}, native: {} };
        const gone = `${NS}.info.groups.gone`;
        a.objects[gone] = { _id: gone, type: 'channel', common: {}, native: {} };
        a.objects[`${gone}.errorsToday`] = { _id: `${gone}.errorsToday`, type: 'state', common: {}, native: {} };
        await a.createDiagnostics([{ name: 'live' }]);
        assert.ok(a.objects[ch], 'channel stays');
        assert.strictEqual(a.objects[`${ch}.timeoutsToday`].native.orphaned, true);
        assert.strictEqual(a.objects[`${ch}.errorsToday`], undefined);
        assert.strictEqual(a.objects[gone], undefined, 'channel without custom settings is deleted');
        assert.strictEqual(a.objects[`${gone}.errorsToday`], undefined);
        assert.ok(a.logsOf('warn').some(m => m.includes(`${ch}.timeoutsToday`)));
    });
});
