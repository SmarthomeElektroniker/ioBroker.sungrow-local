'use strict';

/*
 * ioBroker adapter for a Sungrow hybrid inverter (and battery) behind a WiNet-S2 gateway.
 *
 * Replaces a generic modbus instance: same state IDs (inputRegisters.<unit>.<address>_<name>,
 * holdingRegisters.<unit>.<address>_<name>), but exactly one coordinated connection, an own poll
 * interval per register group, writes before reads with confirmation, and diagnostics per group.
 */

const utils = require('@iobroker/adapter-core');
const ModbusRTU = require('modbus-serial');
const { normalise, buildBlocks, REG_NAMES, num, flag, checkWriteValue } = require('./lib/registers');
const { Poller } = require('./lib/poller');
const {
    T,
    DIAG,
    WRITE_DIAG,
    LAST_VALUE_UPDATE,
    groupChannelName,
    timingWarnings,
    timeOfDay,
    groupKey,
    dayKey,
} = require('./lib/diagnostics');

class SungrowLocal extends utils.Adapter {
    /** @param {Partial<utils.AdapterOptions>} [options] Adapter options */
    constructor(options = {}) {
        super({ ...options, name: 'sungrow-local' });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.poller = null;
        /** full ID -> register */
        this.regsById = new Map();
        /** full ID -> last value written to the state */
        this.lastVal = new Map();
        /** diagnostic counters per group key */
        this.diag = new Map();
        /** failures in a row per group (for the log) */
        this.failRow = new Map();
        this.today = dayKey(new Date());
        this.lastQueueLength = -1;
    }

    async onReady() {
        await this.setStateAsync('info.connection', false, true);
        const c = this.config;
        const round = Math.pow(10, Math.max(0, Math.min(10, parseInt(String(c.round), 10) || 0)));
        const input = normalise('inputRegs', c.inputRegs);
        const holding = normalise('holdingRegs', c.holdingRegs);
        for (const p of [...input.problems, ...holding.problems]) {
            this.log.warn(p);
        }
        const regs = [...input.regs, ...holding.regs];
        for (const r of regs) {
            this.regsById.set(`${this.namespace}.${r.id}`, r);
        }

        // groups and their blocks (blocks are built per group, per register type and per unit)
        const maxBlock = parseInt(String(c.maxBlock), 10) || 100;
        const maxGap = Number.isInteger(parseInt(String(c.maxGap), 10)) ? parseInt(String(c.maxGap), 10) : 10;
        const groups = [];
        const known = new Set();
        for (const row of Array.isArray(c.groups) ? c.groups : []) {
            const name = String(row.name || '').trim();
            if (!name || known.has(name)) {
                if (name) {
                    this.log.warn(`Group "${name}" is defined twice - only the first one is used`);
                }
                continue;
            }
            known.add(name);
            if (row.enabled === false) {
                continue;
            }
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
            const group = {
                name,
                description: String(row.description || ''),
                interval: Math.max(1, num(row.interval, 60)) * 1000,
                timeout: Math.max(500, num(row.timeout, 10000)),
                pauseAfter: Math.max(0, num(row.pauseAfter, 0)),
                blocks,
            };
            groups.push(group);
            // unit 2 (SBH400) has an instruction interval of 5000 ms in the WiNet: warn about too short pauses
            for (const w of timingWarnings(
                group,
                blocks.some(b => b.deviceId === 2),
            )) {
                this.log.warn(w);
            }
            this.log.info(
                `Group ${name}: every ${num(row.interval, 60)} s, ${members.length} registers in ${blocks.length} requests (${blocks
                    .map(b => `unit ${b.deviceId} ${b.regType === 'inputRegs' ? 'FC4' : 'FC3'} ${b.start}+${b.count}`)
                    .join(', ')})`,
            );
        }
        for (const r of regs) {
            if (r.poll && !known.has(r.group)) {
                this.log.warn(`${r.id}: group "${r.group}" does not exist - register is not polled`);
            }
        }

        await this.createRegisterObjects(regs);
        await this.createDiagnostics(groups);
        await this.subscribeStatesAsync('holdingRegisters.*');
        await this.subscribeStatesAsync('inputRegisters.*');

        const host = String(c.host || '').trim();
        if (!host) {
            this.log.error('No gateway address configured');
            return;
        }
        if (!groups.length) {
            this.log.warn('No active poll group - only writes are possible');
        }
        this.poller = new Poller({
            host,
            port: parseInt(String(c.port), 10) || 502,
            groups,
            requestGap: Math.max(0, num(c.requestGap, 100)),
            reconnectAfter: Math.max(1, parseInt(String(c.reconnectAfter), 10) || 3),
            reconnectDelay: Math.max(1, num(c.reconnectDelay, 20)) * 1000,
            connectTimeout: Math.max(1, num(c.connectTimeout, 10)) * 1000,
            writeTimeout: Math.max(500, num(c.writeTimeout, 15000)),
            writeRetries: Math.max(0, parseInt(String(c.writeRetries), 10) || 0),
            writeMaxAge: Math.max(1, num(c.writeMaxAge, 60)) * 1000,
            doNotUseWriteMultipleRegisters: c.doNotUseWriteMultipleRegisters !== false,
            round,
            createClient: () => new ModbusRTU(),
            timers: {
                setTimeout: (cb, ms) => this.setTimeout(cb, ms),
                clearTimeout: t => this.clearTimeout(t),
            },
            log: this.log,
        });
        this.wirePoller(this.poller, flag(c.alwaysUpdate));
        this.log.info(`Connecting to ${host}:${parseInt(String(c.port), 10) || 502} (one connection for all units)`);
        this.poller.start();
    }

