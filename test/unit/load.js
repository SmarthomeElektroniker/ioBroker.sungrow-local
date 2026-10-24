'use strict';

/*
 * Bus load: request count from the real block building, rates, traffic light and the reasons per request.
 * Calibration points of the reference installation (23.10.2026): live 5 s / energie 60 s / steuerung 60 s /
 * akku 120 s = fully used but stable; live 3 s skipped rounds; akku 60 s produced timeouts.
 */

const assert = require('node:assert');
const { analyse, requestDelta, level, DEFAULT_CAPACITY } = require('../../lib/load');
const ioPackage = require('../../io-package.json');

/** @returns {Record<string, any>} Copy of the default configuration */
function defaults() {
    return JSON.parse(JSON.stringify(ioPackage.native));
}

/**
 * @param {Record<string, any>} n Configuration
 * @param {string} name Group
 * @returns {Record<string, any>} Group row
 */
function group(n, name) {
    return n.groups.find(g => g.name === name);
}

describe('load: bus load of a configuration', () => {
    it('counts the requests exactly like the adapter (live 5, energie 2, steuerung 6, akku 1)', () => {
        const a = analyse(defaults());
        const req = Object.fromEntries(a.groups.map(g => [g.name, g.requests]));
        assert.strictEqual(req.live, 5);
        assert.strictEqual(req.energie, 2);
        assert.strictEqual(req.steuerung, 6);
        assert.strictEqual(req.akku, 1);
        assert.strictEqual(a.capacity, DEFAULT_CAPACITY);
    });

    it('measured end state (live 5 s, akku 120 s) is yellow: fully used, below 100 %', () => {
        const a = analyse(defaults());
        assert.ok(a.total.load > 0.8 && a.total.load <= 1, String(a.total.load));
        assert.strictEqual(a.total.level, 'warn');
        assert.ok(Math.abs(a.total.perSecond - 1.1417) < 0.01, String(a.total.perSecond));
    });

    it('live 3 s (skipped rounds measured) and akku 60 s (timeouts measured) are red', () => {
        const n3 = defaults();
        group(n3, 'live').interval = 3;
        assert.strictEqual(analyse(n3).total.level, 'over');
        const n60 = defaults();
        group(n60, 'akku').interval = 60;
        assert.strictEqual(analyse(n60).total.level, 'over');
    });

    it('a group shorter than the battery pause skips rounds for sure', () => {
        const n = defaults();
        group(n, 'live').interval = 4;
        const live = analyse(n).groups.find(g => g.name === 'live');
        assert.ok(live.warnings.some(w => w.kind === 'skipSure' && w.other === 'akku'));
        assert.strictEqual(live.level, 'over');
    });

    it('relaxed intervals are green', () => {
        const n = defaults();
        group(n, 'live').interval = 15;
        const a = analyse(n);
        assert.strictEqual(a.total.level, 'ok');
    });

    it('explains every extra request (gap / unit / register type)', () => {
        const a = analyse(defaults());
        const live = a.groups.find(g => g.name === 'live');
        assert.strictEqual(live.blocks[0].reason.kind, 'base');
        // 35033 starts 11 registers after the block that ends at 35022: one more than maxGap 10
        const gap = live.blocks[1].reason;
        assert.strictEqual(gap.kind, 'gap');
        assert.strictEqual(gap.gap, 11);
        assert.strictEqual(gap.maxGap, 10);
        // mixed group: second unit and second register type are separate requests
        const n = defaults();
        n.inputRegs.find(r => r._address === 40744).group = 'live';
        n.holdingRegs.find(r => r._address === 73031).group = 'live';
        const mixed = analyse(n).groups.find(g => g.name === 'live');
        const kinds = mixed.blocks.map(b => b.reason.kind);
        assert.ok(kinds.includes('unit'), kinds.join());
        assert.ok(kinds.includes('type'), kinds.join());
    });

    it('a block larger than maxBlock is split with reason "size"', () => {
        const n = defaults();
        n.maxBlock = 20;
        const energie = analyse(n).groups.find(g => g.name === 'energie');
        assert.ok(energie.blocks.some(b => b.reason.kind === 'size'));
    });

    it('requestDelta: ticking a register next to others costs nothing, a far one +1', () => {
        const before = analyse(defaults());
        const near = defaults();
        // 35018 lies inside the first live block
        const row = near.inputRegs.find(r => r._address === 35018 && r.deviceId === 1);
        if (row) {
            row.group = 'live';
            row.enabled = true;
            assert.deepStrictEqual(requestDelta(before, analyse(near)), {});
        }
        const far = defaults();
        far.inputRegs.push({ _address: 39000, deviceId: 1, name: 'far away', type: 'uint16be', group: 'live' });
        assert.deepStrictEqual(requestDelta(before, analyse(far)), { live: 1 });
    });

    it('disabled groups and unticked rows cost nothing; orphan groups are reported', () => {
        const n = defaults();
        group(n, 'live').enabled = false;
        n.inputRegs.push({ _address: 39000, deviceId: 1, name: 'x', type: 'uint16be', group: 'nowhere' });
        const a = analyse(n);
        assert.strictEqual(a.groups.find(g => g.name === 'live').requests, 0);
        assert.deepStrictEqual(
            a.orphans.map(o => o.group),
            ['nowhere'],
        );
    });

    it('capacity comes from the configuration (busCapacity) and can be overridden', () => {
        const n = defaults();
        n.busCapacity = 2.5;
        assert.strictEqual(analyse(n).capacity, 2.5);
        assert.strictEqual(analyse(n, { capacity: 1 }).capacity, 1);
        assert.strictEqual(level(0.5), 'ok');
        assert.strictEqual(level(0.85), 'warn');
        assert.strictEqual(level(1.2), 'over');
    });

    it('a measured round longer than the interval is a warning', () => {
        const a = analyse(defaults(), { measured: { energie: 70000 } });
        const e = a.groups.find(g => g.name === 'energie');
        assert.ok(e.warnings.some(w => w.kind === 'roundTooLong'));
    });
});
