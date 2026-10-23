'use strict';

/*
 * Diagnostic states per poll group (info.groups.<group>.*) and for writes (info.write.*).
 * They show how close an interval is to what the gateway can handle: response times, timeouts,
 * errors and "skipped" rounds (the previous round of the group was still queued).
 * Names are translated objects, so the object tree of the admin shows them in its language.
 */

/**
 * @typedef {Record<'en'|'de'|'ru'|'pt'|'nl'|'fr'|'it'|'es'|'pl'|'uk'|'zh-cn', string>} Translated
 */

/** @type {Record<string, Translated>} */
const T = {
    lastResponseTime: {
        en: 'Response time of the last successful request',
        de: 'Antwortzeit der letzten erfolgreichen Anfrage',
        ru: 'Время ответа последнего успешного запроса',
        pt: 'Tempo de resposta do último pedido bem-sucedido',
        nl: 'Reactietijd van het laatste geslaagde verzoek',
        fr: 'Temps de réponse de la dernière requête réussie',
        it: "Tempo di risposta dell'ultima richiesta riuscita",
        es: 'Tiempo de respuesta de la última solicitud correcta',
        pl: 'Czas odpowiedzi ostatniego udanego zapytania',
        uk: 'Час відповіді останнього успішного запиту',
        'zh-cn': '上次成功请求的响应时间',
    },
    lastSuccess: {
        en: 'Last successful request',
        de: 'Letzte erfolgreiche Anfrage',
        ru: 'Последний успешный запрос',
        pt: 'Último pedido bem-sucedido',
        nl: 'Laatste geslaagde verzoek',
        fr: 'Dernière requête réussie',
        it: 'Ultima richiesta riuscita',
        es: 'Última solicitud correcta',
        pl: 'Ostatnie udane zapytanie',
        uk: 'Останній успішний запит',
        'zh-cn': '上次成功请求',
    },
    lastError: {
        en: 'Last error',
        de: 'Letzter Fehler',
        ru: 'Последняя ошибка',
        pt: 'Último erro',
        nl: 'Laatste fout',
        fr: 'Dernière erreur',
        it: 'Ultimo errore',
        es: 'Último error',
        pl: 'Ostatni błąd',
        uk: 'Остання помилка',
        'zh-cn': '最后错误',
    },
    requestsToday: {
        en: 'Requests today',
        de: 'Anfragen heute',
        ru: 'Запросов сегодня',
        pt: 'Pedidos hoje',
        nl: 'Verzoeken vandaag',
        fr: "Requêtes aujourd'hui",
        it: 'Richieste oggi',
        es: 'Solicitudes hoy',
        pl: 'Zapytania dzisiaj',
        uk: 'Запитів сьогодні',
        'zh-cn': '今日请求数',
    },
    timeoutsToday: {
        en: 'Timeouts today',
        de: 'Timeouts heute',
        ru: 'Тайм-аутов сегодня',
        pt: 'Tempos esgotados hoje',
        nl: 'Time-outs vandaag',
        fr: "Délais dépassés aujourd'hui",
        it: 'Timeout oggi',
        es: 'Tiempos de espera agotados hoy',
        pl: 'Przekroczenia czasu dzisiaj',
        uk: 'Тайм-аутів сьогодні',
        'zh-cn': '今日超时次数',
    },
    errorsToday: {
        en: 'Errors today (without timeouts)',
        de: 'Fehler heute (ohne Timeouts)',
        ru: 'Ошибок сегодня (без тайм-аутов)',
        pt: 'Erros hoje (sem tempos esgotados)',
        nl: 'Fouten vandaag (zonder time-outs)',
        fr: "Erreurs aujourd'hui (sans délais dépassés)",
        it: 'Errori oggi (senza timeout)',
        es: 'Errores hoy (sin tiempos de espera)',
        pl: 'Błędy dzisiaj (bez przekroczeń czasu)',
        uk: 'Помилок сьогодні (без тайм-аутів)',
        'zh-cn': '今日错误数（不含超时）',
    },
    skippedToday: {
        en: 'Rounds skipped today (previous round still queued)',
        de: 'Übersprungene Runden heute (vorige Runde noch in der Warteschlange)',
        ru: 'Пропущено циклов сегодня (предыдущий цикл ещё в очереди)',
        pt: 'Rondas ignoradas hoje (ronda anterior ainda na fila)',
        nl: 'Overgeslagen rondes vandaag (vorige ronde nog in de wachtrij)',
        fr: "Cycles sautés aujourd'hui (cycle précédent encore en file d'attente)",
        it: 'Cicli saltati oggi (ciclo precedente ancora in coda)',
        es: 'Rondas omitidas hoy (ronda anterior aún en cola)',
        pl: 'Pominięte cykle dzisiaj (poprzedni cykl wciąż w kolejce)',
        uk: 'Пропущено циклів сьогодні (попередній цикл ще в черзі)',
        'zh-cn': '今日跳过的轮次（上一轮仍在队列中）',
    },
    timeoutsTotal: {
        en: 'Timeouts total',
        de: 'Timeouts gesamt',
        ru: 'Тайм-аутов всего',
        pt: 'Tempos esgotados no total',
        nl: 'Time-outs totaal',
        fr: 'Délais dépassés au total',
        it: 'Timeout totali',
        es: 'Tiempos de espera agotados en total',
        pl: 'Przekroczenia czasu łącznie',
        uk: 'Тайм-аутів усього',
        'zh-cn': '超时总数',
    },
    errorsTotal: {
        en: 'Errors total (without timeouts)',
        de: 'Fehler gesamt (ohne Timeouts)',
        ru: 'Ошибок всего (без тайм-аутов)',
        pt: 'Erros no total (sem tempos esgotados)',
        nl: 'Fouten totaal (zonder time-outs)',
        fr: 'Erreurs au total (sans délais dépassés)',
        it: 'Errori totali (senza timeout)',
        es: 'Errores en total (sin tiempos de espera)',
        pl: 'Błędy łącznie (bez przekroczeń czasu)',
        uk: 'Помилок усього (без тайм-аутів)',
        'zh-cn': '错误总数（不含超时）',
    },
    lastRound: {
        en: 'Last complete round (heartbeat, also without value changes)',
        de: 'Letzte vollständige Runde (Herzschlag, auch ohne Wertänderung)',
        ru: 'Последний полный цикл (пульс, также без изменения значений)',
        pt: 'Última ronda completa (pulsação, também sem alteração de valores)',
        nl: 'Laatste volledige ronde (hartslag, ook zonder waardewijziging)',
        fr: 'Dernier cycle complet (battement, même sans changement de valeur)',
        it: 'Ultimo ciclo completo (battito, anche senza variazione dei valori)',
        es: 'Última ronda completa (latido, también sin cambio de valores)',
        pl: 'Ostatni pełny cykl (puls, także bez zmiany wartości)',
        uk: 'Останній повний цикл (пульс, також без зміни значень)',
        'zh-cn': '上次完整轮次（心跳，即使数值未变化）',
    },
    lastRoundText: {
        en: 'Last complete round (time and duration, for display)',
        de: 'Letzte vollständige Runde (Uhrzeit und Dauer, zur Anzeige)',
        ru: 'Последний полный цикл (время и длительность, для отображения)',
        pt: 'Última ronda completa (hora e duração, para exibição)',
        nl: 'Laatste volledige ronde (tijd en duur, voor weergave)',
        fr: 'Dernier cycle complet (heure et durée, pour affichage)',
        it: 'Ultimo ciclo completo (ora e durata, per la visualizzazione)',
        es: 'Última ronda completa (hora y duración, para mostrar)',
        pl: 'Ostatni pełny cykl (godzina i czas trwania, do wyświetlania)',
        uk: 'Останній повний цикл (час і тривалість, для відображення)',
        'zh-cn': '上次完整轮次（时间和时长，用于显示）',
    },
    roundDuration: {
        en: 'Duration of the last complete round (queue + bus)',
        de: 'Dauer der letzten vollständigen Runde (Warteschlange + Bus)',
        ru: 'Длительность последнего полного цикла (очередь + шина)',
        pt: 'Duração da última ronda completa (fila + barramento)',
        nl: 'Duur van de laatste volledige ronde (wachtrij + bus)',
        fr: "Durée du dernier cycle complet (file d'attente + bus)",
        it: "Durata dell'ultimo ciclo completo (coda + bus)",
        es: 'Duración de la última ronda completa (cola + bus)',
        pl: 'Czas trwania ostatniego pełnego cyklu (kolejka + magistrala)',
        uk: 'Тривалість останнього повного циклу (черга + шина)',
        'zh-cn': '上次完整轮次的时长（队列 + 总线）',
    },
    wLastResponseTime: {
        en: 'Response time of the last write/confirmation',
        de: 'Antwortzeit des letzten Schreibens/der letzten Bestätigung',
        ru: 'Время ответа последней записи/подтверждения',
        pt: 'Tempo de resposta da última escrita/confirmação',
        nl: 'Reactietijd van de laatste schrijfactie/bevestiging',
        fr: 'Temps de réponse de la dernière écriture/confirmation',
        it: "Tempo di risposta dell'ultima scrittura/conferma",
        es: 'Tiempo de respuesta de la última escritura/confirmación',
        pl: 'Czas odpowiedzi ostatniego zapisu/potwierdzenia',
        uk: 'Час відповіді останнього запису/підтвердження',
        'zh-cn': '上次写入/确认的响应时间',
    },
    wLastSuccess: {
        en: 'Last successful write/confirmation',
        de: 'Letztes erfolgreiches Schreiben/Bestätigen',
        ru: 'Последняя успешная запись/подтверждение',
        pt: 'Última escrita/confirmação bem-sucedida',
        nl: 'Laatste geslaagde schrijfactie/bevestiging',
        fr: 'Dernière écriture/confirmation réussie',
        it: 'Ultima scrittura/conferma riuscita',
        es: 'Última escritura/confirmación correcta',
        pl: 'Ostatni udany zapis/potwierdzenie',
        uk: 'Останній успішний запис/підтвердження',
        'zh-cn': '上次成功写入/确认',
    },
    okTotal: {
        en: 'Successful write and confirmation requests',
        de: 'Erfolgreiche Schreib- und Bestätigungsanfragen',
        ru: 'Успешные запросы записи и подтверждения',
        pt: 'Pedidos de escrita e confirmação bem-sucedidos',
        nl: 'Geslaagde schrijf- en bevestigingsverzoeken',
        fr: "Requêtes d'écriture et de confirmation réussies",
        it: 'Richieste di scrittura e conferma riuscite',
        es: 'Solicitudes de escritura y confirmación correctas',
        pl: 'Udane zapytania zapisu i potwierdzenia',
        uk: 'Успішні запити запису та підтвердження',
        'zh-cn': '成功的写入和确认请求',
    },
    failedTotal: {
        en: 'Writes failed after all attempts',
        de: 'Schreibvorgänge, die nach allen Versuchen scheiterten',
        ru: 'Записи, не выполненные после всех попыток',
        pt: 'Escritas falhadas após todas as tentativas',
        nl: 'Schrijfacties mislukt na alle pogingen',
        fr: 'Écritures échouées après toutes les tentatives',
        it: 'Scritture fallite dopo tutti i tentativi',
        es: 'Escrituras fallidas tras todos los intentos',
        pl: 'Zapisy nieudane po wszystkich próbach',
        uk: 'Записи, що не вдалися після всіх спроб',
        'zh-cn': '所有尝试后仍失败的写入',
    },
    channelGroup: {
        en: 'Poll group',
        de: 'Abfragegruppe',
        ru: 'Группа опроса',
        pt: 'Grupo de consulta',
        nl: 'Pollgroep',
        fr: "Groupe d'interrogation",
        it: 'Gruppo di interrogazione',
        es: 'Grupo de consulta',
        pl: 'Grupa odpytywania',
        uk: 'Група опитування',
        'zh-cn': '轮询组',
    },
    channelWrite: {
        en: 'Writes',
        de: 'Schreiben',
        ru: 'Запись',
        pt: 'Escritas',
        nl: 'Schrijven',
        fr: 'Écritures',
        it: 'Scritture',
        es: 'Escrituras',
        pl: 'Zapisy',
        uk: 'Запис',
        'zh-cn': '写入',
    },
    lastValueUpdate: {
        en: 'Last value read from the device (any group)',
        de: 'Letzter vom Gerät gelesener Wert (alle Gruppen)',
        ru: 'Последнее значение, прочитанное с устройства (любая группа)',
        pt: 'Último valor lido do dispositivo (qualquer grupo)',
        nl: 'Laatste waarde gelezen van het apparaat (alle groepen)',
        fr: "Dernière valeur lue sur l'appareil (tous groupes)",
        it: 'Ultimo valore letto dal dispositivo (tutti i gruppi)',
        es: 'Último valor leído del dispositivo (cualquier grupo)',
        pl: 'Ostatnia wartość odczytana z urządzenia (dowolna grupa)',
        uk: 'Останнє значення, прочитане з пристрою (будь-яка група)',
        'zh-cn': '从设备读取的最后一个值（任意组）',
    },
};

