'use strict';

/*
 * Device manager (@iobroker/dm-utils): cards for the running operation only.
 *
 * - "Inverter": connection, PV power, backup output, AC output, house consumption, inside temperature,
 *   PV yield today and total, time of the last values, fault indicator (43052).
 * - "Battery" (only if a battery register is configured): state of charge, power with direction, voltage,
 *   health, temperature and - only shown, never written - backup reserve, min/max SoC and EMS mode, if they
 *   are polled; manufacturer and model from the BMS (40721 + capacity 43039).
 * - "Grid meter" (only if 35601 is configured): power with import/export, import and feed-in today and total.
 *
 * No actions and no controls that write: writes over the WiNet-S2 often fail because of the bus timing, and
 * configuration (address, Modbus, registers) stays in the instance settings. The cards only read states that
 * the adapter writes anyway; no state or object is created.
 *
 * The values are formatted here (getStateHandler of every "info" control): the card subscribes to the state
 * given as stateId and asks the adapter for the text on every change. Words are in the system language.
 * The admin shows these info controls only in the control dialog. The main values are therefore also shown
 * directly on the card (customInfo with read-only "state" items, 0.5.0): inverter PV power, PV yield today and
 * total, backup output; battery power and voltage (the state of charge is the battery status of the card,
 * manufacturer/model from the BMS); grid power, import and feed-in today and total - plus a live direction indicator (battery charging /
 * discharging, grid import / feed-in) from the sign of the registers.
 */

const { DeviceManagement } = require('@iobroker/dm-utils');
const { energyFlow } = require('./flow');

/** @typedef {'en'|'de'|'ru'|'pt'|'nl'|'fr'|'it'|'es'|'pl'|'uk'|'zh-cn'} Lang */
/** @typedef {Record<Lang, string>} Translated */

