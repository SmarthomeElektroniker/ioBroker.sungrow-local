'use strict';

/*
 * Conversion helper for the admin ("Conversion helper" tab): explains addresses, data types, word order
 * and scaling of ONE register, decodes raw words (typed in or read from the device) in every common way and
 * warns about implausible results. Pure functions - the adapter only adds the optional device read.
 */

const { OFFSETS, TYPE_LEN, STRING_TYPES, TYPES, extract, num } = require('./registers');

/** Plausible ranges per unit (for warnings only) */
const RANGES = {
    V: [0, 1000],
    A: [-300, 300],
    W: [-100000, 100000],
    kW: [-100, 100],
    var: [-100000, 100000],
    kWh: [0, 10000000],
    '%': [0, 100],
    '°C': [-40, 100],
    Hz: [45, 65],
    kg: [0, 100000000],
};

/** "No value" markers of Sungrow (register not present on this model) */
const NO_VALUE_16 = [0xffff, 0x7fff, 0x8000];
const NO_VALUE_32 = [0xffffffff, 0x7fffffff, 0x80000000];

const TXT = {
    en: {
        addr: 'Addresses',
        doc: 'Sungrow document (register number, counts from 1)',
        proto: 'Modbus protocol address (counts from 0, e.g. Home Assistant "address:")',
        column: 'Column "Address" in this adapter',
        stateId: 'State ID',
        badAddr: 'The address is not valid for this mode.',
        raw: 'Raw words',
        selected: 'Selected type',
        value: 'Value',
        formula: 'raw × factor + offset',
        others: 'Other interpretations of the same words (with factor and offset)',
        signed: 'with sign',
        unsigned: 'without sign',
        lowFirst: 'low word first (Sungrow)',
        highFirst: 'high word first',
        warn: 'Notes',
        noValue: 'raw value %s is the usual "no value" marker - the register is probably not present on this model',
        tryS16: 'raw value > 32767: with sign (int16be) the value is %s - powers, currents and temperatures can be negative',
        tryS32: 'with sign (int32) the value is %s',
        wordOrder: 'word order: with %s the value would be %s - Sungrow sends 32-bit values low word first (…sw)',
        range: '%s %s is outside the plausible range %s … %s %s',
        factorHint: 'with factor %s the value would be %s %s',
        ok: 'value is plausible',
        noWords: 'Enter raw words or tick "Read from the device" to see values.',
        tooFew: 'type %s needs %s register(s), %s given',
        live: 'Read from the device',
        liveOk: 'answer after %s ms',
        liveErr: 'read failed: %s',
        notConnected: 'not connected to the gateway',
        rowHint: 'Row for the register table',
        string: 'text',
    },
    de: {
        addr: 'Adressen',
        doc: 'Sungrow-Dokument (Registernummer, zählt ab 1)',
        proto: 'Modbus-Protokolladresse (zählt ab 0, z. B. Home Assistant „address:“)',
        column: 'Spalte „Adresse“ in diesem Adapter',
        stateId: 'Datenpunkt-ID',
        badAddr: 'Die Adresse passt nicht zu dieser Angabe.',
        raw: 'Rohwerte (Register)',
        selected: 'Gewählter Typ',
        value: 'Wert',
        formula: 'Rohwert × Faktor + Offset',
        others: 'Andere Lesarten derselben Register (mit Faktor und Offset)',
        signed: 'mit Vorzeichen',
        unsigned: 'ohne Vorzeichen',
        lowFirst: 'niederwertiges Wort zuerst (Sungrow)',
        highFirst: 'höherwertiges Wort zuerst',
        warn: 'Hinweise',
        noValue:
            'Rohwert %s ist die übliche Kennung „kein Wert“ – das Register gibt es bei diesem Modell vermutlich nicht',
        tryS16: 'Rohwert > 32767: mit Vorzeichen (int16be) wäre der Wert %s – Leistung, Strom und Temperatur können negativ sein',
        tryS32: 'mit Vorzeichen (int32) wäre der Wert %s',
        wordOrder:
            'Wortreihenfolge: mit %s wäre der Wert %s – Sungrow sendet 32-Bit-Werte mit dem niederwertigen Wort zuerst (…sw)',
        range: '%s %s liegt außerhalb des plausiblen Bereichs %s … %s %s',
        factorHint: 'mit Faktor %s wäre der Wert %s %s',
        ok: 'Wert ist plausibel',
        noWords: 'Rohwerte eintragen oder „Vom Gerät lesen“ anhaken, dann erscheinen hier die Werte.',
        tooFew: 'Typ %s braucht %s Register, angegeben sind %s',
        live: 'Vom Gerät gelesen',
        liveOk: 'Antwort nach %s ms',
        liveErr: 'Lesen fehlgeschlagen: %s',
        notConnected: 'keine Verbindung zum Gateway',
        rowHint: 'Zeile für die Registertabelle',
        string: 'Text',
    },
};

