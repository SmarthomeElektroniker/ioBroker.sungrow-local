'use strict';

/*
 * Register template ("catalog"): all known Sungrow registers that the adapter does not read by default.
 *
 * The rows live in lib/catalog.json and are added to the register tables of an instance with
 * enabled = false (no tick). Ticking a row in the admin starts reading it; nothing changes for rows that
 * are already configured. Sources: Home Assistant integration of mkaiser (MIT, (c) 2025 Martin Kaiser) and
 * the register list of the reference installation - see README "Register template".
 */

const CATALOG = require('./catalog.json');
/** @type {{registers: Record<string, any>}} */
let META = { registers: {} };
try {
    META = require('./catalog-meta.json');
} catch {
    // no metadata
}
const { OFFSETS, TYPE_LEN, STRING_TYPES, ROLE_FIXES } = require('./registers');

/**
 * Template v7 (0.5.0): English names of the default poll groups. The group name is part of the object IDs
 * (info.groups.<name>.*), ioBroker wants English IDs. Only the names of the default groups are renamed -
 * groups the user named himself are never touched.
 */
const GROUP_RENAMES = { akku: 'battery', energie: 'energy', steuerung: 'control' };

/** English descriptions of the default groups (= io-package.json) */
const DEFAULT_GROUP_DESC = {
    live: 'Powers, voltages, state (inverter)',
    energy: 'Counters and daily values (inverter)',
    control: 'Holding registers (control)',
    battery: 'SBH400 battery (unit 2) - 5 s instruction interval in the WiNet',
    info: 'Device information and rarely changing settings',
};

/**
 * German descriptions of the defaults of 0.1/0.2 (key = old group name). A description is replaced only
 * while it is still exactly this text - an own text of the user stays.
 */
const OLD_GROUP_DESC = {
    live: 'Leistungen, Spannungen, Status (Wechselrichter)',
    energie: 'Zähler und Tageswerte (Wechselrichter)',
    steuerung: 'Holding-Register (Steuerung)',
    akku: 'SBH400 (unit 2) – 5 s Anweisungsintervall im WiNet',
};

/**
 * Renames the default groups (template v7) and replaces unchanged German default descriptions.
 * A group is not renamed when a group with the new name exists already (own group of the user).
 *
 * @param {any[]} groups Group rows (modified copy is returned)
 * @param {Record<string, any[]>} tables Register tables by type (rows of renamed groups are moved; modified in place)
 * @returns {{groups: any[], renamed: [string, string][], described: string[], skipped: string[]}} Result
 */
function renameDefaultGroups(groups, tables) {
    const out = groups.map(g => (g && typeof g === 'object' ? { ...g } : g));
    /** @type {[string, string][]} */
    const renamed = [];
    /** @type {string[]} */
    const described = [];
    /** @type {string[]} */
    const skipped = [];
    const nameOf = (/** @type {any} */ g) => (g && g.name !== undefined ? String(g.name).trim() : '');
    for (const g of out) {
        const oldName = nameOf(g);
        if (!Object.prototype.hasOwnProperty.call(GROUP_RENAMES, oldName)) {
            continue;
        }
        const newName = GROUP_RENAMES[/** @type {keyof typeof GROUP_RENAMES} */ (oldName)];
        if (out.some(x => nameOf(x) === newName)) {
            skipped.push(`${oldName} (a group "${newName}" exists already)`);
            continue;
        }
        g.name = newName;
        renamed.push([oldName, newName]);
        for (const rows of Object.values(tables)) {
            for (const r of rows) {
                if (r && String(r.group || '').trim() === oldName) {
                    r.group = newName;
                }
            }
        }
    }
    for (const g of out) {
        if (!g || typeof g !== 'object') {
            continue;
        }
        const name = nameOf(g);
        const oldName = renamed.find(([, n]) => n === name)?.[0] || name;
        const oldDesc = OLD_GROUP_DESC[/** @type {keyof typeof OLD_GROUP_DESC} */ (oldName)];
        const newDesc = DEFAULT_GROUP_DESC[/** @type {keyof typeof DEFAULT_GROUP_DESC} */ (name)];
        if (oldDesc && newDesc && String(g.description || '').trim() === oldDesc) {
            g.description = newDesc;
            described.push(name);
        }
    }
    return { groups: out, renamed, described, skipped };
}

