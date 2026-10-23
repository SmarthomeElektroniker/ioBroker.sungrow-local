'use strict';

/*
 * The coordinator: exactly ONE Modbus TCP connection to the gateway, all requests strictly one after
 * another with a minimum pause, an own poll interval per register group, writes before the next read.
 *
 * A failed or timed-out request only fails its block. The connection is only re-established after
 * `reconnectAfter` failures in a row (timeouts / transport errors of ANY group; a Modbus exception is an
 * answer and proves the link) or when the socket itself closes.
 */

const { EventEmitter } = require('node:events');
const { READ_FC, encode, unscale, decodeBlock, extract, scale } = require('./registers');

/*
 * Group: {name, interval (ms), timeout (ms), pauseAfter (ms after each request, slow bus devices), blocks}
 *
 * Options: host, port, groups, requestGap (ms), reconnectAfter (failures in a row), reconnectDelay (ms),
 * connectTimeout (ms), writeTimeout (ms, also for the confirmation read), writeRetries, writeMaxAge (ms),
 * doNotUseWriteMultipleRegisters, round (10^decimals), createClient (modbus-serial factory),
 * timers {setTimeout, clearTimeout} (adapter timers), log, now (clock, tests).
 */

/**
 * Coordinated poller for one Modbus TCP gateway
 * (events: connection, values, request, round, skipped, readback, readbackFailed, writeFailed, reconnect, connectFailed)
 */
class Poller extends EventEmitter {
    /** @param {Record<string, any>} opts Options, see above */
    constructor(opts) {
        super();
        this.opts = {
            requestGap: 100,
            reconnectAfter: 3,
            reconnectDelay: 20000,
            connectTimeout: 10000,
            writeTimeout: 15000,
            writeRetries: 1,
            writeMaxAge: 60000,
            doNotUseWriteMultipleRegisters: true,
            round: 10000,
            ...opts,
        };
        this.timers = opts.timers;
        this.log = opts.log;
        this.now = opts.now || Date.now;
        this.client = null;
        this.connected = false;
        this.stopped = true;
        this.queue = [];
        this.busy = false;
        this.failsInRow = 0;
        this.lastEnd = 0;
        this.lastPause = 0;
        /** group name -> queued or running blocks */
        this.pending = new Map();
        this.timerHandles = new Set();
        /** wake-ups of running sleeps (stop) */
        this.sleepers = new Set();
        /** rejects the running request when the socket closes */
        this.abortRunning = null;
        this.reconnectTimer = null;
        this.connecting = false;
    }

    /** Connects and starts all group timers. */
    start() {
        this.stopped = false;
        this.groupsByName = new Map(this.opts.groups.map(g => [g.name, g]));
        this.opts.groups.forEach((g, i) => {
            this.pending.set(g.name, 0);
            // first round right after the connect, in configuration order
            this._scheduleGroup(g, i * 10);
        });
        void this._connect();
    }

    /** Stops everything and closes the connection. */
    async stop() {
        this.stopped = true;
        for (const t of this.timerHandles) {
            this.timers.clearTimeout(t);
        }
        this.timerHandles.clear();
        for (const wake of this.sleepers) {
            wake();
        }
        this.sleepers.clear();
        this.queue = [];
        // no 'connection' event here: a deliberate stop is no connection loss (the adapter resets the state)
        this.connected = false;
        await this._closeClient();
    }

    /**
     * Queues a write before all reads (after earlier writes). A queued but not yet sent write to the
     * same register is replaced: the latest value wins.
     *
     * @param {import('./registers').Reg} reg Holding register
     * @param {unknown} value State value
     */
    write(reg, value) {
        const job = { kind: 'write', reg, value, attempt: 0, queuedAt: this.now() };
        const same = this.queue.findIndex(j => j.kind === 'write' && j.reg.id === reg.id);
        if (same >= 0) {
            this.queue[same] = job;
        } else {
            this._enqueuePriority(job);
        }
        this._pump();
    }

    /**
     * Requests an immediate read of the groups' blocks (e.g. after start), ignored if already queued.
     *
     * @param {string} name Group name
     */
    pollNow(name) {
        const g = this.groupsByName && this.groupsByName.get(name);
        if (g) {
            this._enqueueGroup(g);
        }
    }

    /** @returns {number} Number of queued jobs */
    get queueLength() {
        return this.queue.length;
    }

    // ---------------------------------------------------------------- scheduling

    /**
     * @param {() => void} cb Callback
     * @param {number} ms Delay
     * @returns {any} Handle
     */
    _timer(cb, ms) {
        const h = this.timers.setTimeout(
            () => {
                this.timerHandles.delete(h);
                cb();
            },
            Math.max(0, ms),
        );
        this.timerHandles.add(h);
        return h;
    }

