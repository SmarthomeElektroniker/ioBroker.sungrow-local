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
    batteryModel,
    faultIndicator,
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
        assert.deepStrictEqual(rows.inverter, [
            'pv',
            'backup',
            'ac',
            'house',
            'temp',
            'pvToday',
            'pvTotal',
            'lastValues',
        ]);
        assert.deepStrictEqual(rows.battery, [
            'soc',
            'battPower',
            'battVoltage',
            'soh',
            'battTemp',
            'reserve',
            'minSoc',
            'maxSoc',
            'emsMode',
        ]);
        assert.deepStrictEqual(rows.meter, ['grid', 'importToday', 'importTotal', 'exportToday', 'exportTotal']);
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
        assert.ok(!devices[0].controls.some(c => c.id === 'state'), 'no operating state (user decision)');
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
    it('inverter: PV power, yield today/total, backup; battery: power and voltage (SoC in the status); meter: grid, import/feed-in today/total', () => {
        const regs = templateRegs();
        const cards = Object.fromEntries(buildCards(regs, NS).map(c => [c.id, c]));
        const items = id => cardInfo(cards[id]).schema.items;
        const oids = id => Object.fromEntries(Object.entries(items(id)).map(([k, v]) => [k, v.oid]));
        assert.deepStrictEqual(oids('inverter'), {
            _pv: idOf(regs, 35017),
            _pvToday: idOf(regs, 43002),
            _pvTotal: idOf(regs, 43003),
            _backup: idOf(regs, 35726),
        });
        // SoC: battery status of the card (icon with value), not a second row
        assert.deepStrictEqual(oids('battery'), { _battPower: idOf(regs, 43022), _battVoltage: idOf(regs, 43020) });
        assert.strictEqual(cards.battery.socId, idOf(regs, 43023));
        assert.deepStrictEqual(items('battery')._battPower.label, TXT.battPower);
        assert.deepStrictEqual(oids('meter'), {
            _grid: idOf(regs, 35601),
            _importToday: idOf(regs, 43036),
            _importTotal: idOf(regs, 43037),
            _exportToday: idOf(regs, 43045),
            _exportTotal: idOf(regs, 43046),
        });
        assert.strictEqual(items('meter')._grid.label.de, 'Netz');
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

    it('a value whose register is not ticked is left out (no empty row)', () => {
        const regs = templateRegs().filter(r => ![43003, 35726, 43037, 43046].includes(r.alias));
        const cards = Object.fromEntries(buildCards(regs, NS).map(c => [c.id, c]));
        assert.deepStrictEqual(Object.keys(cardInfo(cards.inverter).schema.items), ['_pv', '_pvToday']);
        assert.deepStrictEqual(Object.keys(cardInfo(cards.meter).schema.items), [
            '_grid',
            '_importToday',
            '_exportToday',
        ]);
        // battery voltage falls back to the BMS of unit 2
        const noInv = templateRegs().filter(r => r.alias !== 43020);
        const bat = buildCards(noInv, NS).find(c => c.id === 'battery');
        assert.strictEqual(cardInfo(bat).schema.items._battVoltage.oid, idOf(noInv, 40741, 2));
    });

    it('battery manufacturer and model from the BMS software version and the capacity', () => {
        assert.deepStrictEqual(batteryModel('SBHBCU-S_22011.04.02', 40.5), {
            manufacturer: 'Sungrow',
            model: 'SBH400',
        });
        assert.deepStrictEqual(batteryModel('SBHBCU-S_22011.04.02', 15.2), {
            manufacturer: 'Sungrow',
            model: 'SBH150',
        });
        assert.deepStrictEqual(batteryModel('SBR_BCU 1.0', 9.6), { manufacturer: 'Sungrow', model: 'SBR096' });
        assert.deepStrictEqual(batteryModel('SBHBCU-S_22011.04.02', undefined), {
            manufacturer: 'Sungrow',
            model: 'SBH',
        });
        assert.deepStrictEqual(batteryModel('BYD HVS', 10.2), {});
        assert.deepStrictEqual(batteryModel(undefined, 40), {});
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
        assert.ok(!by.inverter.manufacturer && !by.meter.manufacturer, 'no manufacturer on inverter and meter');
        assert.ok(!by.battery.manufacturer, 'no BMS software version configured -> no guessed manufacturer');
        assert.deepStrictEqual(a.writes, []);
    });

    it('battery card: manufacturer and model when the BMS software version is read', async () => {
        const regs = [
            ...templateRegs(),
            ...normalise('inputRegs', [
                { _address: 40721, deviceId: 2, name: 'Bat Software version', type: 'string', len: 10 },
            ]).regs,
        ];
        const a = fakeAdapter(regs, { [idOf(regs, 40721, 2)]: 'SBHBCU-S_22011.04.02', [idOf(regs, 43039)]: 40.5 });
        const dm = new SungrowDeviceManagement(a);
        /** @type {any[]} */
        const devices = [];
        await dm.loadDevices({ addDevice: d => devices.push(d), setTotalDevices: () => {} });
        const bat = devices.find(d => d.id === 'battery');
        assert.strictEqual(bat.manufacturer, 'Sungrow');
        assert.strictEqual(bat.model, 'SBH400');
    });
});

describe('device manager: fault indicator (tooltip)', () => {
    const tip = (ind, v, l = 'de') => {
        const lv = ind.levels.find(x => x.value === undefined || x.value === v);
        return lv.tooltip[l];
    };
    it('0 = "Kein Fehler", otherwise "Fehler: ..." with the general text', () => {
        const ind = faultIndicator('x.43052');
        assert.strictEqual(tip(ind, 0), 'Kein Fehler');
        assert.strictEqual(tip(ind, 0, 'en'), 'No fault');
        assert.strictEqual(tip(ind, 17), 'Fehler: netzseitiger Fehlercode ≠ 0');
        assert.strictEqual(ind.levels[0].color, 'ok');
        assert.strictEqual(ind.levels.at(-1).color, 'error');
    });
    it('texts of a value table (common.states) of the user are named', () => {
        const ind = faultIndicator('x.43052', { 0: 'ok', 2: 'Grid overvoltage', 7: { en: 'Island', de: 'Inselnetz' } });
        assert.strictEqual(tip(ind, 0), 'Kein Fehler');
        assert.strictEqual(tip(ind, 2), 'Fehler: Grid overvoltage');
        assert.strictEqual(tip(ind, 7), 'Fehler: Inselnetz');
        assert.strictEqual(tip(ind, 7, 'en'), 'Fault: Island');
        assert.strictEqual(tip(ind, 99), 'Fehler: netzseitiger Fehlercode ≠ 0');
    });
});
