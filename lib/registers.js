'use strict';

/*
 * Register definitions: normalisation, state IDs, block building and value conversion.
 *
 * Everything here deliberately mirrors ioBroker.modbus 9.x (@iobroker/modbus 7.8) with the options
 * used by the instance this adapter replaces (showAliases, directAddresses, multiDeviceId, offsets
 * 30001/40001, maxBlock 100, maxGap 10, round 4). Same rows => same state IDs and the same requests,
 * so a migration is a plain text replacement of the instance prefix.
 */

/** Number of 16-bit registers per type (fixed-length types) */
const TYPE_LEN = {
    uint8be: 1,
    uint8le: 1,
    int8be: 1,
    int8le: 1,
    uint16be: 1,
    uint16le: 1,
    int16be: 1,
    int16le: 1,
    uint32be: 2,
    uint32le: 2,
    uint32sw: 2,
    uint32sb: 2,
    int32be: 2,
    int32le: 2,
    int32sw: 2,
    int32sb: 2,
    floatbe: 2,
    floatle: 2,
    floatsw: 2,
    floatsb: 2,
    uint64be: 4,
    uint64le: 4,
    int64be: 4,
    int64le: 4,
    doublebe: 4,
    doublele: 4,
};

/** Variable-length text types (length in registers comes from the row) */
const STRING_TYPES = ['string', 'stringle'];

/** All supported types (for the admin select and validation) */
const TYPES = [...Object.keys(TYPE_LEN), ...STRING_TYPES];

/** Address offsets ("aliases") as in ioBroker.modbus */
const OFFSETS = { inputRegs: 30001, holdingRegs: 40001 };

/** Channel names of the register types (as in ioBroker.modbus) */
const REG_NAMES = { inputRegs: 'inputRegisters', holdingRegs: 'holdingRegisters' };

/** Modbus function codes for reading */
const READ_FC = { inputRegs: 4, holdingRegs: 3 };

/**
 * @param {unknown} v Number or text with a decimal comma
 * @param {number} def Fallback
 * @returns {number} Parsed number
 */
function num(v, def) {
    if (typeof v === 'number') {
        return Number.isFinite(v) ? v : def;
    }
    if (typeof v === 'string' && v.trim() !== '') {
        const n = parseFloat(v.replace(',', '.'));
        return Number.isFinite(n) ? n : def;
    }
    return def;
}

/**
 * @param {unknown} v Checkbox value (true, "true", 1)
 * @returns {boolean} Set or not
 */
function flag(v) {
    return v === true || v === 'true' || v === 1 || v === '1';
}

/**
 * @param {unknown} v Optional number (empty = not set)
 * @returns {number|undefined} Number or undefined
 */
function optNum(v) {
    if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
        return undefined;
    }
    const n = num(v, NaN);
    return Number.isFinite(n) ? n : undefined;
}

/**
 * Parses the "states" column: `value:text;value:text` (e.g. `0:Self-consumption;2:Forced`).
 * An object (already parsed) is taken as it is.
 *
 * @param {unknown} v Column value
 * @returns {Record<string, string>|undefined} common.states or undefined when empty
 */
function parseStates(v) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
        const o = /** @type {Record<string, string>} */ ({});
        for (const [k, t] of Object.entries(v)) {
            o[String(k).trim()] = String(t);
        }
        return Object.keys(o).length ? o : undefined;
    }
    if (typeof v !== 'string' || !v.trim()) {
        return undefined;
    }
    const o = /** @type {Record<string, string>} */ ({});
    for (const part of v.split(';')) {
        const i = part.indexOf(':');
        if (i <= 0) {
            continue;
        }
        const key = part.substring(0, i).trim();
        const text = part.substring(i + 1).trim();
        if (key && text) {
            o[key] = text;
        }
    }
    return Object.keys(o).length ? o : undefined;
}

/**
 * Checks a value that is about to be written against min, max and states of the register.
 *
 * @param {Reg} reg Register
 * @param {unknown} val State value
 * @returns {string} Problem description, empty when the value is plausible
 */