/**
 * @param {string} s Text with %s placeholders
 * @param {...any} a Values
 * @returns {string} Filled text
 */
function fmt(s, ...a) {
    let i = 0;
    return s.replace(/%s/g, () => String(a[i++]));
}

/**
 * @param {number} v Number
 * @param {string} lang Language
 * @returns {string} Number with up to 4 decimals, decimal comma for German
 */
function show(v, lang) {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
        return String(v);
    }
    const s = String(Math.round(v * 10000) / 10000);
    return lang === 'de' ? s.replace('.', ',') : s;
}

/**
 * Parses raw register words: "0x00FA 0x0001", "250, 1", "250;1", "00FA 0001" (hex without prefix only
 * when it contains a letter).
 *
 * @param {unknown} text Input
 * @returns {number[]} 16-bit words (invalid parts are dropped)
 */
function parseWords(text) {
    if (Array.isArray(text)) {
        return text.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 0xffff);
    }
    if (typeof text !== 'string' && typeof text !== 'number') {
        return [];
    }
    const out = [];
    for (const part of String(text).split(/[\s,;]+/)) {
        if (!part) {
            continue;
        }
        let n;
        if (/^0x[0-9a-f]+$/i.test(part)) {
            n = parseInt(part.substring(2), 16);
        } else if (/^[0-9a-f]+$/i.test(part) && /[a-f]/i.test(part)) {
            n = parseInt(part, 16);
        } else if (/^-?\d+$/.test(part)) {
            n = parseInt(part, 10);
            if (n < 0 && n >= -32768) {
                n += 0x10000;
            }
        }
        if (Number.isInteger(n) && n >= 0 && n <= 0xffff) {
            out.push(n);
        }
    }
    return out;
}

/**
 * Normalises the address input to the three common notations.
 *
 * @param {unknown} value Address as typed
 * @param {'doc'|'protocol'|'column'} mode What the number means
 * @param {'inputRegs'|'holdingRegs'} regType Register type
 * @returns {{doc: number, protocol: number, column: number}|null} Addresses or null if invalid
 */
function addresses(value, mode, regType) {
    const n = parseInt(String(value), 10);
    const offset = OFFSETS[regType];
    if (!Number.isInteger(n) || n < 0) {
        return null;
    }
    let protocol;
    if (mode === 'column') {
        protocol = n - offset;
    } else if (mode === 'protocol') {
        protocol = n;
    } else {
        protocol = n - 1;
    }
    if (protocol < 0 || protocol > 0xffff) {
        return null;
    }
    return { doc: protocol + 1, protocol, column: protocol + offset };
}

/**
 * @param {string} type Register type
 * @param {number[]} words Raw words
 * @returns {number|string|undefined} Raw value or undefined when too few words
 */
function rawValue(type, words) {
    const len = STRING_TYPES.includes(type) ? words.length : TYPE_LEN[type];
    if (!len || words.length < len) {
        return undefined;
    }
    const buf = Buffer.alloc(words.length * 2);
    words.forEach((w, i) => buf.writeUInt16BE(w, i * 2));
    return extract(type, len, buf, 0);
}

