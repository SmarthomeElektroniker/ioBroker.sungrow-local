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
const {
    normalise,
    buildBlocks,
    REG_NAMES,
    TYPE_LEN,
    STRING_TYPES,
    num,
    flag,
    checkWriteValue,
    extract,
} = require('./lib/registers');
const { mergeCatalog } = require('./lib/catalog');
const { explain, resolve, implausible } = require('./lib/convert');
const { Poller } = require('./lib/poller');
const { analyse } = require('./lib/load');
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

/** Translated register names of the template (key regType:unit:_address); optional file */
let META = { registers: {} };
try {
    META = require('./lib/catalog-meta.json');
} catch {
    // no translations - names come from the description column
}

/** Entries kept in info.write.log */
const WRITE_LOG_MAX = 25;

class SungrowLocal extends utils.Adapter {
    /** @param {Partial<utils.AdapterOptions>} [options] Adapter options */
    constructor(options = {}) {
        super({ ...options, name: 'sungrow-local' });
        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
        this.on('message', this.onMessage.bind(this));
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
        /** registers whose first value was checked for plausibility */
        this.checked = new Set();
        /** last device read of the conversion helper (to not read on every key stroke) */
        this.lastProbe = null;
        this.probeRunning = null;
        this.lang = 'en';
        /** pause after requests per unit (from the groups, e.g. 5000 ms for the SBH400) */
        this.unitPause = new Map();
        /** last write commands (info.write.log) */
        this.writeLog = [];
        /** connection test of the setup wizard running */
        this.wizardRunning = false;
    }