function checkWriteValue(reg, val) {
    if (STRING_TYPES.includes(reg.type)) {
        return '';
    }
    const n = typeof val === 'boolean' ? Number(val) : num(val, NaN);
    if (!Number.isFinite(n)) {
        return `${JSON.stringify(val)} is not a number`;
    }
    if (reg.min !== undefined && n < reg.min) {
        return `${n} is below the minimum ${reg.min}`;
    }
    if (reg.max !== undefined && n > reg.max) {
        return `${n} is above the maximum ${reg.max}`;
    }
    if (reg.states && !Object.keys(reg.states).some(k => Number(k) === n)) {
        return `${n} is none of the known values (${Object.entries(reg.states)
            .map(([k, t]) => `${k}=${t}`)
            .join(', ')})`;
    }
    return '';
}

/**
 * State ID below the namespace, exactly as ioBroker.modbus builds it with showAliases + multiDeviceId:
 * `<inputRegisters|holdingRegisters>.<deviceId>.<_address>_<name with spaces and dots replaced by _>`
 *
 * @param {'inputRegs'|'holdingRegs'} regType Register type
 * @param {number} deviceId Modbus unit
 * @param {number} alias Address including the offset (the `_address` of the row)
 * @param {string} name Name column
 * @returns {string} ID without namespace
 */
function stateId(regType, deviceId, alias, name) {
    let id = `${REG_NAMES[regType]}.${deviceId}.${alias}`;
    if (name) {
        id += `_${String(name).replace(/\./g, '_').replace(/\s/g, '_')}`;
    }
    return id;
}

/**
 * Normalises the rows of one register table. Invalid rows are reported and skipped.
 *
 * @param {'inputRegs'|'holdingRegs'} regType Register type
 * @param {any[]} rows Rows from the configuration
 * @param {{defaultDeviceId?: number, defaultGroup?: string}} [opts] Defaults
 * @returns {{regs: Reg[], problems: string[]}} Normalised registers sorted by address and problems found
 */
function normalise(regType, rows, opts = {}) {
    const offset = OFFSETS[regType];
    const problems = [];
    const regs = [];
    const seen = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || row.enabled === false) {
            continue;
        }
        const alias = parseInt(row._address, 10);
        if (!Number.isInteger(alias) || alias < offset) {
            problems.push(`${regType}: invalid address ${JSON.stringify(row._address)} (must be >= ${offset})`);
            continue;
        }
        const deviceId = Number.isInteger(parseInt(row.deviceId, 10))
            ? parseInt(row.deviceId, 10)
            : opts.defaultDeviceId || 1;
        const type = row.type || 'uint16be';
        if (!TYPES.includes(type)) {
            problems.push(`${regType} ${alias}: unsupported type "${type}"`);
            continue;
        }
        const len = STRING_TYPES.includes(type) ? parseInt(row.len, 10) || 1 : TYPE_LEN[type];
        const name = row.name === undefined || row.name === null ? '' : String(row.name);
        const id = stateId(regType, deviceId, alias, name);
        if (seen.has(id)) {
            problems.push(`${regType} ${alias}: duplicate state ID ${id}`);
            continue;
        }
        seen.add(id);
        for (const unsupported of ['formula', 'cw', 'wp', 'isScale']) {
            if (row[unsupported] && row[unsupported] !== 'false') {
                problems.push(`${regType} ${alias}: option "${unsupported}" is not supported and ignored`);
            }
        }
        regs.push({
            regType,
            id,
            alias,
            address: alias - offset,
            deviceId,
            name,
            description: row.description ? String(row.description).replace(/\s+/g, ' ').trim() : '',
            unit: row.unit ? String(row.unit).trim() : '',
            type,
            len,
            factor: num(row.factor, 1) || 1,
            offset: num(row.offset, 0),
            role: row.role ? String(row.role).trim() : 'value',
            states: parseStates(row.states),
            min: optNum(row.min),
            max: optNum(row.max),
            room: row.room ? String(row.room) : '',
            group: String(row.group || opts.defaultGroup || '').trim(),
            // input registers are always read; holding registers only with "poll"
            poll: regType === 'inputRegs' ? true : flag(row.poll),
            // holding registers: writing must be released per row (rows of older versions without the
            // column stay writable - the template migration sets the column for existing instances)
            write: regType === 'holdingRegs' && (row.allowWrite === undefined || flag(row.allowWrite)),
        });
    }
    regs.sort((a, b) => a.alias - b.alias);
    return { regs, problems };
}

