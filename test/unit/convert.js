'use strict';

/*
 * Conversion helper of the admin: addresses, raw words, interpretations and warnings.
 */

const assert = require('node:assert');
const {
    parseWords,
    parseAddress,
    addresses,
    detect,
    resolve,
    knownAt,
    rawValue,
    explain,
    implausible,
} = require('../../lib/convert');
const { CATALOG } = require('../../lib/catalog');
const ioPackage = require('../../io-package.json');

/**
 * Reference registers in every notation (Sungrow document V1.1.x, mkaiser modbus_sungrow.yaml "address: … # reg …",
 * register list of the reference installation = protocol address). doc = document, from 1; protocol = from 0;
 * column = this adapter / ioBroker.modbus with aliases; modicon = 6 digits.
 */
const REFERENCE = [
    {
        what: 'Battery level',
        regType: 'inputRegs',
        doc: 13023,
        protocol: 13022,
        column: 43023,
        modicon: 313023,
        name: /^Battery level$/,
    },
    {
        what: 'Battery power',
        regType: 'inputRegs',
        doc: 13022,
        protocol: 13021,
        column: 43022,
        modicon: 313022,
        name: /^Battery power$/,
    },
    {
        what: 'Load power',
        regType: 'inputRegs',
        doc: 13008,
        protocol: 13007,
        column: 43008,
        modicon: 313008,
        name: /^Load power$/,
    },
    {
        what: 'Export power',
        regType: 'inputRegs',
        doc: 13010,
        protocol: 13009,
        column: 43010,
        modicon: 313010,
        name: /^Export power$/,
    },
    {
        what: 'Total active power',
        regType: 'inputRegs',
        doc: 13034,
        protocol: 13033,
        column: 43034,
        modicon: 313034,
        name: /^Total active power/,
    },
    {
        what: 'Meter total active power',
        regType: 'inputRegs',
        doc: 5601,
        protocol: 5600,
        column: 35601,
        modicon: 305601,
        name: /^power total-EnergyMeter$/,
    },
    {
        what: 'Battery power signed',
        regType: 'inputRegs',
        doc: 5214,
        protocol: 5213,
        column: 35214,
        modicon: 305214,
        name: /^Battery power signed$/,
    },
    {
        what: 'Device type code',
        regType: 'inputRegs',
        doc: 5000,
        protocol: 4999,
        column: 35000,
        modicon: 305000,
        name: /^Device type code$/,
    },
    {
        what: 'EMS mode selection',
        regType: 'holdingRegs',
        doc: 13050,
        protocol: 13049,
        column: 53050,
        modicon: 413050,
        name: /^EMS mode selection$/,
    },
    {
        what: 'Max SoC (EMS)',
        regType: 'holdingRegs',
        doc: 13058,
        protocol: 13057,
        column: 53058,
        modicon: 413058,
        name: /^Max SOC EMS$/,
    },
    {
        what: 'Min SoC (EMS)',
        regType: 'holdingRegs',
        doc: 13059,
        protocol: 13058,
        column: 53059,
        modicon: 413059,
        name: /^Min SOC EMS$/,
    },
    {
        what: 'Max SoC (33xxx)',
        regType: 'holdingRegs',
        doc: 33031,
        protocol: 33030,
        column: 73031,
        modicon: 433031,
        name: /^Max SOC$/,
    },
    {
        what: 'Min SoC (33xxx)',
        regType: 'holdingRegs',
        doc: 33032,
        protocol: 33031,
        column: 73032,
        modicon: 433032,
        name: /^Min SOC$/,
    },
];
const NOTES = ['doc', 'protocol', 'column', 'modicon'];

