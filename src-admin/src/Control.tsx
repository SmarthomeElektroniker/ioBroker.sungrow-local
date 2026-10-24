/*
 * Control: writable (holding) registers separately, writing released per register, value range, global
 * read-only switch and the log of the last write commands (info.write.log).
 */
import React from 'react';
import {
    Alert,
    Box,
    Chip,
    FormControlLabel,
    MenuItem,
    Switch,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    TextField,
    Typography,
} from '@mui/material';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';

import {
    type Native,
    type RowRef,
    allRows,
    clone,
    docOf,
    isActive,
    parseStates,
    rowLabel,
    rowStateId,
    t,
    useStates,
    ago,
} from './shared';

const RESULT_COLORS: Record<string, 'success' | 'warning' | 'error' | 'default' | 'info'> = {
    ok: 'success',
    mismatch: 'warning',
    unconfirmed: 'warning',
    failed: 'error',
    readOnly: 'default',
    notReleased: 'default',
    rejected: 'error',
};

function RangeField(props: { value: unknown; label: string; onCommit: (v: string) => void }): React.JSX.Element {
    const [v, setV] = React.useState(props.value === undefined || props.value === null ? '' : String(props.value));
    React.useEffect(() => setV(props.value === undefined || props.value === null ? '' : String(props.value)), [props.value]);
    return (
        <TextField
            size="small"
            value={v}
            onChange={e => setV(e.target.value)}
            onBlur={() => v !== String(props.value ?? '') && props.onCommit(v.trim())}
            slotProps={{ htmlInput: { 'aria-label': props.label, style: { width: 64, padding: '4px 6px' } } }}
        />
    );
}

