// Smoke test (node, server side rendering): every exported component renders with a simulated admin context.
import React from 'react';
import { renderToString } from 'react-dom/server';
import { ThemeProvider } from '@mui/material/styles';
import { I18n, Theme } from '@iobroker/gui-components';
import { OverviewView } from './Overview';
import { CatalogView } from './Catalog';
import { ControlView } from './Control';
import { DiagnosticsView } from './Diagnostics';

// the jsonConfig wrappers (ConfigGeneric) render only after componentDidMount - the views are rendered directly
const Components: Record<string, any> = {
    Overview: OverviewView,
    Catalog: CatalogView,
    Control: ControlView,
    Diagnostics: DiagnosticsView,
};
import ioPackage from '../../io-package.json';
import en from './i18n/en.json';

export function renderAll(host: string): Record<string, string> {
    I18n.extendTranslations(en as any, 'en');
    I18n.setLanguage('en');
    const theme = Theme('light' as any);
    const socket: any = {
        getForeignStates: async () => ({}),
        getObjectViewSystem: async () => ({}),
        sendTo: async () => ({}),
    };
    const data = JSON.parse(JSON.stringify(ioPackage.native));
    data.host = host;
    const out: Record<string, string> = {};
    for (const [name, C] of Object.entries(Components)) {
        out[name] = renderToString(
            <ThemeProvider theme={theme}>
                <C
                    oContext={{
                        adapterName: 'sungrow-local',
                        socket,
                        instance: 0,
                        themeType: 'light',
                        isFloatComma: true,
                        dateFormat: '',
                        forceUpdate: () => {},
                        systemConfig: {},
                        theme,
                        _themeName: 'light',
                        onCommandRunning: () => {},
                    }}
                    alive={false}
                    changed={false}
                    themeName="light"
                    common={{}}
                    attr="_custom"
                    data={data}
                    originalData={data}
                    onError={() => {}}
                    schema={{ type: 'custom', name, url: '' }}
                    onChange={() => {}}
                    onData={() => {}}
                />
            </ThemeProvider>,
        );
    }
    return out;
}