/**
 * Builds read blocks with the algorithm of ioBroker.modbus (iterateAddresses): a new block starts when
 * the gap to the end of the previous register exceeds maxGap (only for registers shorter than 10) or the
 * block would exceed maxBlock registers. The registers must share type and unit.
 *
 * @param {Reg[]} regs Polled registers of ONE unit and ONE register type, sorted by address
 * @param {number} maxBlock Maximum registers per request
 * @param {number} maxGap Maximum gap bridged in one request
 * @returns {Block[]} Blocks
 */
function buildBlocks(regs, maxBlock = 100, maxGap = 10) {
    const blocks = [];
    let current = null;
    let lastAddress = 0;
    for (const reg of regs) {
        if (current) {
            const exceeds = reg.address + reg.len - current.start > maxBlock;
            const gap = reg.address - lastAddress > maxGap && (maxGap === 0 || reg.len < 10);
            if (exceeds || gap) {
                current.count = lastAddress - current.start;
                blocks.push(current);
                current = null;
            }
        }
        if (!current) {
            current = { regType: reg.regType, deviceId: reg.deviceId, start: reg.address, count: 0, regs: [] };
        }
        current.regs.push(reg);
        lastAddress = reg.address + reg.len;
    }
    if (current) {
        current.count = lastAddress - current.start;
        blocks.push(current);
    }
    return blocks;
}

/**
 * Reads a raw value from a response buffer (big-endian register order of Modbus).
 *
 * @param {string} type Register type
 * @param {number} len Length in registers (strings)
 * @param {Buffer} buf Response payload
 * @param {number} pos Register offset inside the payload
 * @returns {number|string} Raw value
 */
function extract(type, len, buf, pos) {
    const o = pos * 2;
    /** @param {number[]} order Byte order for a 4-byte value */
    const swap4 = order => Buffer.from(order.map(i => buf[o + i]));
    switch (type) {
        case 'uint8be':
            return buf.readUInt8(o + 1);
        case 'uint8le':
            return buf.readUInt8(o);
        case 'int8be':
            return buf.readInt8(o + 1);
        case 'int8le':
            return buf.readInt8(o);
        case 'uint16be':
            return buf.readUInt16BE(o);
        case 'uint16le':
            return buf.readUInt16LE(o);
        case 'int16be':
            return buf.readInt16BE(o);
        case 'int16le':
            return buf.readInt16LE(o);
        case 'uint32be':
            return buf.readUInt32BE(o);
        case 'uint32le':
            return buf.readUInt32LE(o);
        case 'uint32sw':
            return swap4([2, 3, 0, 1]).readUInt32BE(0);
        case 'uint32sb':
            return swap4([1, 0, 3, 2]).readUInt32BE(0);
        case 'int32be':
            return buf.readInt32BE(o);
        case 'int32le':
            return buf.readInt32LE(o);
        case 'int32sw':
            return swap4([2, 3, 0, 1]).readInt32BE(0);
        case 'int32sb':
            return swap4([1, 0, 3, 2]).readInt32BE(0);
        case 'floatbe':
            return buf.readFloatBE(o);
        case 'floatle':
            return buf.readFloatLE(o);
        case 'floatsw':
            return swap4([2, 3, 0, 1]).readFloatBE(0);
        case 'floatsb':
            return swap4([1, 0, 3, 2]).readFloatBE(0);
        case 'uint64be':
            return Number(buf.readBigUInt64BE(o));
        case 'uint64le':
            return Number(buf.readBigUInt64LE(o));
        case 'int64be':
            return Number(buf.readBigInt64BE(o));
        case 'int64le':
            return Number(buf.readBigInt64LE(o));
        case 'doublebe':
            return buf.readDoubleBE(o);
        case 'doublele':
            return buf.readDoubleLE(o);
        case 'string': {
            let n = 0;
            while (n < len * 2 && buf[o + n]) {
                n++;
            }
            return buf.toString('ascii', o, o + n);
        }
        case 'stringle': {
            let s = '';
            for (let n = 0; n < len * 2; n += 2) {
                if (!buf[o + n + 1]) {
                    break;
                }
                s += String.fromCharCode(buf[o + n + 1]);
                if (!buf[o + n]) {
                    break;
                }
                s += String.fromCharCode(buf[o + n]);
            }
            return s;
        }
        default:
            throw new Error(`Invalid type: ${type}`);
    }
}

