'use strict';

/*
 * Language check (0.5.1): every text the cards show and every value table of the template exists in all 11
 * ioBroker languages. common.states of an object only takes plain strings (js-controller), so the value
 * tables are translated by the raw value (lib/catalog-meta.json) - the device manager and the admin pick the
 * language, own texts of the user stay as they are.
 */

const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { normalise, parseStates } = require('../../lib/registers');
const { templateStates, statesIn, CATALOG } = require('../../lib/catalog');
const { SungrowDeviceManagement, formatRow, faultIndicator, TXT, LANGS } = require('../../lib/deviceManager');
const META = require('../../lib/catalog-meta.json');
const ioPackage = require('../../io-package.json');

const NS = 'sungrow-local.0';
const CYR = /[Ѐ-ӿ]/;
const CJK = /[一-鿿]/;
/** Value tables without words (type codes, model names): the same in every language */
const NEUTRAL = new Set(['inputRegs:1:35000', 'inputRegs:1:43043']);
/**
 * Words that are correctly the same in two related languages (the check below flags uk = ru and pt = es
 * otherwise, because that usually means a copied translation).
 */
const SAME_OK = new Set(['lastValues', 'soc', 'battTemp', 'maxSoc', 'emsMode']);

/**
 * @param {string} where Source of the text
 * @param {Record<string, string>} obj Text per language
 * @param {boolean} [checkCopies] Flag uk = ru and pt = es
 */
function checkLangs(where, obj, checkCopies = true) {
    assert.ok(obj && typeof obj === 'object', `${where}: multilingual object`);
    assert.deepStrictEqual(Object.keys(obj).sort(), [...LANGS].sort(), `${where}: exactly the 11 languages`);
    for (const l of LANGS) {
        assert.ok(typeof obj[l] === 'string' && obj[l].trim(), `${where}.${l} is empty`);
        assert.strictEqual(obj[l], obj[l].trim(), `${where}.${l} has leading/trailing blanks`);
    }
    assert.ok(CYR.test(obj.ru), `${where}.ru without Cyrillic letters`);
    assert.ok(CYR.test(obj.uk), `${where}.uk without Cyrillic letters`);
    assert.ok(CJK.test(obj['zh-cn']), `${where}.zh-cn without Chinese characters`);
    if (checkCopies) {
        if (obj.uk.length > 6) {
            assert.notStrictEqual(obj.uk, obj.ru, `${where}: uk = ru`);
        }
        if (obj.pt.length > 8) {
            assert.notStrictEqual(obj.pt, obj.es, `${where}: pt = es`);
        }
    }
}

/** @returns {Map<string, any>} regType:unit:_address -> row of the template (defaults + catalog) */
function templateRows() {
    const rows = new Map();
    for (const src of [ioPackage.native, CATALOG]) {
        for (const t of ['inputRegs', 'holdingRegs']) {
            for (const r of src[t]) {
                rows.set(`${t}:${parseInt(r.deviceId, 10) || 1}:${parseInt(r._address, 10)}`, r);
            }
        }
    }
    return rows;
}

describe('languages: card texts (lib/deviceManager.js)', () => {
    it('every text key in all 11 languages', () => {
        for (const [k, v] of Object.entries(TXT)) {
            // product words that are the same everywhere are allowed; copies uk = ru / pt = es only where correct
            checkLangs(`TXT.${k}`, v, !SAME_OK.has(k));
        }
    });

    it('wording of 0.5.1 (battery state, feed-in to the grid, idle)', () => {
        assert.strictEqual(TXT.soh.de, 'Batteriezustand (SoH)');
        assert.match(TXT.exportToday.pl, /do sieci/);
        assert.match(TXT.exportTotal.pl, /do sieci/);
        assert.match(TXT.export.pl, /do sieci/);
        assert.strictEqual(TXT.idle.uk, 'очікування');
    });
});

describe('languages: value tables of the template (lib/catalog-meta.json)', () => {
    const rows = templateRows();

    it('every template value table is translated (or has no words)', () => {
        let n = 0;
        for (const [key, row] of rows) {
            if (!String(row.states || '').trim() || NEUTRAL.has(key)) {
                continue;
            }
            const m = META.registers[key];
            assert.ok(m && m.states, `${key} (${row.name}): value table without translation`);
            assert.strictEqual(m.statesDefault, row.states, `${key}: statesDefault = states column of the template`);
            assert.deepStrictEqual(
                Object.keys(m.states).sort(),
                Object.keys(parseStates(row.states)).sort(),
                `${key}: same raw values as the template`,
            );
            for (const [code, t] of Object.entries(m.states)) {
                checkLangs(`${key}=${code}`, t, false);
            }
            n++;
        }
        assert.ok(n >= 26, `translated tables: ${n}`);
    });

    it('operating state 43000 and EMS mode 53050 have translated values', () => {
        const run = templateStates('inputRegs', 1, 43000, rows.get('inputRegs:1:43000').states);
        assert.ok(run);
        assert.strictEqual(statesIn(run, 'de')['0'], 'Betrieb');
        assert.strictEqual(statesIn(run, 'de')['-32768'], 'Stopp');
        assert.strictEqual(statesIn(run, 'pl')['5120'], 'Czuwanie');
        const ems = templateStates('holdingRegs', 1, 53050, '');
        assert.ok(ems, 'empty column = template');
        assert.strictEqual(statesIn(ems, 'fr')['0'], 'Autoconsommation');
        assert.strictEqual(statesIn(ems, 'xx')['0'], 'Self-consumption', 'unknown language -> English');
    });

    it('own texts of the user are never translated', () => {
        assert.strictEqual(templateStates('inputRegs', 1, 43000, '0:Betrieb;5120:Standby'), undefined);
        assert.strictEqual(templateStates('inputRegs', 1, 35000, ''), undefined, 'model names stay');
        assert.strictEqual(templateStates('inputRegs', 1, 43052, ''), undefined, 'no template table');
    });

    it('the template defaults stay valid common.states (plain strings, English)', () => {
        for (const [key, row] of rows) {
            const s = parseStates(row.states);
            if (!s) {
                continue;
            }
            for (const [k, v] of Object.entries(s)) {
                assert.strictEqual(typeof v, 'string', `${key}=${k}`);
                assert.ok(!/[ÄÖÜäöüß]/.test(v) || key === 'holdingRegs:1:72535', `${key}=${k}: English default`);
            }
        }
    });
});

