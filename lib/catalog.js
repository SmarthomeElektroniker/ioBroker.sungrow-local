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
 * @returns {{changed: boolean, native: Record<string, any>, added: number, fixed: string[]}} New configuration
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
    const groups = Array.isArray(native.groups) ? [...native.groups] : [];
    for (const g of catalog.groups) {
        if (!groups.some(x => x && String(x.name).trim() === g.name)) {
            groups.push({ ...g });
        }
    }
    out.groups = groups;
    out.templateVersion = catalog.version;
    return { changed: true, native: out, added, fixed };
}

module.exports = { CATALOG, META, mergeCatalog, span };