    /**
     * @param {Poller} p Poller
     * @param {boolean} alwaysUpdate Write unchanged values too
     */
    wirePoller(p, alwaysUpdate) {
        p.on('connection', on => {
            void this.setStateChangedAsync('info.connection', on, true);
            this.log[on ? 'info' : 'warn'](on ? 'Connected to the gateway' : 'Connection to the gateway lost');
        });
        p.on('connectFailed', ({ error }) => this.log.warn(`Connect failed: ${error}`));
        p.on('reconnect', ({ reason }) => void this.onReconnect(reason));
        p.on('values', ({ values }) => {
            for (const { reg, val } of values) {
                if (val === null) {
                    continue;
                }
                const id = `${this.namespace}.${reg.id}`;
                if (alwaysUpdate || this.lastVal.get(id) !== val) {
                    this.lastVal.set(id, val);
                    void this.setState(reg.id, val, true);
                }
            }
        });
        p.on('request', ev => void this.onRequest(ev));
        p.on('skipped', ({ group }) => void this.count(groupKey(group), { skippedToday: 1 }));
        p.on('round', ev => void this.onRound(ev));
        p.on('readback', ({ reg, val, requested, written }) => {
            const id = `${this.namespace}.${reg.id}`;
            this.lastVal.set(id, val);
            // ack=true after the confirmation read - also when the value did not change
            void this.setState(reg.id, val, true);
            if (written && requested !== undefined && Number(requested) !== val && String(requested) !== String(val)) {
                this.log.warn(`${reg.id}: wrote ${requested}, device reports ${val}`);
            } else if (written) {
                this.log.debug(`${reg.id}: ${val} written and confirmed`);
            }
        });
        p.on('readbackFailed', ({ reg, error }) => {
            this.log.warn(`${reg.id}: confirmation read failed (${error}) - value follows with the next poll`);
        });
        p.on('writeFailed', ({ reg, requested, error }) => {
            this.log.warn(`${reg.id}: writing ${requested} failed: ${error}`);
            void this.count(WRITE_DIAG.key, { failedTotal: 1 }, error);
        });
    }