/** States per poll group */
const DIAG = {
    lastResponseTime: { type: 'number', role: 'value', unit: 'ms', name: T.lastResponseTime, def: 0 },
    lastSuccess: { type: 'number', role: 'date', name: T.lastSuccess, def: 0 },
    lastRound: { type: 'number', role: 'date', name: T.lastRound, def: 0 },
    lastRoundText: { type: 'string', role: 'text', name: T.lastRoundText, def: '' },
    roundDuration: { type: 'number', role: 'value', unit: 'ms', name: T.roundDuration, def: 0 },
    lastError: { type: 'string', role: 'text', name: T.lastError, def: '' },
    requestsToday: { type: 'number', role: 'value', name: T.requestsToday, def: 0 },
    timeoutsToday: { type: 'number', role: 'value', name: T.timeoutsToday, def: 0 },
    errorsToday: { type: 'number', role: 'value', name: T.errorsToday, def: 0 },
    skippedToday: { type: 'number', role: 'value', name: T.skippedToday, def: 0 },
    timeoutsTotal: { type: 'number', role: 'value', name: T.timeoutsTotal, def: 0 },
    errorsTotal: { type: 'number', role: 'value', name: T.errorsTotal, def: 0 },
};

/** States for writes */
const WRITE_DIAG = {
    key: 'write',
    states: {
        lastResponseTime: { type: 'number', role: 'value', unit: 'ms', name: T.wLastResponseTime, def: 0 },
        lastSuccess: { type: 'number', role: 'date', name: T.wLastSuccess, def: 0 },
        lastError: { type: 'string', role: 'text', name: T.lastError, def: '' },
        okTotal: { type: 'number', role: 'value', name: T.okTotal, def: 0 },
        failedTotal: { type: 'number', role: 'value', name: T.failedTotal, def: 0 },
    },
};

