'use strict';

const assert = require('node:assert');
const D = require('../../lib/diagnostics');
const io = require('../../io-package.json');
const jsonConfig = require('../../admin/jsonConfig.json');

const LANGS = ['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn'];

describe('diagnostics: names and heartbeat states', () => {
    it('every diagnostic name is translated into all admin languages', () => {
        const defs = [...Object.values(D.DIAG), ...Object.values(D.WRITE_DIAG.states), D.LAST_VALUE_UPDATE];
        for (const d of defs) {
            assert.deepStrictEqual(Object.keys(d.name).sort(), [...LANGS].sort());
            for (const l of LANGS) {
                assert.ok(d.name[l] && d.name[l].trim(), `${d.name.en} / ${l}`);
            }
        }
        for (const o of io.instanceObjects) {
            assert.ok(
                LANGS.every(l => o.common.name[l]),
                o._id,
            );
        }
    });

    it('per group: heartbeat lastRound (date), roundDuration (ms) and a text for the status tab', () => {
        assert.strictEqual(D.DIAG.lastRound.role, 'date');
        assert.strictEqual(D.DIAG.roundDuration.unit, 'ms');
        assert.strictEqual(D.DIAG.lastRoundText.type, 'string');
        assert.strictEqual(D.timeOfDay(new Date(2026, 9, 23, 7, 5, 9)), '07:05:09');
    });

    it('names the group channel with its description in every language', () => {
        const n = D.groupChannelName('akku', 'SBH400 (unit 2)');
        assert.strictEqual(n.de, 'Abfragegruppe akku – SBH400 (unit 2)');
        assert.strictEqual(n.en, 'Poll group akku – SBH400 (unit 2)');
        assert.strictEqual(D.groupChannelName('live', '').de, 'Abfragegruppe live');
    });
});

describe('diagnostics: timing of the battery group', () => {
    it('the proven battery timing (timeout 15000, pause 5000) gives no warning', () => {
        assert.deepStrictEqual(D.timingWarnings({ name: 'akku', timeout: 15000, pauseAfter: 5000 }, true), []);
    });
    it('warns about a too short pause and a too short timeout', () => {
        const w = D.timingWarnings({ name: 'akku', timeout: 8000, pauseAfter: 3000 }, true);
        assert.strictEqual(w.length, 2);
        assert.match(w[0], /shorter than the instruction interval/);
        assert.match(w[1], /should be longer/);
    });
    it('groups without the slow unit are not checked', () => {
        assert.deepStrictEqual(D.timingWarnings({ name: 'live', timeout: 600, pauseAfter: 0 }, false), []);
    });
});

describe('admin: interval warnings of the group table', () => {
    const cols = jsonConfig.items.tabExpert.items.groups.items;
    const checks = cols
        .filter(c => c.validator)
        .map(c => ({ attr: c.attr, fn: new Function('data', `return ${c.validator}`) }));
    /** @param {any} row Group row */
    const failing = row => checks.filter(c => c.attr !== 'name' && !c.fn(row)).map(c => c.attr);

    it('the proven intervals of the installation pass without a warning', () => {
        const proven = [
            { name: 'live', interval: 5, timeout: 10000, pauseAfter: 0 },
            { name: 'energie', interval: 60, timeout: 10000, pauseAfter: 0 },
            { name: 'steuerung', interval: 60, timeout: 10000, pauseAfter: 0 },
            { name: 'akku', interval: 120, timeout: 15000, pauseAfter: 5000 },
        ];
        for (const row of [...proven, ...io.native.groups]) {
            assert.deepStrictEqual(failing(row), [], row.name);
        }
    });

    it('marks the measured failures (live 3 s, akku 60 s, short battery pause/timeout) - warning only', () => {
        assert.deepStrictEqual(failing({ name: 'live', interval: 3, timeout: 10000, pauseAfter: 0 }), ['interval']);
        assert.deepStrictEqual(failing({ name: 'akku', interval: 60, timeout: 15000, pauseAfter: 5000 }), ['interval']);
        assert.deepStrictEqual(failing({ name: 'akku', interval: 120, timeout: 9000, pauseAfter: 4000 }), [
            'timeout',
            'pauseAfter',
        ]);
        for (const c of cols.filter(x => ['interval', 'timeout', 'pauseAfter'].includes(x.attr))) {
            assert.ok(!c.validatorNoSaveOnError, `${c.attr} must not block saving`);
        }
    });

    it('all texts of the admin page exist in every language', () => {
        const fs = require('node:fs');
        const path = require('node:path');
        const used = new Set();
        const json = JSON.stringify(jsonConfig);
        for (const m of json.matchAll(
            /"(label|text|title|help|validatorErrorText|tooltip|trueText|falseText|textAlive|textNotAlive)":"([^"]+)"/g,
        )) {
            used.add(m[2]);
        }
        const typeNames = new Set(require('../../lib/registers').TYPES);
        // option labels marked noTranslation (short type names, factors in the tables) are shown as they are
        const walk = o => {
            if (Array.isArray(o)) {
                o.forEach(walk);
            } else if (o && typeof o === 'object') {
                if (o.noTranslation && typeof o.label === 'string') {
                    typeNames.add(o.label);
                }
                Object.values(o).forEach(walk);
            }
        };
        walk(jsonConfig);
        for (const l of LANGS) {
            const t = JSON.parse(
                fs.readFileSync(path.join(__dirname, '..', '..', 'admin', 'i18n', `${l}.json`), 'utf8'),
            );
            const missing = [...used].filter(k => !typeNames.has(k) && !(k in t));
            assert.deepStrictEqual(missing, [], l);
        }
    });
});