    /**
     * Updates the diagnostics after every request.
     *
     * @param {{group: string, ok: boolean, ms?: number, timeout?: boolean, error?: string, block: string}} ev Event
     */
    async onRequest(ev) {
        const key = ev.group === '_write' ? WRITE_DIAG.key : groupKey(ev.group);
        if (this.poller && this.poller.queueLength !== this.lastQueueLength) {
            this.lastQueueLength = this.poller.queueLength;
            void this.setState('info.queueLength', this.lastQueueLength, true);
        }
        if (ev.group === '_write') {
            // a failed attempt only sets lastError; failedTotal counts writes that failed after all attempts
            await this.count(key, ev.ok ? { okTotal: 1 } : {}, ev.ok ? undefined : `${ev.error} (${ev.block})`, ev);
            return;
        }
        const row = (this.failRow.get(ev.group) || 0) + (ev.ok ? 0 : 1);
        if (ev.ok) {
            if (this.failRow.get(ev.group)) {
                this.log.info(`Group ${ev.group}: answers again (after ${this.failRow.get(ev.group)} failures)`);
            }
            this.failRow.set(ev.group, 0);
            await this.count(key, { requestsToday: 1 }, undefined, ev);
        } else {
            this.failRow.set(ev.group, row);
            const what = ev.timeout ? 'timeout' : 'error';
            const msg = `Group ${ev.group}: ${what} on ${ev.block} (${ev.error})`;
            if (row === 3) {
                this.log.warn(`${msg} - ${row} times in a row`);
            } else {
                this.log.info(msg);
            }
            await this.count(
                key,
                ev.timeout
                    ? { requestsToday: 1, timeoutsToday: 1, timeoutsTotal: 1 }
                    : { requestsToday: 1, errorsToday: 1, errorsTotal: 1 },
                `${what}: ${ev.error} (${ev.block})`,
            );
        }
    }

    /**
     * Increments counters of a diagnostics channel and writes them.
     *
     * @param {string} key Channel key below info (e.g. groups.live)
     * @param {Record<string, number>} inc Increments
     * @param {string} [error] Error text for lastError
     * @param {{ok: boolean, ms?: number}} [ev] Request event (response time, last success)
     */
    async count(key, inc, error, ev) {
        this.rollDay();
        const d = this.diag.get(key);
        if (!d) {
            return;
        }
        for (const [k, v] of Object.entries(inc)) {
            if (!v) {
                continue;
            }
            d[k] = (d[k] || 0) + v;
            await this.setState(`info.${key}.${k}`, d[k], true);
        }
        if (error) {
            await this.setState(`info.${key}.lastError`, `${new Date().toISOString()} ${error}`, true);
        }
        if (ev && ev.ok) {
            if (typeof ev.ms === 'number') {
                await this.setState(`info.${key}.lastResponseTime`, ev.ms, true);
            }
            await this.setState(`info.${key}.lastSuccess`, Date.now(), true);
        }
    }

    /**
     * Heartbeat of a group: written after every complete round (all requests answered), also when no
     * value changed - old timestamps at the values are then no sign of a frozen bus.
     *
     * @param {{group: string, ms: number, blocks: number, failed: number}} ev Round event
     */
    async onRound(ev) {
        const key = groupKey(ev.group);
        if (!this.diag.has(key)) {
            return;
        }
        const now = new Date();
        if (ev.failed < ev.blocks) {
            await this.setState('info.lastValueUpdate', now.getTime(), true);
        }
        if (ev.failed) {
            return;
        }
        await this.setState(`info.${key}.lastRound`, now.getTime(), true);
        await this.setStateChangedAsync(`info.${key}.roundDuration`, ev.ms, true);
        await this.setState(`info.${key}.lastRoundText`, `${timeOfDay(now)} (${ev.ms} ms)`, true);
    }