/** Adapter-wide state: time of the last value read from the device */
const LAST_VALUE_UPDATE = { type: 'number', role: 'date', name: T.lastValueUpdate, def: 0 };

/**
 * Translated channel name of a poll group, with the description from the configuration.
 *
 * @param {string} name Group name
 * @param {string} [description] Description column of the group
 * @returns {Translated} Name
 */
function groupChannelName(name, description) {
    const suffix = description && String(description).trim() ? ` – ${String(description).trim()}` : '';
    return /** @type {Translated} */ (
        Object.fromEntries(Object.entries(T.channelGroup).map(([lang, t]) => [lang, `${t} ${name}${suffix}`]))
    );
}

/**
 * Checks the timing of a group against what the WiNet-S2 needs for a slow bus device: a device with a
 * long instruction interval (SBH400: 5000 ms) needs that pause after each request, and the timeout must
 * cover the pause plus the answer.
 *
 * @param {{name: string, timeout: number, pauseAfter: number}} g Group (times in ms)
 * @param {boolean} slowDevice The group reads a unit with a long instruction interval (unit 2)
 * @param {number} [instructionInterval] Instruction interval of that unit in the WiNet (ms)
 * @returns {string[]} Warnings (empty = plausible)
 */
function timingWarnings(g, slowDevice, instructionInterval = 5000) {
    const out = [];
    if (!slowDevice) {
        return out;
    }
    if (g.pauseAfter < instructionInterval) {
        out.push(
            `Group ${g.name}: pause after request ${g.pauseAfter} ms is shorter than the instruction interval of the battery (${instructionInterval} ms) - expect timeouts`,
        );
    }
    if (g.timeout <= g.pauseAfter + instructionInterval) {
        out.push(
            `Group ${g.name}: timeout ${g.timeout} ms should be longer than pause + instruction interval (${g.pauseAfter + instructionInterval} ms)`,
        );
    }
    return out;
}

/**
 * @param {Date} d Date
 * @returns {string} Local time HH:MM:SS
 */
function timeOfDay(d) {
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
}

/**
 * @param {string} name Group name
 * @returns {string} Channel key below info
 */
function groupKey(name) {
    return `groups.${String(name).replace(/[^A-Za-z0-9_-]/g, '_')}`;
}

/**
 * @param {Date} d Date
 * @returns {string} Local day YYYY-MM-DD
 */
function dayKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

module.exports = {
    T,
    DIAG,
    WRITE_DIAG,
    LAST_VALUE_UPDATE,
    groupChannelName,
    timingWarnings,
    timeOfDay,
    groupKey,
    dayKey,
};
