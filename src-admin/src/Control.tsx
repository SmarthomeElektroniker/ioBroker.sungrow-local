/*
 * Control: writable (holding) registers separately, writing released per register, value range, global
 * read-only switch and the log of the last write commands (info.write.log).
 */
import React from 'react';
import {
    Alert,
    Box,
    Button,
    Chip,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
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
    stateHelp,
    stateTexts,
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
    React.useEffect(
        () => setV(props.value === undefined || props.value === null ? '' : String(props.value)),
        [props.value],
    );
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

/** Current value and - when released - a selection (value table) or a number field to write a new value */
function ValueCell(props: {
    cprops: ConfigGenericProps;
    refRow: RowRef;
    st: ioBroker.State | undefined;
    texts: Record<string, string> | undefined;
    blocked: string;
}): React.JSX.Element {
    const { refRow: ref, st, texts } = props;
    const v = st ? st.val : undefined;
    const [pending, setPending] = React.useState<string | null>(null);
    const [num, setNum] = React.useState('');
    const [info, setInfo] = React.useState('');
    const unit = ref.row.unit ? ` ${String(ref.row.unit)}` : '';
    const label = rowLabel(ref.regType, ref.row);
    const write = async (val: string): Promise<void> => {
        const id = `${props.cprops.oContext.adapterName}.${props.cprops.oContext.instance}.${rowStateId(ref.regType, ref.row)}`;
        try {
            await props.cprops.oContext.socket.setState(id, { val: Number(val), ack: false });
            setInfo(t('writeSent'));
        } catch (e) {
            setInfo(String((e as Error).message || e));
        }
    };
    const current = v === undefined || v === null ? '' : String(v);
    return (
        <Box>
            {texts ? (
                <TextField
                    select
                    size="small"
                    value={current in texts ? current : ''}
                    onChange={e => setPending(e.target.value)}
                    disabled={!!props.blocked}
                    sx={{ minWidth: 220 }}
                    slotProps={{ htmlInput: { 'aria-label': `${t('colValue')}: ${label}` } }}
                    helperText={props.blocked || stateHelp(ref.regType, ref.row, current)}
                >
                    {Object.entries(texts).map(([k, x]) => (
                        <MenuItem
                            key={k}
                            value={k}
                            sx={{ display: 'block', whiteSpace: 'normal', maxWidth: 420 }}
                        >
                            <Typography variant="body2">
                                {x} <span style={{ opacity: 0.6 }}>({k})</span>
                            </Typography>
                            {stateHelp(ref.regType, ref.row, k) ? (
                                <Typography
                                    variant="caption"
                                    color="text.secondary"
                                >
                                    {stateHelp(ref.regType, ref.row, k)}
                                </Typography>
                            ) : null}
                        </MenuItem>
                    ))}
                </TextField>
            ) : (
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                    <Typography
                        variant="body2"
                        sx={{ fontVariantNumeric: 'tabular-nums', minWidth: 70 }}
                    >
                        {current === '' ? '–' : `${current}${unit}`}
                    </Typography>
                    {!props.blocked ? (
                        <>
                            <TextField
                                size="small"
                                value={num}
                                onChange={e => setNum(e.target.value)}
                                placeholder={t('newValue')}
                                slotProps={{
                                    htmlInput: {
                                        inputMode: 'decimal',
                                        'aria-label': `${t('newValue')}: ${label}`,
                                        style: { width: 80, padding: '4px 6px' },
                                    },
                                }}
                            />
                            <Button
                                size="small"
                                disabled={num.trim() === '' || !Number.isFinite(Number(num.replace(',', '.')))}
                                onClick={() => setPending(num.replace(',', '.'))}
                            >
                                {t('write')}
                            </Button>
                        </>
                    ) : null}
                </Box>
            )}
            {!texts && props.blocked ? (
                <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: 'block' }}
                >
                    {props.blocked}
                </Typography>
            ) : null}
            {st ? (
                <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: 'block' }}
                >
                    {ago(st.ts)}
                    {st.ack === false ? ` · ${t('notConfirmed')}` : ''}
                    {info ? ` · ${info}` : ''}
                </Typography>
            ) : null}
            <Dialog
                open={pending !== null}
                onClose={() => setPending(null)}
            >
                <DialogTitle>{t('confirmWriteTitle')}</DialogTitle>
                <DialogContent>
                    <Typography>
                        {t(
                            'confirmWrite',
                            label,
                            pending === null
                                ? ''
                                : texts && texts[pending]
                                  ? `${texts[pending]} (${pending})`
                                  : `${pending}${unit}`,
                        )}
                    </Typography>
                    {pending !== null && stateHelp(ref.regType, ref.row, pending) ? (
                        <Typography
                            variant="body2"
                            color="text.secondary"
                            sx={{ mt: 1 }}
                        >
                            {stateHelp(ref.regType, ref.row, pending)}
                        </Typography>
                    ) : null}
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setPending(null)}>{t('cancel')}</Button>
                    <Button
                        variant="contained"
                        color="warning"
                        onClick={() => {
                            const val = pending;
                            setPending(null);
                            if (val !== null) {
                                void write(val);
                            }
                        }}
                    >
                        {t('write')}
                    </Button>
                </DialogActions>
            </Dialog>
        </Box>
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
                <Box
                    sx={{
                        p: 2,
                        borderRadius: 3,
                        border: '1px solid',
                        borderColor: data.readOnly ? 'warning.main' : 'divider',
                    }}
                >
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
                            const texts = stateTexts(ref.regType, ref.row);
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
                                            {t('regNr', docOf(ref.regType, ref.row))} ·{' '}
                                            {rowStateId(ref.regType, ref.row)}
                                            {!isActive(ref) ? ` · ${t('notPolled')}` : ''}
                                        </Typography>
                                    </TableCell>
                                    <TableCell>
                                        <ValueCell
                                            cprops={props}
                                            refRow={ref}
                                            st={st}
                                            texts={texts}
                                            blocked={
                                                !props.alive
                                                    ? t('blockedNotAlive')
                                                    : data.readOnly
                                                      ? t('blockedReadOnly')
                                                      : !ref.row.allowWrite
                                                        ? t('blockedNotReleased')
                                                        : !isActive(ref)
                                                          ? t('blockedNotPolled')
                                                          : props.changed
                                                            ? t('blockedUnsaved')
                                                            : ''
                                            }
                                        />
                                    </TableCell>
                                    <TableCell>
                                        {texts ? (
                                            <Typography
                                                variant="caption"
                                                color="text.secondary"
                                                sx={{ display: 'block', maxWidth: 260 }}
                                            >
                                                {t('selectionN', Object.keys(texts).length)}
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
                                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                                        {new Date(e.ts).toLocaleString()}
                                    </TableCell>
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
