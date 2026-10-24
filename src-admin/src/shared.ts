/*
 * Shared helpers of the sungrow-local admin components: types, translations, register metadata and the
 * bus load model (the SAME code the adapter uses - lib/load.js, lib/registers.js, lib/convert.js).
 */
import React from 'react';
import { I18n } from '@iobroker/gui-components';
import type { ConfigGenericProps } from '@iobroker/json-config';

import loadLib from '../../lib/load.js';
import registersLib from '../../lib/registers.js';
import convertLib from '../../lib/convert.js';
import META_JSON from '../../lib/catalog-meta.json';

export const { analyse, requestDelta, DEFAULT_CAPACITY } = loadLib;
export const { stateId, TYPES, STRING_TYPES, TYPE_LEN, OFFSETS, parseStates } = registersLib;
export const convert = convertLib;

export type RegType = 'inputRegs' | 'holdingRegs';
export type Level = 'ok' | 'warn' | 'over';

export interface Row {
    _address: number | string;
    deviceId?: number | string;
    name?: string;
    description?: string;
    unit?: string;
    type?: string;
    len?: number | string;
    factor?: number | string;
    offset?: number | string;
    role?: string;
    states?: string;
    room?: string;
    group?: string;
    enabled?: boolean;
    poll?: boolean;
    allowWrite?: boolean;
    min?: number | string;
    max?: number | string;
    source?: string;
    note?: string;
    [k: string]: unknown;
}

export interface Group {
    name: string;
    enabled?: boolean;
    interval: number | string;
    timeout?: number | string;
    pauseAfter?: number | string;
    description?: string;
}

export interface Native {
    host?: string;
    port?: number | string;
    groups: Group[];
    inputRegs: Row[];
    holdingRegs: Row[];
    busCapacity?: number | string;
    overviewTiles?: string[];
    readOnly?: boolean;
    writeCheck?: string;
    [k: string]: unknown;
}

export interface MetaEntry {
    doc?: number;
    theme?: string;
    profile?: string;
    name?: Record<string, string>;
    desc?: Record<string, string>;
    descDefault?: string;
    descOld?: string[];
    /** key of the same quantity from the other source (inverter / battery) */
    pair?: string;
    /** read test on reference devices: model -> 'ok' | 'exception' */
    tested?: Record<string, string>;
}

const META = META_JSON as unknown as { version: number; registers: Record<string, MetaEntry> };

export const THEMES = ['pv', 'battery', 'grid', 'inverter', 'control', 'info', 'custom'] as const;
export type Theme = (typeof THEMES)[number];

export const GROUP_COLORS: Record<string, string> = {
    live: '#2e7dd7',
    energie: '#7b5cd6',
    steuerung: '#d9822b',
    akku: '#2a9d8f',
    info: '#7a8796',
};
const EXTRA_COLORS = ['#c2185b', '#5d8a00', '#00838f', '#8d6e63', '#3949ab'];

/** Color of a poll group (fixed for the defaults, stable for own groups) */
export function groupColor(name: string, index = 0): string {
    return GROUP_COLORS[name] || EXTRA_COLORS[index % EXTRA_COLORS.length];
}

export const LEVEL_COLORS: Record<Level, string> = { ok: '#2e9d57', warn: '#e0a100', over: '#d64545' };

/** Translation with the prefix of this adapter (keys in admin/custom/i18n) */
export function t(key: string, ...args: (string | number)[]): string {
    const k = `sgl_${key}`;
    let s = I18n.t(k, ...(args as string[]));
    if (s === k) {
        s = key;
        for (const a of args) {
            s = s.replace('%s', String(a));
        }
    }
    return s;
}

export function lang(): string {
    return I18n.getLanguage() || 'en';
}

export function num(v: unknown, def: number): number {
    if (typeof v === 'number') {
        return Number.isFinite(v) ? v : def;
    }
    if (typeof v === 'string' && v.trim() !== '') {
        const n = parseFloat(v.replace(',', '.'));
        return Number.isFinite(n) ? n : def;
    }
    return def;
}

