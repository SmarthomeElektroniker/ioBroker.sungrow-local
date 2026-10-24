/*
 * Own register: address in any notation (Sungrow document from 1, protocol from 0, column 30001/40001,
 * Modicon 6-digit) with the converter of the adapter, off-by-one warning, test read before saving.
 */
import React from 'react';
import {
    Alert,
    Box,
    Button,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControlLabel,
    MenuItem,
    Switch,
    TextField,
    Typography,
} from '@mui/material';
import type { ConfigGenericProps } from '@iobroker/json-config';

import {
    type Group,
    type Native,
    type RegType,
    type Row,
    type RowRef,
    STRING_TYPES,
    TYPES,
    allRows,
    convert,
    lang,
    metaByKey,
    num,
    rowLabel,
    rowStateId,
    sendTo,
    t,
    unitOf,
} from './shared';

interface Props extends ConfigGenericProps {
    edit?: RowRef;
    groups: Group[];
    onClose: () => void;
    onSave: (regType: RegType, row: Row, index?: number) => void;
}

const NOTATIONS = ['auto', 'doc', 'protocol', 'column', 'modicon'];

export default function CustomRegisterDialog(props: Props): React.JSX.Element {
    const data = props.data as Native;
    const e = props.edit?.row;
    const [regType, setRegType] = React.useState<RegType>(props.edit?.regType || 'inputRegs');
    const [address, setAddress] = React.useState(e ? String(e._address) : '');
    const [mode, setMode] = React.useState(e ? 'column' : 'auto');
    const [choice, setChoice] = React.useState<'doc' | 'protocol'>('doc');
    const [unit, setUnit] = React.useState(e ? String(unitOf(e)) : '1');
    const [name, setName] = React.useState(e ? String(e.name || '') : '');
    const [description, setDescription] = React.useState(e ? String(e.description || '') : '');
    const [type, setType] = React.useState(e ? String(e.type || 'uint16be') : 'uint16be');
    const [len, setLen] = React.useState(e ? String(e.len || 1) : '1');
    const [factor, setFactor] = React.useState(e ? String(e.factor ?? 1) : '1');
    const [offset, setOffset] = React.useState(e ? String(e.offset ?? 0) : '0');
    const [unitText, setUnitText] = React.useState(e ? String(e.unit || '') : '');
    const [group, setGroup] = React.useState(e ? String(e.group || '') : props.groups[0]?.name || 'live');
    const [allowWrite, setAllowWrite] = React.useState(e ? !!e.allowWrite : false);
    const [min, setMin] = React.useState(e ? String(e.min ?? '') : '');
    const [max, setMax] = React.useState(e ? String(e.max ?? '') : '');
    const [test, setTest] = React.useState<{ running?: boolean; result?: any; error?: string }>({});

    // address in all notations (same functions as the conversion helper of the adapter)
    const res = convert.resolve({ address, addrMode: mode, regType });
    let a = res.a;
    if (!a && res.ambiguous) {
        a = convert.addresses(address, choice, regType);
    }
    const unitNr = parseInt(unit, 10) || 1;
    const known = a ? convert.knownAt(data, a.regType, unitNr, a.protocol) : null;
    const below = a && a.protocol > 0 ? convert.knownAt(data, a.regType, unitNr, a.protocol - 1) : null;
    const above = a ? convert.knownAt(data, a.regType, unitNr, a.protocol + 1) : null;
    const editingSame = known && e && known.column === parseInt(String(e._address), 10);
    const effRegType: RegType = a ? a.regType : regType;
    const row: Row = {
        enabled: true,
        _address: a ? a.column : '',
        deviceId: unitNr,
        name: name.trim(),
        description: description.trim(),
        unit: unitText.trim(),
        type,
        len: STRING_TYPES.includes(type) ? Math.max(1, parseInt(len, 10) || 1) : 1,
        factor: String(num(factor, 1)),
        offset: String(num(offset, 0)),
        role: effRegType === 'holdingRegs' ? 'level' : 'value',
        room: '',
        group,
        states: e ? String(e.states || '') : '',
    };
    if (effRegType === 'holdingRegs') {
        row.poll = true;
        row.allowWrite = allowWrite;
        row.min = min;
        row.max = max;
    }
    const id = a && row.name ? rowStateId(effRegType, row) : '';
    const duplicate =
        id &&
        allRows(data).some(
            r =>
                rowStateId(r.regType, r.row) === id &&
                !(props.edit && r.regType === props.edit.regType && r.index === props.edit.index),
        );
    const valid = !!a && !!row.name && !duplicate && (!known || editingSame);

    const runTest = async (): Promise<void> => {
        if (!a) {
            return;
        }
        setTest({ running: true });
        try {
            const r = await sendTo(props, 'probe', {
                regType: a.regType,
                deviceId: unitNr,
                address: a.protocol,
                type,
                len: row.len,
                factor: row.factor,
                offset: row.offset,
            });
            if (r && r.error) {
                setTest({ error: r.error });
            } else {
                setTest({ result: r });
            }
        } catch (err) {
            setTest({ error: String((err as Error).message || err) });
        }
    };

    /** translated name of a configured row found by the converter */
    const knownLabel = (k: any): string => {
        const m = metaByKey(`${a ? a.regType : regType}:${unitNr}:${k.column}`);
        return m?.name?.[lang()] || m?.name?.en || k.description || k.name;
    };
    const neighbour = (k: any, d: number): string =>
        k ? t('neighbour', d > 0 ? '+1' : '−1', knownLabel(k), k.column) : '';

    return (
        <Dialog
            open
            onClose={props.onClose}
            maxWidth="md"
            fullWidth
        >
            <DialogTitle>{props.edit ? t('editRegister') : t('customRegister')}</DialogTitle>
            <DialogContent>
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2, mt: 1 }}>
                    <TextField
                        select
                        label={t('regType')}
                        value={regType}
                        onChange={ev => setRegType(ev.target.value as RegType)}
                        disabled={!!props.edit}
                        helperText={t('regTypeHelp')}
                    >
                        <MenuItem value="inputRegs">{t('inputRegs')}</MenuItem>
                        <MenuItem value="holdingRegs">{t('holdingRegs')}</MenuItem>
                    </TextField>
                    <TextField
                        label={t('deviceId')}
                        value={unit}
                        onChange={ev => setUnit(ev.target.value)}
                        disabled={!!props.edit}
                        helperText={t('deviceIdHelp')}
                        slotProps={{ htmlInput: { inputMode: 'numeric' } }}
                    />
                    <TextField
                        label={t('address')}
                        value={address}
                        onChange={ev => setAddress(ev.target.value)}
                        disabled={!!props.edit}
                        autoFocus={!props.edit}
                        slotProps={{ htmlInput: { inputMode: 'numeric' } }}
                        helperText={t('addressHelp')}
                    />
                    <TextField
                        select
                        label={t('notation')}
                        value={mode}
                        onChange={ev => setMode(ev.target.value)}
                        disabled={!!props.edit}
                    >
                        {NOTATIONS.map(n => (
                            <MenuItem
                                key={n}
                                value={n}
                            >
                                {t(`notation_${n}`)}
                            </MenuItem>
                        ))}
                    </TextField>
                </Box>
                {res.ambiguous && !res.a ? (
                    <Alert
                        severity="info"
                        sx={{ mt: 2 }}
                    >
                        <Typography variant="body2">{t('ambiguous', address)}</Typography>
                        <Box sx={{ display: 'flex', gap: 1, mt: 1, flexWrap: 'wrap' }}>
                            {(['doc', 'protocol'] as const).map(c => (
                                <Button
                                    key={c}
                                    size="small"
                                    variant={choice === c ? 'contained' : 'outlined'}
                                    onClick={() => setChoice(c)}
                                >
                                    {t(`notation_${c}`)}
                                </Button>
                            ))}
                        </Box>
                    </Alert>
                ) : null}
                {a ? (
                    <Box
                        sx={{
                            mt: 2,
                            p: 1.5,
                            borderRadius: 2,
                            bgcolor: 'action.hover',
                            display: 'grid',
                            gridTemplateColumns: { xs: '1fr 1fr', sm: 'repeat(4, 1fr)' },
                            gap: 1,
                        }}
                    >
                        {(['doc', 'protocol', 'column', 'modicon'] as const).map(n => (
                            <Box key={n}>
                                <Typography
                                    variant="caption"
                                    color="text.secondary"
                                >
                                    {t(`notationShort_${n}`)}
                                </Typography>
                                <Typography
                                    variant="body1"
                                    sx={{ fontWeight: 600, fontFamily: 'monospace' }}
                                >
                                    {a[n]}
                                </Typography>
                            </Box>
                        ))}
                        <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{ gridColumn: '1 / -1' }}
                        >
                            {t('fcInfo', a.fc, a.regType === 'inputRegs' ? t('inputRegs') : t('holdingRegs'))}
                        </Typography>
                    </Box>
                ) : address && !res.ambiguous ? (
                    <Alert
                        severity="error"
                        sx={{ mt: 2 }}
                    >
                        {t('badAddress')}
                    </Alert>
                ) : null}
                {known && !editingSame ? (
                    <Alert
                        severity="warning"
                        sx={{ mt: 2 }}
                    >
                        {t('alreadyKnown', knownLabel(known), known.column, known.enabled ? t('active') : t('inactive'))}
                    </Alert>
                ) : null}
                {a && !known && (below || above) ? (
                    <Alert
                        severity="warning"
                        sx={{ mt: 2 }}
                    >
                        <Typography variant="body2">{t('offByOne')}</Typography>
                        {below ? <Typography variant="body2">• {neighbour(below, -1)}</Typography> : null}
                        {above ? <Typography variant="body2">• {neighbour(above, 1)}</Typography> : null}
                    </Alert>
                ) : null}
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2, mt: 2 }}>
                    <TextField
                        label={t('nameId')}
                        value={name}
                        onChange={ev => setName(ev.target.value)}
                        helperText={id ? `ID: ${id}` : t('nameIdHelp')}
                        error={!!duplicate}
                        disabled={!!props.edit}
                    />
                    <TextField
                        label={t('displayName')}
                        value={description}
                        onChange={ev => setDescription(ev.target.value)}
                        helperText={t('displayNameHelp')}
                    />
                    <TextField
                        select
                        label={t('dataType')}
                        value={type}
                        onChange={ev => setType(ev.target.value)}
                        helperText={t('dataTypeHelp')}
                    >
                        {(TYPES as string[]).map(x => (
                            <MenuItem
                                key={x}
                                value={x}
                            >
                                {x}
                            </MenuItem>
                        ))}
                    </TextField>
                    {STRING_TYPES.includes(type) ? (
                        <TextField
                            label={t('length')}
                            value={len}
                            onChange={ev => setLen(ev.target.value)}
                        />
                    ) : (
                        <TextField
                            label={t('unitText')}
                            value={unitText}
                            onChange={ev => setUnitText(ev.target.value)}
                        />
                    )}
                    <TextField
                        label={t('factor')}
                        value={factor}
                        onChange={ev => setFactor(ev.target.value)}
                        helperText={t('factorHelp')}
                    />
                    <TextField
                        label={t('offset')}
                        value={offset}
                        onChange={ev => setOffset(ev.target.value)}
                    />
                    <TextField
                        select
                        label={t('group')}
                        value={group}
                        onChange={ev => setGroup(ev.target.value)}
                    >
                        {props.groups.map(g => (
                            <MenuItem
                                key={g.name}
                                value={g.name}
                            >
                                {t('intoGroup', g.name, String(num(g.interval, 60)))}
                            </MenuItem>
                        ))}
                    </TextField>
                    {effRegType === 'holdingRegs' ? (
                        <FormControlLabel
                            control={
                                <Switch
                                    checked={allowWrite}
                                    onChange={ev => setAllowWrite(ev.target.checked)}
                                />
                            }
                            label={t('allowWrite')}
                        />
                    ) : null}
                    {effRegType === 'holdingRegs' ? (
                        <>
                            <TextField
                                label={t('min')}
                                value={min}
                                onChange={ev => setMin(ev.target.value)}
                            />
                            <TextField
                                label={t('max')}
                                value={max}
                                onChange={ev => setMax(ev.target.value)}
                            />
                        </>
                    ) : null}
                </Box>
                <Box sx={{ mt: 2, display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                    <Button
                        variant="outlined"
                        onClick={() => void runTest()}
                        disabled={!a || test.running || !props.alive}
                    >
                        {test.running ? t('testing') : t('testRead')}
                    </Button>
                    <Typography
                        variant="caption"
                        color="text.secondary"
                    >
                        {props.alive ? t('testReadHelp') : t('notAlive')}
                    </Typography>
                </Box>
                {test.result ? (
                    <Alert
                        severity="success"
                        sx={{ mt: 1.5 }}
                    >
                        {t(
                            'testResult',
                            String(test.result.value),
                            unitText,
                            (test.result.words || []).map((w: number) => `0x${w.toString(16).padStart(4, '0')}`).join(' '),
                            String(test.result.ms),
                        )}
                    </Alert>
                ) : null}
                {test.error ? (
                    <Alert
                        severity="error"
                        sx={{ mt: 1.5 }}
                    >
                        {t('testError', test.error)}
                    </Alert>
                ) : null}
                {props.edit ? (
                    <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ display: 'block', mt: 1 }}
                    >
                        {t('editHint', rowLabel(props.edit.regType, props.edit.row))}
                    </Typography>
                ) : null}
            </DialogContent>
            <DialogActions>
                <Button onClick={props.onClose}>{t('cancel')}</Button>
                <Button
                    variant="contained"
                    disabled={!valid}
                    onClick={() => props.onSave(effRegType, row, props.edit?.index)}
                >
                    {t('save')}
                </Button>
            </DialogActions>
        </Dialog>
    );
}