    async onReady() {
        await this.setStateAsync('info.connection', false, true);
        // register template: add the known registers that are not configured yet (unticked) - once per
        // template version. The instance goes on with the new configuration (js-controller may restart it).
        await this.applyCatalog();
        try {
            const sys = await this.getForeignObjectAsync('system.config');
            this.lang = (sys && sys.common && sys.common.language) || 'en';
        } catch {
            // keep English
        }
        const c = this.config;
        const round = Math.pow(10, Math.max(0, Math.min(10, parseInt(String(c.round), 10) || 0)));
        const input = normalise('inputRegs', c.inputRegs);
        const holding = normalise('holdingRegs', c.holdingRegs);
        for (const p of [...input.problems, ...holding.problems]) {
            this.log.warn(p);
        }
        const regs = [...input.regs, ...holding.regs];
        for (const r of regs) {
            // translated value table of the template (system language) while the states column is unchanged
            const st = this.localStates(r);
            if (st) {
                r.states = st;
            }
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
            for (const b of blocks) {
                this.unitPause.set(b.deviceId, Math.max(this.unitPause.get(b.deviceId) || 0, group.pauseAfter));
            }
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
        try {
            const load = analyse(c);
            this.log.info(
                `Bus load: ${load.total.requests} requests per round set, ${load.total.perSecond.toFixed(2)} requests/s, ${Math.round(load.total.load * 100)} % of the measured capacity (${load.capacity}/s)`,
            );
            if (load.total.level === 'over') {
                this.log.warn(
                    'Bus load above the measured capacity of the gateway - expect skipped rounds and timeouts (see the tab "Registers")',
                );
            }
        } catch (e) {
            this.log.debug(`Bus load: ${e}`);
        }
        for (const r of regs) {
            if (r.poll && !known.has(r.group)) {
                this.log.warn(`${r.id}: group "${r.group}" does not exist - register is not polled`);
            }
        }

        await this.createRegisterObjects(regs);
        // diagnostics only for groups that read something (a group without ticked registers has no channel)
        await this.createDiagnostics(groups.filter(g => g.blocks.length));
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
                if (!this.checked.has(id)) {
                    // one hint per register and start: helps with wrong type, factor or word order
                    this.checked.add(id);
                    const problem = implausible(reg, val);
                    if (problem) {
                        this.log.info(`${reg.id}: first value ${problem}`);
                    }
                }
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
                this.logWrite(reg, requested, 'mismatch', String(val));
            } else if (written) {
                this.log.debug(`${reg.id}: ${val} written and confirmed`);
                this.logWrite(reg, requested !== undefined ? requested : val, 'ok', String(val));
            }
        });
        p.on('readbackFailed', ({ reg, error }) => {
            this.log.warn(`${reg.id}: confirmation read failed (${error}) - value follows with the next poll`);
            this.logWrite(reg, undefined, 'unconfirmed', String(error));
        });
        p.on('writeFailed', ({ reg, requested, error }) => {
            this.log.warn(`${reg.id}: writing ${requested} failed: ${error}`);
            this.logWrite(reg, requested, 'failed', String(error));
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
                if (/exception 2|illegal data address/i.test(String(ev.error))) {
                    // the whole request fails when ONE register of the block does not exist on this model
                    this.log.warn(
                        `Group ${ev.group}: the device does not know an address of ${ev.block} - deactivate the register(s) activated last in this range (tab "Registers"); all registers of this request are missing until then`,
                    );
                }
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
            type: 'folder',
            common: { name: 'Input registers' },
            native: {},
        });
        await this.extendObjectAsync('holdingRegisters', {
            type: 'folder',
            common: { name: 'Holding registers' },
            native: {},
        });
        // one device per Modbus unit (inputRegisters.1, inputRegisters.2, ...) - no state ID changes
        const unitFolders = new Map();
        for (const r of regs) {
            unitFolders.set(r.id.split('.').slice(0, 2).join('.'), r.deviceId);
        }
        for (const [id, unit] of unitFolders) {
            await this.extendObjectAsync(id, { type: 'device', common: { name: `Unit ${unit}` }, native: {} });
        }
        // objects of up to 0.4.0 carry def 0/'' - remove it (IDs, custom settings and states stay)
        const withDef = new Set();
        for (const regName of Object.values(REG_NAMES)) {
            const view = await this.getObjectViewAsync('system', 'state', {
                startkey: `${this.namespace}.${regName}.`,
                endkey: `${this.namespace}.${regName}.香`,
            });
            for (const row of view.rows) {
                if (row.value && row.value.common && 'def' in row.value.common) {
                    withDef.add(row.id);
                }
            }
        }
        for (const r of regs) {
            /** @type {Record<string, any>} */
            const common = {
                name: this.displayName(r),
                role: r.role,
                type: ['string', 'stringle'].includes(r.type) ? 'string' : 'number',
                read: r.regType === 'inputRegs' ? true : r.poll,
                write: r.write,
                // no def: js-controller would create the state 0/ack=true before the first read
                // (scripts would react on e.g. SoC 0 % at adapter start)
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
            if (withDef.has(`${this.namespace}.${r.id}`)) {
                const obj = await this.getObjectAsync(r.id);
                if (obj && obj.common && 'def' in obj.common) {
                    delete obj.common.def;
                    await this.setObjectAsync(r.id, obj);
                }
            }
            if (r.room) {
                await this.addToRoom(`${this.namespace}.${r.id}`, r.room);
            }
        }
        // IDs of up to 0.4.2 with characters outside [A-Za-z0-9_,-] (e.g. "/"): move settings, value and rooms
        await this.migrateLegacyIds(regs);
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
     * Versions up to 0.4.2 kept characters such as "/" in the state IDs ("53051_Charge/discharge_command").
     * For every register whose ID changed and whose old object still exists: the custom settings (history,
     * sql, influxdb ...) go to the new object - history adapters with "aliasId" = old ID, so the recorded data
     * goes on under the old name -, the last value is copied, room/function enums are switched to the new ID,
     * then the old object is deleted. Scripts and visualisations must be switched by hand (log message).
     *
     * @param {import('./lib/registers').Reg[]} regs Registers (new objects already created)
     */
    async migrateLegacyIds(regs) {
        const moved = [];
        /** @type {Record<string, ioBroker.Object> | null} */
        let enums = null;
        for (const r of regs) {
            if (!r.legacyId || r.legacyId === r.id) {
                continue;
            }
            const oldId = `${this.namespace}.${r.legacyId}`;
            const newId = `${this.namespace}.${r.id}`;
            const old = await this.getForeignObjectAsync(oldId);
            if (!old) {
                continue;
            }
            const custom = old.common && old.common.custom;
            const now = await this.getForeignObjectAsync(newId);
            const nowCustom = now && now.common && now.common.custom;
            if (custom && Object.keys(custom).length && !(nowCustom && Object.keys(nowCustom).length)) {
                /** @type {Record<string, any>} */
                const out = {};
                for (const [inst, c] of Object.entries(custom)) {
                    if (!c || typeof c !== 'object') {
                        continue;
                    }
                    const cc = { ...c };
                    if (/^(history|sql|influxdb)\.\d+$/.test(inst) && !cc.aliasId) {
                        cc.aliasId = oldId;
                    }
                    out[inst] = cc;
                }
                await this.extendForeignObjectAsync(newId, { common: { custom: out } });
            }
            const oldState = await this.getForeignStateAsync(oldId);
            const newState = await this.getForeignStateAsync(newId);
            if (oldState && oldState.val !== null && oldState.val !== undefined && !newState) {
                await this.setForeignStateAsync(newId, {
                    val: oldState.val,
                    ack: true,
                    ts: oldState.ts,
                    lc: oldState.lc,
                    q: oldState.q || 0,
                });
            }
            if (!enums) {
                enums = (await this.getForeignObjectsAsync('enum.*', 'enum')) || {};
            }
            for (const e of Object.values(enums)) {
                const members = e && e.common && Array.isArray(e.common.members) ? e.common.members : null;
                if (members && members.includes(oldId)) {
                    e.common.members = [...new Set(members.map(m => (m === oldId ? newId : m)))];
                    await this.setForeignObjectAsync(e._id, e);
                }
            }
            await this.delForeignObjectAsync(oldId);
            moved.push(`${oldId} -> ${newId}`);
        }
        if (moved.length) {
            this.log.warn(
                `State IDs without special characters (ioBroker recommendation): ${moved.join(', ')}. Settings (history ...), value and rooms were moved - please switch scripts and visualisations to the new IDs.`,
            );
        }
    }

    /**
     * Object name of a register: the translated template name as long as the description column is empty or
     * still the English default of the template; an own description always wins.
     *
     * @param {import('./lib/registers').Reg} r Register
     * @returns {string|Record<string, string>} Name
     */
    displayName(r) {
        const m = META.registers && META.registers[`${r.regType}:${r.deviceId}:${r.alias}`];
        if (m && m.name && m.name.en) {
            const d = r.description;
            const defaults = [m.name.en, m.descDefault, ...(Array.isArray(m.descOld) ? m.descOld : [])];
            if (!d || defaults.includes(d)) {
                return m.name;
            }
        }
        return r.description || r.name;
    }

    /**
     * Value table in the system language for a register whose states column is still the template text (or empty).
     *
     * @param {import('./lib/registers').Reg} r Register
     * @returns {Record<string, string>|undefined} common.states or undefined (keep the configured texts)
     */
    localStates(r) {
        const m = META.registers && META.registers[`${r.regType}:${r.deviceId}:${r.alias}`];
        if (!m || !m.states || !m.statesDefault) {
            return undefined;
        }
        if (r.statesRaw && r.statesRaw !== m.statesDefault) {
            return undefined;
        }
        /** @type {Record<string, string>} */
        const out = {};
        for (const [k, t] of Object.entries(m.states)) {
            out[k] = t[this.lang] || t.en;
        }
        return out;
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
        try {
            const s = await this.getStateAsync('info.write.log');
            const list = s && typeof s.val === 'string' ? JSON.parse(s.val) : [];
            this.writeLog = Array.isArray(list) ? list.slice(0, WRITE_LOG_MAX) : [];
        } catch {
            this.writeLog = [];
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
        this.log.debug(`command ${id} = ${state.val}${reg ? '' : ' (unknown register)'}`);
        if (!reg) {
            return;
        }
        if (!reg.write) {
            if (reg.regType === 'holdingRegs') {
                // holding register that is not released for writing (tab "Control")
                this.log.warn(`${id}: writing is not released for this register - ${state.val} rejected`);
                this.logWrite(reg, state.val, 'notReleased');
            }
            // restore the device value
            if (this.lastVal.has(id)) {
                void this.setState(id, this.lastVal.get(id), true);
            }
            return;
        }
        if (this.config.readOnly) {
            // read-only operation (e.g. first days after the migration): never write to the inverter
            this.log.warn(`${id}: read-only mode - write of ${state.val} rejected`);
            this.logWrite(reg, state.val, 'readOnly');
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
        if (problem && this.config.writeCheck === 'reject') {
            this.log.warn(`${id}: value rejected - ${problem}`);
            this.logWrite(reg, state.val, 'rejected', problem);
            if (this.lastVal.has(id)) {
                void this.setState(id, this.lastVal.get(id), true);
            }
            return;
        }
        if (problem) {
            this.log.warn(`${id}: implausible value - ${problem} (written anyway; the check only warns)`);
        }
        // the confirmation must set ack=true even if the value does not change
        this.lastVal.delete(id);
        this.log.debug(`${id}: write ${state.val}`);
        this.poller.write(reg, state.val);
    }

    /**
     * Adds the register template to the configuration (once per template version) and uses it right away.
     *
     * @returns {Promise<boolean>} true when the configuration was extended and saved
     */
    async applyCatalog() {
        const merged = mergeCatalog(this.config);
        if (!merged.changed) {
            return false;
        }
        const id = `system.adapter.${this.namespace}`;
        const obj = await this.getForeignObjectAsync(id);
        if (!obj) {
            return false;
        }
        obj.native = merged.native;
        this.log.info(
            `Register template version ${merged.native.templateVersion}: ${merged.added} known registers added to the tables (not ticked - nothing is read until you tick them)`,
        );
        if (merged.fixed.length) {
            this.log.info(`Corrected data types/factors of default registers: ${merged.fixed.join(', ')}`);
        }
        await this.setForeignObjectAsync(id, obj);
        this.config = /** @type {any} */ (merged.native);
        // js-controller restarts the instance because its configuration changed: wait idle for that instead
        // of starting to poll (and being killed in the middle of it); without a restart, go on after the pause
        await this.delay(5000);
        return true;
    }

    /**
     * Messages from the admin: "convert" = conversion helper (optionally reads the register once).
     *
     * @param {ioBroker.Message} obj Message
     */
    async onMessage(obj) {
        if (!obj || !obj.command) {
            return;
        }
        if (obj.command === 'probe' || obj.command === 'wizardTest' || obj.command === 'analyse') {
            let res;
            try {
                const q = typeof obj.message === 'string' ? JSON.parse(obj.message) : obj.message || {};
                if (obj.command === 'probe') {
                    res = await this.probeRegister(q);
                } else if (obj.command === 'wizardTest') {
                    res = await this.wizardTest(q);
                } else {
                    res = analyse(q.native || this.config);
                }
            } catch (e) {
                res = { error: (e && e.message) || String(e) };
            }
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, res, obj.callback);
            }
            return;
        }
        if (obj.command === 'convert') {
            let res;
            try {
                const q = typeof obj.message === 'string' ? JSON.parse(obj.message) : obj.message || {};
                const device = flag(q.live) ? await this.probeForHelper(q) : undefined;
                res = explain(q, device, this.lang === 'de' ? 'de' : 'en', this.config);
            } catch (e) {
                res = { text: `Error: ${e && e.message}` };
            }
            if (obj.callback) {
                this.sendTo(
                    obj.from,
                    obj.command,
                    {
                        text: res.text,
                        style: {
                            whiteSpace: 'pre-wrap',
                            fontFamily: 'monospace',
                            fontSize: '0.85rem',
                            lineHeight: 1.5,
                        },
                    },
                    obj.callback,
                );
            }
        }
    }

    /**
     * Test read of one register for the admin ("own register" dialog): read only, FC4 input / FC3 holding,
     * over the running connection. Returns the raw words and the value with type, factor and offset.
     *
     * @param {Record<string, any>} q {regType, deviceId, address (protocol), type, len, factor, offset}
     * @returns {Promise<Record<string, any>>} {words, raw, value, ms} or {error}
     */
    async probeRegister(q) {
        const regType = q.regType === 'holdingRegs' ? 'holdingRegs' : 'inputRegs';
        const address = parseInt(q.address, 10);
        if (!Number.isInteger(address) || address < 0 || address > 0xffff) {
            return { error: 'invalid address' };
        }
        if (!this.poller || !this.poller.connected) {
            return { error: 'not connected' };
        }
        const unit = parseInt(q.deviceId, 10) || 1;
        const type = TYPE_LEN[q.type] || STRING_TYPES.includes(q.type) ? q.type : 'uint16be';
        const count = STRING_TYPES.includes(type)
            ? Math.min(32, Math.max(1, parseInt(q.len, 10) || 1))
            : TYPE_LEN[type] || 1;
        const r = await this.poller.probe({
            regType,
            deviceId: unit,
            address,
            count,
            timeout: Math.max(10000, (this.unitPause.get(unit) || 0) + 5000),
            pauseAfter: this.unitPause.get(unit) || 0,
        });
        const words = [];
        for (let i = 0; i < count; i++) {
            words.push(r.buffer.readUInt16BE(i * 2));
        }
        const raw = extract(type, count, r.buffer, 0);
        const factor = num(q.factor, 1) || 1;
        const offset = num(q.offset, 0);
        const value = typeof raw === 'number' ? Math.round((raw * factor + offset) * 10000) / 10000 : raw;
        return { words, raw, value, ms: r.ms };
    }

    /**
     * Connection test of the setup wizard: reads device type code, serial number and battery indicators.
     * Uses the running connection when it goes to the same gateway, otherwise ONE short own connection
     * (the WiNet-S2 accepts only one Modbus client reliably - the admin warns when another instance is
     * connected to the same address).
     *
     * @param {Record<string, any>} q {host, port, unit, battery2}
     * @returns {Promise<Record<string, any>>} Result
     */
    async wizardTest(q) {
        const host = String(q.host || '').trim();
        const port = parseInt(q.port, 10) || 502;
        const unit = parseInt(q.unit, 10) || 1;
        if (!host) {
            return { ok: false, error: 'no address' };
        }
        if (this.wizardRunning) {
            return { ok: false, error: 'test already running' };
        }
        this.wizardRunning = true;
        const t0 = Date.now();
        /** @type {(fc: 3|4, unitId: number, address: number, count: number, timeout?: number) => Promise<Buffer>} */
        let read;
        let close = async () => {};
        try {
            const own = !(this.poller && this.poller.connected && host === String(this.config.host || '').trim());
            if (!own && this.poller) {
                const p = this.poller;
                read = async (fc, unitId, address, count, timeout = 10000) =>
                    (
                        await p.probe({
                            regType: fc === 4 ? 'inputRegs' : 'holdingRegs',
                            deviceId: unitId,
                            address,
                            count,
                            timeout,
                            pauseAfter: this.unitPause.get(unitId) || 0,
                        })
                    ).buffer;
            } else {
                const client = new ModbusRTU();
                client.on('error', () => {});
                close = () =>
                    new Promise(resolve => {
                        try {
                            client.close(() => resolve(undefined));
                        } catch {
                            resolve(undefined);
                        }
                    });
                await Promise.race([
                    client.connectTCP(host, { port }),
                    new Promise((_, reject) =>
                        this.setTimeout(() => reject(new Error(`no connection to ${host}:${port}`)), 8000),
                    ),
                ]);
                read = async (fc, unitId, address, count, timeout = 8000) => {
                    client.setID(unitId);
                    client.setTimeout(timeout);
                    const res =
                        fc === 4
                            ? await client.readInputRegisters(address, count)
                            : await client.readHoldingRegisters(address, count);
                    await this.delay(150);
                    return res.buffer;
                };
            }
            const out = { ok: true, shared: !own, ms: 0, unit };
            // device type code: Sungrow document 5000 = protocol 4999 (FC4)
            const type = await read(4, unit, 4999, 1);
            out.deviceTypeCode = type.readUInt16BE(0);
            try {
                out.serial = String(extract('string', 10, await read(4, unit, 4989, 10), 0)).trim();
            } catch (e) {
                out.serialError = String((e && e.message) || e);
            }
            try {
                // battery voltage (doc 13020, 0.1 V) and level (doc 13023, 0.1 %) at the inverter
                const b = await read(4, unit, 13019, 4);
                out.batteryVoltage = b.readUInt16BE(0) / 10;
                out.batteryLevel = b.readUInt16BE(6) / 10;
            } catch (e) {
                out.batteryError = String((e && e.message) || e);
            }
            if (q.battery2) {
                try {
                    // SBH battery at unit 2 (slow bus device): level doc 10744 = protocol 10743
                    const b2 = await read(4, 2, 10743, 1, 15000);
                    out.unit2Level = b2.readUInt16BE(0) / 10;
                } catch (e) {
                    out.unit2Error = String((e && e.message) || e);
                }
            }
            out.ms = Date.now() - t0;
            return out;
        } catch (e) {
            const err = /** @type {any} */ (e);
            return {
                ok: false,
                error:
                    err && err.modbusCode !== undefined
                        ? `Modbus exception ${err.modbusCode}`
                        : (err && err.message) || String(err),
                ms: Date.now() - t0,
            };
        } finally {
            await close().catch(() => {});
            this.wizardRunning = false;
        }
    }

    /**
     * Reads the register of the conversion helper once from the device (read only: FC4 input / FC3 holding).
     * The same register is read at most every 5 s and never twice at the same time.
     *
     * @param {Record<string, any>} q Helper input
     * @returns {Promise<{words?: number[], ms?: number, error?: string}>} Raw words or error
     */
    async probeForHelper(q) {
        const { a, ambiguous } = resolve(q);
        if (!a) {
            const de = this.lang === 'de';
            if (ambiguous) {
                return {
                    error: de ? 'Adresse nicht eindeutig – Quelle wählen' : 'address is ambiguous - choose the source',
                };
            }
            return { error: de ? 'ungültige Adresse' : 'invalid address' };
        }
        const regType = a.regType;
        if (!this.poller || !this.poller.connected) {
            return { error: this.lang === 'de' ? 'keine Verbindung zum Gateway' : 'not connected to the gateway' };
        }
        const unit = parseInt(q.deviceId, 10) || 1;
        const type = q.type || 'uint16be';
        const count = STRING_TYPES.includes(type)
            ? Math.min(32, Math.max(1, parseInt(q.len, 10) || 1))
            : TYPE_LEN[type] || 1;
        const key = `${regType}|${unit}|${a.protocol}|${count}`;
        if (this.lastProbe && this.lastProbe.key === key && Date.now() - this.lastProbe.at < 5000) {
            return this.lastProbe.result;
        }
        if (this.probeRunning) {
            await this.probeRunning.catch(() => {});
            if (this.lastProbe && this.lastProbe.key === key) {
                return this.lastProbe.result;
            }
        }
        const run = (async () => {
            let result;
            try {
                const r = await this.poller.probe({
                    regType,
                    deviceId: unit,
                    address: a.protocol,
                    count,
                    timeout: 10000,
                    pauseAfter: this.unitPause.get(unit) || 0,
                });
                const words = [];
                for (let i = 0; i < count; i++) {
                    words.push(r.buffer.readUInt16BE(i * 2));
                }
                result = { words, ms: r.ms };
            } catch (e) {
                const m =
                    e && e.modbusCode !== undefined
                        ? `Modbus exception ${e.modbusCode}`
                        : (e && e.message) || String(e);
                result = { error: m };
            }
            this.lastProbe = { key, at: Date.now(), result };
            this.log.debug(`Conversion helper read ${key}: ${JSON.stringify(result)}`);
            return result;
        })();
        this.probeRunning = run;
        try {
            return await run;
        } finally {
            this.probeRunning = null;
        }
    }

    /**
     * Adds an entry to the write log (info.write.log, newest first) - shown in the tab "Control".
     *
     * @param {import('./lib/registers').Reg} reg Register
     * @param {unknown} value Requested value
     * @param {'ok'|'mismatch'|'failed'|'unconfirmed'|'readOnly'|'notReleased'|'rejected'} result Outcome
     * @param {string} [detail] Device value or error
     */
    logWrite(reg, value, result, detail) {
        this.writeLog.unshift({
            ts: Date.now(),
            id: reg.id,
            name: reg.description || reg.name,
            value: value === undefined ? null : value,
            result,
            detail: detail || '',
        });
        this.writeLog.length = Math.min(this.writeLog.length, WRITE_LOG_MAX);
        void this.setState('info.write.log', JSON.stringify(this.writeLog), true);
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