export function unitOf(row: Row): number {
    const u = parseInt(String(row.deviceId), 10);
    return Number.isInteger(u) ? u : 1;
}

export function aliasOf(row: Row): number {
    return parseInt(String(row._address), 10);
}

/** Sungrow document number (counts from 1) of a row: column address minus 30000 / 40000 */
export function docOf(regType: RegType, row: Row): number {
    return aliasOf(row) - (regType === 'inputRegs' ? 30000 : 40000);
}

export function rowKey(regType: RegType, row: Row): string {
    return `${regType}:${unitOf(row)}:${aliasOf(row)}`;
}

export function metaOf(regType: RegType, row: Row): MetaEntry | undefined {
    return META.registers[rowKey(regType, row)];
}

export function metaByKey(key: string): MetaEntry | undefined {
    return META.registers[key];
}

/** Display name: the uniform translated catalog name; rows without catalog data: description or name column */
export function rowLabel(regType: RegType, row: Row): string {
    const m = metaOf(regType, row);
    const l = lang();
    const d = String(row.description || '').trim();
    return m?.name?.[l] || m?.name?.en || d || String(row.name || '');
}

/** Own description of a catalog row when it differs from the catalog name (shown as a second line) */
export function ownDescription(regType: RegType, row: Row): string {
    const m = metaOf(regType, row);
    const d = String(row.description || '').trim();
    if (!m || !d) {
        return '';
    }
    const defaults = [m.descDefault, m.name?.en, m.name?.[lang()], ...(m.descOld || [])];
    return defaults.includes(d) ? '' : d;
}

/** Sort key that puts the two sources of the same quantity (inverter / battery) next to each other */
export function pairSortKey(regType: RegType, row: Row): string {
    const k = rowKey(regType, row);
    const m = metaOf(regType, row);
    const base = m?.pair && m.pair < k ? m.pair : k;
    const [t, u, a] = base.split(':');
    return `${t}:${a.padStart(6, '0')}:${u}|${k}`;
}

export function rowDescription(regType: RegType, row: Row): string {
    const m = metaOf(regType, row);
    const l = lang();
    return m?.desc?.[l] || m?.desc?.en || '';
}

/** Value table of a row: translated template texts while the states column is unchanged, otherwise the own texts */
export function stateTexts(regType: RegType, row: Row): Record<string, string> | undefined {
    const m = metaOf(regType, row) as
        (MetaEntry & { states?: Record<string, Record<string, string>>; statesDefault?: string }) | undefined;
    const own = String(row.states || '').trim();
    if (m?.states && (!own || own === m.statesDefault)) {
        const l = lang();
        return Object.fromEntries(Object.entries(m.states).map(([k, tx]) => [k, tx[l] || tx.en]));
    }
    return parseStates(own) || undefined;
}

/** Short explanation of one value of a value table (template only) */
export function stateHelp(regType: RegType, row: Row, value: string): string {
    const m = metaOf(regType, row) as (MetaEntry & { statesHelp?: Record<string, Record<string, string>> }) | undefined;
    const h = m?.statesHelp?.[value];
    return h ? h[lang()] || h.en : '';
}

export function themeOf(regType: RegType, row: Row): Theme {
    const m = metaOf(regType, row);
    if (m?.theme && (THEMES as readonly string[]).includes(m.theme)) {
        return m.theme as Theme;
    }
    return 'custom';
}

/** State ID below the namespace (same function as the adapter) */
export function rowStateId(regType: RegType, row: Row): string {
    return stateId(
        regType,
        unitOf(row),
        aliasOf(row),
        row.name === undefined || row.name === null ? '' : String(row.name),
    );
}

export interface RowRef {
    regType: RegType;
    index: number;
    row: Row;
    key: string;
}

export function allRows(data: Native): RowRef[] {
    const out: RowRef[] = [];
    for (const regType of ['inputRegs', 'holdingRegs'] as RegType[]) {
        (Array.isArray(data[regType]) ? data[regType] : []).forEach((row, index) => {
            if (row) {
                out.push({ regType, index, row, key: `${rowKey(regType, row)}#${index}` });
            }
        });
    }
    return out;
}

