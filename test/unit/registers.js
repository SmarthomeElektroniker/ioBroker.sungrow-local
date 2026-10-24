'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const R = require('../../lib/registers');

const io = require('../../io-package.json');
const fixtures = path.join(__dirname, '..', 'fixtures');

describe('registers: compatibility with ioBroker.modbus', () => {
    const input = R.normalise('inputRegs', io.native.inputRegs);
    const holding = R.normalise('holdingRegs', io.native.holdingRegs);

    it('takes over all 68 input and 9 holding registers without problems', () => {
        assert.deepStrictEqual(input.problems, []);
        assert.deepStrictEqual(holding.problems, []);
        assert.strictEqual(input.regs.length, 68);
        assert.strictEqual(holding.regs.length, 9);
    });

    it('builds exactly the state IDs of an ioBroker.modbus instance (same IDs => migration by text replacement)', () => {
        const expected = fs
            .readFileSync(path.join(fixtures, 'modbus-state-ids.txt'), 'utf8')
            .split('\n')
            .map(s => s.trim())
            .filter(Boolean)
            .sort();
        const ours = [...input.regs, ...holding.regs].map(r => r.id).sort();
        assert.deepStrictEqual(ours, expected);
    });

    it('computes the protocol addresses that ioBroker.modbus stored (_address minus 30001/40001)', () => {
        const stored = JSON.parse(fs.readFileSync(path.join(fixtures, 'modbus-stored-addresses.json'), 'utf8'));
        for (const [regType, list] of Object.entries(stored)) {
            const regs = regType === 'inputRegs' ? input.regs : holding.regs;
            for (const { _address, address } of list) {
                assert.strictEqual(regs.find(r => r.alias === _address).address, address, `${regType} ${_address}`);
            }
        }
    });

    it('builds the same blocks as ioBroker.modbus (log: FC4 address 10740 quantity 9 unit 2, block 5000-5020 unit 1)', () => {
        const unit2 = R.buildBlocks(
            input.regs.filter(r => r.deviceId === 2),
            100,
            10,
        );
        assert.deepStrictEqual(
            unit2.map(b => [b.start, b.count]),
            [[10740, 9]],
        );
        const unit1 = R.buildBlocks(
            input.regs.filter(r => r.deviceId === 1),
            100,
            10,
        );
        assert.deepStrictEqual(unit1[0].start, 5000);
        assert.deepStrictEqual(unit1[0].start + unit1[0].count - 1, 5020);
        // all registers are covered exactly once
        assert.strictEqual(
            unit1.reduce((n, b) => n + b.regs.length, 0),
            input.regs.filter(r => r.deviceId === 1).length,
        );
    });

    it('splits blocks per group: battery group is exactly the unit-2 block, live and energy are separate', () => {
        const byGroup = g => input.regs.filter(r => r.group === g);
        assert.ok(byGroup('akku').every(r => r.deviceId === 2));
        const akku = R.buildBlocks(byGroup('akku'), 100, 10);
        assert.deepStrictEqual(
            akku.map(b => [b.deviceId, b.start, b.count]),
            [[2, 10740, 9]],
        );
        const live = R.buildBlocks(byGroup('live'), 100, 10);
        const energie = R.buildBlocks(byGroup('energie'), 100, 10);
        assert.ok(live.length >= 1 && energie.length >= 1);
        for (const b of [...live, ...energie]) {
            assert.ok(b.count <= 100);
            assert.ok(b.regs.every(r => r.address >= b.start && r.address + r.len <= b.start + b.count));
        }
        // new installations: writing is released per register (tab "Control"), nothing by default
        assert.ok(holding.regs.every(r => r.group === 'steuerung' && r.poll && !r.write));
    });

    it('copies name, unit, factor, type and role', () => {
        const soc = input.regs.find(r => r.alias === 40744);
        assert.deepStrictEqual(
            [soc.id, soc.description, soc.unit, soc.factor, soc.type, soc.role, soc.deviceId],
            ['inputRegisters.2.40744_Battery_level', 'Battery module SoC', '%', 0.1, 'uint16be', 'value.battery', 2],
        );
        const total = input.regs.find(r => r.alias === 35004);
        assert.deepStrictEqual([total.type, total.len, total.factor], ['uint32sw', 2, 0.1]);
    });
});

describe('registers: conversion', () => {
    it('reads the word-swapped 32-bit types like modbus (uint32sw / int32sw)', () => {
        // value 0x00012345 as Sungrow sends it: low word first
        const buf = Buffer.from([0x23, 0x45, 0x00, 0x01]);
        assert.strictEqual(R.extract('uint32sw', 2, buf, 0), 0x12345);
        const neg = R.encode('int32sw', -1234, 2);
        assert.strictEqual(R.extract('int32sw', 2, neg, 0), -1234);
    });

    it('round-trips all numeric types', () => {
        for (const type of Object.keys(R.TYPE_LEN)) {
            const v = /^u/.test(type) ? 200 : -100;
            const b = R.encode(type, v, R.TYPE_LEN[type]);
            assert.strictEqual(b.length, R.TYPE_LEN[type] * 2, type);
            assert.strictEqual(R.extract(type, R.TYPE_LEN[type], b, 0), v, type);
        }
    });

    it('scales with factor/offset and rounds to 4 decimals; unscale rounds integers', () => {
        const reg = { factor: 0.1, offset: 0, type: 'uint16be' };
        assert.strictEqual(R.scale(/** @type {any} */ (reg), 955, 10000), 95.5);
        assert.strictEqual(R.unscale(/** @type {any} */ (reg), 95.5), 955);
        assert.strictEqual(R.unscale(/** @type {any} */ (reg), '80'), 800);
        assert.throws(() => R.unscale(/** @type {any} */ (reg), 'abc'));
    });

    it('accepts decimal commas and reports bad rows', () => {
        const { regs, problems } = R.normalise('inputRegs', [
            { _address: 30010, name: 'A', factor: '0,5', type: 'int16be' },
            { _address: 12, name: 'too small' },
            { _address: 30011, name: 'B', type: 'nonsense' },
            { _address: 30010, name: 'A' },
        ]);
        assert.strictEqual(regs.length, 1);
        assert.strictEqual(regs[0].factor, 0.5);
        assert.strictEqual(regs[0].address, 9);
        assert.strictEqual(problems.length, 3);
    });
});

