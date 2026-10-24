'use strict';

/*
 * Bus load ("Auslastung") of a configuration - computed from the SAME block building the adapter uses
 * (lib/registers.js: per group, per register type and per unit, maxBlock/maxGap).
 *
 * Model (calibrated on the reference installation SH20T + SBH400 behind a WiNet-S2, 23.10.2026):
 * - The gateway handles about `capacity` requests per second over a longer time. Measured: live 5 s +
 *   energie 60 s + steuerung 60 s + akku 120 s (1.14 requests/s) ran without skipped rounds, live 3 s
 *   (1.81/s) skipped rounds, akku 60 s produced timeouts. Default capacity 1.25/s puts the measured end
 *   state at ~95 % (yellow = "fully used"), live 3 s and akku 60 s above 100 % (red).
 * - A request with a pause (slow bus device, e.g. SBH400 with 5000 ms instruction interval) blocks the
 *   bus for that pause: its share is pause/interval (time fraction) on top of the request rate.
 * - A group whose interval is shorter than the longest pause of the other groups will skip rounds.
 *
 * Pure functions without Node APIs: also bundled into the admin component (src-admin).
 */

const { normalise, buildBlocks, num } = require('./registers');

/** Default capacity in requests per second (see above) */
const DEFAULT_CAPACITY = 1.25;
/** Typical response time of one request in ms (measured 4-16 ms) - the gap/pause comes on top */
const RESPONSE_MS = 20;
/** Limits of the traffic light: below warn = green, up to over = yellow, above = red */
const LEVELS = { warn: 0.8, over: 1.0 };

/**
 * @param {number} load Load as fraction of the capacity
 * @returns {'ok'|'warn'|'over'} Traffic light
 */
function level(load) {
    if (load > LEVELS.over + 1e-9) {
        return 'over';
    }
    if (load >= LEVELS.warn) {
        return 'warn';
    }
    return 'ok';
}

/**
 * Explains why each block of a group is a request of its own.
 *
 * @param {import('./registers').Block[]} blocks Blocks of ONE group in poll order
 * @param {number} maxBlock Max registers per request
 * @param {number} maxGap Max bridged gap
 * @returns {Array<Record<string, any>>} One entry per block
 */
function explainBlocks(blocks, maxBlock, maxGap) {
    const out = [];
    /** @type {Map<string, import('./registers').Block>} last block per register type + unit */
    const last = new Map();
    let prev = null;
    for (const b of blocks) {
        const key = `${b.regType}|${b.deviceId}`;
        const first = b.regs[0];
        const lastReg = b.regs[b.regs.length - 1];
        const entry = {
            regType: b.regType,
            unit: b.deviceId,
            fc: b.regType === 'inputRegs' ? 4 : 3,
            start: b.start,
            count: b.count,
            regs: b.regs.length,
            firstAlias: first.alias,
            lastAlias: lastReg.alias,
            firstName: first.description || first.name,
            ids: b.regs.map(r => r.id),
            reason: /** @type {Record<string, any>} */ ({ kind: 'base' }),
        };
        const before = last.get(key);
        if (before) {
            const prevLast = before.regs[before.regs.length - 1];
            const end = before.start + before.count;
            const gap = b.start - end;
            if (b.start + first.len - before.start > maxBlock && gap <= maxGap) {
                entry.reason = { kind: 'size', maxBlock, prevAlias: prevLast.alias };
            } else {
                entry.reason = { kind: 'gap', gap, maxGap, prevAlias: prevLast.alias };
            }
        } else if (prev) {
            // another register table (FC3 vs FC4) is always an own request, another unit as well
            const sameTable = [...last.keys()].some(k => k.startsWith(`${b.regType}|`));
            entry.reason = sameTable
                ? { kind: 'unit', prevUnit: prev.deviceId }
                : { kind: 'type', prevFc: prev.regType === 'inputRegs' ? 4 : 3 };
        }
        last.set(key, b);
        prev = b;
        out.push(entry);
    }
    return out;
}

/**
 * Computes requests, rates and load of a configuration (instance native).
 *
 * @param {Record<string, any>} native Configuration (groups, inputRegs, holdingRegs, maxBlock, maxGap, busCapacity)
 * @param {{capacity?: number, measured?: Record<string, number>}} [opts] Capacity override, measured round durations (ms) per group
 * @returns {Record<string, any>} Analysis: groups[], total, problems
 */