/** Texts of the cards (labels are sent translated, words inside values are taken in the system language) */
/** @type {Record<string, Translated>} */
const TXT = {
    inverter: {
        en: 'Inverter',
        de: 'Wechselrichter',
        ru: 'Инвертор',
        pt: 'Inversor',
        nl: 'Omvormer',
        fr: 'Onduleur',
        it: 'Inverter',
        es: 'Inversor',
        pl: 'Falownik',
        uk: 'Інвертор',
        'zh-cn': '逆变器',
    },
    battery: {
        en: 'Battery',
        de: 'Batterie',
        ru: 'Аккумулятор',
        pt: 'Bateria',
        nl: 'Accu',
        fr: 'Batterie',
        it: 'Batteria',
        es: 'Batería',
        pl: 'Akumulator',
        uk: 'Акумулятор',
        'zh-cn': '电池',
    },
    meter: {
        en: 'Grid meter',
        de: 'Netzzähler',
        ru: 'Сетевой счётчик',
        pt: 'Contador da rede',
        nl: 'Netmeter',
        fr: 'Compteur réseau',
        it: 'Contatore di rete',
        es: 'Contador de red',
        pl: 'Licznik sieciowy',
        uk: 'Мережевий лічильник',
        'zh-cn': '电网电表',
    },
    state: {
        en: 'Operating state',
        de: 'Betriebszustand',
        ru: 'Рабочее состояние',
        pt: 'Estado de funcionamento',
        nl: 'Bedrijfstoestand',
        fr: 'État de fonctionnement',
        it: 'Stato di funzionamento',
        es: 'Estado de funcionamiento',
        pl: 'Stan pracy',
        uk: 'Робочий стан',
        'zh-cn': '运行状态',
    },
    pv: {
        en: 'PV power',
        de: 'PV-Leistung',
        ru: 'Мощность PV',
        pt: 'Potência FV',
        nl: 'PV-vermogen',
        fr: 'Puissance PV',
        it: 'Potenza FV',
        es: 'Potencia FV',
        pl: 'Moc PV',
        uk: 'Потужність PV',
        'zh-cn': '光伏功率',
    },
    ac: {
        en: 'AC output',
        de: 'AC-Ausgang',
        ru: 'Выход AC',
        pt: 'Saída CA',
        nl: 'AC-uitgang',
        fr: 'Sortie CA',
        it: 'Uscita CA',
        es: 'Salida CA',
        pl: 'Wyjście AC',
        uk: 'Вихід AC',
        'zh-cn': '交流输出',
    },
    house: {
        en: 'House consumption',
        de: 'Hausverbrauch',
        ru: 'Потребление дома',
        pt: 'Consumo da casa',
        nl: 'Huisverbruik',
        fr: 'Consommation de la maison',
        it: 'Consumo della casa',
        es: 'Consumo de la casa',
        pl: 'Zużycie domu',
        uk: 'Споживання будинку',
        'zh-cn': '家庭用电',
    },
    temp: {
        en: 'Inside temperature',
        de: 'Innentemperatur',
        ru: 'Внутренняя температура',
        pt: 'Temperatura interna',
        nl: 'Binnentemperatuur',
        fr: 'Température intérieure',
        it: 'Temperatura interna',
        es: 'Temperatura interior',
        pl: 'Temperatura wewnętrzna',
        uk: 'Внутрішня температура',
        'zh-cn': '内部温度',
    },
    pvToday: {
        en: 'PV yield today',
        de: 'PV-Ertrag heute',
        ru: 'Выработка PV сегодня',
        pt: 'Produção FV hoje',
        nl: 'PV-opbrengst vandaag',
        fr: 'Production PV du jour',
        it: 'Produzione FV oggi',
        es: 'Producción FV hoy',
        pl: 'Uzysk PV dziś',
        uk: 'Виробіток PV сьогодні',
        'zh-cn': '今日光伏发电量',
    },
    lastValues: {
        en: 'Last values',
        de: 'Letzte Werte',
        ru: 'Последние значения',
        pt: 'Últimos valores',
        nl: 'Laatste waarden',
        fr: 'Dernières valeurs',
        it: 'Ultimi valori',
        es: 'Últimos valores',
        pl: 'Ostatnie wartości',
        uk: 'Останні значення',
        'zh-cn': '最新数值',
    },
    soc: {
        en: 'State of charge',
        de: 'Ladezustand',
        ru: 'Уровень заряда',
        pt: 'Estado de carga',
        nl: 'Laadtoestand',
        fr: 'État de charge',
        it: 'Stato di carica',
        es: 'Estado de carga',
        pl: 'Stan naładowania',
        uk: 'Рівень заряду',
        'zh-cn': '荷电状态',
    },
    battPower: {
        en: 'Power',
        de: 'Leistung',
        ru: 'Мощность',
        pt: 'Potência',
        nl: 'Vermogen',
        fr: 'Puissance',
        it: 'Potenza',
        es: 'Potencia',
        pl: 'Moc',
        uk: 'Потужність',
        'zh-cn': '功率',
    },
    soh: {
        en: 'Health (SoH)',
        de: 'Gesundheit (SoH)',
        ru: 'Состояние (SoH)',
        pt: 'Saúde (SoH)',
        nl: 'Gezondheid (SoH)',
        fr: 'Santé (SoH)',
        it: 'Salute (SoH)',
        es: 'Salud (SoH)',
        pl: 'Kondycja (SoH)',
        uk: 'Стан (SoH)',
        'zh-cn': '健康度 (SoH)',
    },
    battTemp: {
        en: 'Temperature',
        de: 'Temperatur',
        ru: 'Температура',
        pt: 'Temperatura',
        nl: 'Temperatuur',
        fr: 'Température',
        it: 'Temperatura',
        es: 'Temperatura',
        pl: 'Temperatura',
        uk: 'Температура',
        'zh-cn': '温度',
    },
    reserve: {
        en: 'Backup reserve',
        de: 'Notstromreserve',
        ru: 'Резерв для резервного питания',
        pt: 'Reserva de backup',
        nl: 'Noodstroomreserve',
        fr: 'Réserve de secours',
        it: 'Riserva di backup',
        es: 'Reserva de respaldo',
        pl: 'Rezerwa awaryjna',
        uk: 'Резерв резервного живлення',
        'zh-cn': '备用电源预留',
    },
    minSoc: {
        en: 'Min. SoC',
        de: 'Min. SoC',
        ru: 'Мин. SoC',
        pt: 'SoC mín.',
        nl: 'Min. SoC',
        fr: 'SoC min.',
        it: 'SoC min.',
        es: 'SoC mín.',
        pl: 'Min. SoC',
        uk: 'Мін. SoC',
        'zh-cn': '最低 SoC',
    },
    maxSoc: {
        en: 'Max. SoC',
        de: 'Max. SoC',
        ru: 'Макс. SoC',
        pt: 'SoC máx.',
        nl: 'Max. SoC',
        fr: 'SoC max.',
        it: 'SoC max.',
        es: 'SoC máx.',
        pl: 'Maks. SoC',
        uk: 'Макс. SoC',
        'zh-cn': '最高 SoC',
    },
    emsMode: {
        en: 'EMS mode',
        de: 'EMS-Modus',
        ru: 'Режим EMS',
        pt: 'Modo EMS',
        nl: 'EMS-modus',
        fr: 'Mode EMS',
        it: 'Modalità EMS',
        es: 'Modo EMS',
        pl: 'Tryb EMS',
        uk: 'Режим EMS',
        'zh-cn': 'EMS 模式',
    },
    grid: {
        en: 'Grid',
        de: 'Netz',
        ru: 'Сеть',
        pt: 'Rede',
        nl: 'Net',
        fr: 'Réseau',
        it: 'Rete',
        es: 'Red',
        pl: 'Sieć',
        uk: 'Мережа',
        'zh-cn': '电网',
    },
    importToday: {
        en: 'Import today',
        de: 'Bezug heute',
        ru: 'Потребление из сети сегодня',
        pt: 'Consumo da rede hoje',
        nl: 'Afname vandaag',
        fr: 'Soutirage du jour',
        it: 'Prelievo oggi',
        es: 'Consumo de red hoy',
        pl: 'Pobór dziś',
        uk: 'Споживання з мережі сьогодні',
        'zh-cn': '今日购电',
    },
    exportToday: {
        en: 'Feed-in today',
        de: 'Einspeisung heute',
        ru: 'Отдача в сеть сегодня',
        pt: 'Injeção hoje',
        nl: 'Teruglevering vandaag',
        fr: 'Injection du jour',
        it: 'Immissione oggi',
        es: 'Inyección hoy',
        pl: 'Oddanie dziś',
        uk: 'Віддача в мережу сьогодні',
        'zh-cn': '今日上网电量',
    },
    noFault: {
        en: 'No fault reported',
        de: 'Kein Fehler gemeldet',
        ru: 'Неисправностей нет',
        pt: 'Nenhuma falha comunicada',
        nl: 'Geen storing gemeld',
        fr: 'Aucun défaut signalé',
        it: 'Nessun guasto segnalato',
        es: 'Ningún fallo notificado',
        pl: 'Brak zgłoszonych usterek',
        uk: 'Несправностей немає',
        'zh-cn': '未报告故障',
    },
    fault: {
        en: 'Fault reported (grid-side fault code ≠ 0)',
        de: 'Fehler gemeldet (netzseitiger Fehlercode ≠ 0)',
        ru: 'Сообщение о неисправности (код ошибки сети ≠ 0)',
        pt: 'Falha comunicada (código de falha da rede ≠ 0)',
        nl: 'Storing gemeld (netzijdige foutcode ≠ 0)',
        fr: 'Défaut signalé (code de défaut côté réseau ≠ 0)',
        it: 'Guasto segnalato (codice guasto lato rete ≠ 0)',
        es: 'Fallo notificado (código de fallo de red ≠ 0)',
        pl: 'Zgłoszona usterka (kod usterki sieci ≠ 0)',
        uk: 'Повідомлено про несправність (код помилки мережі ≠ 0)',
        'zh-cn': '已报告故障（电网侧故障码 ≠ 0）',
    },
    faultLabel: {
        en: 'Fault',
        de: 'Fehler',
        ru: 'Неисправность',
        pt: 'Falha',
        nl: 'Storing',
        fr: 'Défaut',
        it: 'Guasto',
        es: 'Fallo',
        pl: 'Usterka',
        uk: 'Несправність',
        'zh-cn': '故障',
    },
    pvTotal: {
        en: 'PV yield total',
        de: 'PV-Ertrag gesamt',
        ru: 'Выработка PV всего',
        pt: 'Produção FV total',
        nl: 'PV-opbrengst totaal',
        fr: 'Production PV totale',
        it: 'Produzione FV totale',
        es: 'Producción FV total',
        pl: 'Uzysk PV łącznie',
        uk: 'Виробіток PV загалом',
        'zh-cn': '光伏累计发电量',
    },
    backup: {
        en: 'Backup output',
        de: 'Backup-Ausgang',
        ru: 'Резервный выход',
        pt: 'Saída de backup',
        nl: 'Back-up-uitgang',
        fr: 'Sortie de secours',
        it: 'Uscita di backup',
        es: 'Salida de respaldo',
        pl: 'Wyjście awaryjne',
        uk: 'Резервний вихід',
        'zh-cn': '备用输出',
    },
    battVoltage: {
        en: 'Voltage',
        de: 'Spannung',
        ru: 'Напряжение',
        pt: 'Tensão',
        nl: 'Spanning',
        fr: 'Tension',
        it: 'Tensione',
        es: 'Tensión',
        pl: 'Napięcie',
        uk: 'Напруга',
        'zh-cn': '电压',
    },
    importTotal: {
        en: 'Import total',
        de: 'Bezug gesamt',
        ru: 'Потребление из сети всего',
        pt: 'Consumo da rede total',
        nl: 'Afname totaal',
        fr: 'Soutirage total',
        it: 'Prelievo totale',
        es: 'Consumo de red total',
        pl: 'Pobór łącznie',
        uk: 'Споживання з мережі загалом',
        'zh-cn': '累计购电',
    },
    exportTotal: {
        en: 'Feed-in total',
        de: 'Einspeisung gesamt',
        ru: 'Отдача в сеть всего',
        pt: 'Injeção total',
        nl: 'Teruglevering totaal',
        fr: 'Injection totale',
        it: 'Immissione totale',
        es: 'Inyección total',
        pl: 'Oddanie łącznie',
        uk: 'Віддача в мережу загалом',
        'zh-cn': '累计上网电量',
    },
    battPowerSigned: {
        en: 'Power (+ discharging / − charging)',
        de: 'Leistung (+ Entladen / − Laden)',
        ru: 'Мощность (+ разряд / − заряд)',
        pt: 'Potência (+ descarga / − carga)',
        nl: 'Vermogen (+ ontladen / − laden)',
        fr: 'Puissance (+ décharge / − charge)',
        it: 'Potenza (+ scarica / − carica)',
        es: 'Potencia (+ descarga / − carga)',
        pl: 'Moc (+ rozładowanie / − ładowanie)',
        uk: 'Потужність (+ розряд / − заряд)',
        'zh-cn': '功率（+ 放电 / − 充电）',
    },
    gridSigned: {
        en: 'Grid (+ import / − feed-in)',
        de: 'Netz (+ Bezug / − Einspeisung)',
        ru: 'Сеть (+ потребление / − отдача)',
        pt: 'Rede (+ consumo / − injeção)',
        nl: 'Net (+ afname / − teruglevering)',
        fr: 'Réseau (+ soutirage / − injection)',
        it: 'Rete (+ prelievo / − immissione)',
        es: 'Red (+ consumo / − inyección)',
        pl: 'Sieć (+ pobór / − oddawanie)',
        uk: 'Мережа (+ споживання / − віддача)',
        'zh-cn': '电网（+ 购电 / − 上网）',
    },
    direction: {
        en: 'Direction',
        de: 'Richtung',
        ru: 'Направление',
        pt: 'Sentido',
        nl: 'Richting',
        fr: 'Sens',
        it: 'Direzione',
        es: 'Sentido',
        pl: 'Kierunek',
        uk: 'Напрямок',
        'zh-cn': '方向',
    },
    // words inside values
    import: {
        en: 'import',
        de: 'Bezug',
        ru: 'потребление',
        pt: 'consumo',
        nl: 'afname',
        fr: 'soutirage',
        it: 'prelievo',
        es: 'consumo',
        pl: 'pobór',
        uk: 'споживання',
        'zh-cn': '购电',
    },
    export: {
        en: 'feed-in',
        de: 'Einspeisung',
        ru: 'отдача',
        pt: 'injeção',
        nl: 'teruglevering',
        fr: 'injection',
        it: 'immissione',
        es: 'inyección',
        pl: 'oddawanie',
        uk: 'віддача',
        'zh-cn': '上网',
    },
    charging: {
        en: 'charging',
        de: 'lädt',
        ru: 'заряжается',
        pt: 'a carregar',
        nl: 'laadt',
        fr: 'en charge',
        it: 'in carica',
        es: 'cargando',
        pl: 'ładowanie',
        uk: 'заряджається',
        'zh-cn': '充电中',
    },
    discharging: {
        en: 'discharging',
        de: 'entlädt',
        ru: 'разряжается',
        pt: 'a descarregar',
        nl: 'ontlaadt',
        fr: 'en décharge',
        it: 'in scarica',
        es: 'descargando',
        pl: 'rozładowanie',
        uk: 'розряджається',
        'zh-cn': '放电中',
    },
    idle: {
        en: 'idle',
        de: 'Ruhe',
        ru: 'покой',
        pt: 'em repouso',
        nl: 'rust',
        fr: 'au repos',
        it: 'a riposo',
        es: 'en reposo',
        pl: 'spoczynek',
        uk: 'спокій',
        'zh-cn': '静置',
    },
    unbalanced: {
        en: 'not balanced (unmeasured generator?)',
        de: 'nicht bilanzierbar (ungemessener Erzeuger?)',
        ru: 'баланс не сходится (неизмеряемый генератор?)',
        pt: 'sem balanço (gerador não medido?)',
        nl: 'niet sluitend (niet gemeten opwekker?)',
        fr: 'bilan impossible (producteur non mesuré ?)',
        it: 'bilancio non possibile (generatore non misurato?)',
        es: 'sin balance (¿generador no medido?)',
        pl: 'bilans się nie zgadza (niemierzony generator?)',
        uk: 'баланс не сходиться (невиміряний генератор?)',
        'zh-cn': '无法平衡（存在未计量的发电设备？）',
    },
};

