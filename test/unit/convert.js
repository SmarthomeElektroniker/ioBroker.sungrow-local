'use strict';

/*
 * Conversion helper of the admin: addresses, raw words, interpretations and warnings.
 */

const assert = require('node:assert');
const { parseWords, addresses, rawValue, explain, implausible } = require('../../lib/convert');

describe('convert: addresses in the three notations', () => {
    it('Sungrow document number (1-based), protocol address (0-based) and adapter column', () => {
        // battery level: Sungrow 13023, Home Assistant address 13022, adapter column 43023
        const expected = { doc: 13023, protocol: 13022, column: 43023 };
        assert.deepStrictEqual(addresses(13023, 'doc', 'inputRegs'), expected);
        assert.deepStrictEqual(addresses('13022', 'protocol', 'inputRegs'), expected);
        assert.deepStrictEqual(addresses(43023, 'column', 'inputRegs'), expected);
        assert.deepStrictEqual(addresses(33031, 'doc', 'holdingRegs'), { doc: 33031, protocol: 33030, column: 73031 });
    });

    it('rejects addresses that do not fit', () => {
        assert.strictEqual(addresses(0, 'doc', 'inputRegs'), null);
        assert.strictEqual(addresses(20000, 'column', 'inputRegs'), null);
        assert.strictEqual(addresses('abc', 'doc', 'inputRegs'), null);
    });
});

describe('convert: raw words', () => {
    it('parses decimal, 0x-hex, plain hex with letters, negative 16-bit numbers and separators', () => {
        assert.deepStrictEqual(parseWords('950'), [950]);
        assert.deepStrictEqual(parseWords('0x03B6, 0x0001'), [950, 1]);
        assert.deepStrictEqual(parseWords('FFFF 1;2'), [0xffff, 1, 2]);
        assert.deepStrictEqual(parseWords('-400'), [0x10000 - 400]);
        assert.deepStrictEqual(parseWords('70000 x 1'), [1], 'out-of-range and garbage are dropped');
        assert.deepStrictEqual(parseWords(undefined), []);
    });

    it('decodes Sungrow 32-bit values low word first (sw) and the other orders', () => {
        // 70000 = 0x0001_1170 -> registers [0x1170, 0x0001]
        assert.strictEqual(rawValue('uint32sw', [0x1170, 0x0001]), 70000);
        assert.strictEqual(rawValue('uint32be', [0x0001, 0x1170]), 70000);
        assert.strictEqual(rawValue('int32sw', [0xfc18, 0xffff]), -1000);
        assert.strictEqual(rawValue('int16be', [0xfe70]), -400);
        assert.strictEqual(rawValue('uint32sw', [1]), undefined, 'too few words');
    });
});

describe('convert: explanation and warnings', () => {
    it('battery level: raw 950 with factor 0,1 = 95 %, plausible, row for the table', () => {
        const r = explain(
            {
                address: '13023',
                addrMode: 'doc',
                regType: 'inputRegs',
                deviceId: '1',
                type: 'uint16be',
                factor: '0,1',
                unitText: '%',
                words: '950',
                name: 'Battery level',
            },
            undefined,
            'de',
        );
        assert.strictEqual(r.value, 95);
        assert.deepStrictEqual(r.warnings, []);
        assert.match(r.text, /inputRegisters\.1\.43023_Battery_level/);
        assert.match(r.text, /43023 \| unit 1 \| uint16be \| factor 0\.1/);
    });

    it('unsigned power above 32767 suggests S16 with the negative value', () => {
        const r = explain({ address: 13022, type: 'uint16be', factor: 1, unitText: 'W', words: '65136' });
        assert.ok(
            r.warnings.some(w => /int16be/.test(w) && /-400 W/.test(w)),
            r.warnings.join('|'),
        );
    });

    it('wrong word order is detected and the Sungrow order (sw) is suggested', () => {
        const r = explain({ address: 5017, type: 'uint32be', factor: 1, unitText: 'W', words: '4464 1' });
        assert.ok(
            r.warnings.some(w => /uint32sw/.test(w) && /70000 W/.test(w)),
            r.warnings.join('|'),
        );
    });

    it('wrong factor: 2314 V is implausible, factor 0.1 gives 231.4 V', () => {
        const r = explain({ address: 5019, type: 'uint16be', factor: 1, unitText: 'V', words: '2314' });
        assert.ok(
            r.warnings.some(w => /0\.1/.test(w) && /231\.4 V/.test(w)),
            r.warnings.join('|'),
        );
    });

    it('0xFFFF is reported as "no value" (and not as a wrong factor)', () => {
        const r = explain({ address: 5115, type: 'uint16be', factor: 0.1, unitText: 'V', words: '0xFFFF' });
        assert.strictEqual(r.warnings.length, 1);
        assert.match(r.warnings[0], /no value/);
    });

    it('text registers and device reads', () => {
        const words = [0x5348, 0x3230, 0x5400]; // "SH20T"
        const r = explain({ address: 4990, type: 'string' }, { words, ms: 12 });
        assert.strictEqual(r.value, 'SH20T');
        assert.match(r.text, /answer after 12 ms/);
        const e = explain({ address: 4990, type: 'string', live: true }, { error: 'not connected' }, 'de');
        assert.match(e.text, /Lesen fehlgeschlagen: not connected/);
    });

    it('first-value check of the poller uses the same ranges', () => {
        assert.strictEqual(implausible({ unit: 'V' }, 231.4), '');
        assert.match(implausible({ unit: 'V' }, 6553.5), /outside the plausible range/);
        assert.strictEqual(implausible({ unit: '' }, 99999), '');
    });
});