/**
 * Explains one register: addresses, the decoded value, other interpretations and warnings.
 *
 * @param {Record<string, any>} q Input of the admin form
 * @param {{words?: number[], ms?: number, error?: string}} [device] Result of a device read
 * @param {string} [lang] Language (de or en)
 * @returns {{text: string, lines: string[], value?: number|string, warnings: string[]}} Explanation
 */
function explain(q, device, lang = 'en') {
    const t = TXT[lang] || TXT.en;
    const L = TXT[lang] ? lang : 'en';
    const regType = q.regType === 'holdingRegs' ? 'holdingRegs' : 'inputRegs';
    const type = TYPES.includes(q.type) ? q.type : 'uint16be';
    const factor = num(q.factor, 1) || 1;
    const offset = num(q.offset, 0);
    const unitText = String(q.unitText || '').trim();
    const unit = parseInt(q.deviceId, 10) || 1;
    const lines = [];
    const warnings = [];

    const a = addresses(q.address, q.addrMode || 'doc', regType);
    lines.push(`${t.addr}:`);
    if (!a) {
        lines.push(`  ${t.badAddr}`);
    } else {
        lines.push(`  ${t.doc}: ${a.doc}`);
        lines.push(`  ${t.proto}: ${a.protocol}`);
        lines.push(`  ${t.column}: ${a.column}`);
        const prefix = regType === 'inputRegs' ? 'inputRegisters' : 'holdingRegisters';
        const name = String(q.name || '').trim();
        lines.push(
            `  ${t.stateId}: ${prefix}.${unit}.${a.column}${name ? `_${name.replace(/\./g, '_').replace(/\s/g, '_')}` : '_…'}`,
        );
    }

    let words = parseWords(q.words);
    if (device && Array.isArray(device.words)) {
        words = device.words;
        lines.push('');
        lines.push(`${t.live}: ${device.error ? fmt(t.liveErr, device.error) : fmt(t.liveOk, device.ms)}`);
    } else if (device && device.error) {
        lines.push('');
        lines.push(`${t.live}: ${fmt(t.liveErr, device.error)}`);
    }
    let value;
    if (!words.length) {
        lines.push('');
        lines.push(t.noWords);
    } else {
        lines.push('');
        lines.push(
            `${t.raw}: ${words.map(w => `0x${w.toString(16).toUpperCase().padStart(4, '0')} (${w})`).join('  ')}`,
        );
        const need = STRING_TYPES.includes(type) ? 1 : TYPE_LEN[type];
        if (words.length < need) {
            warnings.push(fmt(t.tooFew, type, need, words.length));
        }
        const raw = rawValue(type, words);
        if (raw !== undefined) {
            if (typeof raw === 'number') {
                value = Math.round((raw * factor + offset) * 10000) / 10000;
                lines.push(
                    `${t.selected} ${type}: ${show(raw, L)} → ${t.formula} = ${show(raw, L)} × ${show(factor, L)} + ${show(offset, L)} = ${show(value, L)} ${unitText}`.trim(),
                );
            } else {
                value = raw;
                lines.push(`${t.selected} ${type} (${t.string}): "${raw}"`);
            }
        }
        // other interpretations
        if (!STRING_TYPES.includes(type)) {
            lines.push('');
            lines.push(`${t.others}:`);
            const alt = [
                ['uint16be', `16 bit ${t.unsigned}`],
                ['int16be', `16 bit ${t.signed}`],
                ['uint32sw', `32 bit ${t.unsigned}, ${t.lowFirst}`],
                ['int32sw', `32 bit ${t.signed}, ${t.lowFirst}`],
                ['uint32be', `32 bit ${t.unsigned}, ${t.highFirst}`],
                ['int32be', `32 bit ${t.signed}, ${t.highFirst}`],
            ];
            for (const [ty, label] of alt) {
                const r = rawValue(ty, words);
                if (r === undefined || typeof r !== 'number') {
                    continue;
                }
                const v = Math.round((r * factor + offset) * 10000) / 10000;
                lines.push(
                    `  ${ty === type ? '→' : ' '} ${ty.padEnd(9)} ${label}: ${show(v, L)} ${unitText}`.trimEnd(),
                );
            }
        }
        // warnings
        if (typeof value === 'number') {
            const raw16 = words[0];
            const raw32lo = words.length >= 2 ? words[0] + words[1] * 0x10000 : undefined;
            const is32 = TYPE_LEN[type] === 2;
            const noValue =
                (!is32 && NO_VALUE_16.includes(raw16)) ||
                (is32 && raw32lo !== undefined && NO_VALUE_32.includes(raw32lo >>> 0));
            if (noValue) {
                warnings.push(fmt(t.noValue, `0x${(is32 ? raw32lo : raw16).toString(16).toUpperCase()}`));
            }
            if (type === 'uint16be' && raw16 > 0x7fff && !NO_VALUE_16.includes(raw16)) {
                warnings.push(fmt(t.tryS16, `${show((raw16 - 0x10000) * factor + offset, L)} ${unitText}`.trim()));
            }
            if (/^uint32/.test(type) && words.length >= 2) {
                const s = rawValue(type.replace('uint', 'int'), words);
                if (typeof s === 'number' && s < 0) {
                    warnings.push(fmt(t.tryS32, `${show(s * factor + offset, L)} ${unitText}`.trim()));
                }
            }
            if (is32 && words.length >= 2 && !/^float/.test(type)) {
                const other = /sw$/.test(type) ? type.replace(/sw$/, 'be') : type.replace(/(be|le|sb)$/, 'sw');
                const ov = rawValue(other, words);
                if (typeof ov === 'number' && Math.abs(ov) < Math.abs(Number(rawValue(type, words))) / 1000) {
                    warnings.push(fmt(t.wordOrder, other, `${show(ov * factor + offset, L)} ${unitText}`.trim()));
                }
            }
            const range = RANGES[unitText];
            if (range && !noValue && (value < range[0] || value > range[1])) {
                warnings.push(fmt(t.range, show(value, L), unitText, show(range[0], L), show(range[1], L), unitText));
                const rawNum = Number(rawValue(type, words));
                for (const f of [0.1, 0.01, 0.001, 10, 100]) {
                    const v = rawNum * f + offset;
                    if (f !== factor && v >= range[0] && v <= range[1] && v !== 0) {
                        warnings.push(fmt(t.factorHint, show(f, L), show(v, L), unitText));
                        break;
                    }
                }
            }
        }
        lines.push('');
        lines.push(`${t.warn}:`);
        if (!warnings.length) {
            lines.push(`  ✓ ${t.ok}`);
        }
        for (const w of warnings) {
            lines.push(`  ⚠ ${w}`);
        }
    }
    if (a) {
        lines.push('');
        lines.push(
            `${t.rowHint}: ${a.column} | unit ${unit} | ${type}${STRING_TYPES.includes(type) ? ` | len ${words.length || 1}` : ''} | factor ${show(factor, 'en')} | offset ${show(offset, 'en')}${unitText ? ` | ${unitText}` : ''}`,
        );
    }
    return { text: lines.join('\n'), lines, value, warnings };
}

/**
 * Plausibility of a polled value (for a one-time hint in the log when a register is read the first time).
 *
 * @param {{unit: string}} reg Register
 * @param {unknown} val Value
 * @returns {string} Problem text (English) or empty
 */
function implausible(reg, val) {
    const range = RANGES[reg.unit];
    if (!range || typeof val !== 'number') {
        return '';
    }
    if (val < range[0] || val > range[1]) {
        return `${val} ${reg.unit} is outside the plausible range ${range[0]} … ${range[1]} ${reg.unit} - check type, factor and word order (Conversion helper tab)`;
    }
    return '';
}

module.exports = { parseWords, addresses, rawValue, explain, implausible, RANGES };
