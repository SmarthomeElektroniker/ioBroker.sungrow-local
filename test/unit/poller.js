'use strict';

/*
 * The coordinator against a simulated WiNet-S2 (real TCP, real modbus-serial client, short timings).
 */

const assert = require('node:assert');
const ModbusRTU = require('modbus-serial');
const { Poller } = require('../../lib/poller');
const R = require('../../lib/registers');
const { createFakeWinet } = require('../fakeWinet');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const quiet = { debug() {}, info() {}, warn() {}, error() {} };

/** Registers of the test: three live values of unit 1, the battery block of unit 2, two holding registers */
function testRegs() {
    const input = R.normalise('inputRegs', [
        { _address: 35017, name: 'Total DC Power', type: 'uint32sw', factor: 1, group: 'live' },
        { _address: 35019, name: 'Spannung Ph A', type: 'int16be', factor: 0.1, group: 'live' },
        { _address: 40741, name: 'Bat Voltage', type: 'uint16be', factor: 0.1, deviceId: 2, group: 'akku' },
        { _address: 40744, name: 'Battery level', type: 'uint16be', factor: 0.1, deviceId: 2, group: 'akku' },
        { _address: 40746, name: 'Total Charge Energie', type: 'int32sw', factor: 0.1, deviceId: 2, group: 'akku' },
        { _address: 40748, name: 'Total Discharge Energie', type: 'int32sw', factor: 0.1, deviceId: 2, group: 'akku' },
    ]).regs;
    const holding = R.normalise('holdingRegs', [
        { _address: 73031, name: 'Max SOC', type: 'uint16be', factor: 0.1, poll: true, group: 'steuerung' },
        { _address: 53052, name: 'Charge/discharge power', type: 'uint16be', factor: 1, poll: true, group: 'steuerung' },
        { _address: 53060, name: 'Long value', type: 'uint32sw', factor: 1, poll: true, group: 'steuerung' },
    ]).regs;
    return { input, holding, all: [...input, ...holding] };
}

/**
 * @param {any} fake Fake server
 * @param {Record<string, any>} [over] Option overrides
 * @returns {{p: Poller, ev: Record<string, any[]>, regs: ReturnType<typeof testRegs>}} Poller with recorded events
 */
function makePoller(fake, over = {}) {
    const regs = testRegs();
    const group = (name, interval, timeout, pauseAfter) => {
        const members = regs.all.filter(r => r.group === name);
        const blocks = [];
        for (const t of ['inputRegs', 'holdingRegs']) {
            for (const u of [1, 2]) {
                blocks.push(...R.buildBlocks(members.filter(r => r.regType === t && r.deviceId === u)));
            }
        }
        return { name, interval, timeout, pauseAfter, blocks };
    };
    const p = new Poller({
        host: fake.host,
        port: fake.port,
        groups: over.groups || [
            group('live', 150, 300, 0),
            group('steuerung', 1000, 300, 0),
            group('akku', 600, 400, 150),
        ],
        requestGap: 10,
        reconnectAfter: 3,
        reconnectDelay: 300,
        connectTimeout: 1000,
        writeTimeout: 600,
        writeRetries: 1,
        writeMaxAge: 5000,
        doNotUseWriteMultipleRegisters: true,
        round: 10000,
        createClient: () => new ModbusRTU(),
        timers: { setTimeout, clearTimeout },
        log: quiet,
        ...over,
    });
    const ev = {
        connection: [],
        values: [],
        request: [],
        readback: [],
        writeFailed: [],
        reconnect: [],
        skipped: [],
        round: [],
    };
    for (const k of Object.keys(ev)) {
        p.on(k, e => ev[k].push({ t: Date.now(), ...(typeof e === 'object' ? e : { value: e }) }));
    }
    return { p, ev, regs };
}

/**
 * @param {() => boolean} pred Condition
 * @param {number} ms Max wait
 */
async function until(pred, ms = 5000) {
    const end = Date.now() + ms;
    while (!pred()) {
        if (Date.now() > end) {
            throw new Error('condition not reached');
        }
        await sleep(20);
    }
}

/** @param {any} fake Fake server */
function fillDevice(fake) {
    // 35017 Total DC Power = 70000 W (uint32sw: low word first), 35019 = 231.4 V
    fake.set(1, 'input', 5016, [70000 & 0xffff, 70000 >>> 16]);
    fake.set(1, 'input', 5018, [2314]);
    // unit 2: 40741 = 412.3 V, 40744 SoC 97.0 %
    fake.set(2, 'input', 10740, [4123]);
    fake.set(2, 'input', 10743, [970]);
    fake.set(1, 'holding', 33030, [1000]);
    fake.set(1, 'holding', 13051, [0]);
}