/** Languages of the adapter */
const LANGS = /** @type {Lang[]} */ (['en', 'de', 'ru', 'pt', 'nl', 'fr', 'it', 'es', 'pl', 'uk', 'zh-cn']);

/**
 * @param {string} lang System language
 * @returns {Lang} Supported language (English otherwise)
 */
function langOf(lang) {
    return LANGS.includes(/** @type {Lang} */ (lang)) ? /** @type {Lang} */ (lang) : 'en';
}

/**
 * @param {string} key Text key
 * @param {string} lang Language
 * @returns {string} Text in that language
 */
function word(key, lang) {
    return TXT[key][langOf(lang)] || TXT[key].en;
}

/**
 * Registers the cards read (regType, Modbus unit, column address as in the register tables).
 * The first configured entry of a list is used.
 */
const SOURCES = {
    pv: [{ regType: 'inputRegs', unit: 1, alias: 35017 }],
    ac: [{ regType: 'inputRegs', unit: 1, alias: 43034 }],
    temp: [{ regType: 'inputRegs', unit: 1, alias: 35008 }],
    pvToday: [{ regType: 'inputRegs', unit: 1, alias: 43002 }],
    pvTotal: [{ regType: 'inputRegs', unit: 1, alias: 43003 }],
    backup: [{ regType: 'inputRegs', unit: 1, alias: 35726 }],
    fault: [{ regType: 'inputRegs', unit: 1, alias: 43052 }],
    grid: [{ regType: 'inputRegs', unit: 1, alias: 35601 }],
    importToday: [{ regType: 'inputRegs', unit: 1, alias: 43036 }],
    exportToday: [{ regType: 'inputRegs', unit: 1, alias: 43045 }],
    importTotal: [
        { regType: 'inputRegs', unit: 1, alias: 43037 },
        { regType: 'inputRegs', unit: 1, alias: 35747 },
    ],
    exportTotal: [
        { regType: 'inputRegs', unit: 1, alias: 43046 },
        { regType: 'inputRegs', unit: 1, alias: 35749 },
    ],
    battVoltage: [
        { regType: 'inputRegs', unit: 1, alias: 43020 },
        { regType: 'inputRegs', unit: 2, alias: 40741 },
    ],
    battSoftware: [{ regType: 'inputRegs', unit: 2, alias: 40721 }],
    battCapacity: [{ regType: 'inputRegs', unit: 1, alias: 43039 }],
    soc: [
        { regType: 'inputRegs', unit: 1, alias: 43023 },
        { regType: 'inputRegs', unit: 2, alias: 40744 },
    ],
    battPower: [{ regType: 'inputRegs', unit: 1, alias: 43022 }],
    battCurrent: [{ regType: 'inputRegs', unit: 1, alias: 43021 }],
    battSigned: [{ regType: 'inputRegs', unit: 1, alias: 35214 }],
    soh: [
        { regType: 'inputRegs', unit: 1, alias: 43024 },
        { regType: 'inputRegs', unit: 2, alias: 40745 },
    ],
    battTemp: [{ regType: 'inputRegs', unit: 1, alias: 43025 }],
    reserve: [{ regType: 'holdingRegs', unit: 1, alias: 53100 }],
    minSoc: [{ regType: 'holdingRegs', unit: 1, alias: 73032 }],
    maxSoc: [{ regType: 'holdingRegs', unit: 1, alias: 73031 }],
    emsMode: [{ regType: 'holdingRegs', unit: 1, alias: 53050 }],
};