/** Is the row read cyclically (ticked and - for holding registers - "poll")? */
export function isActive(ref: RowRef): boolean {
    if (ref.row.enabled === false) {
        return false;
    }
    return ref.regType === 'inputRegs' || ref.row.poll === true || String(ref.row.poll) === 'true';
}

/** Deep copy of the configuration (the admin compares by value) */
export function clone<T>(o: T): T {
    return JSON.parse(JSON.stringify(o)) as T;
}

/** Text of one "why is this a request of its own" reason */
export function reasonText(regType: RegType, b: Record<string, any>): string {
    const off = regType === 'inputRegs' ? 30000 : 40000;
    const r = b.reason || {};
    const doc = b.firstAlias - off;
    switch (r.kind) {
        case 'gap':
            return t('reasonGap', doc, r.gap, r.prevAlias - off, r.maxGap);
        case 'size':
            return t('reasonSize', doc, r.maxBlock);
        case 'unit':
            return t('reasonUnit', b.unit);
        case 'type':
            return t('reasonType');
        default:
            return t('reasonBase');
    }
}

export function levelOf(load: number): Level {
    if (load > 1.000000001) {
        return 'over';
    }
    if (load >= 0.8) {
        return 'warn';
    }
    return 'ok';
}

export function fmt(n: number, digits = 2): string {
    return n.toLocaleString(lang() === 'en' ? 'en-US' : lang(), {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    });
}

/** sendTo with a timeout (a stopped instance never answers) */
export function sendTo<T = any>(
    props: ConfigGenericProps,
    command: string,
    message: unknown,
    timeoutMs = 25000,
): Promise<T> {
    const target = `${props.oContext.adapterName}.${props.oContext.instance}`;
    return Promise.race([
        props.oContext.socket.sendTo(target, command, message) as Promise<T>,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(t('noAnswer'))), timeoutMs)),
    ]);
}

/** Polls states of the instance (live data of the components) */
export function useStates(props: ConfigGenericProps, ids: string[], everyMs = 4000): Record<string, ioBroker.State> {
    const [states, setStates] = React.useState<Record<string, ioBroker.State>>({});
    const key = ids.join('|');
    React.useEffect(() => {
        let stop = false;
        const prefix = `${props.oContext.adapterName}.${props.oContext.instance}.`;
        const full = ids.map(id => prefix + id);
        const poll = async (): Promise<void> => {
            if (!full.length) {
                return;
            }
            try {
                const res = await props.oContext.socket.getForeignStates(full);
                if (!stop) {
                    const out: Record<string, ioBroker.State> = {};
                    for (const [id, st] of Object.entries(res || {})) {
                        if (st) {
                            out[id.substring(prefix.length)] = st;
                        }
                    }
                    setStates(out);
                }
            } catch {
                // keep the last values
            }
        };
        void poll();
        const h = setInterval(() => void poll(), everyMs);
        return () => {
            stop = true;
            clearInterval(h);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [key, props.oContext.instance]);
    return states;
}

/** Age text "vor 3 s" */
export function ago(ts: number | undefined): string {
    if (!ts) {
        return '–';
    }
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 90) {
        return t('agoS', s);
    }
    if (s < 5400) {
        return t('agoM', Math.round(s / 60));
    }
    return t('agoH', Math.round(s / 3600));
}

/** Analysis of a configuration with the measured round durations of the running instance */
export function analyseNative(data: Native, measured?: Record<string, number>): any {
    return analyse(data as any, { measured });
}

/** English descriptions of the default groups (io-package) - shown translated as long as they are unchanged */
const DEFAULT_GROUP_DESC: Record<string, string> = {
    live: 'Powers, voltages, state (inverter)',
    energie: 'Counters and daily values (inverter)',
    steuerung: 'Holding registers (control)',
    akku: 'SBH400 battery (unit 2) - 5 s instruction interval in the WiNet',
    info: 'Device information and rarely changing settings',
};

export function groupDescription(g: { name: string; description?: string }): string {
    const d = String(g.description || '');
    return DEFAULT_GROUP_DESC[g.name] === d ? t(`groupDesc_${g.name}`) : d;
}
