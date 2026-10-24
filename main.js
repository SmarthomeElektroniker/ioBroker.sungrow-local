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
} = require('./lib/registers');
const { mergeCatalog } = require('./lib/catalog');
const { explain, resolve, implausible } = require('./lib/convert');
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