/**
 * @typedef {object} CardRow
 * @property {string} id Control ID
 * @property {string} kind Formatting ("power", "percent", "temp", "energy", "states", "grid", "battery", "house", "time")
 * @property {string} stateId Full ID of the state the card subscribes to
 * @property {Record<string, string>} inputs Full IDs of all states the value is computed from
 */

/**
 * @typedef {object} Card
 * @property {'inverter'|'battery'|'meter'} id Device ID
 * @property {CardRow[]} rows Rows (info controls)
 * @property {string} [socId] Full ID of the state of charge (battery symbol)
 * @property {string} [faultId] Full ID of the fault register (indicator)
 * @property {CardValue[]} values Main values shown directly on the card (customInfo, read only)
 * @property {string} [softwareId] Battery: software version of the BMS (manufacturer/model)
 * @property {string} [capacityId] Battery: capacity in kWh (model size)
 * @property {CardDirection} [direction] Live direction indicator (battery: charging/discharging, grid: import/feed-in)
 */

/**
 * @typedef {object} CardValue
 * @property {string} key Item key
 * @property {string} stateId Full state ID (raw value, the card shows it with the unit of the object)
 * @property {string} label Text key (TXT)
 * @property {number} [digits] Fraction digits
 */

/**
 * @typedef {object} CardDirection
 * @property {'battery'|'grid'} kind Battery (+ = discharging) or grid meter (+ = import)
 * @property {string} stateId Full ID of the signed state
 * @property {number} threshold Below this amount the value counts as idle (unit of the state)
 */