/**
 * @param {any} row Register row
 * @param {'inputRegs'|'holdingRegs'} regType Table
 * @returns {number[]} Protocol addresses covered by the row
 */
function span(row, regType) {
    const start = parseInt(row._address, 10) - OFFSETS[regType];
    const type = row.type || 'uint16be';
    const len = STRING_TYPES.includes(type) ? parseInt(row.len, 10) || 1 : TYPE_LEN[type] || 1;
    return Array.from({ length: len }, (_, i) => start + i);
}

/**
 * @param {unknown} a Value in the configuration
 * @param {string} b Value of a fix
 * @param {string} field Field name
 * @returns {boolean} true when both mean the same
 */
function sameValue(a, b, field) {
    if (field === 'factor') {
        return parseFloat(String(a).replace(',', '.')) === parseFloat(b);
    }
    return String(a).trim() === b;
}

/**
 * Translated value table of the template (all 11 languages) for a register whose states column is still the
 * template text or empty. common.states of an object only takes plain strings (js-controller), so the
 * translation happens by the raw value: the adapter writes the system language into common.states, the
 * device manager and the admin pick the language themselves. An own text of the user is never translated.
 *
 * @param {string} regType inputRegs or holdingRegs
 * @param {number|string} deviceId Modbus unit
 * @param {number|string} alias Column address (30001/40001 based, as in the tables)
 * @param {string} [statesRaw] States column as configured
 * @returns {Record<string, Record<string, string>>|undefined} Raw value -> text per language, or undefined
 */
function templateStates(regType, deviceId, alias, statesRaw) {
    const m =
        META.registers &&
        META.registers[`${regType}:${parseInt(String(deviceId), 10) || 1}:${parseInt(String(alias), 10)}`];
    if (!m || !m.states || !m.statesDefault) {
        return undefined;
    }
    const own = String(statesRaw || '').trim();
    if (own && own !== m.statesDefault) {
        return undefined;
    }
    return m.states;
}

/**
 * @param {Record<string, Record<string, string>>} multi Raw value -> text per language
 * @param {string} lang Language
 * @returns {Record<string, string>} Raw value -> text in that language (English otherwise)
 */
function statesIn(multi, lang) {
    /** @type {Record<string, string>} */
    const out = {};
    for (const [k, t] of Object.entries(multi)) {
        out[k] = t[lang] || t.en;
    }
    return withHexCodes(out);
}

/** Sungrow codes that the documentation writes in hexadecimal (switches, battery command, wallbox mode) */
const HEX_CODES = new Set([0x55, 0xaa, 0xbb, 0xcc, 0xee, 0xa0, 0xa1, 0xa2, 0xa3]);

/**
 * Adds the hexadecimal code to the texts of a value table that consists only of such codes
 * ("170": "Enable" -> "Enable (0xAA)") - the Sungrow documentation and most forum posts name them in hex.
 * Texts that name a code already ("On (0xAA)") and other tables stay as they are.
 *
 * @param {Record<string, string> | undefined} states Raw value -> text
 * @returns {Record<string, string> | undefined} Same table with codes
 */
function withHexCodes(states) {
    if (!states || typeof states !== 'object') {
        return states;
    }
    const keys = Object.keys(states);
    if (!keys.length || !keys.every(k => /^\d+$/.test(k) && HEX_CODES.has(Number(k)))) {
        return states;
    }
    /** @type {Record<string, string>} */
    const out = {};
    for (const k of keys) {
        const text = String(states[k]);
        out[k] = /0x[0-9a-f]{2}/i.test(text) ? text : `${text} (0x${Number(k).toString(16).toUpperCase()})`;
    }
    return out;
}

/**
 * Adds the template rows that the configuration does not have yet (unticked) and marks the existing rows
 * as ticked when they have no enabled flag (rows without the flag have always been read).
 *
 * A template row is left out when ANY of its registers is already covered by a configured row of the same
 * unit - own rows always win, nothing is read twice, no state ID changes.
 *
 * Known wrong defaults of earlier versions (catalog.fixes) are corrected, but only in rows that still have
 * exactly the old value - a value the user changed is kept.
 *
 * @param {Record<string, any>} native Instance configuration (not modified)
 * @param {{version: number, groups: any[], inputRegs: any[], holdingRegs: any[], fixes?: any[]}} [catalog] Template
 * @returns {{changed: boolean, native: Record<string, any>, added: number, fixed: string[], renamedGroups?: [string, string][], skippedGroups?: string[]}} New configuration
 */
