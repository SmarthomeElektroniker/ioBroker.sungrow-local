'use strict';

/*
 * Safe battery control (0.6.0, experimental, off by default). Writes only against fakes: a recording poller
 * and the simulated WiNet-S2 (test/fakeWinet.js) - never against a real inverter.
 */

const assert = require('node:assert');
const ModbusRTU = require('modbus-serial');
const { EventEmitter } = require('node:events');
const B = require('../../lib/batteryControl');
const { Poller } = require('../../lib/poller');
const { createFakeWinet } = require('../fakeWinet');
const { loadMain, settle, NS } = require('../fakeAdapter');
const ioPackage = require('../../io-package.json');

const createAdapter = loadMain();
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Recording poller: every write is confirmed with the written value (or fails for listed aliases) */
function fakePoller(failAliases = []) {
    const p = new EventEmitter();
    p.connected = true;
    p.writes = [];
    p.write = (reg, value) => {
        p.writes.push([reg.alias, value]);
        setImmediate(() => {
            if (failAliases.includes(reg.alias)) {
                p.emit('writeFailed', { reg, requested: value, error: 'Modbus exception 2' });
            } else {
                p.emit('readback', { reg, val: value, requested: value, written: true });
            }
        });
    };
    return p;
}

/**
 * @param {Record<string, any>} config Configuration
 * @param {string[]} [fail] Failing aliases
 */
async function setup(config, fail) {
    const a = createAdapter();
    a.config = { readOnly: false, ...config };
    const p = fakePoller(fail);
    a.poller = p;
    a.wirePoller(p, false);
    await a.setupBatteryControl();
    return { a, p };
}

/** @param {any} a Adapter @param {string} mode Mode */
async function command(a, mode, minutes = 30, target = 90) {
    a.states[`${NS}.control.battery.minutes`] = { val: minutes, ack: true };
    a.states[`${NS}.control.battery.targetSoc`] = { val: target, ack: true };
    a.onStateChange(`${NS}.control.battery.mode`, { val: mode, ack: false });
    for (let i = 0; i < 6; i++) {
        await settle();
    }
}

describe('battery control: rules', () => {
    it('off by default, limits in io-package', () => {
        assert.strictEqual(ioPackage.native.batteryControl, false);
        assert.strictEqual(ioPackage.native.batteryMaxMinutes, 240);
        assert.strictEqual(ioPackage.native.batteryMinPause, 60);
        assert.strictEqual(ioPackage.native.batteryMaxPerDay, 12);
    });

    it('plans: normal and hold switch the window off first; charge sets the window last', () => {
        assert.deepStrictEqual(B.plan('normal'), [
            [73208, 0x55],
            [53051, 0xcc],
            [53050, 0],
        ]);
        assert.deepStrictEqual(B.plan('hold'), [
            [73208, 0x55],
            [53051, 0xcc],
            [53050, 2],
        ]);
        const start = new Date(2026, 10, 14, 13, 5);
        assert.deepStrictEqual(B.plan('charge', { start, minutes: 90, target: 80 }), [
            [53051, 0xcc],
            [53050, 0],
            [73209, 1],
            [73210, 13],
            [73211, 5],
            [73212, 14],
            [73213, 35],
            [73214, 80],
            [73208, 0xaa],
        ]);
    });

    it('the charge window ends at 23:59 at the latest (time of day of the inverter)', () => {
        const end = B.windowEnd(new Date(2026, 10, 14, 23, 0), 120);
        assert.deepStrictEqual([end.getHours(), end.getMinutes(), end.getDate()], [23, 59, 14]);
    });

    it('rejections: off, read-only, duration, target, pause, changes per day; normal is always allowed', () => {
        const base = { enabled: true, readOnly: false, maxMinutes: 240, minPause: 60, maxPerDay: 3, lastChange: 0, changesToday: 0, now: 1e9 };
        assert.match(B.check({ mode: 'hold', minutes: 10 }, { ...base, enabled: false }), /switched off/);
        assert.match(B.check({ mode: 'normal' }, { ...base, readOnly: true }), /read-only/);
        assert.match(B.check({ mode: 'hold', minutes: 241 }, base), /duration/);
        assert.match(B.check({ mode: 'hold', minutes: 0 }, base), /duration/);
        assert.match(B.check({ mode: 'charge', minutes: 10, target: 5 }, base), /target/);
        assert.match(B.check({ mode: 'hold', minutes: 10 }, { ...base, lastChange: 1e9 - 30000 }), /minimum pause/);
        assert.match(B.check({ mode: 'charge', minutes: 10, target: 80 }, { ...base, changesToday: 3 }), /changes today/);
        assert.match(B.check({ mode: 'boost', minutes: 10 }, base), /unknown mode/);
        assert.strictEqual(B.check({ mode: 'normal' }, { ...base, lastChange: 1e9 - 1000, changesToday: 99 }), '');
        assert.strictEqual(B.check({ mode: 'charge', minutes: 30, target: 80 }, base), '');
    });
});

