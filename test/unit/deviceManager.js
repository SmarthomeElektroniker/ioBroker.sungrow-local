'use strict';

/*
 * Device manager cards (lib/deviceManager.js) with a fake adapter: which cards and rows exist for which
 * configuration, how values are formatted, and that the cards never write (only "info" controls, no actions).
 */

const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { normalise } = require('../../lib/registers');
const {
    SungrowDeviceManagement,
    buildCards,
    formatRow,
    cardInfo,
    directionIndicator,
    TXT,
    LANGS,
} = require('../../lib/deviceManager');
const ioPackage = require('../../io-package.json');

const NS = 'sungrow-local.0';

/** @returns {any[]} Registers of the template (enabled rows) */
function templateRegs() {
    return [
        ...normalise('inputRegs', ioPackage.native.inputRegs).regs,
        ...normalise('holdingRegs', ioPackage.native.holdingRegs).regs,
    ];
}

/**
 * @param {any[]} regs Registers
 * @param {Record<string, any>} states Full ID -> state value
 * @param {Record<string, any>} [objects] Full ID -> object
 * @returns {any} Fake adapter
 */
function fakeAdapter(regs, states, objects = {}) {
    const a = new EventEmitter();
    Object.assign(a, {
        namespace: NS,
        lang: 'de',
        regsById: new Map(regs.map(r => [`${NS}.${r.id}`, r])),
        log: { debug() {}, info() {}, warn() {}, error() {} },
        writes: [],
        sent: [],
        getForeignStateAsync: async id =>
            id in states ? { val: states[id], ack: true, ts: 1000, lc: 1000, from: 'test', q: 0 } : null,
        getForeignObjectAsync: async id => objects[id] || null,
        setState: (...args) => a.writes.push(args),
        setStateAsync: async (...args) => a.writes.push(args),
        setForeignState: (...args) => a.writes.push(args),
        setForeignStateAsync: async (...args) => a.writes.push(args),
        sendTo: (...args) => a.sent.push(args),
    });
    return a;
}

/**
 * @param {any[]} regs Registers
 * @param {number} alias Column address
 * @param {number} [unit] Modbus unit
 * @returns {string} Full state ID
 */
function idOf(regs, alias, unit = 1) {
    const r = regs.find(x => x.alias === alias && x.deviceId === unit);
    assert.ok(r, `register ${alias} configured`);
    return `${NS}.${r.id}`;
}

describe('device manager: cards', () => {
    it('template: inverter, battery and grid meter with the expected rows', () => {
        const cards = buildCards(templateRegs(), NS);
        assert.deepStrictEqual(
            cards.map(c => c.id),
            ['inverter', 'battery', 'meter'],
        );
        const rows = Object.fromEntries(cards.map(c => [c.id, c.rows.map(r => r.id)]));
        assert.deepStrictEqual(rows.inverter, ['state', 'pv', 'ac', 'house', 'temp', 'pvToday', 'lastValues']);
        assert.deepStrictEqual(rows.battery, [
            'soc',
            'battPower',
            'soh',
            'battTemp',
            'reserve',
            'minSoc',
            'maxSoc',
            'emsMode',
        ]);
        assert.deepStrictEqual(rows.meter, ['grid', 'importToday', 'exportToday']);
        assert.ok(cards[0].faultId && cards[0].faultId.includes('43052'));
        assert.ok(cards[1].socId && cards[1].socId.includes('43023'));
    });

    it('without battery and meter registers only the inverter card is there', () => {
        const regs = templateRegs().filter(
            r => ![43020, 43021, 43022, 43023, 35214, 35601].includes(r.alias) && r.deviceId === 1,
        );
        const cards = buildCards(regs, NS);
        assert.deepStrictEqual(
            cards.map(c => c.id),
            ['inverter'],
        );
        // no grid -> no house consumption
        assert.ok(!cards[0].rows.some(r => r.id === 'house'));
    });

    it('state of charge falls back to the battery unit 2 (40744)', () => {
        const regs = templateRegs().filter(r => r.alias !== 43023);
        const bat = buildCards(regs, NS).find(c => c.id === 'battery');
        assert.ok(bat && bat.socId && bat.socId.includes('.2.40744'));
    });

    it('holding registers that are not polled are not shown', () => {
        const regs = templateRegs().map(r => (r.alias === 53100 ? { ...r, poll: false } : r));
        const bat = buildCards(regs, NS).find(c => c.id === 'battery');
        assert.ok(bat && !bat.rows.some(r => r.id === 'reserve'));
    });

    it('every label is translated into all languages of the adapter', () => {
        for (const [key, t] of Object.entries(TXT)) {
            for (const l of LANGS) {
                assert.ok(t[l] && t[l].trim(), `${key}.${l}`);
            }
        }
    });
});

