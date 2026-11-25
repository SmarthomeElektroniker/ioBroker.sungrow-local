'use strict';

/*
 * Plausibility check of read answers - a wrong value must not reach the states as if it were measured.
 *
 * 1. All-zero answer: the WiNet-S2 sometimes answers a read of the battery (unit 2) with the right length
 *    but only 0 words - every register of the block becomes 0 (SoC 0 %, voltage 0 V, totals 0 kWh, software
 *    version empty) for one round, about three times a day at the reference system, mostly when the answer
 *    came seconds later than usual. Such an answer is held back as a read error (the states keep their
 *    last value) unless it repeats: the `confirm`-th all-zero answer in a row is accepted, and further
 *    all-zero answers then pass at once (a block that really is 0 - PV values at night - is delayed by
 *    `confirm` - 1 rounds only once). Only for input registers (measured values) and blocks of at least
 *    `minWords` registers: a single register that becomes 0 is a normal value, and holding registers
 *    (settings) are often all 0 - EMS mode 0, command 0, power 0 - and are confirmed by read-backs anyway.
 * 2. Value range: a number outside min … max of its row (or outside 0 … 100 for the unit %, when the row has
 *    no own limits) is held back the same way: accepted only when it comes `confirm` times in a row.
 *
 * `confirm` <= 1 switches both checks off.
 */

/**
 * @typedef {object} BlockLike
 * @property {string} regType Register type
 * @property {number} deviceId Modbus unit
 * @property {number} start First address
 * @property {number} count Number of registers
 */

/** Holds back all-zero answers and values outside their limits until they repeat */
class Plausibility {
    /**
     * @param {object} [opts] Options
     * @param {number} [opts.confirm] Number of identical suspicious answers in a row that are accepted (default 3)
     * @param {number} [opts.minWords] Smallest block for the all-zero check (default 4)
     */
    constructor(opts = {}) {
        this.confirm = opts.confirm === undefined ? 3 : Number(opts.confirm) || 0;
        this.minWords = opts.minWords === undefined ? 4 : opts.minWords;
        /** block key -> {row, zeroAccepted} */
        this.blocks = new Map();
        /** register id -> suspicious values in a row */
        this.values = new Map();
    }

    /** @returns {boolean} Checks active */
    get active() {
        return this.confirm > 1;
    }

    /**
     * Checks the raw answer of a block.
     *
     * @param {BlockLike} block Block
     * @param {Buffer} payload Answer bytes
     * @returns {{hold: boolean, row: number, need: number, accepted?: boolean}} hold = discard the answer;
     *   accepted = an all-zero answer was taken over after `need` in a row
     */
    checkBlock(block, payload) {
        const need = this.confirm;
        if (!this.active || block.regType !== 'inputRegs' || block.count < this.minWords) {
            return { hold: false, row: 0, need };
        }
        const key = `${block.regType}:${block.deviceId}:${block.start}+${block.count}`;
        let s = this.blocks.get(key);
        if (!s) {
            // unknown before the first answer: an all-zero first answer is suspicious as well
            s = { row: 0, zeroAccepted: false };
            this.blocks.set(key, s);
        }
        if (!allZero(payload, block.count * 2)) {
            s.row = 0;
            s.zeroAccepted = false;
            return { hold: false, row: 0, need };
        }
        if (s.zeroAccepted) {
            return { hold: false, row: 0, need };
        }
        s.row++;
        if (s.row < need) {
            return { hold: true, row: s.row, need };
        }
        const row = s.row;
        s.row = 0;
        s.zeroAccepted = true;
        return { hold: false, row, need, accepted: true };
    }

    /**
     * Checks one decoded value against the limits of its row.
     *
     * @param {{id: string, unit?: string, min?: number, max?: number}} reg Register
     * @param {unknown} val Value
     * @returns {{hold: boolean, row: number, need: number, min?: number, max?: number}} hold = do not publish
     */
    checkValue(reg, val) {
        const need = this.confirm;
        if (!this.active || typeof val !== 'number' || !Number.isFinite(val)) {
            return { hold: false, row: 0, need };
        }
        const { min, max } = limits(reg);
        if ((min === undefined || val >= min) && (max === undefined || val <= max)) {
            this.values.delete(reg.id);
            return { hold: false, row: 0, need };
        }
        const row = (this.values.get(reg.id) || 0) + 1;
        this.values.set(reg.id, row);
        // from the need-th value in a row on it is taken over (a wrong limit must not hide the value for ever)
        return { hold: row < need, row, need, min, max };
    }

    /** Forgets everything (new configuration). */
    reset() {
        this.blocks.clear();
        this.values.clear();
    }
}

/**
 * @param {Buffer} payload Answer bytes
 * @param {number} len Number of bytes to check
 * @returns {boolean} All checked bytes are 0
 */
function allZero(payload, len) {
    const n = Math.min(len, payload.length);
    if (!n) {
        return false;
    }
    for (let i = 0; i < n; i++) {
        if (payload[i] !== 0) {
            return false;
        }
    }
    return true;
}

/**
 * Limits of a register: own min/max of the row, otherwise 0 … 100 for percent values.
 *
 * @param {{unit?: string, min?: number, max?: number}} reg Register
 * @returns {{min?: number, max?: number}} Limits
 */
function limits(reg) {
    const hasMin = typeof reg.min === 'number' && Number.isFinite(reg.min);
    const hasMax = typeof reg.max === 'number' && Number.isFinite(reg.max);
    if (hasMin || hasMax) {
        return { min: hasMin ? reg.min : undefined, max: hasMax ? reg.max : undefined };
    }
    if (String(reg.unit || '').trim() === '%') {
        return { min: 0, max: 100 };
    }
    return {};
}

module.exports = { Plausibility, allZero, limits };
