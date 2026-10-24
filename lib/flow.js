'use strict';

/*
 * Energy flow for the overview tiles: battery direction and house consumption.
 *
 * Signs (verified 24.10.2026 on the reference installation SH20T + SBH400 with 4 days of history: whenever the
 * battery current 13021 (column 43021) was positive the state of charge FELL, -0.84 % per 10 min over 811
 * samples; negative current -> SoC rose, +0.38 % per 10 min over 1849 samples; raw read 17:37: battery power
 * signed 5214 (column 35214) +1500 W while AC output 13034 = PV 599 W + 1500 W - losses):
 * - battery current 43021 and "battery power signed" 35214: + = DISCHARGING, - = charging
 * - battery power 43022: absolute value, no sign
 * - meter power 35601: + = import from the grid, - = feed-in
 *
 * House consumption = AC output of the inverter (43034, 13034 in the document) + meter (35601). This does not
 * depend on the battery sign and contains no inverter losses (17:39, measured without other generators: AC 2008 W
 * - 37 W = 1971 W, load register 2003 W; PV 703 W + battery 1475 W - AC 2008 W = ~165 W own consumption and losses
 * of the inverter). Without 43034: PV + battery discharge + meter (contains the inverter losses).
 *
 * A generator that the inverter does not measure (e.g. a small wind turbine in the house grid) makes the result
 * too small or negative. It is NOT clamped to 0: a clearly negative result is reported as "unbalanced".
 *
 * Pure function, also bundled into the admin component.
 */

/**
 * @param {number|undefined} v Value
 * @returns {boolean} A finite number
 */
function has(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

/** Tolerance before a negative house consumption is reported as unbalanced (W) */
const TOLERANCE = 50;

/**
 * @param {{pv?: number, battPower?: number, battCurrent?: number, battSigned?: number, acPower?: number, grid?: number}} v Values (W, A)
 * @returns {{battery: number|undefined, house: number|undefined, houseSource: 'ac'|'balance'|undefined, unbalanced: boolean, direction: 'charge'|'discharge'|'idle'|undefined}} Battery (+ charging, - discharging), house consumption (not clamped) and whether it cannot be balanced
 */
function energyFlow(v) {
    /** battery power for the display: + = charging, - = discharging */
    let battery;
    if (has(v.battSigned)) {
        battery = -Number(v.battSigned);
    } else if (has(v.battPower)) {
        const p = Math.abs(Number(v.battPower));
        if (has(v.battCurrent) && Number(v.battCurrent) !== 0) {
            battery = Number(v.battCurrent) > 0 ? -p : p;
        } else if (p < 1) {
            battery = 0;
        } else if (has(v.pv) && has(v.acPower)) {
            // current rounds to 0 A at small powers: PV above the AC output -> the difference goes into the battery
            battery = Number(v.pv) >= Number(v.acPower) ? p : -p;
        }
    }
    let house;
    /** @type {'ac'|'balance'|undefined} */
    let houseSource;
    if (has(v.acPower) && has(v.grid)) {
        house = Number(v.acPower) + Number(v.grid);
        houseSource = 'ac';
    } else if (has(v.pv) && battery !== undefined && has(v.grid)) {
        house = Number(v.pv) - battery + Number(v.grid);
        houseSource = 'balance';
    }
    /** @type {'charge'|'discharge'|'idle'|undefined} */
    let direction;
    if (battery !== undefined) {
        direction = Math.abs(battery) < 1 ? 'idle' : battery > 0 ? 'charge' : 'discharge';
    }
    return { battery, house, houseSource, unbalanced: house !== undefined && house < -TOLERANCE, direction };
}

module.exports = { energyFlow, TOLERANCE };
