'use strict';

/*
 * Energy flow of the overview: battery direction and house consumption with values recorded on the reference
 * installation (raw reads 24.10.2026, documented in lib/flow.js).
 */

const assert = require('node:assert');
const { energyFlow } = require('../../lib/flow');

describe('flow: battery direction and house consumption', () => {
    it('17:39 without other generators: discharging 1475 W, house = AC + grid (1971 W, load register 2003 W)', () => {
        const f = energyFlow({ pv: 703, battPower: 1488, battCurrent: 2.5, acPower: 2008, grid: -37 });
        assert.strictEqual(f.direction, 'discharge');
        assert.strictEqual(f.battery, -1488);
        assert.strictEqual(f.house, 1971);
        assert.strictEqual(f.houseSource, 'ac');
        assert.strictEqual(f.unbalanced, false);
        assert.ok(Math.abs(f.house - 2003) < 100);
    });

    it('battery power signed (35214) wins: + = discharging', () => {
        const f = energyFlow({
            pv: 703,
            battPower: 1488,
            battCurrent: -2.5,
            battSigned: 1475,
            acPower: 2008,
            grid: -37,
        });
        assert.strictEqual(f.battery, -1475);
        assert.strictEqual(f.direction, 'discharge');
    });

    it('negative battery current = charging (night charging from the grid: -1.8 A, SoC rising)', () => {
        const f = energyFlow({ pv: 0, battPower: 1000, battCurrent: -1.8, grid: 1200 });
        assert.strictEqual(f.direction, 'charge');
        assert.strictEqual(f.battery, 1000);
        // without AC output: balance PV - charging + grid
        assert.strictEqual(f.house, 200);
        assert.strictEqual(f.houseSource, 'balance');
    });

    it('current rounded to 0 A: direction from PV vs. AC output', () => {
        assert.strictEqual(
            energyFlow({ pv: 600, battPower: 120, battCurrent: 0, acPower: 470, grid: 0 }).direction,
            'charge',
        );
        assert.strictEqual(
            energyFlow({ pv: 100, battPower: 120, battCurrent: 0, acPower: 210, grid: 0 }).direction,
            'discharge',
        );
        assert.strictEqual(energyFlow({ pv: 100, battPower: 0, battCurrent: 0 }).direction, 'idle');
    });

    it('an unmeasured generator (wind turbine, 17:31) is not hidden as 0 W but reported as unbalanced', () => {
        // PV 167 W, battery 472 W discharging, feed-in 19 W, AC output lower than the feed-in of the turbine
        const f = energyFlow({ pv: 167, battPower: 472, battCurrent: 0.9, acPower: -200, grid: -19 });
        assert.strictEqual(f.unbalanced, true);
        assert.ok(f.house < 0, 'not clamped');
        const ok = energyFlow({ pv: 167, battPower: 472, battCurrent: 0.9, grid: -19 });
        assert.strictEqual(ok.house, 620);
        assert.strictEqual(ok.unbalanced, false);
    });

    it('missing values give undefined, no guess', () => {
        const f = energyFlow({ pv: 500 });
        assert.strictEqual(f.house, undefined);
        assert.strictEqual(f.battery, undefined);
        assert.strictEqual(f.unbalanced, false);
    });
});