function analyse(native, opts = {}) {
    const c = native || {};
    const capacity = Math.max(0.05, num(opts.capacity !== undefined ? opts.capacity : c.busCapacity, DEFAULT_CAPACITY));
    const maxBlock = parseInt(String(c.maxBlock), 10) || 100;
    const maxGapRaw = parseInt(String(c.maxGap), 10);
    const maxGap = Number.isInteger(maxGapRaw) ? maxGapRaw : 10;
    const requestGap = Math.max(0, num(c.requestGap, 100));
    const input = normalise('inputRegs', c.inputRegs);
    const holding = normalise('holdingRegs', c.holdingRegs);
    const regs = [...input.regs, ...holding.regs];
    const problems = [...input.problems, ...holding.problems];

    const groups = [];
    const known = new Set();
    for (const row of Array.isArray(c.groups) ? c.groups : []) {
        const name = String((row && row.name) || '').trim();
        if (!name || known.has(name)) {
            continue;
        }
        known.add(name);
        const enabled = row.enabled !== false;
        const interval = Math.max(1, num(row.interval, 60));
        const pauseAfter = Math.max(0, num(row.pauseAfter, 0));
        const members = regs.filter(r => r.group === name && r.poll);
        const blocks = [];
        for (const regType of ['inputRegs', 'holdingRegs']) {
            const units = [...new Set(members.filter(r => r.regType === regType).map(r => r.deviceId))];
            for (const unit of units) {
                blocks.push(
                    ...buildBlocks(
                        members.filter(r => r.regType === regType && r.deviceId === unit),
                        maxBlock,
                        maxGap,
                    ),
                );
            }
        }
        const requests = enabled ? blocks.length : 0;
        const perSecond = requests / interval;
        // time the bus is blocked by the pauses of this group (fraction of time)
        const pauseShare = enabled ? (requests * pauseAfter) / 1000 / interval : 0;
        const roundMs = requests * (Math.max(requestGap, pauseAfter) + RESPONSE_MS);
        groups.push({
            name,
            description: String(row.description || ''),
            enabled,
            interval,
            pauseAfter,
            timeout: num(row.timeout, 10000),
            registers: members.length,
            requests,
            perSecond,
            pauseShare,
            load: perSecond / capacity + pauseShare,
            roundMs,
            measuredMs: opts.measured && typeof opts.measured[name] === 'number' ? opts.measured[name] : undefined,
            blocks: explainBlocks(blocks, maxBlock, maxGap),
            warnings: /** @type {Array<Record<string, any>>} */ ([]),
        });
    }
    // registers in groups that do not exist are not read
    const orphans = regs.filter(r => r.poll && !known.has(r.group)).map(r => ({ id: r.id, group: r.group }));

    // skipped rounds: interval shorter than the longest pause of another group (+ own round)
    for (const g of groups) {
        if (!g.enabled || !g.requests) {
            continue;
        }
        const blocker = groups
            .filter(o => o !== g && o.enabled && o.requests && o.pauseAfter > 0)
            .sort((a, b) => b.pauseAfter - a.pauseAfter)[0];
        if (blocker) {
            const own = (g.measuredMs !== undefined ? g.measuredMs : g.roundMs) / 1000;
            if (g.interval < blocker.pauseAfter / 1000) {
                g.warnings.push({ kind: 'skipSure', other: blocker.name, pause: blocker.pauseAfter });
            } else if (g.interval < blocker.pauseAfter / 1000 + own) {
                g.warnings.push({ kind: 'skipRisk', other: blocker.name, pause: blocker.pauseAfter });
            }
        }
        if (g.pauseAfter > 0 && g.timeout <= g.pauseAfter) {
            g.warnings.push({ kind: 'timeoutShort', timeout: g.timeout, pause: g.pauseAfter });
        }
        if (g.measuredMs !== undefined && g.measuredMs > g.interval * 1000) {
            g.warnings.push({ kind: 'roundTooLong', measured: g.measuredMs });
        }
        g.level = level(g.load);
        if (g.warnings.some(w => w.kind === 'skipSure')) {
            g.level = 'over';
        } else if (g.warnings.some(w => w.kind === 'skipRisk' || w.kind === 'roundTooLong') && g.level === 'ok') {
            g.level = 'warn';
        }
    }
    for (const g of groups) {
        if (!g.level) {
            g.level = 'ok';
        }
    }
    const perSecond = groups.reduce((s, g) => s + g.perSecond, 0);
    const pauseShare = groups.reduce((s, g) => s + g.pauseShare, 0);
    const load = perSecond / capacity + pauseShare;
    let totalLevel = level(load);
    if (groups.some(g => g.level === 'over')) {
        totalLevel = 'over';
    } else if (totalLevel === 'ok' && groups.some(g => g.level === 'warn')) {
        totalLevel = 'warn';
    }
    return {
        capacity,
        maxBlock,
        maxGap,
        groups,
        orphans,
        problems,
        total: {
            requests: groups.reduce((s, g) => s + g.requests, 0),
            registers: groups.reduce((s, g) => s + (g.enabled ? g.registers : 0), 0),
            perSecond,
            pauseShare,
            load,
            level: totalLevel,
        },
    };
}

/**
 * Difference of the analysis when one register would be added to / removed from a group: number of
 * extra requests and the block that causes them (for "+1 request because …" hints while clicking).
 *
 * @param {Record<string, any>} before analyse() of the current configuration
 * @param {Record<string, any>} after analyse() of the changed configuration
 * @returns {Record<string, number>} Change of the request count per group (only groups that changed)
 */
function requestDelta(before, after) {
    const out = {};
    const names = new Set([...before.groups.map(g => g.name), ...after.groups.map(g => g.name)]);
    for (const n of names) {
        const a = before.groups.find(g => g.name === n);
        const b = after.groups.find(g => g.name === n);
        const d = (b ? b.requests : 0) - (a ? a.requests : 0);
        if (d) {
            out[n] = d;
        }
    }
    return out;
}

module.exports = { analyse, explainBlocks, requestDelta, level, DEFAULT_CAPACITY, RESPONSE_MS, LEVELS };