describe('battery control: adapter', () => {
    it('switched off: no objects, a command writes nothing', async () => {
        const { a, p } = await setup({});
        assert.strictEqual(a.objects[`${NS}.control.battery`], undefined);
        await command(a, 'charge');
        assert.deepStrictEqual(p.writes, []);
    });

    it('switched on: objects; charge writes the window and confirms; the time limit returns to normal', async () => {
        const { a, p } = await setup({ batteryControl: true });
        assert.ok(a.objects[`${NS}.control.battery.mode`]);
        assert.ok(a.objects[`${NS}.control.battery.until`]);
        await command(a, 'charge', 30, 90);
        assert.deepStrictEqual(
            p.writes.map(w => w[0]),
            [53051, 53050, 73209, 73210, 73211, 73212, 73213, 73214, 73208],
        );
        assert.strictEqual(a.states[`${NS}.control.battery.active`].val, 'charge');
        assert.ok(a.states[`${NS}.control.battery.until`].val > Date.now());
        assert.match(a.states[`${NS}.control.battery.lastResult`].val, /charge: ok/);
        assert.ok(a.battery.timer, 'return timer armed');
        // time limit (called directly instead of waiting 30 min)
        p.writes.length = 0;
        await a.battery.run({ mode: 'normal' }, 'time limit');
        for (let i = 0; i < 6; i++) {
            await settle();
        }
        assert.deepStrictEqual(p.writes, [
            [73208, 0x55],
            [53051, 0xcc],
            [53050, 0],
        ]);
        assert.strictEqual(a.states[`${NS}.control.battery.active`].val, 'normal');
        assert.strictEqual(a.battery.timer, null);
    });

    it('read-only instance: rejected, the command state shows the active mode again', async () => {
        const { a, p } = await setup({ batteryControl: true, readOnly: true });
        await command(a, 'hold');
        assert.deepStrictEqual(p.writes, []);
        assert.strictEqual(a.states[`${NS}.control.battery.mode`].val, 'normal');
        assert.ok(a.logsOf('warn').some(m => m.includes('read-only')));
    });

    it('minimum pause between two changes', async () => {
        const { a, p } = await setup({ batteryControl: true, batteryMinPause: 600 });
        await command(a, 'hold', 10);
        const n = p.writes.length;
        await command(a, 'charge', 10, 80);
        assert.strictEqual(p.writes.length, n, 'second change rejected');
        assert.match(a.states[`${NS}.control.battery.lastResult`].val, /minimum pause/);
        // back to normal is always possible
        await command(a, 'normal');
        assert.strictEqual(a.states[`${NS}.control.battery.active`].val, 'normal');
    });

    it('a failed write of hold/charge returns to normal', async () => {
        const { a, p } = await setup({ batteryControl: true }, [53050]);
        await command(a, 'hold', 10);
        for (let i = 0; i < 6; i++) {
            await settle();
        }
        assert.ok(a.logsOf('error').some(m => m.includes('"hold" not completely written')));
        // after the failed hold the normal plan was sent (53050 fails again in this fake)
        assert.deepStrictEqual(p.writes.slice(-3), [
            [73208, 0x55],
            [53051, 0xcc],
            [53050, 0],
        ]);
        assert.notStrictEqual(a.states[`${NS}.control.battery.active`] && a.states[`${NS}.control.battery.active`].val, 'hold');
    });

    it('after a restart: an expired mode returns to normal after the connect; a running one keeps its limit', async () => {
        const a = createAdapter();
        a.config = { batteryControl: true };
        a.states[`${NS}.control.battery.active`] = { val: 'hold', ack: true };
        a.states[`${NS}.control.battery.until`] = { val: Date.now() - 1000, ack: true };
        const p = fakePoller();
        a.poller = p;
        a.wirePoller(p, false);
        await a.setupBatteryControl();
        assert.strictEqual(a.battery.fallbackOnConnect, true);
        p.emit('connection', true);
        for (let i = 0; i < 6; i++) {
            await settle();
        }
        assert.deepStrictEqual(p.writes.map(w => w[0]), [73208, 53051, 53050]);
        assert.strictEqual(a.states[`${NS}.control.battery.active`].val, 'normal');

        const b = createAdapter();
        b.config = { batteryControl: true };
        b.states[`${NS}.control.battery.active`] = { val: 'hold', ack: true };
        b.states[`${NS}.control.battery.until`] = { val: Date.now() + 600000, ack: true };
        await b.setupBatteryControl();
        assert.strictEqual(b.battery.fallbackOnConnect, false);
        assert.ok(b.battery.timer);
        b.battery.stop();
    });

    it('switched off while a mode is still active: back to normal first, objects stay until then', async () => {
        const a = createAdapter();
        a.config = {};
        a.objects[`${NS}.control.battery`] = { _id: `${NS}.control.battery`, type: 'channel', common: {}, native: {} };
        a.states[`${NS}.control.battery.active`] = { val: 'charge', ack: true };
        a.states[`${NS}.control.battery.until`] = { val: Date.now() + 600000, ack: true };
        await a.setupBatteryControl();
        assert.strictEqual(a.battery.fallbackOnConnect, true);
        assert.ok(a.objects[`${NS}.control.battery`]);
        // without a stored mode the objects are removed
        const b = createAdapter();
        b.config = {};
        b.objects[`${NS}.control.battery`] = { _id: `${NS}.control.battery`, type: 'channel', common: {}, native: {} };
        b.objects[`${NS}.control.battery.mode`] = { _id: `${NS}.control.battery.mode`, type: 'state', common: {}, native: {} };
        await b.setupBatteryControl();
        assert.strictEqual(b.objects[`${NS}.control.battery`], undefined);
        assert.strictEqual(b.objects[`${NS}.control.battery.mode`], undefined);
    });
});

