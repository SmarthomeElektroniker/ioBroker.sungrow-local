/*
 * Setup wizard: gateway address, connection test (device type code, serial number, battery), profile
 * Basic / Battery / Extended with a preview of the bus load.
 */
import React from 'react';
import {
    Alert,
    Box,
    Button,
    Checkbox,
    FormControlLabel,
    LinearProgress,
    Radio,
    Step,
    StepLabel,
    Stepper,
    TextField,
    Typography,
} from '@mui/material';
import type { ConfigGenericProps } from '@iobroker/json-config';

import {
    type Native,
    allRows,
    analyseNative,
    clone,
    metaOf,
    parseStates,
    sendTo,
    t,
    unitOf,
    aliasOf,
    LEVEL_COLORS,
} from './shared';
import { LoadBar } from './BusLoad';

const PROFILES = ['basis', 'akku', 'erweitert'] as const;
type Profile = (typeof PROFILES)[number];

/** Configuration with the registers of a profile ticked (rows without template data stay as they are) */
export function applyProfile(data: Native, profile: Profile, opts: { unit2: boolean }): Native {
    const out = clone(data);
    const rank = PROFILES.indexOf(profile);
    for (const ref of allRows(out)) {
        const m = metaOf(ref.regType, ref.row);
        if (!m || !m.profile) {
            continue;
        }
        let on = PROFILES.indexOf(m.profile as Profile) <= rank && PROFILES.indexOf(m.profile as Profile) >= 0;
        if (unitOf(ref.row) === 2 && !opts.unit2) {
            on = false;
        }
        const row = out[ref.regType][ref.index];
        row.enabled = on;
        if (ref.regType === 'holdingRegs' && on) {
            row.poll = true;
        }
    }
    return out;
}

/** Model name from the device type code (value table of the template row "Device type code") */
function modelOf(data: Native, code: number | undefined): string {
    if (code === undefined) {
        return '';
    }
    const row = (data.inputRegs || []).find(r => aliasOf(r) === 35000 && unitOf(r) === 1);
    const states = row ? parseStates(row.states) : undefined;
    return (states && states[String(code)]) || `0x${code.toString(16).toUpperCase()}`;
}