    /**
     * @param {{name: string, interval: number, timeout: number, pauseAfter: number, blocks: any[], nextAt?: number}} g Group
     * @param {number} delay First run after this delay
     */
    _scheduleGroup(g, delay) {
        g.nextAt = this.now() + delay;
        const tick = () => {
            if (this.stopped) {
                return;
            }
            this._enqueueGroup(g);
            g.nextAt += g.interval;
            if (g.nextAt < this.now()) {
                g.nextAt = this.now() + g.interval;
            }
            this._timer(tick, g.nextAt - this.now());
        };
        this._timer(tick, delay);
    }

    /** @param {{name: string, interval: number, timeout: number, pauseAfter: number, blocks: any[], nextAt?: number}} g Group */
    _enqueueGroup(g) {
        if (!g.blocks.length) {
            return;
        }
        if (this.pending.get(g.name)) {
            // previous round still waiting or running: the interval is too short for the bus
            // (while disconnected this is expected and not reported)
            if (this.connected) {
                this.emit('skipped', { group: g.name });
            }
            return;
        }
        this.pending.set(g.name, g.blocks.length);
        // bookkeeping for the 'round' event (end of a complete round of this group)
        g.roundStart = this.now();
        g.roundFailed = 0;
        for (const block of g.blocks) {
            this.queue.push({ kind: 'read', group: g, block });
        }
        this._pump();
    }

    /** @param {any} job Job that must run before all reads */
    _enqueuePriority(job) {
        let i = 0;
        while (i < this.queue.length && this.queue[i].kind !== 'read') {
            i++;
        }
        this.queue.splice(i, 0, job);
    }

    // ---------------------------------------------------------------- connection

    /** Opens the one connection (no-op while connected or connecting). */
    async _connect() {
        if (this.stopped || this.connected || this.connecting) {
            return;
        }
        this.connecting = true;
        const client = this.opts.createClient();
        client.on('error', e => this.log.debug(`Socket error: ${e && e.message}`));
        try {
            await this._withTimeout(
                client.connectTCP(this.opts.host, { port: this.opts.port }),
                this.opts.connectTimeout,
                'connect timeout',
            );
        } catch (e) {
            this.connecting = false;
            try {
                client.close(() => {});
            } catch {
                // ignore
            }
            if (!this.stopped) {
                this.emit('connectFailed', { error: errText(e) });
                this._scheduleReconnect();
            }
            return;
        }
        this.connecting = false;
        if (this.stopped) {
            client.close(() => {});
            return;
        }
        client.on('close', () => this._onSocketClosed(client));
        this.client = client;
        this.connected = true;
        this.failsInRow = 0;
        this.emit('connection', true);
        this._pump();
    }

    /** @param {any} client Client whose socket closed */
    _onSocketClosed(client) {
        if (client !== this.client || this.stopped) {
            return;
        }
        this._drop('connection closed by the gateway');
    }

    /**
     * Gives up the current connection and connects again after the reconnect delay.
     *
     * @param {string} reason Reason for the log
     */
    _drop(reason) {
        const wasConnected = this.connected;
        this.connected = false;
        if (this.abortRunning) {
            this.abortRunning(new Error(reason));
        }
        void this._closeClient();
        if (wasConnected) {
            this.emit('connection', false);
            this.emit('reconnect', { reason });
        }
        this._scheduleReconnect();
    }

    /** Connects again after the reconnect delay (only one pending attempt). */
    _scheduleReconnect() {
        if (this.stopped || this.reconnectTimer) {
            return;
        }
        this.reconnectTimer = this._timer(() => {
            this.reconnectTimer = null;
            void this._connect();
        }, this.opts.reconnectDelay);
    }

    /** Closes the socket without waiting longer than 1 s. */
    async _closeClient() {
        const c = this.client;
        this.client = null;
        if (!c) {
            return;
        }
        c.removeAllListeners('close');
        await new Promise(resolve => {
            // close() of modbus-serial calls back on the socket's close event; never wait forever
            const h = this._timer(() => resolve(undefined), 1000);
            const done = () => {
                this.timers.clearTimeout(h);
                this.timerHandles.delete(h);
                resolve(undefined);
            };
            try {
                c.close(done);
            } catch {
                done();
            }
        });
    }

    // ---------------------------------------------------------------- queue processing

    /** Runs the next job if the bus is free. */
    _pump() {
        if (this.busy || !this.connected || this.stopped || !this.queue.length) {
            return;
        }
        this.busy = true;
        const job = this.queue.shift();
        this._run(job)
            .catch(e => this.log.error(`Unexpected error: ${errText(e)}`))
            .finally(() => {
                this.busy = false;
                if (!this.stopped) {
                    this._pump();
                }
            });
    }

