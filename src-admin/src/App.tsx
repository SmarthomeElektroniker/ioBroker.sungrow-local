// Development harness: renders the components with a simulated admin socket (no ioBroker needed).
// Used by `npm start` and by the smoke test (smoke.mjs) - not part of the admin build.
import React from 'react';
import { ThemeProvider, StyledEngineProvider } from '@mui/material/styles';
import { Box, CssBaseline, Tab, Tabs } from '@mui/material';
import { I18n, Theme } from '@iobroker/gui-components';

import Components from './Components';
import ioPackage from '../../io-package.json';
import en from './i18n/en.json';
import de from './i18n/de.json';

const params = new URLSearchParams(window.location.search);
const language = (params.get('lang') || 'de') as ioBroker.Languages;
const prefersDark = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
const themeName = (params.get('theme') || (prefersDark ? 'dark' : 'light')) === 'dark' ? 'dark' : 'light';
I18n.extendTranslations(en as any, 'en');
I18n.extendTranslations(de as any, 'de');
I18n.setLanguage(language);

const start = Date.now();
/** Simulated values of the reference installation */
function simulated(id: string): ioBroker.State | null {
    const now = Date.now();
    const st = (val: any, ts = now - 2000): ioBroker.State => ({ val, ack: true, ts, lc: ts, from: 'sim', q: 0 }) as any;
    const s = (now - start) / 1000;
    if (id.endsWith('info.connection')) return st(true);
    if (id.endsWith('info.lastValueUpdate')) return st(now - 1500);
    if (id.endsWith('info.reconnects')) return st(0);
    if (id.endsWith('.lastRound')) return st(now - 3000);
    if (id.endsWith('.roundDuration')) return st(id.includes('akku') ? 5040 : id.includes('live') ? 620 : 260);
    if (id.endsWith('.lastResponseTime')) return st(9);
    if (id.endsWith('Today')) return st(id.includes('requests') ? 8231 : 0);
    if (id.endsWith('Total')) return st(id.includes('ok') ? 42 : 0);
    if (id.endsWith('info.write.log'))
        return st(
            JSON.stringify([
                { ts: now - 120000, id: 'holdingRegisters.1.73031_Max_SOC', name: 'Max SoC', value: 100, result: 'ok', detail: '100' },
                { ts: now - 3600000, id: 'holdingRegisters.1.53050_EMS_mode_selection', name: 'EMS mode', value: 2, result: 'notReleased', detail: '' },
            ]),
        );
    if (id.includes('35017')) return st(Math.round(7400 + 300 * Math.sin(s / 7)));
    if (id.includes('43023')) return st(84.8);
    if (id.includes('43022')) return st(2150);
    if (id.includes('43021')) return st(4.6);
    if (id.includes('35601')) return st(-3810);
    if (id.includes('43002')) return st(21.4);
    if (id.includes('35008')) return st(38.2);
    if (id.includes('73031')) return st(100);
    if (id.includes('53050')) return st(0);
    if (id.includes('holdingRegisters')) return st(0);
    return null;
}

const socket: any = {
    getForeignStates: async (ids: string[]) => Object.fromEntries(ids.map(id => [id, simulated(id)])),
    getState: async (id: string) => simulated(id),
    subscribeState: async () => {},
    unsubscribeState: () => {},
    getObjectViewSystem: async () => ({}),
    sendTo: async (_inst: string, cmd: string, msg: any) => {
        await new Promise(r => setTimeout(r, 600));
        if (cmd === 'probe') return { words: [848], raw: 848, value: 848 * Number(msg.factor || 1), ms: 11 };
        if (cmd === 'wizardTest')
            return { ok: true, ms: 1840, deviceTypeCode: 0x0e26, serial: 'A2290000000', batteryVoltage: 512.3, batteryLevel: 84.8, unit2Level: 85.6 };
        return {};
    },
};

export default function App(): React.JSX.Element {
    const [theme] = React.useState(() => Theme(themeName as any));
    const [tab, setTab] = React.useState(Number(params.get('tab') || 0));
    const [data, setData] = React.useState<any>(() => {
        const n = JSON.parse(JSON.stringify(ioPackage.native));
        if (params.get('host') !== '') n.host = params.get('host') || '192.168.30.40';
        return n;
    });
    const names = ['Overview', 'Catalog', 'Control', 'Diagnostics'] as const;
    const labels =
        language === 'de'
            ? ['Übersicht', 'Register', 'Steuerung', 'Werkzeuge', 'Verbindung', 'Experte']
            : ['Overview', 'Registers', 'Control', 'Tools', 'Connection', 'Expert'];
    const C: any = (Components as any)[names[Math.min(tab, 3)]];
    return (
        <StyledEngineProvider injectFirst>
            <ThemeProvider theme={theme}>
                <CssBaseline />
                <Box sx={{ p: 2, bgcolor: 'background.default', minHeight: '100vh' }}>
                    <Tabs
                        value={tab}
                        onChange={(_e, v) => setTab(v)}
                        variant="scrollable"
                        sx={{ mb: 2 }}
                    >
                        {labels.map(n => (
                            <Tab
                                key={n}
                                label={n}
                            />
                        ))}
                    </Tabs>
                    {tab >= 3 ? (
                        <Box sx={{ mb: 2, p: 2, border: '1px dashed', borderColor: 'divider', borderRadius: 3, color: 'text.secondary' }}>
                            {tab === 3
                                ? language === 'de'
                                    ? 'Oben auf diesem Reiter: die bekannte Umrechnungshilfe (Adresse in allen Schreibweisen, Datentyp, Faktor, Testlesen). Darunter die Diagnose:'
                                    : 'At the top of this tab: the conversion helper (address in all notations, data type, factor, test read). Below the diagnostics:'
                                : language === 'de'
                                  ? tab === 4
                                      ? 'Verbindung: IP-Adresse und Port des WiNet-S2; aufklappbar „Erweitert“ mit Zeiten, Schreib-Optionen, Blockbildung und Bus-Kapazität (Standard-Admin-Felder).'
                                      : 'Experte: Gruppen-, Input- und Holding-Tabelle wie bisher – für Massenänderungen (Standard-Admin-Tabellen).'
                                  : 'Standard admin fields (jsonConfig).'}
                        </Box>
                    ) : null}
                    {tab <= 3 ? (
                    <C
                        key={tab}
                        oContext={{
                            adapterName: 'sungrow-local',
                            socket,
                            instance: 0,
                            themeType: theme.palette.mode,
                            isFloatComma: true,
                            dateFormat: 'DD.MM.YYYY',
                            forceUpdate: () => {},
                            systemConfig: {} as any,
                            theme,
                            _themeName: themeName,
                            onCommandRunning: () => {},
                        }}
                        alive
                        changed={false}
                        themeName={themeName}
                        common={{}}
                        attr="_custom"
                        data={data}
                        originalData={data}
                        onError={() => {}}
                        schema={{ type: 'custom', name: names[tab], url: '' }}
                        onChange={(d: any, _v: any, cb?: () => void) => {
                            if (d && typeof d === 'object') setData(d);
                            cb?.();
                        }}
                    />
                    ) : null}
                </Box>
            </ThemeProvider>
        </StyledEngineProvider>
    );
}
