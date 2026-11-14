'use strict';

/*
 * Safe battery control (0.6.0, experimental, OFF by default).
 *
 * Three modes instead of single register commands:
 *   normal - self-consumption: forced-charging window off, battery command "stop", EMS mode 0
 *   hold   - keep the level: EMS forced mode (2) with the command "stop" - the battery neither charges nor
 *            discharges
 *   charge - forced-charging window of the inverter (33208 ff.) from now for N minutes up to a target level;
 *            the inverter ends the window by itself, no repeated commands
 * Every mode other than normal has a time limit; when it runs out (also after an adapter restart), the
 * control returns to normal. Changes are limited (minimum pause, maximum per day) and nothing is written
 * while the instance is read-only or the feature is off.
 *
 * The registers are written through the normal write path of the poller (write before the next read,
 * confirmation read). They do not have to be ticked in the register tables.
 */

const { normalise } = require('./registers');

/** Holding registers used by the control (alias notation 40001 + protocol address, unit 1) */
const ROWS = [
    { _address: 53050, name: 'EMS mode selection' },
    { _address: 53051, name: 'Charge/discharge command' },
    { _address: 73208, name: 'Forced charging' },
    { _address: 73209, name: 'Forced charging valid days' },
    { _address: 73210, name: 'Forced charging 1 start hour' },
    { _address: 73211, name: 'Forced charging 1 start minute' },
    { _address: 73212, name: 'Forced charging 1 end hour' },
    { _address: 73213, name: 'Forced charging 1 end minute' },
    { _address: 73214, name: 'Forced charging target' },
];

const EMS_SELF = 0;
const EMS_FORCED = 2;
const CMD_STOP = 0xcc;
const ON = 0xaa;
const OFF = 0x55;

const MODES = ['normal', 'hold', 'charge'];

/**
 * @returns {Record<number, import('./registers').Reg>} Register per alias address
 */
function controlRegs() {
    const { regs } = normalise(
        'holdingRegs',
        ROWS.map(r => ({
            ...r,
            deviceId: 1,
            type: 'uint16be',
            factor: 1,
            poll: false,
            allowWrite: true,
            group: 'control',
        })),
    );
    /** @type {Record<number, any>} */
    const out = {};
    for (const r of regs) {
        out[r.alias] = r;
    }
    return out;
}

/**
 * Write plan of a mode: register alias -> value, in this order.
 *
 * @param {'normal'|'hold'|'charge'} mode Mode
 * @param {{start?: Date, minutes?: number, target?: number}} [p] Charge window (charge only)
 * @returns {[number, number][]} [alias, value] in write order
 */
function plan(mode, p = {}) {
    if (mode === 'normal') {
        // window off first (it would start charging again), then stop, then back to self-consumption
        return [
            [73208, OFF],
            [53051, CMD_STOP],
            [53050, EMS_SELF],
        ];
    }
    if (mode === 'hold') {
        return [
            [73208, OFF],
            [53051, CMD_STOP],
            [53050, EMS_FORCED],
        ];
    }
    if (mode === 'charge') {
        const start = p.start || new Date();
        const end = windowEnd(start, p.minutes || 60);
        return [
            // self-consumption with the window of the inverter (the window works in self-consumption mode)
            [53051, CMD_STOP],
            [53050, EMS_SELF],
            [73209, 1], // every day - the window is switched off again by the control
            [73210, start.getHours()],
            [73211, start.getMinutes()],
            [73212, end.getHours()],
            [73213, end.getMinutes()],
            [73214, Math.round(p.target || 100)],
            [73208, ON],
        ];
    }
    throw new Error(`unknown mode ${mode}`);
}

/**
 * End of the charge window: start + minutes, but not past 23:59 of the same day (the window of the inverter
 * is a time of day).
 *
 * @param {Date} start Start
 * @param {number} minutes Duration
 * @returns {Date} End
 */
function windowEnd(start, minutes) {
    const end = new Date(start.getTime() + minutes * 60000);
    const lastMinute = new Date(start);
    lastMinute.setHours(23, 59, 0, 0);
    return end > lastMinute ? lastMinute : end;
}

/**
 * Checks a command. Returns an error text or '' when it may be carried out.
 *
 * @param {{mode: string, minutes?: number, target?: number}} cmd Command
 * @param {{enabled: boolean, readOnly: boolean, maxMinutes: number, minPause: number, maxPerDay: number, lastChange: number, changesToday: number, now: number}} s Settings and counters
 * @returns {string} Reason for the rejection
 */
