'use strict';

/*
 * Conversion helper for the admin ("Conversion helper" tab): explains addresses, data types, word order
 * and scaling of ONE register, decodes raw words (typed in or read from the device) in every common way and
 * warns about implausible results. Pure functions - the adapter only adds the optional device read.
 */

const { OFFSETS, READ_FC, TYPE_LEN, STRING_TYPES, TYPES, extract, num, idName } = require('./registers');
const { span } = require('./catalog');

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
        addr: 'Address in all notations',
        regTypes: { inputRegs: 'input register', holdingRegs: 'holding register' },
        names: {
            doc: 'Sungrow document, column "Register" (counts from 1)',
            protocol: 'Protocol address (counts from 0, sent on the bus)',
            column: 'ioBroker column "Address" (this adapter, ioBroker.modbus with aliases)',
            modicon: 'Modicon 6-digit (300001 / 400001 + protocol)',
        },
        short: { protocol: 'protocol', column: 'column' },
        usedBy: {
            doc: '= SunGather, openHAB binding (they subtract 1 before sending)',
            protocol:
                '= Excel/register lists "address incl. offset", Home Assistant/mkaiser "address:", evcc, Loxone, ioBroker.modbus without aliases (usual forum guide: IDs like 13022_Battery_level)',
        },
        asMode: { doc: 'as Sungrow document number (from 1)', protocol: 'as protocol address (from 0)' },
        ambiguous:
            '%s can be a Sungrow document number (counts from 1) or a protocol address (counts from 0) - please choose the source under "The number is …":',
        ambiguousHint:
            'Rule of thumb: Sungrow PDF = document; Excel/register lists "incl. offset" and Home Assistant "address:" = protocol.',
        detected: 'detected: %s',
        known: 'Register at this address',
        unknown: 'not in the register tables',
        part: 'word %s of %s',
        notTicked: 'not ticked',
        neighbours: 'Off by one (counting from 0 vs. from 1) you would get',
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
        addr: 'Adresse in allen Schreibweisen',
        regTypes: { inputRegs: 'Input-Register', holdingRegs: 'Holding-Register' },
        names: {
            doc: 'Sungrow-Doku, Spalte „Register“ (zählt ab 1)',
            protocol: 'Protokolladresse (zählt ab 0, wird gesendet)',
            column: 'ioBroker-Spalte „Adresse“ (dieser Adapter, ioBroker.modbus mit Aliasen)',
            modicon: 'Modicon 6-stellig (300001 / 400001 + Protokoll)',
        },
        short: { protocol: 'Protokoll', column: 'Spalte' },
        usedBy: {
            doc: '= SunGather, openHAB-Binding (ziehen vor dem Senden 1 ab)',
            protocol:
                '= Excel-/Registerlisten „Adresse incl. Offset“, Home Assistant/mkaiser „address:“, evcc, Loxone, ioBroker.modbus ohne Aliase (übliche Forenanleitung: IDs wie 13022_Battery_level)',
        },
        asMode: { doc: 'als Sungrow-Doku-Nummer (ab 1)', protocol: 'als Protokolladresse (ab 0)' },
        ambiguous:
            '%s kann eine Sungrow-Doku-Nummer (zählt ab 1) oder eine Protokolladresse (zählt ab 0) sein – bitte unter „Die Zahl ist …“ die Quelle wählen:',
        ambiguousHint:
            'Faustregel: Sungrow-PDF = Doku; Excel-/Registerlisten „incl. Offset“ und Home Assistant „address:“ = Protokoll.',
        detected: 'erkannt: %s',
        known: 'Register an dieser Adresse',
        unknown: 'nicht in den Registertabellen',
        part: 'Wort %s von %s',
        notTicked: 'nicht angehakt',
        neighbours: 'Um eins verzählt (ab 0 statt ab 1 oder umgekehrt) wäre es',
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
 * Address notations (all describe the same register):
 * - doc:      "Register address" of the Sungrow protocol document, counts from 1 (battery level 13023)
 * - protocol: address sent on the bus, counts from 0 (13022) - register lists with "address incl. offset",
 *             Home Assistant modbus "address:" (mkaiser YAML), ioBroker.modbus WITHOUT aliases
 * - column:   column "Address" of this adapter = ioBroker.modbus WITH aliases: 30001 / 40001 + protocol (43023);
 *             for addresses below 10000 this is also the classic 5-digit Modicon notation (3xxxx / 4xxxx)
 * - modicon:  6-digit Modicon notation 300001 / 400001 + protocol (313023); the first digit gives the table
 */