describe('registers: display columns (0.2.0) - IDs stay, only names/roles/units/states/limits change', () => {
    const input = R.normalise('inputRegs', io.native.inputRegs);
    const holding = R.normalise('holdingRegs', io.native.holdingRegs);
    const all = [...input.regs, ...holding.regs];
    const byAlias = a => all.find(r => r.alias === a);

    it('read-only input registers never carry a level role (level = writable set point)', () => {
        assert.deepStrictEqual(
            input.regs.filter(r => r.role.startsWith('level')).map(r => r.id),
            [],
        );
    });

    it('units, MPPT 3 name and whitespace in display names are corrected; the IDs are not', () => {
        assert.strictEqual(byAlias(35001).unit, 'kW');
        assert.strictEqual(byAlias(35016).description, 'MPPT3 current');
        assert.strictEqual(byAlias(35016).id, 'inputRegisters.1.35016_MPPT_3_Current');
        assert.strictEqual(byAlias(35003).id, 'inputRegisters.1.35003_Daily__Output_Energy');
        for (const r of all) {
            assert.strictEqual(r.description, r.description.replace(/\s+/g, ' ').trim(), r.id);
        }
        assert.strictEqual(byAlias(53050).description, 'EMS mode');
    });

    it('roles follow the ioBroker role list for the measured quantities', () => {
        const expect = {
            35017: 'value.power',
            35011: 'value.voltage',
            35012: 'value.current',
            35036: 'value.frequency',
            35008: 'value.temperature',
            43023: 'value.battery',
            40744: 'value.battery',
            43002: 'value.energy.produced',
            43036: 'value.energy.consumed',
            53050: 'level',
            73031: 'level',
        };
        for (const [a, role] of Object.entries(expect)) {
            assert.strictEqual(byAlias(Number(a)).role, role, a);
        }
    });

    it('status and control registers carry plain text and limits; current device values are plausible', () => {
        assert.strictEqual(byAlias(53050).states['0'], 'Self-consumption');
        assert.strictEqual(byAlias(53051).states['187'], 'Discharge (0xBB)');
        assert.strictEqual(byAlias(43000).states['0'], 'Run');
        assert.strictEqual(byAlias(43000).states['-32768'], 'Stop');
        assert.deepStrictEqual([byAlias(73031).min, byAlias(73031).max], [0, 100]);
        // typical device values must not trigger the write warning
        const now = {
            53050: 0,
            53051: 187,
            53052: 3690,
            53075: 170,
            53100: 5,
            70230: 85,
            72535: 170,
            73031: 100,
            73032: 5,
        };
        for (const [a, v] of Object.entries(now)) {
            assert.strictEqual(R.checkWriteValue(byAlias(Number(a)), v), '', a);
        }
        // the running state is a bit field and the grid state is unclear: deliberately no texts
        assert.strictEqual(byAlias(43001).states, undefined);
        assert.strictEqual(byAlias(43030).states, undefined);
    });
});

describe('registers: states, min, max and the write check', () => {
    it('parses the states column (value:text;value:text) and ignores broken parts', () => {
        assert.deepStrictEqual(R.parseStates('170:an (0xAA); 85 : aus ;:x;nur text;'), { 170: 'an (0xAA)', 85: 'aus' });
        assert.strictEqual(R.parseStates(''), undefined);
        assert.strictEqual(R.parseStates(undefined), undefined);
        assert.deepStrictEqual(R.parseStates({ 1: 'eins' }), { 1: 'eins' });
    });

    it('takes min/max (also with decimal comma) and leaves them out when empty', () => {
        const { regs } = R.normalise('holdingRegs', [
            { _address: 40010, name: 'A', min: '0', max: '99,5', states: '1:x' },
            { _address: 40011, name: 'B', min: '', max: null },
        ]);
        assert.deepStrictEqual([regs[0].min, regs[0].max, regs[0].states], [0, 99.5, { 1: 'x' }]);
        assert.deepStrictEqual([regs[1].min, regs[1].max, regs[1].states], [undefined, undefined, undefined]);
    });

    it('reports values outside min/max or not among the states', () => {
        const regs = R.normalise('holdingRegs', [
            { _address: 73031, name: 'Max SOC', factor: 0.1, min: 0, max: 100 },
            { _address: 53051, name: 'Cmd', states: '170:Laden;187:Entladen;204:Stopp' },
            { _address: 53052, name: 'Free' },
        ]).regs;
        const [soc, cmd, free] = [73031, 53051, 53052].map(a => regs.find(r => r.alias === a));
        assert.match(R.checkWriteValue(soc, 1000), /above the maximum 100/);
        assert.match(R.checkWriteValue(soc, -1), /below the minimum 0/);
        assert.strictEqual(R.checkWriteValue(soc, '95,5'), '');
        assert.match(R.checkWriteValue(cmd, 171), /none of the known values/);
        assert.strictEqual(R.checkWriteValue(cmd, '204'), '');
        assert.match(R.checkWriteValue(free, 'abc'), /not a number/);
        assert.strictEqual(R.checkWriteValue(free, 123456), '');
    });
});
