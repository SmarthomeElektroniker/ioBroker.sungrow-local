'use strict';

/*
 * Simulated WiNet-S2: Modbus TCP server in front of ONE shared RTU bus.
 *
 * - Requests of all connections are answered strictly one after another (one bus).
 * - Each unit has a latency and an "instruction interval" (busGap): after a request to that unit the bus
 *   stays blocked for busGap ms - like the 5000 ms of the SBH400 (unit 2) in the real gateway.
 * - `drop(unit, n)` swallows the next n requests of a unit: the gateway waits its own bus timeout and never
 *   answers (what ioBroker.modbus saw as "Request timed out" on block 10740-10748 of unit 2).
 * - `late(unit, n, ms)` answers the next n requests only after ms (later than the client's timeout).
 * - `stall(true)` stops answering everything (dead gateway with open socket).
 * - `kick()` closes all client sockets (gateway restart / network loss).
 * - `short(unit, n, missing)` answers the next n reads of a unit with `missing` registers less than asked.
 */

const net = require('node:net');

/**
 * @param {object} [opts] Options
 * @param {Record<number, {latency?: number, busGap?: number, busTimeout?: number}>} [opts.units] Units
 * @returns {Promise<any>} Fake server
 */
async function createFakeWinet(opts = {}) {
    const units = {};
    for (const [id, u] of Object.entries(opts.units || { 1: {}, 2: {} })) {
        units[id] = {
            latency: 20,
            busGap: 0,
            busTimeout: 200,
            input: new Map(),
            holding: new Map(),
            dropCount: 0,
            lateCount: 0,
            lateMs: 0,
            exceptions: new Set(),
            shortCount: 0,
            shortBy: 0,
            ...u,
        };
    }
    const state = {
        units,
        requests: [],
        connections: 0,
        open: new Set(),
        stalled: false,
        busFreeAt: 0,
        maxParallelConnections: 0,
    };
    /** @type {{sock: net.Socket, frame: Buffer, t: number}[]} */
    const busQueue = [];
    let busRunning = false;
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    async function runBus() {
        if (busRunning) {
            return;
        }
        busRunning = true;
        while (busQueue.length) {
            const { sock, frame } = busQueue.shift();
            const wait = state.busFreeAt - Date.now();
            if (wait > 0) {
                await sleep(wait);
            }
            await handle(sock, frame);
        }
        busRunning = false;
    }

    /**
     * @param {net.Socket} sock Client
     * @param {Buffer} frame MBAP + PDU
     */
    async function handle(sock, frame) {
        const tid = frame.readUInt16BE(0);
        const unitId = frame.readUInt8(6);
        const fc = frame.readUInt8(7);
        const addr = frame.readUInt16BE(8);
        const qtyOrVal = frame.readUInt16BE(10);
        const u = units[unitId];
        const rec = { t: Date.now(), unit: unitId, fc, addr, qty: qtyOrVal, answered: false };
        state.requests.push(rec);
        if (state.stalled) {
            return;
        }
        if (!u) {
            state.busFreeAt = Date.now() + 200;
            return;
        }
        if (u.dropCount > 0) {
            u.dropCount--;
            rec.dropped = true;
            // gateway waits for the device until its own timeout, the bus is blocked meanwhile
            await sleep(u.busTimeout);
            state.busFreeAt = Date.now() + u.busGap;
            return;
        }
        await sleep(u.latency);
        let pdu;
        if (fc === 3 || fc === 4) {
            const map = fc === 3 ? u.holding : u.input;
            if ([...Array(qtyOrVal).keys()].some(i => u.exceptions.has(addr + i))) {
                pdu = Buffer.from([fc | 0x80, 2]);
            } else {
                let qty = qtyOrVal;
                if (u.shortCount > 0) {
                    u.shortCount--;
                    rec.short = true;
                    qty = Math.max(0, qtyOrVal - u.shortBy);
                }
                pdu = Buffer.alloc(2 + qty * 2);
                pdu[0] = fc;
                pdu[1] = qty * 2;
                for (let i = 0; i < qty; i++) {
                    pdu.writeUInt16BE(map.get(addr + i) || 0, 2 + i * 2);
                }
            }
        } else if (fc === 6) {
            rec.value = qtyOrVal;
            u.holding.set(addr, qtyOrVal);
            pdu = frame.subarray(7, 12);
        } else if (fc === 16) {
            const values = [];
            for (let i = 0; i < qtyOrVal; i++) {
                values.push(frame.readUInt16BE(13 + i * 2));
                u.holding.set(addr + i, frame.readUInt16BE(13 + i * 2));
            }
            rec.values = values;
            pdu = frame.subarray(7, 12);
        } else {
            pdu = Buffer.from([fc | 0x80, 1]);
        }
        const mbap = Buffer.alloc(7);
        mbap.writeUInt16BE(tid, 0);
        mbap.writeUInt16BE(0, 2);
        mbap.writeUInt16BE(pdu.length + 1, 4);
        mbap.writeUInt8(unitId, 6);
        const answer = Buffer.concat([mbap, pdu]);
        state.busFreeAt = Date.now() + u.busGap;
        if (u.lateCount > 0) {
            u.lateCount--;
            rec.late = true;
            setTimeout(() => !sock.destroyed && sock.write(answer), u.lateMs);
            return;
        }
        if (!sock.destroyed) {
            sock.write(answer);
            rec.answered = true;
        }
    }

    const server = net.createServer(sock => {
        state.connections++;
        state.open.add(sock);
        state.maxParallelConnections = Math.max(state.maxParallelConnections, state.open.size);
        let buf = Buffer.alloc(0);
        sock.on('data', d => {
            buf = Buffer.concat([buf, d]);
            while (buf.length >= 7) {
                const len = buf.readUInt16BE(4);
                if (buf.length < 6 + len) {
                    break;
                }
                busQueue.push({ sock, frame: buf.subarray(0, 6 + len), t: Date.now() });
                buf = buf.subarray(6 + len);
            }
            void runBus();
        });
        sock.on('close', () => state.open.delete(sock));
        sock.on('error', () => {});
    });
    await new Promise(r => server.listen(opts.port || 0, '127.0.0.1', () => r(undefined)));
    const port = /** @type {net.AddressInfo} */ (server.address()).port;

    return {
        host: '127.0.0.1',
        port,
        state,
        /**
         * @param {number} unit Unit
         * @param {'input'|'holding'} table Table
         * @param {number} addr Protocol address
         * @param {number[]} words Register words
         */
        set(unit, table, addr, words) {
            words.forEach((w, i) => units[unit][table].set(addr + i, w & 0xffff));
        },
        drop(unit, n) {
            units[unit].dropCount = n;
        },
        late(unit, n, ms) {
            units[unit].lateCount = n;
            units[unit].lateMs = ms;
        },
        short(unit, n, missing) {
            units[unit].shortCount = n;
            units[unit].shortBy = missing;
        },
        stall(on) {
            state.stalled = on;
        },
        kick() {
            for (const s of state.open) {
                s.destroy();
            }
        },
        /** @param {(r: any) => boolean} pred Filter */
        count(pred) {
            return state.requests.filter(pred).length;
        },
        close() {
            for (const s of state.open) {
                s.destroy();
            }
            return new Promise(r => server.close(() => r(undefined)));
        },
    };
}

module.exports = { createFakeWinet };