describe('device manager: values', () => {
    it('power, percent, temperature, energy', () => {
        assert.strictEqual(formatRow('power', { value: 512 }, 'en'), '512 W');
        assert.strictEqual(formatRow('power', { value: 5100 }, 'de'), '5,10 kW');
        assert.strictEqual(formatRow('percent', { value: 87 }, 'de'), '87 %');
        assert.strictEqual(formatRow('temp', { value: 31.25 }, 'en'), '31.3 °C');
        assert.strictEqual(formatRow('energy', { value: 12.34 }, 'en'), '12.3 kWh');
        assert.strictEqual(formatRow('power', {}, 'en'), '–');
    });

    it('grid: + = import, - = feed-in', () => {
        assert.strictEqual(formatRow('grid', { value: 1200 }, 'de'), '1,20 kW · Bezug');
        assert.strictEqual(formatRow('grid', { value: -3810 }, 'en'), '3.81 kW · feed-in');
        assert.strictEqual(formatRow('grid', { value: 0 }, 'en'), '0 W · idle');
    });

    it('battery direction as in lib/flow.js (17:39 reference: discharging 1488 W)', () => {
        assert.strictEqual(
            formatRow('battery', { battPower: 1488, battCurrent: 2.5, pv: 703, acPower: 2008 }, 'de'),
            '1,49 kW · entlädt',
        );
        assert.strictEqual(formatRow('battery', { battSigned: -800 }, 'en'), '800 W · charging');
    });

    it('house consumption = AC output + grid; unbalanced is reported', () => {
        assert.strictEqual(formatRow('house', { acPower: 2008, grid: -37 }, 'en'), '1.97 kW');
        assert.strictEqual(formatRow('house', { acPower: 100, grid: -500 }, 'en'), TXT.unbalanced.en);
    });

    it('value texts of the object (common.states)', () => {
        assert.strictEqual(formatRow('states', { value: 0 }, 'en', { 0: 'Run' }), 'Run');
        assert.strictEqual(formatRow('states', { value: 7 }, 'en', { 0: 'Run' }), '7');
        assert.strictEqual(formatRow('states', {}, 'en'), '–');
    });
});

describe('device manager: messages with a fake adapter', () => {
    it('dm:instanceInfo has no instance actions', async () => {
        const a = fakeAdapter(templateRegs(), {});
        new SungrowDeviceManagement(a);
        a.emit('message', { command: 'dm:instanceInfo', from: 'admin', callback: 1, message: {} });
        await new Promise(r => setImmediate(r));
        assert.strictEqual(a.sent.length, 1);
        const reply = a.sent[0][2];
        assert.strictEqual(reply.apiVersion, 'v3');
        assert.ok(!reply.actions || reply.actions.length === 0);
    });

    it('loadDevices: read-only cards with formatted live values, nothing is written', async () => {
        const regs = templateRegs();
        const states = {
            [`${NS}.info.connection`]: true,
            [idOf(regs, 43000)]: 0,
            [idOf(regs, 35017)]: 5100,
            [idOf(regs, 43034)]: 2008,
            [idOf(regs, 35601)]: -37,
            [idOf(regs, 43023)]: 87,
            [idOf(regs, 43022)]: 1488,
            [idOf(regs, 43021)]: 2.5,
            [idOf(regs, 43052)]: 0,
        };
        const objects = { [idOf(regs, 43000)]: { common: { states: { 0: 'Run' } } } };
        const a = fakeAdapter(regs, states, objects);
        const dm = new SungrowDeviceManagement(a);
        /** @type {any[]} */
        const devices = [];
        await dm.loadDevices({ addDevice: d => devices.push(d), setTotalDevices: () => {} });
        assert.deepStrictEqual(
            devices.map(d => d.id),
            ['inverter', 'battery', 'meter'],
        );
        for (const d of devices) {
            assert.ok(!d.actions || d.actions.length === 0, `${d.id}: no actions`);
            assert.strictEqual(d.status.connection.stateId, `${NS}.info.connection`);
            assert.match(d.icon, /^data:image\/svg\+xml;base64,/, `${d.id}: header icon`);
            for (const c of d.controls) {
                assert.strictEqual(c.type, 'info', `${d.id}.${c.id} is read only`);
                assert.ok(!c.handler, `${d.id}.${c.id} has no write handler`);
            }
        }
        const val = (dev, ctl) => devices.find(d => d.id === dev).controls.find(c => c.id === ctl).state.val;
        assert.strictEqual(val('inverter', 'state'), 'Run');
        assert.strictEqual(val('inverter', 'pv'), '5,10 kW');
        assert.strictEqual(val('inverter', 'house'), '1,97 kW');
        assert.strictEqual(val('battery', 'soc'), '87 %');
        assert.strictEqual(val('battery', 'battPower'), '1,49 kW · entlädt');
        assert.strictEqual(val('meter', 'grid'), '37 W · Einspeisung');
        assert.strictEqual(val('inverter', 'temp'), '–');
        // live update: the card asks the handler after a state change
        states[idOf(regs, 35017)] = 640;
        const pv = devices[0].controls.find(c => c.id === 'pv');
        const st = await pv.getStateHandler('inverter', 'pv');
        assert.strictEqual(st.val, '640 W');
        assert.deepStrictEqual(a.writes, []);
        assert.strictEqual(devices[0].indicators[0].value.stateId, idOf(regs, 43052));
    });
});