/**
 * Encodes a raw value into register bytes.
 *
 * @param {string} type Register type
 * @param {number|string} value Raw value (already divided by factor)
 * @param {number} len Length in registers (strings)
 * @returns {Buffer} Bytes, length = 2 * registers
 */
function encode(type, value, len) {
    const n = Number(value);
    const b4 = Buffer.alloc(4);
    /** @param {number[]} order Byte order */
    const reorder = order => Buffer.from(order.map(i => b4[i]));
    let b;
    switch (type) {
        case 'uint8be':
            b = Buffer.alloc(2);
            b.writeUInt8(n & 0xff, 1);
            return b;
        case 'int8be':
            b = Buffer.alloc(2);
            b.writeUInt8(n & 0xff, 1);
            return b;
        case 'uint8le':
        case 'int8le':
            b = Buffer.alloc(2);
            b.writeUInt8(n & 0xff, 0);
            return b;
        case 'uint16be':
            b = Buffer.alloc(2);
            b.writeUInt16BE(n, 0);
            return b;
        case 'uint16le':
            b = Buffer.alloc(2);
            b.writeUInt16LE(n, 0);
            return b;
        case 'int16be':
            b = Buffer.alloc(2);
            b.writeInt16BE(n, 0);
            return b;
        case 'int16le':
            b = Buffer.alloc(2);
            b.writeInt16LE(n, 0);
            return b;
        case 'uint32be':
            b4.writeUInt32BE(n, 0);
            return b4;
        case 'uint32le':
            b4.writeUInt32LE(n, 0);
            return b4;
        case 'int32be':
            b4.writeInt32BE(n, 0);
            return b4;
        case 'int32le':
            b4.writeInt32LE(n, 0);
            return b4;
        case 'uint32sw':
            b4.writeUInt32BE(n, 0);
            return reorder([2, 3, 0, 1]);
        case 'int32sw':
            b4.writeInt32BE(n, 0);
            return reorder([2, 3, 0, 1]);
        case 'uint32sb':
            b4.writeUInt32BE(n, 0);
            return reorder([1, 0, 3, 2]);
        case 'int32sb':
            b4.writeInt32BE(n, 0);
            return reorder([1, 0, 3, 2]);
        case 'floatbe':
            b4.writeFloatBE(n, 0);
            return b4;
        case 'floatle':
            b4.writeFloatLE(n, 0);
            return b4;
        case 'floatsw':
            b4.writeFloatBE(n, 0);
            return reorder([2, 3, 0, 1]);
        case 'floatsb':
            b4.writeFloatBE(n, 0);
            return reorder([1, 0, 3, 2]);
        case 'uint64be':
            b = Buffer.alloc(8);
            b.writeBigUInt64BE(BigInt(Math.trunc(n)), 0);
            return b;
        case 'uint64le':
            b = Buffer.alloc(8);
            b.writeBigUInt64LE(BigInt(Math.trunc(n)), 0);
            return b;
        case 'int64be':
            b = Buffer.alloc(8);
            b.writeBigInt64BE(BigInt(Math.trunc(n)), 0);
            return b;
        case 'int64le':
            b = Buffer.alloc(8);
            b.writeBigInt64LE(BigInt(Math.trunc(n)), 0);
            return b;
        case 'doublebe':
            b = Buffer.alloc(8);
            b.writeDoubleBE(n, 0);
            return b;
        case 'doublele':
            b = Buffer.alloc(8);
            b.writeDoubleLE(n, 0);
            return b;
        case 'string':
        case 'stringle': {
            b = Buffer.alloc(len * 2);
            const s = String(value);
            for (let i = 0; i < s.length && i < len * 2; i++) {
                b[type === 'string' ? i : i ^ 1] = s.charCodeAt(i) & 0xff;
            }
            return b;
        }
        default:
            throw new Error(`Invalid type: ${type}`);
    }
}