    /** @param {string} reason Reason of the reconnect */
    async onReconnect(reason) {
        const s = await this.getStateAsync('info.reconnects');
        await this.setState('info.reconnects', ((s && Number(s.val)) || 0) + 1, true);
        await this.setState('info.lastReconnect', `${new Date().toISOString()} ${reason}`, true);
        this.log.warn(`Reconnecting: ${reason}`);
    }

    /** Resets the "today" counters at midnight. */
    rollDay() {
        const now = dayKey(new Date());
        if (now === this.today) {
            return;
        }
        this.today = now;
        for (const [key, d] of this.diag) {
            for (const k of Object.keys(d)) {
                if (k.endsWith('Today')) {
                    d[k] = 0;
                    void this.setState(`info.${key}.${k}`, 0, true);
                }
            }
        }
    }

    /**
     * Creates or updates the register states (extendObject keeps custom settings such as history).
     * Registers that are no longer configured are removed.
     *
     * @param {import('./lib/registers').Reg[]} regs Registers
     */
    async createRegisterObjects(regs) {
        await this.extendObjectAsync('inputRegisters', {
            type: 'channel',
            common: { name: 'Input registers' },
            native: {},
        });
        await this.extendObjectAsync('holdingRegisters', {
            type: 'channel',
            common: { name: 'Holding registers' },
            native: {},
        });
        for (const r of regs) {
            /** @type {Record<string, any>} */
            const common = {
                name: r.description || r.name,
                role: r.role,
                type: ['string', 'stringle'].includes(r.type) ? 'string' : 'number',
                read: r.regType === 'inputRegs' ? true : r.poll,
                write: r.write,
                def: ['string', 'stringle'].includes(r.type) ? '' : 0,
                unit: r.unit,
            };
            // texts of known values and plausible limits (only when configured - display and write check)
            if (r.states) {
                common.states = r.states;
            }
            if (r.min !== undefined) {
                common.min = r.min;
            }
            if (r.max !== undefined) {
                common.max = r.max;
            }
            const native = {
                regType: r.regType,
                address: r.address,
                deviceId: r.deviceId,
                type: r.type,
                len: r.len,
                offset: r.offset,
                factor: r.factor,
                group: r.group,
            };
            if (r.regType === 'holdingRegs') {
                native.poll = r.poll;
            }
            await this.extendObjectAsync(r.id, { type: 'state', common, native });
            if (r.room) {
                await this.addToRoom(`${this.namespace}.${r.id}`, r.room);
            }
        }
        // remove states of registers that are no longer configured
        const wanted = new Set(regs.map(r => `${this.namespace}.${r.id}`));
        for (const regName of Object.values(REG_NAMES)) {
            const existing = await this.getObjectViewAsync('system', 'state', {
                startkey: `${this.namespace}.${regName}.`,
                endkey: `${this.namespace}.${regName}.香`,
            });
            for (const row of existing.rows) {
                if (!wanted.has(row.id)) {
                    this.log.info(`Removing ${row.id} (no longer configured)`);
                    await this.delForeignObjectAsync(row.id);
                }
            }
        }
    }

    /**
     * Adds a state to a room enum (never removes - rooms may be maintained by hand).
     *
     * @param {string} fullId State ID
     * @param {string} room Enum ID (enum.rooms.xyz)
     */
    async addToRoom(fullId, room) {
        try {
            const e = await this.getForeignObjectAsync(room);
            if (!e || e.type !== 'enum') {
                return;
            }
            const members = Array.isArray(e.common.members) ? e.common.members : [];
            if (!members.includes(fullId)) {
                members.push(fullId);
                await this.extendForeignObjectAsync(room, { common: { members } });
            }
        } catch (err) {
            this.log.debug(`Room ${room}: ${err}`);
        }
    }