export default function Wizard(
    props: ConfigGenericProps & { onData: (d: Native) => void; onClose?: () => void },
): React.JSX.Element {
    const data = props.data as Native;
    const [step, setStep] = React.useState(0);
    const [host, setHost] = React.useState(String(data.host || ''));
    const [port, setPort] = React.useState(String(data.port || 502));
    const [battery2, setBattery2] = React.useState(true);
    const [test, setTest] = React.useState<{ running?: boolean; result?: any; error?: string }>({});
    const [profile, setProfile] = React.useState<Profile | ''>('');
    const [conflict, setConflict] = React.useState<string>('');

    // another instance of this adapter that talks to the same gateway: the WiNet-S2 serves one client only
    React.useEffect(() => {
        let stop = false;
        void (async () => {
            try {
                const objs = await props.oContext.socket.getObjectViewSystem(
                    'instance',
                    `system.adapter.${props.oContext.adapterName}.`,
                    `system.adapter.${props.oContext.adapterName}.香`,
                );
                const own = `system.adapter.${props.oContext.adapterName}.${props.oContext.instance}`;
                const other = Object.values(objs || {}).find(
                    (o: any) =>
                        o &&
                        o._id !== own &&
                        o.common?.enabled &&
                        String(o.native?.host || '').trim() === host.trim() &&
                        host.trim(),
                ) as any;
                if (!stop) {
                    setConflict(other ? other._id.replace('system.adapter.', '') : '');
                }
            } catch {
                // no check possible
            }
        })();
        return () => {
            stop = true;
        };
    }, [host, props.oContext]);

    const result = test.result;
    const batteryAt1 = !!result && (result.batteryVoltage > 0 || result.batteryLevel > 0);
    const unit2 = !!result && typeof result.unit2Level === 'number';
    const suggested: Profile = unit2 ? 'erweitert' : batteryAt1 ? 'akku' : 'basis';
    const chosen: Profile = profile || suggested;

    const runTest = async (): Promise<void> => {
        setTest({ running: true });
        try {
            const r = await sendTo(props, 'wizardTest', { host: host.trim(), port, unit: 1, battery2 }, 45000);
            if (!r || r.ok === false) {
                setTest({ error: (r && r.error) || t('noAnswer') });
            } else {
                setTest({ result: r });
                setStep(2);
            }
        } catch (e) {
            setTest({ error: String((e as Error).message || e) });
        }
    };

    const preview = (p: Profile): any => analyseNative(applyProfile(data, p, { unit2 }));

    const finish = (): void => {
        const out = applyProfile(data, chosen, { unit2 });
        out.host = host.trim();
        out.port = parseInt(port, 10) || 502;
        props.onData(out);
        props.onClose?.();
    };

    return (
        <Box
            sx={{
                p: { xs: 2, sm: 3 },
                borderRadius: 3,
                border: '1px solid',
                borderColor: 'primary.main',
                bgcolor: 'background.paper',
            }}
        >
            <Typography
                variant="h6"
                sx={{ mb: 0.5 }}
            >
                {t('wizardTitle')}
            </Typography>
            <Typography
                variant="body2"
                color="text.secondary"
                sx={{ mb: 2 }}
            >
                {t('wizardIntro')}
            </Typography>
            <Stepper
                activeStep={step}
                alternativeLabel
                sx={{ mb: 3 }}
            >
                {[t('wizStep1'), t('wizStep2'), t('wizStep3')].map(l => (
                    <Step key={l}>
                        <StepLabel>{l}</StepLabel>
                    </Step>
                ))}
            </Stepper>
            {step <= 1 ? (
                <Box>
                    <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                        <TextField
                            label={t('host')}
                            value={host}
                            onChange={e => {
                                setHost(e.target.value);
                                setStep(e.target.value.trim() ? 1 : 0);
                            }}
                            placeholder="192.168.1.50"
                            helperText={t('hostHelp')}
                            sx={{ flex: '1 1 240px' }}
                        />
                        <TextField
                            label={t('port')}
                            value={port}
                            onChange={e => setPort(e.target.value)}
                            sx={{ width: 120 }}
                            slotProps={{ htmlInput: { inputMode: 'numeric' } }}
                        />
                    </Box>
                    <FormControlLabel
                        sx={{ mt: 1 }}
                        control={
                            <Checkbox
                                checked={battery2}
                                onChange={e => setBattery2(e.target.checked)}
                            />
                        }
                        label={t('checkUnit2')}
                    />
                    {conflict ? (
                        <Alert
                            severity="error"
                            sx={{ mt: 1 }}
                        >
                            {t('wizardConflict', conflict)}
                        </Alert>
                    ) : null}
                    {!props.alive ? (
                        <Alert
                            severity="info"
                            sx={{ mt: 1 }}
                        >
                            {t('wizardNotAlive')}
                        </Alert>
                    ) : null}
                    {test.running ? <LinearProgress sx={{ mt: 2 }} /> : null}
                    {test.error ? (
                        <Alert
                            severity="error"
                            sx={{ mt: 2 }}
                        >
                            {t('wizardError', test.error)}
                            {/ECONNRESET|reset/i.test(test.error) ? ` ${t('wizardWhitelist')}` : ''}
                        </Alert>
                    ) : null}
                    <Box sx={{ display: 'flex', gap: 1, mt: 2, flexWrap: 'wrap' }}>
                        <Button
                            variant="contained"
                            onClick={() => void runTest()}
                            disabled={!host.trim() || test.running || !!conflict || !props.alive}
                        >
                            {t('testConnection')}
                        </Button>
                        <Button
                            onClick={() => setStep(2)}
                            disabled={!host.trim()}
                        >
                            {t('skipTest')}
                        </Button>
                        {props.onClose ? <Button onClick={props.onClose}>{t('cancel')}</Button> : null}
                    </Box>
                </Box>
            ) : (
                <Box>
                    {result ? (
                        <Alert
                            severity="success"
                            sx={{ mb: 2 }}
                        >
                            <Typography
                                variant="body2"
                                sx={{ fontWeight: 600 }}
                            >
                                {t(
                                    'wizardFound',
                                    modelOf(data, result.deviceTypeCode),
                                    result.serial || '–',
                                    result.ms,
                                )}
                            </Typography>
                            <Typography variant="body2">
                                {batteryAt1
                                    ? t('wizardBattery', result.batteryLevel, result.batteryVoltage)
                                    : t('wizardNoBattery')}
                            </Typography>
                            {battery2 ? (
                                <Typography variant="body2">
                                    {unit2 ? t('wizardUnit2', result.unit2Level) : t('wizardNoUnit2')}
                                </Typography>
                            ) : null}
                        </Alert>
                    ) : (
                        <Alert
                            severity="info"
                            sx={{ mb: 2 }}
                        >
                            {t('wizardUntested')}
                        </Alert>
                    )}
                    <Typography
                        variant="subtitle2"
                        sx={{ mb: 1 }}
                    >
                        {t('chooseProfile')}
                    </Typography>
                    <Box
                        role="radiogroup"
                        sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(3, 1fr)' }, gap: 1.5 }}
                    >
                        {PROFILES.map(p => {
                            const a = preview(p);
                            const sel = chosen === p;
                            return (
                                <Box
                                    key={p}
                                    role="radio"
                                    aria-checked={sel}
                                    tabIndex={0}
                                    onClick={() => setProfile(p)}
                                    onKeyDown={e => (e.key === ' ' || e.key === 'Enter') && setProfile(p)}
                                    sx={{
                                        p: 1.5,
                                        borderRadius: 2,
                                        border: '2px solid',
                                        borderColor: sel ? 'primary.main' : 'divider',
                                        cursor: 'pointer',
                                        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' },
                                    }}
                                >
                                    <Box sx={{ display: 'flex', alignItems: 'center' }}>
                                        <Radio
                                            checked={sel}
                                            size="small"
                                            tabIndex={-1}
                                        />
                                        <Typography sx={{ fontWeight: 600 }}>{t(`profile_${p}`)}</Typography>
                                        {p === suggested ? (
                                            <Typography
                                                variant="caption"
                                                sx={{ ml: 1, color: 'primary.main', fontWeight: 600 }}
                                            >
                                                {t('suggested')}
                                            </Typography>
                                        ) : null}
                                    </Box>
                                    <Typography
                                        variant="body2"
                                        color="text.secondary"
                                        sx={{ mb: 1 }}
                                    >
                                        {t(`profileDesc_${p}`)}
                                    </Typography>
                                    <LoadBar
                                        load={a.total.load}
                                        level={a.total.level}
                                    />
                                    <Typography
                                        variant="caption"
                                        sx={{ color: LEVEL_COLORS[a.total.level as 'ok'], display: 'block', mt: 0.5 }}
                                    >
                                        {t(
                                            'profileStats',
                                            a.total.registers,
                                            a.total.requests,
                                            Math.round(a.total.load * 100),
                                        )}
                                    </Typography>
                                </Box>
                            );
                        })}
                    </Box>
                    <Box sx={{ display: 'flex', gap: 1, mt: 2, flexWrap: 'wrap' }}>
                        <Button onClick={() => setStep(1)}>{t('back')}</Button>
                        <Button
                            variant="contained"
                            onClick={finish}
                        >
                            {t('applyProfile')}
                        </Button>
                        {props.onClose ? <Button onClick={props.onClose}>{t('cancel')}</Button> : null}
                    </Box>
                    <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ display: 'block', mt: 1 }}
                    >
                        {t('wizardSaveHint')}
                    </Typography>
                </Box>
            )}
        </Box>
    );
}