/**
 * Builds the cards from the configured registers. Pure function (unit tests).
 *
 * @param {import('./registers').Reg[]} regs Configured (enabled) registers
 * @param {string} namespace Instance namespace (sungrow-local.0)
 * @returns {Card[]} Cards; the inverter is always there
 */
function buildCards(regs, namespace) {
    /**
     * @param {keyof typeof SOURCES} key Source key
     * @returns {string|undefined} Full state ID of the first configured and read register
     */
    const find = key => {
        for (const s of SOURCES[key]) {
            const r = regs.find(
                x => x.regType === s.regType && x.deviceId === s.unit && x.alias === s.alias && x.poll !== false,
            );
            if (r) {
                return `${namespace}.${r.id}`;
            }
        }
        return undefined;
    };
    /**
     * @param {CardRow[]} rows Rows
     * @param {string} id Control ID
     * @param {string} kind Formatting
     * @param {Record<string, string|undefined>} inputs Inputs; the first one is the subscribed state
     * @param {string} [main] Input that must exist (default: the first)
     */
    const add = (rows, id, kind, inputs, main) => {
        const keys = Object.keys(inputs);
        const stateId = inputs[main || keys[0]];
        if (!stateId) {
            return;
        }
        /** @type {Record<string, string>} */
        const present = {};
        for (const k of keys) {
            if (inputs[k]) {
                present[k] = /** @type {string} */ (inputs[k]);
            }
        }
        rows.push({ id, kind, stateId, inputs: present });
    };

    /** @type {Card[]} */
    const cards = [];

    const inv = /** @type {CardRow[]} */ ([]);
    add(inv, 'pv', 'power', { value: find('pv') });
    add(inv, 'backup', 'power', { value: find('backup') });
    add(inv, 'ac', 'power', { value: find('ac') });
    const battInputs = {
        battSigned: find('battSigned'),
        battPower: find('battPower'),
        battCurrent: find('battCurrent'),
        pv: find('pv'),
        acPower: find('ac'),
    };
    // house consumption: AC output + grid; without AC output: PV - battery + grid (lib/flow.js)
    if (find('grid') && (find('ac') || (find('pv') && (battInputs.battSigned || battInputs.battPower)))) {
        add(inv, 'house', 'house', { grid: find('grid'), ...battInputs });
    }
    add(inv, 'temp', 'temp', { value: find('temp') });
    add(inv, 'pvToday', 'energy', { value: find('pvToday') });
    add(inv, 'pvTotal', 'energy', { value: find('pvTotal') });
    inv.push({
        id: 'lastValues',
        kind: 'time',
        stateId: `${namespace}.info.lastValueUpdate`,
        inputs: { value: `${namespace}.info.lastValueUpdate` },
    });
    /** @type {CardValue[]} */
    const invValues = [];
    /**
     * @param {CardValue[]} list Values of a card
     * @param {string} key Item key and text key
     * @param {string|undefined} stateId State
     * @param {number} digits Fraction digits
     * @param {string} [label] Text key (default: key)
     */
    const value = (list, key, stateId, digits, label) => {
        if (stateId) {
            list.push({ key, stateId, label: label || key, digits });
        }
    };
    // the operating state is not on the card (user decision 12.11.2026): PV power and energy, backup output
    value(invValues, 'pv', find('pv'), 0);
    value(invValues, 'pvToday', find('pvToday'), 1);
    value(invValues, 'pvTotal', find('pvTotal'), 0);
    value(invValues, 'backup', find('backup'), 0);
    cards.push({ id: 'inverter', rows: inv, faultId: find('fault'), values: invValues });

    const bat = /** @type {CardRow[]} */ ([]);
    add(bat, 'soc', 'percent', { value: find('soc') });
    if (battInputs.battSigned || battInputs.battPower) {
        add(bat, 'battPower', 'battery', battInputs, battInputs.battSigned ? 'battSigned' : 'battPower');
    }
    add(bat, 'battVoltage', 'voltage', { value: find('battVoltage') });
    add(bat, 'soh', 'percent', { value: find('soh') });
    add(bat, 'battTemp', 'temp', { value: find('battTemp') });
    add(bat, 'reserve', 'percent', { value: find('reserve') });
    add(bat, 'minSoc', 'percent', { value: find('minSoc') });
    add(bat, 'maxSoc', 'percent', { value: find('maxSoc') });
    add(bat, 'emsMode', 'states', { value: find('emsMode') });
    if (bat.some(r => r.id === 'soc' || r.id === 'battPower')) {
        /** @type {CardValue[]} */
        const values = [];
        // the state of charge is shown by the battery status of the card (icon with the value); a read-only
        // "%" state item would be drawn by the admin as a progress bar above its label
        // 35214 is signed (+ = discharging); 43022 is an amount - the direction then comes from 43021
        if (battInputs.battSigned) {
            values.push({ key: 'battPower', stateId: battInputs.battSigned, label: 'battPowerSigned', digits: 0 });
        } else if (battInputs.battPower) {
            values.push({ key: 'battPower', stateId: battInputs.battPower, label: 'battPower', digits: 0 });
        }
        value(values, 'battVoltage', find('battVoltage'), 1);
        /** @type {CardDirection|undefined} */
        let direction;
        if (battInputs.battSigned) {
            direction = { kind: 'battery', stateId: battInputs.battSigned, threshold: 10 };
        } else if (battInputs.battCurrent) {
            direction = { kind: 'battery', stateId: battInputs.battCurrent, threshold: 0.1 };
        }
        cards.push({
            id: 'battery',
            rows: bat,
            socId: find('soc'),
            values,
            direction,
            softwareId: find('battSoftware'),
            capacityId: find('battCapacity'),
        });
    }

    const met = /** @type {CardRow[]} */ ([]);
    add(met, 'grid', 'grid', { value: find('grid') });
    if (met.length) {
        add(met, 'importToday', 'energy', { value: find('importToday') });
        add(met, 'importTotal', 'energy', { value: find('importTotal') });
        add(met, 'exportToday', 'energy', { value: find('exportToday') });
        add(met, 'exportTotal', 'energy', { value: find('exportTotal') });
        const grid = /** @type {string} */ (find('grid'));
        /** @type {CardValue[]} */
        const metValues = [{ key: 'grid', stateId: grid, label: 'gridSigned', digits: 0 }];
        value(metValues, 'importToday', find('importToday'), 1);
        value(metValues, 'importTotal', find('importTotal'), 0);
        value(metValues, 'exportToday', find('exportToday'), 1);
        value(metValues, 'exportTotal', find('exportTotal'), 0);
        cards.push({
            id: 'meter',
            rows: met,
            values: metValues,
            direction: { kind: 'grid', stateId: grid, threshold: 10 },
        });
    }
    return cards;
}