const NOTATIONS = ['doc', 'protocol', 'column', 'modicon'];

/** 6-digit Modicon offsets */
const MODICON = { inputRegs: 300001, holdingRegs: 400001 };

/**
 * @param {unknown} value Address as typed (decimal; spaces and thousands dots are ignored)
 * @returns {number} Integer or NaN
 */
function parseAddress(value) {
    const s = String(value === undefined || value === null ? '' : value)
        .trim()
        .replace(/[\s.']/g, '');
    return /^\d+$/.test(s) ? parseInt(s, 10) : NaN;
}

/**
 * Converts an address from one notation into all others.
 *
 * @param {unknown} value Address as typed
 * @param {string} mode Notation of the number: doc | protocol | column | modicon
 * @param {'inputRegs'|'holdingRegs'} regType Register type (a 6-digit Modicon number brings its own)
 * @returns {{regType: 'inputRegs'|'holdingRegs', fc: number, doc: number, protocol: number, column: number, modicon: number}|null} Addresses or null if invalid
 */
function addresses(value, mode, regType) {
    const n = parseAddress(value);
    let rt = regType === 'holdingRegs' ? 'holdingRegs' : 'inputRegs';
    if (!Number.isInteger(n) || n < 0) {
        return null;
    }
    let protocol;
    if (mode === 'column') {
        protocol = n - OFFSETS[rt];
    } else if (mode === 'protocol') {
        protocol = n;
    } else if (mode === 'modicon') {
        if (n >= MODICON.holdingRegs) {
            rt = 'holdingRegs';
        } else if (n >= MODICON.inputRegs && n < MODICON.inputRegs + 0x10000) {
            rt = 'inputRegs';
        } else {
            return null;
        }
        protocol = n - MODICON[rt];
    } else {
        protocol = n - 1;
    }
    if (protocol < 0 || protocol > 0xffff) {
        return null;
    }
    return {
        regType: /** @type {'inputRegs'|'holdingRegs'} */ (rt),
        fc: READ_FC[rt],
        doc: protocol + 1,
        protocol,
        column: protocol + OFFSETS[rt],
        modicon: protocol + MODICON[rt],
    };
}

/**
 * Detects the notation where the number alone is unambiguous:
 * 300001 … 365536 / 400001 … 465536 = 6-digit Modicon; input >= 30001 or holding >= 40001 = column of this
 * adapter (Sungrow documents no input register above 13xxx and no holding register above 3xxxx).
 * Every smaller number may be a document number (from 1) or a protocol address (from 0) - that is ambiguous.
 *
 * @param {unknown} value Address as typed
 * @param {'inputRegs'|'holdingRegs'} regType Register type
 * @returns {{mode: string}|{ambiguous: string[]}|null} Detected notation, the candidates or null if invalid
 */
function detect(value, regType) {
    const n = parseAddress(value);
    if (!Number.isInteger(n) || n < 0) {
        return null;
    }
    if (
        (n >= MODICON.inputRegs && n < MODICON.inputRegs + 0x10000) ||
        (n >= MODICON.holdingRegs && n < MODICON.holdingRegs + 0x10000)
    ) {
        return { mode: 'modicon' };
    }
    const offset = OFFSETS[regType === 'holdingRegs' ? 'holdingRegs' : 'inputRegs'];
    if (n >= offset && n < offset + 0x10000) {
        return { mode: 'column' };
    }
    if (n > 0xffff + 1) {
        return null;
    }
    return { ambiguous: n === 0 ? ['protocol'] : ['doc', 'protocol'] };
}

/**
 * Resolves the address input of the helper (notation chosen or detected).
 *
 * @param {Record<string, any>} q Input of the admin form
 * @returns {{a: ReturnType<typeof addresses>, mode: string, auto: boolean, ambiguous?: string[]}} Result
 */
function resolve(q) {
    const regType = q.regType === 'holdingRegs' ? 'holdingRegs' : 'inputRegs';
    const wanted = q.addrMode === 'auto' || NOTATIONS.includes(q.addrMode) ? q.addrMode : 'doc';
    if (wanted !== 'auto') {
        return { a: addresses(q.address, wanted, regType), mode: wanted, auto: false };
    }
    const d = detect(q.address, regType);
    if (!d) {
        return { a: null, mode: 'auto', auto: true };
    }
    if ('ambiguous' in d) {
        if (d.ambiguous.length === 1) {
            return { a: addresses(q.address, d.ambiguous[0], regType), mode: d.ambiguous[0], auto: true };
        }
        return { a: null, mode: 'auto', auto: true, ambiguous: d.ambiguous };
    }
    return { a: addresses(q.address, d.mode, regType), mode: d.mode, auto: true };
}

/**
 * Finds the configured or template row that covers a protocol address.
 *
 * @param {Record<string, any>|undefined} rows Configuration with inputRegs / holdingRegs
 * @param {'inputRegs'|'holdingRegs'} regType Register type
 * @param {number} unit Modbus unit
 * @param {number} protocol Protocol address
 * @returns {{name: string, description: string, column: number, part: number, enabled: boolean}|null} Row
 */
function knownAt(rows, regType, unit, protocol) {
    const list = rows && Array.isArray(rows[regType]) ? rows[regType] : [];
    for (const r of list) {
        if (!r || (parseInt(r.deviceId, 10) || 1) !== unit) {
            continue;
        }
        const covered = span(r, regType);
        const i = covered.indexOf(protocol);
        if (i >= 0) {
            return {
                name: String(r.name || '').trim(),
                description: String(r.description || '').trim(),
                column: parseInt(r._address, 10),
                part: i,
                enabled: r.enabled !== false,
            };
        }
    }
    return null;
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
 * @param {Record<string, any>|null} k Known row
 * @param {Record<string, string>} t Texts
 * @returns {string} "Battery level (Battery level (SoC))" or the text for unknown
 */
function knownText(k, t) {
    if (!k) {
        return t.unknown;
    }
    const label = k.description && k.description !== k.name ? `${k.name} – ${k.description}` : k.name;
    return `${label}${k.part ? ` (${fmt(t.part, k.part + 1, k.column)})` : ''}${k.enabled ? '' : ` [${t.notTicked}]`}`;
}

/**
 * Lines of the address block: all notations, the register known at this address and the neighbours that an
 * off-by-one mix-up (counting from 0 vs. from 1) would hit.
 *
 * @param {Record<string, any>} q Helper input
 * @param {ReturnType<typeof resolve>} r Resolved address
 * @param {number} unit Modbus unit
 * @param {Record<string, any>|undefined} rows Register tables
 * @param {Record<string, any>} t Texts
 * @returns {string[]} Lines
 */
function addressLines(q, r, unit, rows, t) {
    const lines = [];
    const regType = q.regType === 'holdingRegs' ? 'holdingRegs' : 'inputRegs';
    if (r.ambiguous) {
        lines.push(fmt(t.ambiguous, parseAddress(q.address)));
        for (const mode of r.ambiguous) {
            const c = addresses(q.address, mode, regType);
            if (!c) {
                continue;
            }
            const k = rows ? knownAt(rows, c.regType, unit, c.protocol) : null;
            lines.push(
                `  ${t.asMode[mode]}: ${t.short.protocol} ${c.protocol}, ${t.short.column} ${c.column}${rows ? ` → ${knownText(k, t)}` : ''}`,
            );
        }
        lines.push(`  ${t.ambiguousHint}`);
        return lines;
    }
    const a = r.a;
    if (!a) {
        lines.push(`${t.addr}:`);
        lines.push(`  ${t.badAddr}`);
        return lines;
    }
    lines.push(
        `${t.addr} – ${t.regTypes[a.regType]}, FC${a.fc} ${a.fc === 4 ? 'Read Input Registers' : 'Read Holding Registers'}:`,
    );
    if (r.auto) {
        lines.push(`  ${fmt(t.detected, t.names[r.mode])}`);
    }
    const mark = (/** @type {string} */ m) => (m === r.mode ? '→' : ' ');
    lines.push(`  ${mark('doc')} ${t.names.doc}: ${a.doc}`);
    lines.push(`      ${t.usedBy.doc}`);
    lines.push(
        `  ${mark('protocol')} ${t.names.protocol}: ${a.protocol} (0x${a.protocol.toString(16).toUpperCase().padStart(4, '0')})`,
    );
    lines.push(`      ${t.usedBy.protocol}`);
    lines.push(
        `      Home Assistant (mkaiser): address: ${a.protocol}  # reg ${a.doc}, input_type: ${a.regType === 'inputRegs' ? 'input' : 'holding'}`,
    );
    lines.push(`  ${mark('column')} ${t.names.column}: ${a.column} (= ${OFFSETS[a.regType]} + ${a.protocol})`);
    lines.push(`  ${mark('modicon')} ${t.names.modicon}: ${a.modicon}`);
    const prefix = a.regType === 'inputRegs' ? 'inputRegisters' : 'holdingRegisters';
    const k = rows ? knownAt(rows, a.regType, unit, a.protocol) : null;
    // without a name of its own the ID uses the name of the row that starts at this address
    const name = String(q.name || '').trim() || (k && !k.part ? k.name : '');
    lines.push(`  ${t.stateId}: ${prefix}.${unit}.${a.column}${name ? `_${idName(name)}` : '_…'}`);
    if (rows) {
        lines.push(`  ${t.known}: ${knownText(k, t)}`);
        const near = [];
        for (const d of [-1, 1]) {
            const n = knownAt(rows, a.regType, unit, a.protocol + d);
            if (n && (!k || n.column !== k.column)) {
                near.push(
                    `${t.short.protocol} ${a.protocol + d} / ${t.short.column} ${a.column + d} = ${knownText(n, t)}`,
                );
            }
        }
        if (near.length) {
            lines.push(`  ${t.neighbours}:`);
            near.forEach(n => lines.push(`    ${n}`));
        }
    }
    return lines;
}

/**
 * Explains one register: addresses, the decoded value, other interpretations and warnings.
 *
 * @param {Record<string, any>} q Input of the admin form
 * @param {{words?: number[], ms?: number, error?: string}} [device] Result of a device read
 * @param {string} [lang] Language (de or en)
 * @param {Record<string, any>} [rows] Register tables (inputRegs / holdingRegs) to name known registers
 * @returns {{text: string, lines: string[], value?: number|string, warnings: string[]}} Explanation
 */
function explain(q, device, lang = 'en', rows = undefined) {
    const t = TXT[lang] || TXT.en;
    const L = TXT[lang] ? lang : 'en';
    const type = TYPES.includes(q.type) ? q.type : 'uint16be';
    const factor = num(q.factor, 1) || 1;
    const offset = num(q.offset, 0);
    const unitText = String(q.unitText || '').trim();
    const unit = parseInt(q.deviceId, 10) || 1;
    const lines = [];
    const warnings = [];

    const r = resolve(q);
    const a = r.a;
    lines.push(...addressLines(q, r, unit, rows, t));

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
            `${t.rowHint} (${t.regTypes[a.regType]}): ${a.column} | unit ${unit} | ${type}${STRING_TYPES.includes(type) ? ` | len ${words.length || 1}` : ''} | factor ${show(factor, 'en')} | offset ${show(offset, 'en')}${unitText ? ` | ${unitText}` : ''}`,
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

module.exports = {
    parseWords,
    parseAddress,
    addresses,
    detect,
    resolve,
    knownAt,
    rawValue,
    explain,
    implausible,
    RANGES,
    NOTATIONS,
};