    /** @param {any} job Job */
    async _run(job) {
        if (job.kind === 'read') {
            await this._runRead(job);
        } else if (job.kind === 'write') {
            await this._runWrite(job);
        } else if (job.kind === 'confirm') {
            await this._runConfirm(job);
        }
    }

    /** @param {any} job Read job */
    async _runRead(job) {
        const { group, block } = job;
        try {
            const res = await this._request(
                block.deviceId,
                c =>
                    block.regType === 'inputRegs'
                        ? c.readInputRegisters(block.start, block.count)
                        : c.readHoldingRegisters(block.start, block.count),
                group.timeout,
                group.pauseAfter,
            );
            const values = decodeBlock(block, res.data.buffer, this.opts.round);
            this.emit('request', { group: group.name, ok: true, ms: res.ms, block: describe(block) });
            this.emit('values', { group: group.name, values });
        } catch (e) {
            group.roundFailed = (group.roundFailed || 0) + 1;
            this.emit('request', {
                group: group.name,
                ok: false,
                timeout: isTimeout(e),
                error: errText(e),
                ms: e && e.ms,
                block: describe(block),
            });
        } finally {
            const left = Math.max(0, (this.pending.get(group.name) || 1) - 1);
            this.pending.set(group.name, left);
            if (left === 0 && !this.stopped) {
                // heartbeat: emitted after EVERY finished round, also when no value changed
                this.emit('round', {
                    group: group.name,
                    ms: this.now() - (group.roundStart || this.now()),
                    blocks: group.blocks.length,
                    failed: group.roundFailed || 0,
                });
            }
        }
    }

    /** @param {any} job Write job */
    async _runWrite(job) {
        const { reg } = job;
        if (this.now() - job.queuedAt > this.opts.writeMaxAge) {
            this.emit('writeFailed', { reg, requested: job.value, error: 'expired (no connection in time)' });
            this._enqueuePriority({ kind: 'confirm', reg });
            return;
        }
        let raw;
        let bytes;
        try {
            raw = unscale(reg, job.value);
            bytes = encode(reg.type, raw, reg.len);
        } catch (e) {
            this.emit('writeFailed', { reg, requested: job.value, error: `invalid value: ${errText(e)}` });
            this._enqueuePriority({ kind: 'confirm', reg });
            return;
        }
        const words = [];
        for (let i = 0; i < reg.len; i++) {
            words.push(bytes.readUInt16BE(i * 2));
        }
        const pause = this._pauseOf(reg.group);
        try {
            if (words.length === 1) {
                const r = await this._request(
                    reg.deviceId,
                    c => c.writeRegister(reg.address, words[0]),
                    this.opts.writeTimeout,
                    pause,
                );
                this.emit('request', { group: '_write', ok: true, ms: r.ms, block: `FC6 ${reg.address}` });
            } else if (this.opts.doNotUseWriteMultipleRegisters) {
                for (let i = 0; i < words.length; i++) {
                    const r = await this._request(
                        reg.deviceId,
                        c => c.writeRegister(reg.address + i, words[i]),
                        this.opts.writeTimeout,
                        pause,
                    );
                    this.emit('request', { group: '_write', ok: true, ms: r.ms, block: `FC6 ${reg.address + i}` });
                }
            } else {
                const r = await this._request(
                    reg.deviceId,
                    c => c.writeRegisters(reg.address, words),
                    this.opts.writeTimeout,
                    pause,
                );
                this.emit('request', { group: '_write', ok: true, ms: r.ms, block: `FC16 ${reg.address}` });
            }
        } catch (e) {
            this.emit('request', {
                group: '_write',
                ok: false,
                timeout: isTimeout(e),
                error: errText(e),
                ms: e && e.ms,
                block: `write ${reg.address}`,
            });
            if (job.attempt < this.opts.writeRetries && !this.stopped) {
                this.log.info(`Write of ${reg.id} failed (${errText(e)}), retrying`);
                this._enqueuePriority({ ...job, attempt: job.attempt + 1 });
            } else {
                this.emit('writeFailed', { reg, requested: job.value, error: errText(e) });
                this._enqueuePriority({ kind: 'confirm', reg });
            }
            return;
        }
        await this._runConfirm({ kind: 'confirm', reg, requested: job.value, written: true });
    }

    /**
     * Reads a register back and reports its real value (confirmation after a write).
     *
     * @param {any} job Confirm job
     */
    async _runConfirm(job) {
        const { reg } = job;
        try {
            const r = await this._request(
                reg.deviceId,
                c => c.readHoldingRegisters(reg.address, reg.len),
                this.opts.writeTimeout,
                this._pauseOf(reg.group),
            );
            const val = scale(reg, extract(reg.type, reg.len, r.data.buffer, 0), this.opts.round);
            this.emit('request', { group: '_write', ok: true, ms: r.ms, block: `FC3 ${reg.address}` });
            this.emit('readback', { reg, val, requested: job.requested, written: !!job.written });
        } catch (e) {
            this.emit('request', {
                group: '_write',
                ok: false,
                timeout: isTimeout(e),
                error: errText(e),
                ms: e && e.ms,
                block: `FC3 ${reg.address}`,
            });
            this.emit('readbackFailed', { reg, requested: job.requested, written: !!job.written, error: errText(e) });
        }
    }