function mergeCatalog(native, catalog = CATALOG) {
    // templateVersion is only ever written by the adapter itself (never a default in io-package.json:
    // "iobroker upload" copies new default keys into existing instances)
    if (native && Number(native.templateVersion) >= catalog.version) {
        return { changed: false, native, added: 0, fixed: [] };
    }
    const out = { ...native };
    delete out.catalogVersion; // key of a 0.3.0 pre-release, came in as a default
    let added = 0;
    /** @type {string[]} */
    const fixed = [];
    for (const regType of /** @type {('inputRegs'|'holdingRegs')[]} */ (['inputRegs', 'holdingRegs'])) {
        const rows = (Array.isArray(native[regType]) ? native[regType] : []).map(r => {
            if (!r) {
                return r;
            }
            const row = r.enabled === undefined ? { ...r, enabled: true } : { ...r };
            // template v3: writing is released per holding register. Rows that existed before keep what they
            // could do: ticked rows stay writable, unticked template rows are not released.
            if (regType === 'holdingRegs' && row.allowWrite === undefined) {
                row.allowWrite = row.enabled !== false;
            }
            // template v4: value table (states) of known registers with an enumeration, only when the row has none
            // (an own text of the user is never replaced)
            const m = META.registers[`${regType}:${parseInt(row.deviceId, 10) || 1}:${parseInt(row._address, 10)}`];
            if (m && m.statesDefault && !String(row.states || '').trim()) {
                row.states = m.statesDefault;
            }
            // template v6: roles that are not in the ioBroker role list ("level.mode" of the 0.1 defaults)
            const role = String(row.role || '').trim();
            if (Object.prototype.hasOwnProperty.call(ROLE_FIXES, role)) {
                row.role = ROLE_FIXES[/** @type {keyof typeof ROLE_FIXES} */ (role)];
            }
            return row;
        });
        for (const f of (catalog.fixes || []).filter(x => x.regType === regType)) {
            rows.forEach((r, i) => {
                if (
                    r &&
                    (parseInt(r.deviceId, 10) || 1) === f.deviceId &&
                    parseInt(r._address, 10) === f._address &&
                    sameValue(r[f.field], f.from, f.field)
                ) {
                    rows[i] = { ...r, [f.field]: f.to };
                    fixed.push(`${f._address} ${f.field} ${f.from} -> ${f.to}`);
                }
            });
        }
        const used = new Set();
        for (const r of rows) {
            if (!r) {
                continue;
            }
            const unit = parseInt(r.deviceId, 10) || 1;
            for (const a of span(r, regType)) {
                used.add(`${unit}:${a}`);
            }
        }
        for (const c of catalog[regType]) {
            const keys = span(c, regType).map(a => `${c.deviceId}:${a}`);
            if (keys.some(k => used.has(k))) {
                continue;
            }
            keys.forEach(k => used.add(k));
            rows.push(
                regType === 'holdingRegs' ? { ...c, enabled: false, allowWrite: false } : { ...c, enabled: false },
            );
            added++;
        }
        out[regType] = rows;
    }
    // template v7: English names of the default groups (after the fixes above - they still name the old groups)
    const ren = renameDefaultGroups(Array.isArray(native.groups) ? native.groups : [], {
        inputRegs: out.inputRegs,
        holdingRegs: out.holdingRegs,
    });
    for (const [o, n] of ren.renamed) {
        fixed.push(`group ${o} -> ${n}`);
    }
    for (const n of ren.described) {
        fixed.push(`group ${n}: English default description`);
    }
    const groups = ren.groups;
    for (const g of catalog.groups) {
        if (!groups.some(x => x && String(x.name).trim() === g.name)) {
            groups.push({ ...g });
        }
    }
    out.groups = groups;
    out.templateVersion = catalog.version;
    return { changed: true, native: out, added, fixed, renamedGroups: ren.renamed, skippedGroups: ren.skipped };
}

module.exports = {
    withHexCodes,
    HEX_CODES,
    CATALOG,
    META,
    mergeCatalog,
    templateStates,
    statesIn,
    span,
    renameDefaultGroups,
    GROUP_RENAMES,
    DEFAULT_GROUP_DESC,
    OLD_GROUP_DESC,
};