describe('languages: device manager shows the values in the language', () => {
    /**
     * @param {string} lang System language
     * @param {any[]} regs Registers
     * @param {Record<string, any>} states Full ID -> value
     * @param {Record<string, any>} [objects] Full ID -> object
     * @returns {any} Fake adapter
     */
    function fakeAdapter(lang, regs, states, objects = {}) {
        const a = new EventEmitter();
        Object.assign(a, {
            namespace: NS,
            lang,
            regsById: new Map(regs.map(r => [`${NS}.${r.id}`, r])),
            log: { debug() {}, info() {}, warn() {}, error() {} },
            getForeignStateAsync: async id =>
                id in states ? { val: states[id], ack: true, ts: 1000, lc: 1000, from: 'test', q: 0 } : null,
            getForeignObjectAsync: async id => objects[id] || null,
            sendTo: () => {},
        });
        return a;
    }
    const regs = () => [
        ...normalise('inputRegs', ioPackage.native.inputRegs).regs,
        ...normalise('holdingRegs', ioPackage.native.holdingRegs).regs,
    ];
    const idOf = (list, alias) => `${NS}.${list.find(r => r.alias === alias && r.deviceId === 1).id}`;

    for (const [lang, want] of [
        ['de', 'Eigenverbrauch'],
        ['en', 'Self-consumption'],
        ['pl', 'Autokonsumpcja'],
        ['uk', 'Власне споживання'],
        ['zh-cn', '自发自用'],
    ]) {
        it(`EMS mode on the battery card in ${lang}`, async () => {
            const list = regs();
            const ems = idOf(list, 53050);
            // the object carries English texts (written in another language before): the card still translates
            const a = fakeAdapter(
                lang,
                list,
                { [ems]: 0, [idOf(list, 43023)]: 80, [idOf(list, 43022)]: 0, [idOf(list, 43021)]: 0 },
                { [ems]: { common: { states: { 0: 'Self-consumption' } } } },
            );
            const dm = new SungrowDeviceManagement(a);
            const bat = (await dm.deviceInfos()).find(d => d.id === 'battery');
            const row = bat.controls.find(c => c.id === 'emsMode');
            assert.strictEqual(row.state.val, want);
            assert.strictEqual(row.label[lang], TXT.emsMode[lang]);
        });
    }

    it('own value table of the user: shown as written', async () => {
        const list = regs();
        const r = list.find(x => x.alias === 53050);
        r.statesRaw = '0:Eigenverbrauch (mein Text);2:Zwang';
        r.states = parseStates(r.statesRaw);
        const ems = idOf(list, 53050);
        const a = fakeAdapter(
            'en',
            list,
            { [ems]: 0, [idOf(list, 43023)]: 80 },
            { [ems]: { common: { states: r.states } } },
        );
        const dm = new SungrowDeviceManagement(a);
        const bat = (await dm.deviceInfos()).find(d => d.id === 'battery');
        assert.strictEqual(bat.controls.find(c => c.id === 'emsMode').state.val, 'Eigenverbrauch (mein Text)');
    });

    it('fault tooltip: template texts in every language, own texts as written', () => {
        const multi = {
            0: Object.fromEntries(LANGS.map(l => [l, 'x'])),
            21760: META.registers['inputRegs:1:43000'].states['21760'],
        };
        const ind = faultIndicator('x.43052', multi);
        const lvl = ind.levels.find(l => l.value === 21760);
        for (const l of LANGS) {
            assert.ok(lvl.tooltip[l].includes(multi[21760][l]), `${l}: ${lvl.tooltip[l]}`);
            assert.ok(lvl.tooltip[l].startsWith(TXT.faultLabel[l]), `${l}: label first`);
        }
        assert.strictEqual(lvl.tooltip.de, 'Fehler: Störung');
    });

    it('formatRow: raw value without a text stays the number', () => {
        assert.strictEqual(formatRow('states', { value: 99 }, 'de', { 0: 'Betrieb' }), '99');
    });
});