/**
 * @param {number} v Value
 * @param {number} digits Fraction digits
 * @param {string} lang Language
 * @returns {string} Number in the notation of the language
 */
function fmt(v, digits, lang) {
    try {
        return new Intl.NumberFormat(langOf(lang) === 'zh-cn' ? 'zh-CN' : langOf(lang), {
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
        }).format(v);
    } catch {
        return v.toFixed(digits);
    }
}

/**
 * @param {number} w Power in W
 * @param {string} lang Language
 * @returns {string} "512 W" or "5.10 kW"
 */
function power(w, lang) {
    return Math.abs(w) >= 1000 ? `${fmt(w / 1000, 2, lang)} kW` : `${fmt(Math.round(w), 0, lang)} W`;
}

/**
 * @param {any} v Value
 * @returns {number|undefined} Finite number
 */
function numOf(v) {
    if (typeof v === 'number' && Number.isFinite(v)) {
        return v;
    }
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
        return Number(v);
    }
    return undefined;
}

/**
 * Text of one card row. Pure function (unit tests).
 *
 * @param {string} kind Formatting of the row
 * @param {Record<string, any>} values Values of the inputs (key as in CardRow.inputs)
 * @param {string} lang Language of the words
 * @param {Record<string, string>} [states] Value texts of the main state (common.states)
 * @returns {string} Text ("–" without a value)
 */
function formatRow(kind, values, lang, states) {
    const v = numOf(values.value);
    switch (kind) {
        case 'power':
            return v === undefined ? '–' : power(v, lang);
        case 'percent':
            return v === undefined ? '–' : `${fmt(v, Number.isInteger(v) ? 0 : 1, lang)} %`;
        case 'voltage':
            return v === undefined ? '–' : `${fmt(v, 1, lang)} V`;
        case 'temp':
            return v === undefined ? '–' : `${fmt(v, 1, lang)} °C`;
        case 'energy':
            return v === undefined ? '–' : `${fmt(v, 1, lang)} kWh`;
        case 'states': {
            if (values.value === undefined || values.value === null) {
                return '–';
            }
            const text = states && states[String(values.value)];
            return text ? String(text) : String(values.value);
        }
        case 'grid': {
            if (v === undefined) {
                return '–';
            }
            if (Math.abs(v) < 1) {
                return `0 W · ${word('idle', lang)}`;
            }
            return `${power(Math.abs(v), lang)} · ${word(v > 0 ? 'import' : 'export', lang)}`;
        }
        case 'battery': {
            const f = energyFlow({
                battSigned: numOf(values.battSigned),
                battPower: numOf(values.battPower),
                battCurrent: numOf(values.battCurrent),
                pv: numOf(values.pv),
                acPower: numOf(values.acPower),
            });
            if (f.battery === undefined) {
                return '–';
            }
            const dir = f.direction === 'charge' ? 'charging' : f.direction === 'discharge' ? 'discharging' : 'idle';
            return `${power(Math.abs(f.battery), lang)} · ${word(dir, lang)}`;
        }
        case 'house': {
            const f = energyFlow({
                battSigned: numOf(values.battSigned),
                battPower: numOf(values.battPower),
                battCurrent: numOf(values.battCurrent),
                pv: numOf(values.pv),
                acPower: numOf(values.acPower),
                grid: numOf(values.grid),
            });
            if (f.unbalanced) {
                return word('unbalanced', lang);
            }
            return f.house === undefined ? '–' : power(Math.max(0, f.house), lang);
        }
        case 'time': {
            if (v === undefined || v <= 0) {
                return '–';
            }
            const d = new Date(v);
            const p = (/** @type {number} */ n) => String(n).padStart(2, '0');
            return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
        }
        default:
            return values.value === undefined || values.value === null ? '–' : String(values.value);
    }
}