describe('battery control: against the simulated WiNet-S2', function () {
    this.timeout(15000);
    let fake;
    let p;
    afterEach(async () => {
        if (p) {
            await p.stop();
        }
        if (fake) {
            await fake.close();
        }
    });

    it('charge and the return to normal end with the expected register contents', async () => {
        fake = await createFakeWinet();
        const log = { debug() {}, info() {}, warn() {}, error() {} };
        p = new Poller({
            host: fake.host,
            port: fake.port,
            groups: [],
            requestGap: 5,
            writeTimeout: 600,
            createClient: () => new ModbusRTU(),
            timers: { setTimeout, clearTimeout },
            log,
        });
        const a = createAdapter();
        a.config = { batteryControl: true, batteryMinPause: 0 };
        a.poller = p;
        a.wirePoller(p, false);
        await a.setupBatteryControl();
        p.start();
        const t0 = Date.now();
        while (!p.connected && Date.now() - t0 < 3000) {
            await sleep(20);
        }
        await command(a, 'charge', 45, 85);
        const t1 = Date.now();
        while ((a.states[`${NS}.control.battery.active`] || {}).val !== 'charge' && Date.now() - t1 < 5000) {
            await sleep(20);
        }
        const h = addr => fake.state.units[1].holding.get(addr - 40001);
        assert.strictEqual(h(73208), 0xaa);
        assert.strictEqual(h(73214), 85);
        assert.strictEqual(h(73209), 1);
        assert.strictEqual(h(53050), 0);
        assert.strictEqual(h(53051), 0xcc);
        await command(a, 'normal');
        const t2 = Date.now();
        while (h(73208) !== 0x55 && Date.now() - t2 < 5000) {
            await sleep(20);
        }
        assert.strictEqual(h(73208), 0x55);
        a.battery.stop();
    });
});
