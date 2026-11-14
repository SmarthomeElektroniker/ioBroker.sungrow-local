'use strict';

/*
 * Loads main.js with a fake @iobroker/adapter-core: an in-memory object and state database, a recording log
 * and switchable failures (e.g. setState rejects like after "DB closed" while the adapter stops).
 * Only what main.js uses is implemented.
 */

const { EventEmitter } = require('node:events');
const path = require('node:path');

const NS = 'sungrow-local.0';

class FakeAdapter extends EventEmitter {
    /** @param {Record<string, any>} options Adapter options */
    constructor(options = {}) {
        super();
        this.name = options.name;
        this.namespace = NS;
        this.config = {};
        /** @type {Record<string, any>} */
        this.objects = {};
        /** @type {Record<string, any>} */
        this.states = {};
        /** @type {{level: string, msg: string}[]} */
        this.logs = [];
        /** when set: every setState rejects with this error */
        this.failSetState = null;
        this.restarted = 0;
        const rec = level => msg => this.logs.push({ level, msg: String(msg) });
        this.log = { silly: rec('silly'), debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };
    }

    _full(id) {
        return id.startsWith(`${NS}.`) || id.startsWith('system.') || id.startsWith('enum.') ? id : `${NS}.${id}`;
    }

    // ------------------------------------------------------------------ states
    async setState(id, val, ack) {
        if (this.failSetState) {
            throw this.failSetState;
        }
        const s = val !== null && typeof val === 'object' ? { ...val } : { val, ack: !!ack };
        this.states[this._full(id)] = { ...s, ts: Date.now() };
    }
    setStateAsync(id, val, ack) {
        return this.setState(id, val, ack);
    }
    setStateChangedAsync(id, val, ack) {
        return this.setState(id, val, ack);
    }
    setForeignStateAsync(id, val, ack) {
        return this.setState(id, val, ack);
    }
    async getStateAsync(id) {
        return this.states[this._full(id)] || null;
    }
    getForeignStateAsync(id) {
        return this.getStateAsync(id);
    }

    // ------------------------------------------------------------------ objects
    async getObjectAsync(id) {
        const o = this.objects[this._full(id)];
        return o ? JSON.parse(JSON.stringify(o)) : null;
    }
    getForeignObjectAsync(id) {
        return this.getObjectAsync(id);
    }
    async setObjectAsync(id, obj) {
        const full = this._full(id);
        this.objects[full] = JSON.parse(JSON.stringify({ ...obj, _id: full }));
    }
    setForeignObjectAsync(id, obj) {
        return this.setObjectAsync(id, obj);
    }
    async extendObjectAsync(id, obj) {
        const full = this._full(id);
        const old = this.objects[full] || { _id: full, common: {}, native: {} };
        const merged = {
            ...old,
            ...obj,
            _id: full,
            common: { ...old.common, ...(obj.common || {}) },
        };
        if (obj.common && obj.common.custom && old.common && old.common.custom) {
            // js-controller merges the custom settings per instance
            merged.common.custom = { ...old.common.custom, ...obj.common.custom };
        }
        Object.assign(merged, {
            native: { ...old.native, ...(obj.native || {}) },
        });
        this.objects[full] = JSON.parse(JSON.stringify(merged));
    }
    extendForeignObjectAsync(id, obj) {
        return this.extendObjectAsync(id, obj);
    }
    async delForeignObjectAsync(id, opts) {
        const full = this._full(id);
        delete this.objects[full];
        if (opts && opts.recursive) {
            for (const k of Object.keys(this.objects)) {
                if (k.startsWith(`${full}.`)) {
                    delete this.objects[k];
                }
            }
        }
    }
    delObjectAsync(id, opts) {
        return this.delForeignObjectAsync(id, opts);
    }
    async getObjectViewAsync(design, type, { startkey, endkey }) {
        const rows = Object.keys(this.objects)
            .filter(k => this.objects[k].type === type && k >= startkey && k <= endkey)
            .sort()
            .map(k => ({ id: k, value: JSON.parse(JSON.stringify(this.objects[k])) }));
        return { rows };
    }
    async getForeignObjectsAsync(pattern, type) {
        const re = new RegExp(`^${pattern.replace(/[.]/g, '\\.').replace(/\*/g, '.*')}$`);
        /** @type {Record<string, any>} */
        const out = {};
        for (const [k, o] of Object.entries(this.objects)) {
            if (re.test(k) && (!type || o.type === type)) {
                out[k] = JSON.parse(JSON.stringify(o));
            }
        }
        return out;
    }
    async subscribeStatesAsync() {}

    // ------------------------------------------------------------------ misc
    setTimeout(cb, ms) {
        return setTimeout(cb, ms);
    }
    clearTimeout(t) {
        clearTimeout(t);
    }
    delay(ms) {
        return new Promise(r => setTimeout(r, ms));
    }
    sendTo() {}
    restart() {
        this.restarted++;
    }

    /** @param {string} level Log level @returns {string[]} Messages of this level */
    logsOf(level) {
        return this.logs.filter(l => l.level === level).map(l => l.msg);
    }
}

/**
 * Loads main.js with the fake adapter-core (cache entry restored afterwards).
 *
 * @returns {(options?: any) => any} Factory of main.js
 */
function loadMain() {
    const corePath = require.resolve('@iobroker/adapter-core');
    const mainPath = path.join(__dirname, '..', 'main.js');
    const savedCore = require.cache[corePath];
    delete require.cache[mainPath];
    require.cache[corePath] = /** @type {any} */ ({
        id: corePath,
        filename: corePath,
        loaded: true,
        exports: { Adapter: FakeAdapter, EXIT_CODES: {} },
    });
    try {
        return require(mainPath);
    } finally {
        if (savedCore) {
            require.cache[corePath] = savedCore;
        } else {
            delete require.cache[corePath];
        }
        delete require.cache[mainPath];
    }
}

/** Waits until all pending promise callbacks and immediates ran */
async function settle() {
    for (let i = 0; i < 5; i++) {
        await new Promise(r => setImmediate(r));
    }
}

module.exports = { FakeAdapter, loadMain, settle, NS };