/** Card header icons (Material Design Icons, Apache 2.0), white on the coloured header */
const ICON_PATHS = {
    inverter:
        'M11.45,2V5.55L15,3.77L11.45,2M10.45,8L8,10.46L11.75,11.71L10.45,8M2,11.45L3.77,15L5.55,11.45H2M10,2H2V10C2.57,10.17 3.17,10.25 3.77,10.25C7.35,10.26 10.26,7.35 10.27,3.75C10.26,3.16 10.17,2.57 10,2M17,22V16H14L19,7V13H22L17,22Z',
    battery:
        'M12 20L5 20V12H2L12 3L14.78 5.5H14V7.17C12.84 7.58 12 8.7 12 10V20M15 9H16V7.5H20V9H21C21.55 9 22 9.45 22 10V21C22 21.55 21.55 22 21 22H15C14.45 22 14 21.55 14 21V10C14 9.45 14.45 9 15 9M16 11V14H20V11H16Z',
    meter: 'M12 2C7.04 2 3 6.04 3 11C3 14.91 5.5 18.24 9 19.47V22H11V19.94C11.33 20 11.66 20 12 20S12.67 20 13 19.94V22H15V19.47C18.5 18.23 21 14.9 21 11C21 6.04 16.96 2 12 2M14.25 14L11.25 17L9.75 15.5L11 14.25L9.75 13L12.75 10L14.25 11.5L13 12.75L14.25 14M16 9H8V7H16V9Z',
};

/**
 * @param {string} cardId Card ID (inverter, battery, meter)
 * @returns {string|undefined} Icon as data URL (the device manager takes base64 or a URL)
 */