/**
 * @param {Record<string, any[]>} ev Events
 * @param {string} id State ID
 * @returns {any[]} Values of that register
 */
function valuesOf(ev, id) {
    return ev.values.flatMap(e => e.values.filter(v => v.reg.id === id).map(v => ({ t: e.t, val: v.val })));
}

describe('poller against the simulated WiNet-S2', function () {
    this.timeout(20000);
    let fake;
    let poller;

    beforeEach(async () => {
        fake = await createFakeWinet({
            units: { 1: { latency: 10, busTimeout: 200 }, 2: { latency: 40, busGap: 150, busTimeout: 300 } },
        });
        fillDevice(fake);
    });
    afterEach(async () => {
        if (poller) {
            await poller.stop();
            poller = null;
        }
        await fake.close();
    });

    it('reads every group in its own interval over ONE connection with the expected requests', async () => {
        const { p, ev } = makePoller(fake);
        poller = p;
        p.start();
        await sleep(1400);
        assert.strictEqual(fake.state.connections, 1);
        assert.strictEqual(fake.state.maxParallelConnections, 1);
        const live = valuesOf(ev, 'inputRegisters.1.35017_Total_DC_Power');
        assert.ok(live.length >= 6, `live polled ${live.length} times`);
        assert.strictEqual(live[0].val, 70000);
        assert.strictEqual(valuesOf(ev, 'inputRegisters.1.35019_Spannung_Ph_A')[0].val, 231.4);
        assert.strictEqual(valuesOf(ev, 'inputRegisters.2.40744_Battery_level')[0].val, 97);
        const akkuReq = fake.count(r => r.unit === 2);
        assert.ok(akkuReq >= 2 && akkuReq <= 3, `battery requested ${akkuReq} times in 1.4 s at 600 ms`);
        // the battery block is the same request ioBroker.modbus sent: FC4 address 10740 quantity 9 unit 2
        assert.ok(fake.state.requests.filter(r => r.unit === 2).every(r => r.fc === 4 && r.addr === 10740 && r.qty === 9));
        // strictly serial: never more than one request on the bus
        const reqs = fake.state.requests;
        for (let i = 1; i < reqs.length; i++) {
            assert.ok(reqs[i].t >= reqs[i - 1].t);
        }
    });

    it('keeps a pause after battery requests (5 s instruction interval of the SBH400, scaled)', async () => {
        const { p } = makePoller(fake);
        poller = p;
        p.start();
        await sleep(1500);
        const reqs = fake.state.requests;
        for (let i = 0; i < reqs.length - 1; i++) {
            if (reqs[i].unit === 2) {
                // latency 40 + pauseAfter 150 => the next request leaves at least ~190 ms later
                assert.ok(reqs[i + 1].t - reqs[i].t >= 180, `gap after unit 2: ${reqs[i + 1].t - reqs[i].t} ms`);
            }
        }
    });

    it('a timeout of unit 2 only fails that block: unit-1 values go on, no reconnect, connection stays', async () => {
        const { p, ev } = makePoller(fake);
        poller = p;
        p.start();
        await until(() => valuesOf(ev, 'inputRegisters.2.40744_Battery_level').length >= 1);
        fake.drop(2, 3);
        const tDrop = Date.now();
        await until(() => ev.request.filter(r => r.group === 'akku' && !r.ok).length >= 3, 6000);
        const tEnd = Date.now();
        // unit 1 kept delivering while unit 2 failed
        const liveDuring = valuesOf(ev, 'inputRegisters.1.35017_Total_DC_Power').filter(v => v.t > tDrop && v.t < tEnd);
        assert.ok(liveDuring.length >= 5, `live values during the battery outage: ${liveDuring.length}`);
        const fails = ev.request.filter(r => !r.ok);
        assert.ok(
            fails.every(r => r.group === 'akku' && r.timeout),
            `only battery requests failed, as timeouts: ${JSON.stringify(fails)}`,
        );
        assert.strictEqual(ev.reconnect.length, 0);
        assert.deepStrictEqual(
            ev.connection.map(c => c.value),
            [true],
        );
        assert.strictEqual(fake.state.connections, 1);
        // battery recovers with the next round
        const before = valuesOf(ev, 'inputRegisters.2.40744_Battery_level').length;
        await until(() => valuesOf(ev, 'inputRegisters.2.40744_Battery_level').length > before, 3000);
    });

    it('a late answer (after the timeout) is not mistaken for the answer of the next request', async () => {
        const { p, ev } = makePoller(fake);
        poller = p;
        p.start();
        await until(() => valuesOf(ev, 'inputRegisters.2.40744_Battery_level').length >= 1);
        fake.late(2, 1, 500); // client timeout for the battery group is 400 ms
        await until(() => ev.request.some(r => r.group === 'akku' && !r.ok), 3000);
        await sleep(800);
        for (const v of valuesOf(ev, 'inputRegisters.1.35017_Total_DC_Power')) {
            assert.strictEqual(v.val, 70000);
        }
        assert.ok(valuesOf(ev, 'inputRegisters.1.35019_Spannung_Ph_A').every(v => v.val === 231.4));
        assert.strictEqual(ev.reconnect.length, 0);
    });

    it('a Modbus exception is an answer: block fails, no reconnect', async () => {
        fake.state.units[2].exceptions.add(10743);
        const { p, ev } = makePoller(fake, { reconnectAfter: 2 });
        poller = p;
        p.start();
        await until(() => ev.request.filter(r => r.group === 'akku' && !r.ok).length >= 3, 5000);
        assert.ok(ev.request.filter(r => r.group === 'akku' && !r.ok).every(r => !r.timeout && /exception/i.test(r.error)));
        assert.strictEqual(ev.reconnect.length, 0);
    });

    it('writes go before the next read, are confirmed by reading back and report the device value', async () => {
        const { p, ev, regs } = makePoller(fake);
        poller = p;
        p.start();
        await until(() => valuesOf(ev, 'inputRegisters.1.35017_Total_DC_Power').length >= 2);
        const maxSoc = regs.holding.find(r => r.alias === 73031);
        // make sure reads are waiting in the queue
        p.pollNow('akku');
        p.pollNow('steuerung');
        p.pollNow('live');
        const queuedReads = p.queueLength;
        const idx0 = fake.state.requests.length;
        p.write(maxSoc, 95);
        await until(() => ev.readback.length === 1, 3000);
        const after = fake.state.requests.slice(idx0);
        const iw = after.findIndex(r => r.fc === 6);
        assert.ok(queuedReads >= 2, `reads were waiting: ${queuedReads}`);
        assert.ok(iw >= 0 && iw <= 1, `write was request #${iw} after the call (at most the running one before it)`);
        assert.deepStrictEqual([after[iw].unit, after[iw].addr, after[iw].value], [1, 33030, 950]);
        assert.deepStrictEqual([after[iw + 1].fc, after[iw + 1].addr, after[iw + 1].qty], [3, 33030, 1], 'confirmation read');
        assert.deepStrictEqual(
            [ev.readback[0].val, ev.readback[0].requested, ev.readback[0].written],
            [95, 95, true],
        );
    });

    it('writing the SAME value is confirmed as well (ack must follow even without a change)', async () => {
        const { p, ev, regs } = makePoller(fake);
        poller = p;
        p.start();
        await until(() => ev.connection.length >= 1);
        const maxSoc = regs.holding.find(r => r.alias === 73031);
        p.write(maxSoc, 100); // device already has 100.0 %
        await until(() => ev.readback.length === 1, 3000);
        assert.deepStrictEqual([ev.readback[0].val, ev.readback[0].written], [100, true]);
    });

    it('doNotUseWriteMultipleRegisters: a 32-bit value is written with two FC6 requests', async () => {
        const { p, ev, regs } = makePoller(fake);
        poller = p;
        p.start();
        await until(() => ev.connection.length >= 1);
        p.write(
            regs.holding.find(r => r.alias === 53060),
            70000,
        );
        await until(() => ev.readback.length === 1, 3000);
        const w = fake.state.requests.filter(r => r.fc === 6 || r.fc === 16);
        assert.deepStrictEqual(
            w.map(r => [r.fc, r.addr, r.value]),
            [
                [6, 13059, 70000 & 0xffff],
                [6, 13060, 70000 >>> 16],
            ],
        );
        assert.strictEqual(ev.readback[0].val, 70000);
    });

    it('a write whose answer is lost is retried, then confirmed', async () => {
        const { p, ev, regs } = makePoller(fake);
        poller = p;
        p.start();
        await until(() => ev.connection.length >= 1);
        fake.drop(1, 1);
        // the next unit-1 request is dropped - make it the write
        p.write(
            regs.holding.find(r => r.alias === 53052),
            3000,
        );
        await until(() => ev.readback.length === 1, 4000);
        assert.strictEqual(ev.readback[0].val, 3000);
        assert.strictEqual(fake.state.units[1].holding.get(13051), 3000);
    });

    it('reconnects only after N failures in a row and continues afterwards', async () => {
        const { p, ev } = makePoller(fake);
        poller = p;
        p.start();
        await until(() => valuesOf(ev, 'inputRegisters.1.35017_Total_DC_Power').length >= 2);
        fake.stall(true);
        await until(() => ev.reconnect.length === 1, 5000);
        const fails = ev.request.filter(r => !r.ok);
        assert.ok(fails.length >= 3);
        assert.deepStrictEqual(
            ev.connection.map(c => c.value),
            [true, false],
        );
        fake.stall(false);
        await until(() => ev.connection.length === 3, 3000);
        const n = valuesOf(ev, 'inputRegisters.1.35017_Total_DC_Power').length;
        await until(() => valuesOf(ev, 'inputRegisters.1.35017_Total_DC_Power').length > n, 2000);
        assert.strictEqual(fake.state.connections, 2);
        assert.strictEqual(fake.state.maxParallelConnections, 1, 'never two connections at the same time');
    });

    it('a closed socket is a real connection loss: connection false, reconnect, values again', async () => {
        const { p, ev } = makePoller(fake);
        poller = p;
        p.start();
        await until(() => ev.connection.length === 1);
        fake.kick();
        await until(() => ev.connection.length === 3, 3000);
        assert.deepStrictEqual(
            ev.connection.map(c => c.value),
            [true, false, true],
        );
        const n = valuesOf(ev, 'inputRegisters.1.35017_Total_DC_Power').length;
        await until(() => valuesOf(ev, 'inputRegisters.1.35017_Total_DC_Power').length > n, 2000);
    });

    it('reports skipped rounds when an interval is shorter than the bus needs', async () => {
        fake.state.units[1].latency = 120;
        const { p, ev } = makePoller(fake);
        poller = p;
        p.start();
        await sleep(1500);
        assert.ok(ev.skipped.some(s => s.group === 'live'), 'live round skipped');
    });

    it('heartbeat: a round event after every complete round, also when no value changed', async () => {
        const { p, ev } = makePoller(fake);
        poller = p;
        p.start();
        await sleep(1400);
        // the device values never change in this test - the heartbeat comes anyway
        const live = ev.round.filter(r => r.group === 'live');
        assert.ok(live.length >= 6, `live rounds: ${live.length}`);
        // ms includes waiting in the queue behind other groups - slow CI runners (Windows) need headroom
        assert.ok(live.every(r => r.failed === 0 && r.blocks === 1 && r.ms >= 0 && r.ms < 1000), JSON.stringify(live));
        // a round ends after the LAST block of the group (steuerung has 2 blocks: 53052 and 73031)
        const st = ev.round.filter(r => r.group === 'steuerung');
        assert.ok(st.length >= 1 && st.every(r => r.blocks === 2));
        const lastReqSt = ev.request.filter(r => r.group === 'steuerung');
        assert.ok(st[0].t >= lastReqSt[1].t);
        // one round event per round: never more round events than requests / blocks
        assert.ok(live.length <= ev.request.filter(r => r.group === 'live').length);
    });

    it('a round with a failed block is reported with failed > 0 (not a complete round)', async () => {
        const { p, ev } = makePoller(fake);
        poller = p;
        p.start();
        await until(() => ev.round.some(r => r.group === 'akku'));
        fake.drop(2, 1);
        await until(() => ev.round.some(r => r.group === 'akku' && r.failed === 1), 4000);
        await until(() => ev.round.filter(r => r.group === 'akku').slice(-1)[0].failed === 0, 4000);
        assert.ok(ev.round.filter(r => r.group === 'live').every(r => r.failed === 0));
    });

    it('stop() closes the only connection and leaves no timers running', async () => {
        const { p, ev } = makePoller(fake);
        p.start();
        await until(() => ev.connection.length === 1);
        await p.stop();
        assert.strictEqual(p.timerHandles.size, 0);
        await sleep(100);
        assert.strictEqual(fake.state.open.size, 0);
    });
});