describe('convert: addresses in all notations', () => {
    for (const r of REFERENCE) {
        it(`${r.what}: every notation converts into every other (round trip)`, () => {
            const expected = {
                regType: r.regType,
                fc: r.regType === 'inputRegs' ? 4 : 3,
                doc: r.doc,
                protocol: r.protocol,
                column: r.column,
                modicon: r.modicon,
            };
            for (const mode of NOTES) {
                const a = addresses(r[mode], mode, r.regType);
                assert.deepStrictEqual(a, expected, `${mode} ${r[mode]}`);
                // and back: the result in each notation leads to the same register again
                for (const back of NOTES) {
                    assert.deepStrictEqual(addresses(a[back], back, r.regType), expected, `${mode} -> ${back}`);
                }
            }
        });
    }

    it('a 6-digit Modicon number brings its register type along', () => {
        assert.strictEqual(addresses(413058, 'modicon', 'inputRegs').regType, 'holdingRegs');
        assert.strictEqual(addresses(313023, 'modicon', 'holdingRegs').regType, 'inputRegs');
        assert.strictEqual(addresses(213023, 'modicon', 'inputRegs'), null);
    });

    it('rejects addresses that do not fit', () => {
        assert.strictEqual(addresses(0, 'doc', 'inputRegs'), null);
        assert.strictEqual(addresses(20000, 'column', 'inputRegs'), null);
        assert.strictEqual(addresses('abc', 'doc', 'inputRegs'), null);
        assert.strictEqual(addresses(70000, 'protocol', 'inputRegs'), null);
        assert.strictEqual(parseAddress(' 13.023 '), 13023, 'thousands dot and spaces are ignored');
    });

    it('auto: column and Modicon numbers are detected, smaller numbers are ambiguous (from 0 or from 1)', () => {
        assert.deepStrictEqual(detect(43023, 'inputRegs'), { mode: 'column' });
        assert.deepStrictEqual(detect(73031, 'holdingRegs'), { mode: 'column' });
        assert.deepStrictEqual(detect(313023, 'inputRegs'), { mode: 'modicon' });
        assert.deepStrictEqual(detect(413058, 'inputRegs'), { mode: 'modicon' });
        assert.deepStrictEqual(detect(13023, 'inputRegs'), { ambiguous: ['doc', 'protocol'] });
        // holding 33031 is NOT a column (holding columns start at 40001): Sungrow 33031 or protocol 33031
        assert.deepStrictEqual(detect(33031, 'holdingRegs'), { ambiguous: ['doc', 'protocol'] });
        assert.deepStrictEqual(detect(0, 'inputRegs'), { ambiguous: ['protocol'] });
        assert.strictEqual(detect('x', 'inputRegs'), null);
        const r = resolve({ address: 43023, addrMode: 'auto' });
        assert.strictEqual(r.mode, 'column');
        assert.strictEqual(r.a && r.a.protocol, 13022);
        const amb = resolve({ address: 13023, addrMode: 'auto' });
        assert.strictEqual(amb.a, null);
        assert.deepStrictEqual(amb.ambiguous, ['doc', 'protocol']);
        assert.strictEqual(resolve({ address: 13023 }).mode, 'doc', 'without a choice the number is a document number');
    });

    it('register tables: template and defaults have the reference registers at the right address', () => {
        const rows = { inputRegs: [], holdingRegs: [] };
        for (const t of ['inputRegs', 'holdingRegs']) {
            rows[t] = [...ioPackage.native[t], ...CATALOG[t]];
        }
        for (const r of REFERENCE) {
            const k = knownAt(rows, r.regType, 1, r.protocol);
            assert.ok(k, `${r.what}: nothing at protocol ${r.protocol}`);
            assert.match(k.name, r.name, `${r.what}: protocol ${r.protocol}`);
            assert.strictEqual(k.column, r.column, r.what);
            assert.strictEqual(k.part, 0, `${r.what} starts at ${r.column}`);
        }
    });

    it('names the register, its state ID and the off-by-one neighbours (43022 is battery power!)', () => {
        const rows = { inputRegs: ioPackage.native.inputRegs, holdingRegs: ioPackage.native.holdingRegs };
        const r = explain({ address: 13023, addrMode: 'doc' }, undefined, 'en', rows);
        assert.match(r.text, /Sungrow document, column "Register" \(counts from 1\): 13023/);
        assert.match(r.text, /Protocol address \(counts from 0, sent on the bus\): 13022 \(0x32DE\)/);
        assert.match(r.text, /address: 13022 {2}# reg 13023, input_type: input/);
        assert.match(r.text, /: 43023 \(= 30001 \+ 13022\)/);
        assert.match(r.text, /Modicon 6-digit .*: 313023/);
        assert.match(r.text, /inputRegisters\.1\.43023_Battery_level/, 'ID uses the name of the known row');
        assert.match(r.text, /Register at this address: Battery level/);
        assert.match(r.text, /protocol 13021 \/ column 43022 = Battery power/);
        assert.match(r.text, /protocol 13023 \/ column 43024 = Battery SoH/);

        const amb = explain({ address: 33031, addrMode: 'auto', regType: 'holdingRegs' }, undefined, 'de', rows);
        assert.match(amb.text, /als Sungrow-Doku-Nummer \(ab 1\): Protokoll 33030, Spalte 73031 → Max SOC/);
        assert.match(amb.text, /als Protokolladresse \(ab 0\): Protokoll 33031, Spalte 73032 → Min SOC/);
        assert.doesNotMatch(amb.text, /Zeile für die Registertabelle/, 'no table row while the address is ambiguous');

        const mod = explain({ address: 413058, addrMode: 'auto' }, undefined, 'de', {
            holdingRegs: CATALOG.holdingRegs,
        });
        assert.match(mod.text, /erkannt: Modicon 6-stellig/);
        assert.match(mod.text, /Holding-Register, FC3/);
        assert.match(mod.text, /Max SOC EMS .*\[nicht angehakt\]/);
    });

    it('second word of a 32-bit register is named as such', () => {
        const rows = { inputRegs: ioPackage.native.inputRegs };
        const r = explain({ address: 43009, addrMode: 'column' }, undefined, 'en', rows);
        assert.match(r.text, /Register at this address: Load power .*word 2 of 43008/);
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