function cardIcon(cardId) {
    const path = ICON_PATHS[cardId];
    if (!path) {
        return undefined;
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#ffffff" d="${path}"/></svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/**
 * Manufacturer and model of the battery from the BMS of unit 2 (no configuration needed):
 * the software version of the battery control unit (40721, e.g. "SBHBCU-S_22011.04.02") names the Sungrow
 * battery family (SBH, SBR), the size follows from the capacity 43039 and the module size of the family
 * (SBH: 5 kWh per module, SBH100 ... SBH400; SBR: 3.2 kWh, SBR096 ... SBR256). Only the family is given when
 * the capacity is missing; nothing is given for an unknown battery (no guessed manufacturer).
 *
 * @param {unknown} software Software version string of the BMS
 * @param {unknown} capacity Battery capacity in kWh
 * @returns {{manufacturer?: string, model?: string}} Manufacturer and model
 */
function batteryModel(software, capacity) {
    const m = /^\s*(SBH|SBR)/i.exec(typeof software === 'string' ? software : '');
    if (!m) {
        return {};
    }
    const family = m[1].toUpperCase();
    const cap = numOf(capacity);
    const step = family === 'SBH' ? 5 : 3.2;
    const modules = cap !== undefined && cap > 0 ? Math.round(cap / step) : 0;
    const size = modules ? String(Math.round(modules * step * 10)).padStart(3, '0') : '';
    return { manufacturer: 'Sungrow', model: `${family}${size}` };
}

/** Direction icons (Material Design Icons, Apache 2.0) */
const ARROW_UP = 'M15,20H9V12H4.16L12,4.16L19.84,12H15V20Z';
const ARROW_DOWN = 'M9,4H15V12H19.84L12,19.84L4.16,12H9V4Z';
const MINUS = 'M19,13H5V11H19V13Z';

/**
 * @param {string} path SVG path
 * @param {string} color Fill colour
 * @returns {string} Icon as data URL
 */
function svgIcon(path, color) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="${color}" d="${path}"/></svg>`;
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

/**
 * Main values directly on the card: a JSON config panel of read-only "state" items. The admin (8.3.7) shows
 * the info controls only in the control dialog, these rows are visible on the card itself. The card reads the
 * states live; nothing is written.
 *
 * @param {Card} card Card
 * @returns {{id: string, schema: {type: 'panel', items: Record<string, any>}} | undefined} customInfo
 */
function cardInfo(card) {
    if (!card.values || !card.values.length) {
        return undefined;
    }
    /** @type {Record<string, any>} */
    const items = {};
    for (const v of card.values) {
        /** @type {Record<string, any>} */
        const item = {
            type: 'state',
            oid: v.stateId,
            foreign: true,
            label: TXT[v.label],
            readOnly: true,
            control: 'text',
            xs: 12,
        };
        if (v.digits !== undefined) {
            item.digits = v.digits;
        }
        items[`_${v.key}`] = item;
    }
    return { id: card.id, schema: { type: 'panel', items } };
}

/**
 * Live direction of the battery (charging/discharging) or the grid (import/feed-in) as an indicator. The sign
 * convention of the Sungrow registers: battery current 43021 / signed power 35214 + = discharging, − = charging;
 * meter 35601 + = import, − = feed-in.
 *
 * @param {CardDirection} d Direction source
 * @returns {any} Status indicator
 */
function directionIndicator(d) {
    const minus = d.kind === 'battery' ? 'charging' : 'export';
    const plus = d.kind === 'battery' ? 'discharging' : 'import';
    return {
        id: 'direction',
        value: { stateId: d.stateId },
        label: TXT.direction,
        hideIfEmpty: true,
        levels: [
            {
                max: -d.threshold,
                icon: svgIcon(ARROW_UP, '#43a047'),
                color: 'ok',
                text: TXT[minus],
                tooltip: TXT[minus],
            },
            {
                min: d.threshold,
                icon: svgIcon(ARROW_DOWN, '#f57c00'),
                color: 'warning',
                text: TXT[plus],
                tooltip: TXT[plus],
            },
            { icon: svgIcon(MINUS, '#9e9e9e'), color: 'inactive', text: TXT.idle, tooltip: TXT.idle },
        ],
    };
}

/** Unit of the info controls: one space, so the card does not append the unit of the object a second time */
const NO_UNIT = ' ';

/** Device management of the adapter: read-only cards (see the top of this file) */
class SungrowDeviceManagement extends DeviceManagement {
    /**
     * @param {import('@iobroker/adapter-core').AdapterInstance & {regsById?: Map<string, any>, lang?: string}} adapter Adapter
     */
    constructor(adapter) {
        // no communication state: the cards follow the states themselves (no object is created)
        super(adapter);
        /** @type {Map<string, Card>} */
        this.cards = new Map();
    }

    /** @returns {import('@iobroker/dm-utils').InstanceDetails} Instance info without actions */
    getInstanceInfo() {
        return { apiVersion: 'v3' };
    }

    /** @returns {string} System language */
    get lang() {
        return /** @type {any} */ (this.adapter).lang || 'en';
    }

    /**
     * Reads the inputs of a row and formats them.
     *
     * @param {CardRow} row Row
     * @returns {Promise<ioBroker.State>} State with the text as value (ts of the newest input)
     */
    async rowState(row) {
        /** @type {Record<string, any>} */
        const values = {};
        let ts = 0;
        let lc = 0;
        for (const [k, id] of Object.entries(row.inputs)) {
            try {
                const st = await this.adapter.getForeignStateAsync(id);
                if (st) {
                    values[k] = st.val;
                    ts = Math.max(ts, st.ts || 0);
                    lc = Math.max(lc, st.lc || 0);
                }
            } catch {
                // no value
            }
        }
        /** @type {Record<string, string>|undefined} */
        let states;
        if (row.kind === 'states') {
            try {
                const obj = await this.adapter.getForeignObjectAsync(row.stateId);
                const s = obj && obj.common && /** @type {any} */ (obj.common).states;
                states = s && typeof s === 'object' && !Array.isArray(s) ? s : undefined;
            } catch {
                // raw value
            }
        }
        const now = Date.now();
        return {
            val: formatRow(row.kind, values, this.lang, states),
            ack: true,
            ts: ts || now,
            lc: lc || ts || now,
            from: `system.adapter.${this.adapter.namespace}`,
            q: 0,
        };
    }

    /**
     * Cards of the configured registers as device infos.
     *
     * @returns {Promise<any[]>} Device infos (inverter, optionally battery and grid meter)
     */
    async deviceInfos() {
        const regsById = /** @type {any} */ (this.adapter).regsById;
        const regs = regsById instanceof Map ? [...regsById.values()] : [];
        const cards = buildCards(regs, this.adapter.namespace);
        this.cards = new Map(cards.map(c => [c.id, c]));
        const connection = {
            stateId: `${this.adapter.namespace}.info.connection`,
            mapping: { true: 'connected', false: 'disconnected' },
        };
        const out = [];
        for (const card of cards) {
            /** @type {any[]} */
            const controls = [];
            for (const row of card.rows) {
                // read only: "info" controls, no handler that writes
                controls.push({
                    id: row.id,
                    type: 'info',
                    label: TXT[row.id],
                    showSemicolon: true,
                    unit: NO_UNIT,
                    stateId: row.stateId,
                    state: await this.rowState(row),
                    getStateHandler: async (/** @type {string} */ deviceId, /** @type {string} */ controlId) => {
                        const c = this.cards.get(deviceId);
                        const r = c && c.rows.find(x => x.id === controlId);
                        if (!r) {
                            return { error: { code: 404, message: `Unknown control ${deviceId}/${controlId}` } };
                        }
                        return this.rowState(r);
                    },
                });
            }
            /** @type {any} */
            const status = { connection };
            if (card.socId) {
                status.battery = { stateId: card.socId };
            }
            /** @type {any} */
            const device = {
                id: card.id,
                name: TXT[card.id],
                icon: cardIcon(card.id),
                connectionType: 'lan',
                status,
                controls,
            };
            if (card.id === 'battery') {
                // only on the battery card: the battery may come from another manufacturer than the inverter
                const read = async (/** @type {string|undefined} */ id) => {
                    try {
                        const st = id ? await this.adapter.getForeignStateAsync(id) : null;
                        return st ? st.val : undefined;
                    } catch {
                        return undefined;
                    }
                };
                const bm = batteryModel(await read(card.softwareId), await read(card.capacityId));
                if (bm.manufacturer) {
                    device.manufacturer = bm.manufacturer;
                }
                if (bm.model) {
                    device.model = bm.model;
                }
            }
            const info = cardInfo(card);
            if (info) {
                device.customInfo = info;
            }
            /** @type {any[]} */
            const indicators = [];
            if (card.direction) {
                indicators.push(directionIndicator(card.direction));
            }
            device.indicators = indicators;
            if (card.faultId) {
                indicators.push({
                    id: 'fault',
                    value: { stateId: card.faultId },
                    label: TXT.faultLabel,
                    icon: 'info',
                    levels: [
                        { value: 0, color: 'ok', tooltip: TXT.noFault },
                        { color: 'error', tooltip: TXT.fault },
                    ],
                });
            }
            if (!indicators.length) {
                delete device.indicators;
            }
            out.push(device);
        }
        return out;
    }

    /**
     * @param {import('@iobroker/dm-utils').DeviceLoadContext<string>} context Load context
     */
    async loadDevices(context) {
        const devices = await this.deviceInfos();
        context.setTotalDevices(devices.length);
        for (const d of devices) {
            context.addDevice(d);
        }
    }

    /**
     * @param {string} deviceId Device ID
     * @returns {Promise<any>} Device info
     */
    async getDeviceInfo(deviceId) {
        const d = (await this.deviceInfos()).find(x => x.id === deviceId);
        if (!d) {
            throw new Error(`Unknown device ${deviceId}`);
        }
        return d;
    }

    /**
     * @param {string} deviceId Device ID
     * @returns {Promise<any>} Status of the device
     */
    async getDeviceStatus(deviceId) {
        return (await this.getDeviceInfo(deviceId)).status;
    }
}

module.exports = {
    SungrowDeviceManagement,
    buildCards,
    formatRow,
    cardIcon,
    cardInfo,
    directionIndicator,
    batteryModel,
    SOURCES,
    TXT,
    LANGS,
};