describe('device manager: main values on the card (customInfo, 0.5.0)', () => {
    it('inverter: PV power and operating state; battery: SoC and power; meter: grid power - read-only state items', () => {
        const regs = templateRegs();
        const cards = Object.fromEntries(buildCards(regs, NS).map(c => [c.id, c]));
        const items = id => cardInfo(cards[id]).schema.items;
        assert.deepStrictEqual(Object.keys(items('inverter')), ['_pv', '_state']);
        assert.strictEqual(items('inverter')._pv.oid, idOf(regs, 35017));
        assert.strictEqual(items('inverter')._state.oid, idOf(regs, 43000));
        assert.deepStrictEqual(Object.keys(items('battery')), ['_soc', '_battPower']);
        assert.strictEqual(items('battery')._soc.oid, idOf(regs, 43023));
        // template: 35214 (signed) is not ticked -> amount 43022, direction from the current 43021
        assert.strictEqual(items('battery')._battPower.oid, idOf(regs, 43022));
        assert.deepStrictEqual(items('battery')._battPower.label, TXT.battPower);
        assert.deepStrictEqual(Object.keys(items('meter')), ['_grid']);
        assert.strictEqual(items('meter')._grid.oid, idOf(regs, 35601));
        assert.strictEqual(items('meter')._grid.label.de, 'Netz (+ Bezug / − Einspeisung)');
        for (const id of ['inverter', 'battery', 'meter']) {
            assert.strictEqual(cardInfo(cards[id]).schema.type, 'panel');
            for (const it of Object.values(items(id))) {
                assert.strictEqual(it.type, 'state');
                assert.strictEqual(it.readOnly, true, `${id} ${it.oid} read only`);
                assert.strictEqual(it.control, 'text', `${id} ${it.oid} shown as text`);
                assert.strictEqual(it.foreign, true);
            }
        }
    });

    it('battery direction: + = discharging, - = charging (43021); with 35214 the signed power is shown', () => {
        const regs = templateRegs();
        let bat = buildCards(regs, NS).find(c => c.id === 'battery');
        assert.deepStrictEqual(bat.direction, { kind: 'battery', stateId: idOf(regs, 43021), threshold: 0.1 });
        const ind = directionIndicator(bat.direction);
        const level = v =>
            ind.levels.find(l => (l.min === undefined || v >= l.min) && (l.max === undefined || v <= l.max)).text.en;
        assert.strictEqual(level(2.5), 'discharging');
        assert.strictEqual(level(-1.2), 'charging');
        assert.strictEqual(level(0), 'idle');
        assert.strictEqual(ind.value.stateId, idOf(regs, 43021));

        const signed = templateRegs();
        const all = normalise('inputRegs', [
            { _address: 35214, deviceId: 1, name: 'Battery power signed', type: 'int32sw' },
        ]).regs;
        signed.push(...all);
        bat = buildCards(signed, NS).find(c => c.id === 'battery');
        const items = cardInfo(bat).schema.items;
        assert.strictEqual(items._battPower.oid, `${NS}.${all[0].id}`);
        assert.strictEqual(items._battPower.label.de, 'Leistung (+ Entladen / − Laden)');
        assert.deepStrictEqual(bat.direction, { kind: 'battery', stateId: `${NS}.${all[0].id}`, threshold: 10 });
    });

    it('grid direction: + = import, - = feed-in (35601)', () => {
        const regs = templateRegs();
        const met = buildCards(regs, NS).find(c => c.id === 'meter');
        const ind = directionIndicator(met.direction);
        const level = v =>
            ind.levels.find(l => (l.min === undefined || v >= l.min) && (l.max === undefined || v <= l.max)).text.de;
        assert.strictEqual(level(1200), 'Bezug');
        assert.strictEqual(level(-3810), 'Einspeisung');
        assert.strictEqual(level(3), 'Ruhe');
    });

    it('loadDevices: customInfo and the direction indicator on the cards, no controls that write', async () => {
        const regs = templateRegs();
        const a = fakeAdapter(regs, {});
        const dm = new SungrowDeviceManagement(a);
        /** @type {any[]} */
        const devices = [];
        await dm.loadDevices({ addDevice: d => devices.push(d), setTotalDevices: () => {} });
        const by = Object.fromEntries(devices.map(d => [d.id, d]));
        for (const d of devices) {
            assert.ok(d.customInfo && d.customInfo.id === d.id, `${d.id} customInfo`);
        }
        assert.deepStrictEqual(
            by.battery.indicators.map(i => i.id),
            ['direction'],
        );
        assert.deepStrictEqual(
            by.meter.indicators.map(i => i.id),
            ['direction'],
        );
        assert.deepStrictEqual(
            by.inverter.indicators.map(i => i.id),
            ['fault'],
        );
        assert.deepStrictEqual(a.writes, []);
    });
});