    /**
     * @param {string} groupName Group
     * @returns {number} Pause after requests of this group
     */
    _pauseOf(groupName) {
        const g = this.groupsByName && this.groupsByName.get(groupName);
        return g ? g.pauseAfter : 0;
    }

    /**
     * One request on the bus: waits for the minimum gap, sends, waits for the answer or the timeout.
     *
     * @param {number} unit Modbus unit
     * @param {(c: any) => Promise<any>} fn Request
     * @param {number} timeout Timeout in ms
     * @param {number} pauseAfter Pause after this request
     * @returns {Promise<{data: any, ms: number}>} Answer
     */
    async _request(unit, fn, timeout, pauseAfter) {
        const wait = this.lastEnd + Math.max(this.opts.requestGap, this.lastPause) - this.now();
        if (wait > 0) {
            await this._sleep(wait);
        }
        if (!this.connected || !this.client || this.stopped) {
            throw Object.assign(new Error('not connected'), { notConnected: true });
        }
        const client = this.client;
        const t0 = this.now();
        client.setID(unit);
        client.setTimeout(timeout);
        let guard;
        try {
            const data = await new Promise((resolve, reject) => {
                this.abortRunning = reject;
                // safety net in case the library never answers
                guard = this._timer(
                    () => reject(Object.assign(new Error('Timed out'), { name: 'TransactionTimedOutError' })),
                    timeout + 2000,
                );
                fn(client).then(resolve, reject);
            });
            this.failsInRow = 0;
            return { data, ms: this.now() - t0 };
        } catch (e) {
            // modbus-serial rejects with plain objects (TransactionTimedOutError is no Error instance)
            const err =
                e instanceof Error
                    ? e
                    : Object.assign(new Error((e && e.message) || String(e)), e && typeof e === 'object' ? e : {});
            Object.assign(err, { ms: this.now() - t0 });
            // a Modbus exception is an answer: the link works
            if (err.modbusCode !== undefined) {
                this.failsInRow = 0;
            } else if (this.connected) {
                this.failsInRow++;
                if (this.failsInRow >= this.opts.reconnectAfter) {
                    this.log.warn(`${this.failsInRow} failed requests in a row - reconnecting`);
                    this.failsInRow = 0;
                    this._drop(`${this.opts.reconnectAfter} failed requests in a row`);
                }
            }
            throw err;
        } finally {
            this.abortRunning = null;
            if (guard) {
                this.timers.clearTimeout(guard);
                this.timerHandles.delete(guard);
            }
            this.lastEnd = this.now();
            this.lastPause = pauseAfter || 0;
        }
    }

    /**
     * @param {Promise<any>} p Promise
     * @param {number} ms Timeout
     * @param {string} msg Error text
     * @returns {Promise<any>} Result
     */
    _withTimeout(p, ms, msg) {
        return new Promise((resolve, reject) => {
            const h = this._timer(() => reject(new Error(msg)), ms);
            p.then(
                v => {
                    this.timers.clearTimeout(h);
                    this.timerHandles.delete(h);
                    resolve(v);
                },
                e => {
                    this.timers.clearTimeout(h);
                    this.timerHandles.delete(h);
                    reject(e);
                },
            );
        });
    }

    /**
     * @param {number} ms Duration
     * @returns {Promise<void>} Resolves after ms or on stop
     */
    _sleep(ms) {
        return new Promise(resolve => {
            const wake = () => {
                this.sleepers.delete(wake);
                resolve();
            };
            this.sleepers.add(wake);
            this._timer(wake, ms);
        });
    }
}

/**
 * @param {any} e Error
 * @returns {boolean} Request timed out
 */
function isTimeout(e) {
    return !!e && (e.name === 'TransactionTimedOutError' || e.errno === 'ETIMEDOUT' || /timed out/i.test(e.message));
}

/**
 * @param {any} e Error
 * @returns {string} Short text
 */
function errText(e) {
    if (!e) {
        return 'unknown error';
    }
    return e.message || e.code || String(e);
}

/**
 * @param {import('./registers').Block} b Block
 * @returns {string} e.g. "FC4 unit 2 10740+9"
 */
function describe(b) {
    return `FC${READ_FC[b.regType]} unit ${b.deviceId} ${b.start}+${b.count}`;
}

module.exports = { Poller, isTimeout, errText, describe };