function check(cmd, s) {
    if (!s.enabled) {
        return 'battery control is switched off in the instance settings (tab "Control")';
    }
    if (s.readOnly) {
        return 'read-only mode is on';
    }
    if (!MODES.includes(cmd.mode)) {
        return `unknown mode "${cmd.mode}" (normal, hold, charge)`;
    }
    if (cmd.mode !== 'normal') {
        const m = Number(cmd.minutes);
        if (!Number.isFinite(m) || m < 1 || m > s.maxMinutes) {
            return `duration ${cmd.minutes} min outside 1 … ${s.maxMinutes} min`;
        }
        if (s.changesToday >= s.maxPerDay) {
            return `already ${s.changesToday} changes today (limit ${s.maxPerDay}) - only "normal" is allowed`;
        }
        if (s.lastChange && s.now - s.lastChange < s.minPause * 1000) {
            return `last change ${Math.round((s.now - s.lastChange) / 1000)} s ago (minimum pause ${s.minPause} s)`;
        }
    }
    if (cmd.mode === 'charge') {
        const t = Number(cmd.target);
        if (!Number.isFinite(t) || t < 10 || t > 100) {
            return `target level ${cmd.target} % outside 10 … 100 %`;
        }
    }
    return '';
}

/** Objects below control.battery */
const STATES = {
    mode: {
        type: 'string',
        role: 'state',
        read: true,
        write: true,
        states: { normal: 'normal', hold: 'hold', charge: 'charge' },
        name: {
            en: 'Battery mode (command)',
            de: 'Akkumodus (Befehl)',
            ru: 'Режим аккумулятора (команда)',
            pt: 'Modo da bateria (comando)',
            nl: 'Batterijmodus (opdracht)',
            fr: 'Mode batterie (commande)',
            it: 'Modalità batteria (comando)',
            es: 'Modo de batería (comando)',
            pl: 'Tryb akumulatora (polecenie)',
            uk: 'Режим акумулятора (команда)',
            'zh-cn': '电池模式（命令）',
        },
    },
    minutes: {
        type: 'number',
        role: 'level',
        unit: 'min',
        min: 1,
        read: true,
        write: true,
        def: 60,
        name: {
            en: 'Duration of the next hold/charge command',
            de: 'Dauer des nächsten Halten-/Laden-Befehls',
            ru: 'Длительность следующей команды удержания/зарядки',
            pt: 'Duração do próximo comando manter/carregar',
            nl: 'Duur van de volgende vasthouden-/laadopdracht',
            fr: 'Durée de la prochaine commande maintien/charge',
            it: 'Durata del prossimo comando mantieni/carica',
            es: 'Duración del próximo comando mantener/cargar',
            pl: 'Czas trwania następnego polecenia utrzymania/ładowania',
            uk: 'Тривалість наступної команди утримання/заряджання',
            'zh-cn': '下一次保持/充电命令的持续时间',
        },
    },
    targetSoc: {
        type: 'number',
        role: 'level',
        unit: '%',
        min: 10,
        max: 100,
        read: true,
        write: true,
        def: 100,
        name: {
            en: 'Target level of the charge command',
            de: 'Zielladestand des Laden-Befehls',
            ru: 'Целевой уровень команды зарядки',
            pt: 'Nível alvo do comando de carga',
            nl: 'Doelniveau van de laadopdracht',
            fr: 'Niveau cible de la commande de charge',
            it: 'Livello obiettivo del comando di carica',
            es: 'Nivel objetivo del comando de carga',
            pl: 'Docelowy poziom polecenia ładowania',
            uk: 'Цільовий рівень команди заряджання',
            'zh-cn': '充电命令的目标电量',
        },
    },
    active: {
        type: 'string',
        role: 'text',
        read: true,
        write: false,
        def: 'normal',
        name: {
            en: 'Battery mode (confirmed)',
            de: 'Akkumodus (bestätigt)',
            ru: 'Режим аккумулятора (подтверждён)',
            pt: 'Modo da bateria (confirmado)',
            nl: 'Batterijmodus (bevestigd)',
            fr: 'Mode batterie (confirmé)',
            it: 'Modalità batteria (confermata)',
            es: 'Modo de batería (confirmado)',
            pl: 'Tryb akumulatora (potwierdzony)',
            uk: 'Режим акумулятора (підтверджено)',
            'zh-cn': '电池模式（已确认）',
        },
    },
    until: {
        type: 'number',
        role: 'date',
        read: true,
        write: false,
        def: 0,
        name: {
            en: 'Back to normal at',
            de: 'Rückkehr zu normal um',
            ru: 'Возврат в обычный режим в',
            pt: 'Regresso ao normal às',
            nl: 'Terug naar normaal om',
            fr: 'Retour au mode normal à',
            it: 'Ritorno al normale alle',
            es: 'Vuelta a normal a las',
            pl: 'Powrót do normalnego o',
            uk: 'Повернення до звичайного о',
            'zh-cn': '恢复正常的时间',
        },
    },
    lastResult: {
        type: 'string',
        role: 'text',
        read: true,
        write: false,
        def: '',
        name: {
            en: 'Result of the last command',
            de: 'Ergebnis des letzten Befehls',
            ru: 'Результат последней команды',
            pt: 'Resultado do último comando',
            nl: 'Resultaat van de laatste opdracht',
            fr: 'Résultat de la dernière commande',
            it: "Risultato dell'ultimo comando",
            es: 'Resultado del último comando',
            pl: 'Wynik ostatniego polecenia',
            uk: 'Результат останньої команди',
            'zh-cn': '上一条命令的结果',
        },
    },
};