    /**
     * Creates the diagnostic states per group and loads the persisted counters.
     *
     * @param {{name: string, description?: string}[]} groups Active groups
     */
    async createDiagnostics(groups) {
        const today = dayKey(new Date());
        await this.extendObjectAsync('info.lastValueUpdate', {
            type: 'state',
            common: { read: true, write: false, ...LAST_VALUE_UPDATE },
            native: {},
        });
        /** @type {{key: string, name: any, defs: Record<string, any>}[]} */
        const channels = [
            ...groups.map(g => ({ key: groupKey(g.name), name: groupChannelName(g.name, g.description), defs: DIAG })),
            { key: WRITE_DIAG.key, name: T.channelWrite, defs: WRITE_DIAG.states },
        ];
        for (const ch of channels) {
            await this.extendObjectAsync(`info.${ch.key}`, { type: 'channel', common: { name: ch.name }, native: {} });
            const counters = {};
            for (const [k, def] of Object.entries(ch.defs)) {
                await this.extendObjectAsync(`info.${ch.key}.${k}`, {
                    type: 'state',
                    common: { read: true, write: false, ...def },
                    native: {},
                });
                if (def.type === 'number' && (k.endsWith('Total') || k.endsWith('Today'))) {
                    const s = await this.getStateAsync(`info.${ch.key}.${k}`);
                    const valid =
                        s && typeof s.val === 'number' && (k.endsWith('Total') || dayKey(new Date(s.ts)) === today);
                    counters[k] = valid ? Number(s.val) : 0;
                    if (!valid) {
                        await this.setState(`info.${ch.key}.${k}`, 0, true);
                    }
                }
            }
            this.diag.set(ch.key, counters);
        }
        // channels of groups that no longer exist
        const existing = await this.getObjectViewAsync('system', 'channel', {
            startkey: `${this.namespace}.info.groups.`,
            endkey: `${this.namespace}.info.groups.香`,
        });
        for (const row of existing.rows) {
            const key = row.id.substring(this.namespace.length + 'info.'.length + 1);
            if (!this.diag.has(key)) {
                await this.delObjectAsync(row.id.substring(this.namespace.length + 1), { recursive: true });
            }
        }
    }

    /**
     * @param {string} id State ID
     * @param {ioBroker.State | null | undefined} state State
     */
    onStateChange(id, state) {
        if (!state || state.ack) {
            return;
        }
        const reg = this.regsById.get(id);
        if (!reg) {
            return;
        }
        if (!reg.write) {
            // input registers are read-only: restore the device value
            if (this.lastVal.has(id)) {
                void this.setState(id, this.lastVal.get(id), true);
            }
            return;
        }
        if (this.config.readOnly) {
            // read-only operation (e.g. first days after the migration): never write to the inverter
            this.log.warn(`${id}: read-only mode - write of ${state.val} rejected`);
            if (this.lastVal.has(id)) {
                void this.setState(id, this.lastVal.get(id), true);
            }
            return;
        }
        if (!this.poller) {
            this.log.warn(`${id}: not connected - write ignored`);
            return;
        }
        // plausibility (min/max/states of the register): for now only a warning, the value is still written
        const problem = checkWriteValue(reg, state.val);
        if (problem) {
            this.log.warn(`${id}: implausible value - ${problem} (written anyway; the check only warns)`);
        }
        // the confirmation must set ack=true even if the value does not change
        this.lastVal.delete(id);
        this.log.debug(`${id}: write ${state.val}`);
        this.poller.write(reg, state.val);
    }

    /** @param {() => void} callback Done */
    onUnload(callback) {
        const done = () => {
            try {
                callback();
            } catch {
                // ignore
            }
        };
        if (this.poller) {
            const p = this.poller;
            this.poller = null;
            p.stop()
                .then(() => this.setState('info.connection', false, true))
                .catch(() => {})
                .finally(done);
        } else {
            done();
        }
    }
}

if (require.main !== module) {
    /** @param {Partial<utils.AdapterOptions>} [options] Adapter options */
    module.exports = options => new SungrowLocal(options);
} else {
    new SungrowLocal();
}