/**
 * Raw register value -> state value (factor, offset, rounding as in ioBroker.modbus).
 *
 * @param {Reg} reg Register
 * @param {number|string} raw Raw value
 * @param {number} round Rounding multiplier (10^decimals)
 * @returns {number|string|null} State value, null for NaN
 */
function scale(reg, raw, round) {
    if (typeof raw !== 'number') {
        return raw;
    }
    const v = Math.round((raw * reg.factor + reg.offset) * round) / round;
    return Number.isNaN(v) ? null : v;
}

/**
 * State value -> raw register value for writing (as in ioBroker.modbus: integers are rounded).
 *
 * @param {Reg} reg Register
 * @param {unknown} val State value
 * @returns {number|string} Raw value
 */
function unscale(reg, val) {
    if (STRING_TYPES.includes(reg.type)) {
        return String(val);
    }
    const n = typeof val === 'boolean' ? Number(val) : num(val, NaN);
    if (!Number.isFinite(n)) {
        throw new Error(`not a number: ${JSON.stringify(val)}`);
    }
    const raw = (n - reg.offset) / reg.factor;
    return /^float|^double/.test(reg.type) ? raw : Math.round(raw);
}

/**
 * Decodes all registers of a block from a response.
 *
 * @param {Block} block Block
 * @param {Buffer} payload Response bytes
 * @param {number} round Rounding multiplier
 * @returns {{reg: Reg, val: number|string|null}[]} Values (registers beyond a short answer are left out)
 */
function decodeBlock(block, payload, round) {
    const out = [];
    for (const reg of block.regs) {
        const pos = reg.address - block.start;
        if ((pos + reg.len) * 2 > payload.length) {
            continue;
        }
        out.push({ reg, val: scale(reg, extract(reg.type, reg.len, payload, pos), round) });
    }
    return out;
}

/**
 * @typedef {object} Reg
 * @property {'inputRegs'|'holdingRegs'} regType Register type
 * @property {string} id State ID below the namespace
 * @property {number} alias Address with offset (_address)
 * @property {number} address Protocol address
 * @property {number} deviceId Modbus unit
 * @property {string} name Name column
 * @property {string} description Description (object name)
 * @property {string} unit Unit
 * @property {string} type Register type
 * @property {number} len Length in registers
 * @property {number} factor Factor
 * @property {number} offset Offset
 * @property {string} role Role
 * @property {Record<string, string>} [states] Texts of known values (common.states)
 * @property {number} [min] Lowest plausible value (common.min)
 * @property {number} [max] Highest plausible value (common.max)
 * @property {string} room Room enum
 * @property {string} group Poll group
 * @property {boolean} poll Read cyclically
 * @property {boolean} write Writable (holding register released for writing)
 */

/**
 * @typedef {object} Block
 * @property {'inputRegs'|'holdingRegs'} regType Register type
 * @property {number} deviceId Modbus unit
 * @property {number} start First protocol address
 * @property {number} count Number of registers
 * @property {Reg[]} regs Registers inside
 */

module.exports = {
    TYPE_LEN,
    TYPES,
    STRING_TYPES,
    OFFSETS,
    REG_NAMES,
    READ_FC,
    stateId,
    normalise,
    buildBlocks,
    extract,
    encode,
    scale,
    unscale,
    decodeBlock,
    num,
    flag,
    parseStates,
    checkWriteValue,
};