/**
 * Runtime part: carries out commands of control.battery.mode through the poller of the adapter, watches the
 * confirmations and returns to normal when the time is up.
 */
class BatteryController {
    /**
     * @param {any} adapter Adapter (setState, getStateAsync, setTimeout, clearTimeout, log, config, poller, background)
     * @param {{now?: () => number}} [opts] Clock (tests)
     */
    constructor(adapter, opts = {}) {
        this.a = adapter;
        this.now = opts.now || Date.now;
        this.regs = controlRegs();
        /** register ID -> expected value of the running command */
        this.pending = new Map();
        this.running = null;
        this.timer = null;
        this.lastChange = 0;
        this.changesToday = 0;
        this.day = new Date(this.now()).toDateString();
        /** mode confirmed last ('normal' after the start until the stored state is read) */
        this.active = 'normal';
        this.until = 0;
        /** return to normal as soon as the connection is up (stored mode expired or feature off) */
        this.fallbackOnConnect = false;
    }

    /** @returns {Record<string, any>} Settings */
    settings() {
        const c = this.a.config || {};
        const n = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d);
        return {
            enabled: c.batteryControl === true,
            readOnly: !!c.readOnly,
            maxMinutes: Math.max(1, n(c.batteryMaxMinutes, 240)),
            minPause: Math.max(0, n(c.batteryMinPause, 60)),
            maxPerDay: Math.max(1, n(c.batteryMaxPerDay, 12)),
        };
    }

    /**
     * Reads the stored mode after a start: an expired hold/charge returns to normal (after the connect), a
     * running one keeps its time limit.
     */
    async restore() {
        const active = await this.a.getStateAsync('control.battery.active');
        const until = await this.a.getStateAsync('control.battery.until');
        this.active = active && MODES.includes(String(active.val)) ? String(active.val) : 'normal';
        this.until = until && typeof until.val === 'number' ? until.val : 0;
        if (this.active === 'normal') {
            return;
        }
        if (!this.settings().enabled || this.until <= this.now()) {
            this.a.log.warn(
                `Battery control: mode "${this.active}" ${this.settings().enabled ? 'ran out while the adapter was stopped' : 'is still active although battery control is switched off'} - back to normal after the connect`,
            );
            this.fallbackOnConnect = true;
        } else {
            this.arm(this.until - this.now());
            this.a.log.info(`Battery control: mode "${this.active}" until ${new Date(this.until).toISOString()}`);
        }
    }

    /** Called on every (re)connect */
    onConnected() {
        if (this.fallbackOnConnect && !this.running) {
            this.fallbackOnConnect = false;
            this.a.background(() => this.run({ mode: 'normal' }, 'time limit'), 'battery control');
        }
    }

    /** @param {number} ms Delay until the return to normal */
    arm(ms) {
        this.disarm();
        this.timer = this.a.setTimeout(
            () => {
                this.timer = null;
                this.a.background(() => this.run({ mode: 'normal' }, 'time limit'), 'battery control');
            },
            Math.max(0, Math.min(ms, 0x7fffffff)),
        );
    }

    /** Cancels the return timer */
    disarm() {
        if (this.timer) {
            this.a.clearTimeout(this.timer);
            this.timer = null;
        }
    }

    /**
     * Command from control.battery.mode.
     *
     * @param {string} mode Requested mode
     */
    async command(mode) {
        const minutes = await this.a.getStateAsync('control.battery.minutes');
        const target = await this.a.getStateAsync('control.battery.targetSoc');
        await this.run({
            mode,
            minutes: minutes && minutes.val !== null ? Number(minutes.val) : 60,
            target: target && target.val !== null ? Number(target.val) : 100,
        });
    }

    /**
     * Checks and carries out a command; the writes go through the poller (confirmation per register).
     *
     * @param {{mode: string, minutes?: number, target?: number}} cmd Command
     * @param {string} [reason] 'time limit' for the automatic return (always allowed while not read-only)
     */
    async run(cmd, reason) {
        const today = new Date(this.now()).toDateString();
        if (today !== this.day) {
            this.day = today;
            this.changesToday = 0;
        }
        const s = this.settings();
        const automatic = reason === 'time limit';
        const problem = automatic
            ? s.readOnly
                ? 'read-only mode is on'
                : ''
            : check(cmd, { ...s, lastChange: this.lastChange, changesToday: this.changesToday, now: this.now() });
        const poller = this.a.poller;
        const error = problem || (!poller || !poller.connected ? 'not connected to the gateway' : '');
        if (error) {
            this.a.log.warn(`Battery control: "${cmd.mode}" rejected - ${error}`);
            await this.result(`${cmd.mode}: rejected - ${error}`);
            // the command state shows the mode that is really active
            await this.a.setState('control.battery.mode', this.active, true);
            if (automatic && error.startsWith('not connected')) {
                this.fallbackOnConnect = true;
            }
            return;
        }
        const start = new Date(this.now());
        const steps = plan(/** @type {any} */ (cmd.mode), { start, minutes: cmd.minutes, target: cmd.target });
        const until =
            cmd.mode === 'normal'
                ? 0
                : cmd.mode === 'charge'
                  ? windowEnd(start, Number(cmd.minutes)).getTime()
                  : start.getTime() + Number(cmd.minutes) * 60000;
        this.pending.clear();
        let sent = 0;
        for (const [alias, value] of steps) {
            const reg = this.regs[alias];
            const fullId = `${this.a.namespace}.${reg.id}`;
            // a ticked register with a recent equal value is not written again (skip unchanged writes)
            const known = this.a.regsById && this.a.regsById.get(fullId);
            if (known && this.a.isUnchangedWrite(known, fullId, value)) {
                continue;
            }
            this.pending.set(reg.id, value);
            poller.write(reg, value);
            sent++;
        }
        this.running = { mode: cmd.mode, until, automatic, failed: [] };
        if (!automatic) {
            this.lastChange = this.now();
            if (cmd.mode !== 'normal') {
                this.changesToday++;
            }
        }
        this.a.log.info(
            `Battery control: ${cmd.mode}${automatic ? ' (time limit)' : ''}${until ? ` until ${new Date(until).toISOString()}` : ''} - ${sent} register(s) written`,
        );
        if (!sent) {
            await this.finish();
        }
    }

    /**
     * Confirmation of a write from the poller (readback / writeFailed).
     *
     * @param {any} reg Register
     * @param {boolean} ok Written and confirmed with the expected value
     * @param {string} [detail] Error or device value
     */
    async onConfirm(reg, ok, detail) {
        if (!this.running || !this.pending.has(reg.id)) {
            return;
        }
        this.pending.delete(reg.id);
        if (!ok) {
            this.running.failed.push(`${reg.id}: ${detail}`);
        }
        if (!this.pending.size) {
            await this.finish();
        }
    }

    /** All writes of the running command are confirmed or failed */
    async finish() {
        const r = this.running;
        this.running = null;
        if (!r) {
            return;
        }
        if (r.failed.length) {
            this.a.log.error(`Battery control: "${r.mode}" not completely written: ${r.failed.join('; ')}`);
            await this.result(`${r.mode}: failed - ${r.failed.join('; ')}`);
            if (r.mode !== 'normal') {
                // half a mode is worse than none: back to normal
                this.a.log.warn('Battery control: back to normal');
                await this.run({ mode: 'normal' }, 'time limit');
            } else {
                this.fallbackOnConnect = true;
            }
            return;
        }
        this.active = r.mode;
        this.until = r.until;
        if (r.mode === 'normal') {
            this.disarm();
        } else {
            this.arm(r.until - this.now());
        }
        await this.a.setState('control.battery.active', r.mode, true);
        await this.a.setState('control.battery.until', r.until, true);
        await this.a.setState('control.battery.mode', r.mode, true);
        await this.result(`${r.mode}: ok${r.automatic ? ' (time limit)' : ''}`);
    }

    /** @param {string} text Result text */
    async result(text) {
        await this.a.setState('control.battery.lastResult', `${new Date(this.now()).toISOString()} ${text}`, true);
    }

    /** Adapter stops: no more timers (the stored "until" brings the return to normal after the next start) */
    stop() {
        this.disarm();
    }
}

module.exports = {
    ROWS,
    MODES,
    STATES,
    controlRegs,
    plan,
    windowEnd,
    check,
    BatteryController,
    EMS_SELF,
    EMS_FORCED,
    CMD_STOP,
    ON,
    OFF,
};