export function ControlView(props: ConfigGenericProps & { onData: (d: Native) => void }): React.JSX.Element {
    const data = props.data as Native;
    const [showAll, setShowAll] = React.useState(false);
    const holding = allRows(data).filter(r => r.regType === 'holdingRegs');
    const list = showAll ? holding : holding.filter(r => isActive(r) || r.row.allowWrite);
    const states = useStates(props, [...list.map(r => rowStateId(r.regType, r.row)), 'info.write.log'], 5000);
    let log: any[] = [];
    try {
        const s = states['info.write.log'];
        log = s && typeof s.val === 'string' ? JSON.parse(s.val) : [];
    } catch {
        log = [];
    }
    const released = holding.filter(r => r.row.allowWrite && isActive(r)).length;

    const setRow = (ref: RowRef, patch: Record<string, unknown>): void => {
        const out = clone(data);
        Object.assign(out.holdingRegs[ref.index], patch);
        props.onData(out);
    };
    const setNative = (patch: Record<string, unknown>): void => {
        const out = clone(data);
        Object.assign(out, patch);
        props.onData(out);
    };

    return (
        <Box sx={{ width: '100%' }}>
            <Box
                sx={{
                    display: 'grid',
                    gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
                    gap: 2,
                    mb: 2,
                }}
            >
                <Box sx={{ p: 2, borderRadius: 3, border: '1px solid', borderColor: data.readOnly ? 'warning.main' : 'divider' }}>
                    <FormControlLabel
                        control={
                            <Switch
                                checked={!!data.readOnly}
                                onChange={e => setNative({ readOnly: e.target.checked })}
                            />
                        }
                        label={<Typography sx={{ fontWeight: 600 }}>{t('readOnly')}</Typography>}
                    />
                    <Typography
                        variant="body2"
                        color="text.secondary"
                    >
                        {t('readOnlyHelp')}
                    </Typography>
                </Box>
                <Box sx={{ p: 2, borderRadius: 3, border: '1px solid', borderColor: 'divider' }}>
                    <TextField
                        select
                        size="small"
                        fullWidth
                        label={t('writeCheck')}
                        value={data.writeCheck === 'reject' ? 'reject' : 'warn'}
                        onChange={e => setNative({ writeCheck: e.target.value })}
                    >
                        <MenuItem value="warn">{t('writeCheck_warn')}</MenuItem>
                        <MenuItem value="reject">{t('writeCheck_reject')}</MenuItem>
                    </TextField>
                    <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{ mt: 1 }}
                    >
                        {t('writeCheckHelp')}
                    </Typography>
                </Box>
            </Box>
            {data.readOnly ? (
                <Alert
                    severity="warning"
                    sx={{ mb: 2 }}
                >
                    {t('readOnlyActive')}
                </Alert>
            ) : (
                <Alert
                    severity={released ? 'info' : 'success'}
                    sx={{ mb: 2 }}
                >
                    {released ? t('releasedCount', released) : t('nothingReleased')}
                </Alert>
            )}
            <Box sx={{ display: 'flex', alignItems: 'center', mb: 1 }}>
                <Typography
                    variant="h6"
                    sx={{ fontWeight: 600, flex: 1 }}
                >
                    {t('writableTitle')}
                </Typography>
                <FormControlLabel
                    control={
                        <Switch
                            size="small"
                            checked={showAll}
                            onChange={e => setShowAll(e.target.checked)}
                        />
                    }
                    label={<Typography variant="body2">{t('showInactive')}</Typography>}
                />
            </Box>
            <TableContainer sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 3 }}>
                <Table
                    size="small"
                    aria-label={t('writableTitle')}
                >
                    <TableHead>
                        <TableRow>
                            <TableCell>{t('colRegister')}</TableCell>
                            <TableCell>{t('colValue')}</TableCell>
                            <TableCell>{t('colRange')}</TableCell>
                            <TableCell>{t('colAllowWrite')}</TableCell>
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {list.map(ref => {
                            const st = states[rowStateId(ref.regType, ref.row)];
                            const texts = parseStates(ref.row.states);
                            const v = st ? st.val : undefined;
                            const label = rowLabel(ref.regType, ref.row);
                            return (
                                <TableRow
                                    key={ref.key}
                                    hover
                                    sx={{ opacity: isActive(ref) ? 1 : 0.6 }}
                                >
                                    <TableCell sx={{ maxWidth: 320 }}>
                                        <Typography
                                            variant="body2"
                                            sx={{ fontWeight: 500 }}
                                        >
                                            {label}
                                        </Typography>
                                        <Typography
                                            variant="caption"
                                            color="text.secondary"
                                        >
                                            {t('regNr', docOf(ref.regType, ref.row))} · {rowStateId(ref.regType, ref.row)}
                                            {!isActive(ref) ? ` · ${t('notPolled')}` : ''}
                                        </Typography>
                                    </TableCell>
                                    <TableCell>
                                        <Typography
                                            variant="body2"
                                            sx={{ fontVariantNumeric: 'tabular-nums' }}
                                        >
                                            {v === undefined || v === null
                                                ? '–'
                                                : `${String(v)}${ref.row.unit ? ` ${String(ref.row.unit)}` : ''}${
                                                      texts && texts[String(v)] ? ` (${texts[String(v)]})` : ''
                                                  }`}
                                        </Typography>
                                        {st ? (
                                            <Typography
                                                variant="caption"
                                                color="text.secondary"
                                            >
                                                {ago(st.ts)}
                                            </Typography>
                                        ) : null}
                                    </TableCell>
                                    <TableCell>
                                        {texts ? (
                                            <Typography
                                                variant="caption"
                                                color="text.secondary"
                                                sx={{ display: 'block', maxWidth: 260 }}
                                            >
                                                {Object.entries(texts)
                                                    .map(([k, x]) => `${k}=${x}`)
                                                    .join(', ')}
                                            </Typography>
                                        ) : (
                                            <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
                                                <RangeField
                                                    value={ref.row.min}
                                                    label={`${t('min')} ${label}`}
                                                    onCommit={x => setRow(ref, { min: x })}
                                                />
                                                <Typography variant="body2">…</Typography>
                                                <RangeField
                                                    value={ref.row.max}
                                                    label={`${t('max')} ${label}`}
                                                    onCommit={x => setRow(ref, { max: x })}
                                                />
                                            </Box>
                                        )}
                                    </TableCell>
                                    <TableCell>
                                        <Switch
                                            checked={!!ref.row.allowWrite}
                                            onChange={e => setRow(ref, { allowWrite: e.target.checked })}
                                            slotProps={{ input: { 'aria-label': `${t('colAllowWrite')}: ${label}` } }}
                                        />
                                    </TableCell>
                                </TableRow>
                            );
                        })}
                    </TableBody>
                </Table>
            </TableContainer>
            <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', mt: 1 }}
            >
                {t('writableHint')}
            </Typography>

            <Typography
                variant="h6"
                sx={{ fontWeight: 600, mt: 3, mb: 1 }}
            >
                {t('writeLogTitle')}
            </Typography>
            {!log.length ? (
                <Typography
                    variant="body2"
                    color="text.secondary"
                >
                    {props.alive ? t('writeLogEmpty') : t('notAlive')}
                </Typography>
            ) : (
                <TableContainer sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 3 }}>
                    <Table
                        size="small"
                        aria-label={t('writeLogTitle')}
                    >
                        <TableHead>
                            <TableRow>
                                <TableCell>{t('colTime')}</TableCell>
                                <TableCell>{t('colRegister')}</TableCell>
                                <TableCell>{t('colRequested')}</TableCell>
                                <TableCell>{t('colResult')}</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {log.map((e, i) => (
                                <TableRow key={i}>
                                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{new Date(e.ts).toLocaleString()}</TableCell>
                                    <TableCell>
                                        <Typography variant="body2">{e.name}</Typography>
                                        <Typography
                                            variant="caption"
                                            color="text.secondary"
                                        >
                                            {e.id}
                                        </Typography>
                                    </TableCell>
                                    <TableCell>{e.value === null ? '–' : String(e.value)}</TableCell>
                                    <TableCell>
                                        <Chip
                                            size="small"
                                            color={RESULT_COLORS[e.result] || 'default'}
                                            label={t(`result_${e.result}`)}
                                        />
                                        {e.detail ? (
                                            <Typography
                                                variant="caption"
                                                color="text.secondary"
                                                sx={{ ml: 1 }}
                                            >
                                                {e.detail}
                                            </Typography>
                                        ) : null}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </TableContainer>
            )}
        </Box>
    );
}

/** jsonConfig custom component "Control" */
export default class Control extends ConfigGeneric<ConfigGenericProps, ConfigGenericState> {
    onData = (data: Native): void => {
        this.props.onChange(data, undefined, () => {
            this.props.oContext.forceUpdate(['holdingRegs', 'readOnly', 'writeCheck'], data);
        });
    };

    renderItem(): React.JSX.Element {
        return (
            <ControlView
                {...this.props}
                onData={this.onData}
            />
        );
    }
}
