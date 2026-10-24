/*
 * Register catalog: all known registers by topic, activate by click or drag & drop into a poll group,
 * live bus load per group and in total with the reason for every additional request.
 */
import React from 'react';
import {
    Alert,
    Box,
    Button,
    Chip,
    IconButton,
    InputAdornment,
    Menu,
    MenuItem,
    Snackbar,
    Switch,
    FormControlLabel,
    TextField,
    ToggleButton,
    ToggleButtonGroup,
    Tooltip,
    Typography,
} from '@mui/material';
import {
    Add as IconAdd,
    ArrowDropDown as IconDropDown,
    Close as IconClose,
    DragIndicator as IconDrag,
    Search as IconSearch,
    DeleteOutlined as IconDelete,
    Tune as IconTune,
} from '@mui/icons-material';
import {
    DndContext,
    DragOverlay,
    KeyboardSensor,
    PointerSensor,
    TouchSensor,
    useDraggable,
    useDroppable,
    useSensor,
    useSensors,
    type DragEndEvent,
    type DragStartEvent,
} from '@dnd-kit/core';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';

import {
    type Group,
    type Native,
    type RegType,
    type Row,
    type RowRef,
    THEMES,
    allRows,
    analyseNative,
    clone,
    docOf,
    fmt,
    groupColor,
    groupDescription,
    isActive,
    metaOf,
    num,
    reasonText,
    requestDelta,
    ownDescription,
    pairSortKey,
    rowDescription,
    rowLabel,
    rowStateId,
    t,
    themeOf,
    unitOf,
    useStates,
    LEVEL_COLORS,
} from './shared';
import { BusLoadSummary, LoadBar } from './BusLoad';
import CustomRegisterDialog from './CustomRegisterDialog';

interface Change {
    text: string;
    severity: 'success' | 'info' | 'warning';
}

/** Applies a change to a copy of the configuration and describes its effect on the bus */
function describeChange(before: Native, after: Native, ref: RowRef | null, verb: string): Change {
    const a = analyseNative(before);
    const b = analyseNative(after);
    const delta = requestDelta(a, b) as Record<string, number>;
    const label = ref ? rowLabel(ref.regType, ref.row) : '';
    const parts: string[] = [];
    for (const [g, d] of Object.entries(delta)) {
        if (d > 0 && ref) {
            const grp = b.groups.find((x: any) => x.name === g);
            const id = rowStateId(ref.regType, after[ref.regType][ref.index]);
            const block = grp?.blocks.find((x: any) => x.ids.includes(id));
            const why = block ? reasonText(ref.regType, block) : '';
            // the reason starts with "+1 request because …" already
            parts.push(why && d === 1 ? `${g}: ${why}.` : t('changeMoreShort', d, g));
        } else if (d > 0) {
            parts.push(t('changeMoreShort', d, g));
        } else {
            parts.push(t('changeLess', -d, g));
        }
    }
    const lvl = b.total.level;
    const text = `${verb ? `${verb}: ${label}. ` : ''}${parts.length ? parts.join(' ') : t('changeFree')} ${t(
        'changeTotal',
        Math.round(b.total.load * 100),
    )}`;
    return { text, severity: lvl === 'over' ? 'warning' : parts.some(p => p.startsWith('+')) ? 'info' : 'success' };
}

/** Preview of the cost of activating a row in a group (for the tooltip of the button) */
function previewCost(data: Native, ref: RowRef, group: string): string {
    const after = clone(data);
    const row = after[ref.regType][ref.index];
    row.enabled = true;
    row.group = group;
    if (ref.regType === 'holdingRegs') {
        row.poll = true;
    }
    const a = analyseNative(data);
    const b = analyseNative(after);
    const d = (requestDelta(a, b) as Record<string, number>)[group] || 0;
    if (d <= 0) {
        return t('previewFree', group);
    }
    const grp = b.groups.find((x: any) => x.name === group);
    const id = rowStateId(ref.regType, row);
    const block = grp?.blocks.find((x: any) => x.ids.includes(id));
    return `${t('previewMore', d, group)} ${block ? reasonText(ref.regType, block) : ''}`;
}

function ThemeLabel(theme: string): string {
    return t(`theme_${theme}`);
}

/** One register as a card (draggable by the handle, buttons for keyboard/touch) */
function RegisterCard(props: {
    refRow: RowRef;
    data: Native;
    groups: Group[];
    compact?: boolean;
    inGroup?: boolean;
    onActivate: (ref: RowRef, group: string) => void;
    onDeactivate: (ref: RowRef) => void;
    onEdit?: (ref: RowRef) => void;
    disabled?: boolean;
}): React.JSX.Element {
    const { refRow: ref } = props;
    const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
        id: ref.key,
        data: { ref },
        disabled: props.disabled,
    });
    const [menu, setMenu] = React.useState<HTMLElement | null>(null);
    const [preview, setPreview] = React.useState('');
    const active = isActive(ref);
    const label = rowLabel(ref.regType, ref.row);
    const desc = rowDescription(ref.regType, ref.row);
    const unit = unitOf(ref.row);
    const defGroup =
        props.groups.find(g => g.name === ref.row.group)?.name || props.groups[0]?.name || String(ref.row.group || '');
    const doc = docOf(ref.regType, ref.row);
    return (
        <Box
            ref={setNodeRef}
            sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 0.5,
                p: props.compact ? 0.5 : 1,
                pl: 0.25,
                mb: 0.75,
                borderRadius: 2,
                border: '1px solid',
                borderColor: 'divider',
                bgcolor: 'background.paper',
                opacity: isDragging ? 0.35 : 1,
                boxShadow: props.compact ? 'none' : '0 1px 2px rgba(0,0,0,0.06)',
                '&:hover': { borderColor: 'primary.main' },
            }}
        >
            <IconButton
                size="small"
                aria-label={t('dragHandle', label)}
                {...listeners}
                {...attributes}
                disabled={props.disabled}
                sx={{ cursor: 'grab', touchAction: 'none', color: 'text.secondary' }}
            >
                <IconDrag fontSize="small" />
            </IconButton>
            <Box sx={{ flex: 1, minWidth: 0 }}>
                <Tooltip
                    title={
                        <span>
                            {desc ? (
                                <>
                                    {desc}
                                    <br />
                                </>
                            ) : null}
                            {ownDescription(ref.regType, ref.row) ? (
                                <>
                                    {t('ownDescription', ownDescription(ref.regType, ref.row))}
                                    <br />
                                </>
                            ) : null}
                            {t('cardTooltip', doc, ref.row.type || 'uint16be', String(ref.row.factor ?? 1))}
                            <br />
                            ID: {rowStateId(ref.regType, ref.row)}
                        </span>
                    }
                    enterDelay={600}
                >
                    <Typography
                        variant="body2"
                        sx={{
                            fontWeight: 500,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                        }}
                    >
                        {label}
                    </Typography>
                </Tooltip>
                <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', alignItems: 'center', mt: 0.25 }}>
                    <Typography
                        variant="caption"
                        color="text.secondary"
                    >
                        {t('regNr', doc)}
                        {ref.row.unit ? ` · ${String(ref.row.unit)}` : ''}
                    </Typography>
                    {unit !== 1 ? (
                        <Chip
                            size="small"
                            label={t('unitChip', unit)}
                            sx={{ height: 18, fontSize: 11 }}
                        />
                    ) : null}
                    {Object.entries(metaOf(ref.regType, ref.row)?.tested || {})
                        .filter(([, r]) => r === 'exception')
                        .map(([model]) => (
                            <Tooltip
                                key={model}
                                title={t('notAnsweredHelp', model)}
                            >
                                <Chip
                                    size="small"
                                    color="warning"
                                    variant="outlined"
                                    label={t('notAnswered', model)}
                                    sx={{ height: 18, fontSize: 11 }}
                                />
                            </Tooltip>
                        ))}
                    {ref.regType === 'holdingRegs' ? (
                        <Chip
                            size="small"
                            label={t('holdingChip')}
                            sx={{ height: 18, fontSize: 11 }}
                            color={ref.row.allowWrite ? 'warning' : 'default'}
                        />
                    ) : null}
                    {!props.inGroup && active ? (
                        <Chip
                            size="small"
                            label={t('activeIn', String(ref.row.group))}
                            sx={{
                                height: 18,
                                fontSize: 11,
                                bgcolor: groupColor(String(ref.row.group)),
                                color: '#fff',
                            }}
                        />
                    ) : null}
                </Box>
            </Box>
            {props.inGroup ? (
                <>
                    {props.onEdit ? (
                        <IconButton
                            size="small"
                            aria-label={t('edit', label)}
                            onClick={() => props.onEdit?.(ref)}
                        >
                            <IconTune fontSize="small" />
                        </IconButton>
                    ) : null}
                    <Tooltip title={t('deactivate')}>
                        <IconButton
                            size="small"
                            aria-label={`${t('deactivate')}: ${label}`}
                            onClick={() => props.onDeactivate(ref)}
                            disabled={props.disabled}
                        >
                            <IconClose fontSize="small" />
                        </IconButton>
                    </Tooltip>
                </>
            ) : active ? (
                <Button
                    size="small"
                    onClick={() => props.onDeactivate(ref)}
                    disabled={props.disabled}
                >
                    {t('deactivate')}
                </Button>
            ) : (
                <Box sx={{ display: 'flex' }}>
                    <Tooltip
                        title={preview}
                        onOpen={() => setPreview(previewCost(props.data, ref, defGroup))}
                    >
                        <span>
                            <Button
                                size="small"
                                variant="outlined"
                                startIcon={<IconAdd />}
                                onClick={() => props.onActivate(ref, defGroup)}
                                disabled={props.disabled || !defGroup}
                                sx={{ borderTopRightRadius: 0, borderBottomRightRadius: 0, whiteSpace: 'nowrap' }}
                            >
                                {defGroup}
                            </Button>
                        </span>
                    </Tooltip>
                    <Button
                        size="small"
                        variant="outlined"
                        aria-label={t('chooseGroup', label)}
                        aria-haspopup="menu"
                        onClick={e => setMenu(e.currentTarget)}
                        disabled={props.disabled}
                        sx={{ minWidth: 28, px: 0, borderTopLeftRadius: 0, borderBottomLeftRadius: 0, ml: '-1px' }}
                    >
                        <IconDropDown fontSize="small" />
                    </Button>
                    <Menu
                        open={!!menu}
                        anchorEl={menu}
                        onClose={() => setMenu(null)}
                    >
                        {props.groups.map((g, i) => (
                            <MenuItem
                                key={g.name}
                                onClick={() => {
                                    setMenu(null);
                                    props.onActivate(ref, g.name);
                                }}
                            >
                                <Box
                                    sx={{
                                        width: 10,
                                        height: 10,
                                        borderRadius: '50%',
                                        bgcolor: groupColor(g.name, i),
                                        mr: 1,
                                    }}
                                />
                                {t('intoGroup', g.name, String(num(g.interval, 60)))}
                            </MenuItem>
                        ))}
                    </Menu>
                </Box>
            )}
        </Box>
    );
}

/** Drop zone of a group with its blocks (= bus requests) */
function GroupColumn(props: {
    group: Group;
    index: number;
    analysis: any;
    refs: RowRef[];
    data: Native;
    measured?: number;
    onInterval: (name: string, value: number) => void;
    onDeactivate: (ref: RowRef) => void;
    onActivate: (ref: RowRef, group: string) => void;
    onRemoveGroup?: (name: string) => void;
    onEdit: (ref: RowRef) => void;
    disabled?: boolean;
}): React.JSX.Element {
    const { group } = props;
    const { setNodeRef, isOver } = useDroppable({ id: `group:${group.name}`, data: { group: group.name } });
    const ga = props.analysis.groups.find((x: any) => x.name === group.name);
    const color = groupColor(group.name, props.index);
    const [interval, setIntervalText] = React.useState(String(group.interval));
    React.useEffect(() => setIntervalText(String(group.interval)), [group.interval]);
    // blocks in poll order, registers in each block
    const byId = new Map(props.refs.map(r => [rowStateId(r.regType, r.row), r]));
    const blocks: { block: any; regType: RegType; refs: RowRef[] }[] = (ga?.blocks || []).map((b: any) => ({
        block: b,
        regType: b.regType,
        refs: b.ids.map((id: string) => byId.get(id)).filter(Boolean),
    }));
    const disabledGroup = group.enabled === false;
    return (
        <Box
            ref={setNodeRef}
            role="region"
            aria-label={t('groupRegion', group.name)}
            sx={{
                flex: '1 1 260px',
                minWidth: 240,
                maxWidth: 420,
                borderRadius: 3,
                border: '2px solid',
                borderColor: isOver ? color : 'divider',
                bgcolor: theme => (theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)'),
                transition: 'border-color 120ms',
                display: 'flex',
                flexDirection: 'column',
                opacity: disabledGroup ? 0.6 : 1,
            }}
        >
            <Box sx={{ p: 1.5, pb: 1, borderBottom: '1px solid', borderColor: 'divider' }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Box sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: color, flexShrink: 0 }} />
                    <Typography
                        variant="subtitle1"
                        sx={{ fontWeight: 700 }}
                    >
                        {group.name}
                    </Typography>
                    <Box sx={{ flex: 1 }} />
                    <TextField
                        size="small"
                        value={interval}
                        onChange={e => setIntervalText(e.target.value)}
                        onBlur={() => {
                            const v = Math.max(1, Math.round(num(interval, num(group.interval, 60))));
                            setIntervalText(String(v));
                            if (v !== num(group.interval, 60)) {
                                props.onInterval(group.name, v);
                            }
                        }}
                        onKeyDown={e => {
                            if (e.key === 'Enter') {
                                (e.target as HTMLInputElement).blur();
                            }
                        }}
                        disabled={props.disabled}
                        slotProps={{
                            htmlInput: {
                                inputMode: 'numeric',
                                'aria-label': t('intervalOf', group.name),
                                style: { width: 44, textAlign: 'right', padding: '4px 6px' },
                            },
                            input: {
                                startAdornment: <InputAdornment position="start">{t('every')}</InputAdornment>,
                                endAdornment: <InputAdornment position="end">s</InputAdornment>,
                            },
                        }}
                    />
                    {props.onRemoveGroup && !props.refs.length ? (
                        <Tooltip title={t('removeGroup')}>
                            <IconButton
                                size="small"
                                aria-label={`${t('removeGroup')}: ${group.name}`}
                                onClick={() => props.onRemoveGroup?.(group.name)}
                            >
                                <IconDelete fontSize="small" />
                            </IconButton>
                        </Tooltip>
                    ) : null}
                </Box>
                {group.description ? (
                    <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ display: 'block', mt: 0.25 }}
                    >
                        {groupDescription(group)}
                    </Typography>
                ) : null}
                <Box sx={{ mt: 1 }}>
                    <LoadBar
                        load={ga ? ga.load : 0}
                        level={ga ? ga.level : 'ok'}
                        label={t('groupLoad', group.name)}
                    />
                </Box>
                <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: 'block', mt: 0.5 }}
                >
                    {disabledGroup
                        ? t('groupDisabled')
                        : t(
                              'groupStats',
                              ga ? ga.registers : 0,
                              ga ? ga.requests : 0,
                              fmt(ga ? ga.perSecond : 0, 3),
                              Math.round((ga ? ga.load : 0) * 100),
                          )}
                    {props.measured !== undefined ? ` · ${t('measuredRound', props.measured)}` : ''}
                    {ga && ga.pauseAfter ? ` · ${t('pauseInfo', ga.pauseAfter)}` : ''}
                </Typography>
                {ga?.warnings?.map((w: any, i: number) => (
                    <Typography
                        key={i}
                        variant="caption"
                        sx={{ display: 'block', color: LEVEL_COLORS[w.kind === 'skipSure' ? 'over' : 'warn'] }}
                    >
                        {t(
                            `warn_${w.kind}`,
                            ...(w.kind === 'timeoutShort'
                                ? [w.timeout]
                                : w.kind === 'roundTooLong'
                                  ? [w.measured]
                                  : [w.other, w.pause]),
                        )}
                    </Typography>
                ))}
            </Box>
            <Box sx={{ p: 1, flex: 1, minHeight: 80 }}>
                {blocks.map((b, i) => (
                    <Box
                        key={i}
                        sx={{ mb: 1 }}
                    >
                        <Typography
                            variant="caption"
                            sx={{
                                display: 'block',
                                fontWeight: 600,
                                color: i === 0 ? 'text.secondary' : LEVEL_COLORS.warn,
                                mb: 0.25,
                            }}
                        >
                            {t('requestN', i + 1, b.block.fc, b.block.unit, b.block.count)}
                            {i > 0 ? ` – ${reasonText(b.regType, b.block)}` : ''}
                        </Typography>
                        {b.refs.map(ref => (
                            <RegisterCard
                                key={ref.key}
                                refRow={ref}
                                data={props.data}
                                groups={[]}
                                compact
                                inGroup
                                onActivate={props.onActivate}
                                onDeactivate={props.onDeactivate}
                                onEdit={themeOf(ref.regType, ref.row) === 'custom' ? props.onEdit : undefined}
                                disabled={props.disabled}
                            />
                        ))}
                    </Box>
                ))}
                {!blocks.length ? (
                    <Typography
                        variant="body2"
                        color="text.secondary"
                        sx={{ textAlign: 'center', mt: 2 }}
                    >
                        {t('dropHere')}
                    </Typography>
                ) : null}
            </Box>
        </Box>
    );
}

function Pool(props: { children: React.ReactNode }): React.JSX.Element {
    const { setNodeRef, isOver } = useDroppable({ id: 'pool' });
    return (
        <Box
            ref={setNodeRef}
            sx={{
                borderRadius: 3,
                border: '2px dashed',
                borderColor: isOver ? 'error.main' : 'transparent',
                transition: 'border-color 120ms',
            }}
        >
            {props.children}
        </Box>
    );
}

export function CatalogView(props: ConfigGenericProps & { onData: (data: Native) => void }): React.JSX.Element {
    const data = props.data as Native;
    const [search, setSearch] = React.useState('');
    const [theme, setTheme] = React.useState<string>('all');
    const [onlyFree, setOnlyFree] = React.useState(true);
    const [change, setChange] = React.useState<Change | null>(null);
    const [dragRef, setDragRef] = React.useState<RowRef | null>(null);
    const [custom, setCustom] = React.useState<{ open: boolean; edit?: RowRef }>({ open: false });
    const [newGroup, setNewGroup] = React.useState('');
    const groups: Group[] = (Array.isArray(data.groups) ? data.groups : []).filter(g => g && g.name);
    const refs = allRows(data);

    // measured round durations of the running instance
    const roundIds = groups.map(g => `info.groups.${g.name.replace(/[^A-Za-z0-9_-]/g, '_')}.roundDuration`);
    const states = useStates(props, roundIds, 15000);
    const measured: Record<string, number> = {};
    groups.forEach((g, i) => {
        const st = states[roundIds[i]];
        if (st && typeof st.val === 'number' && props.alive) {
            measured[g.name] = st.val;
        }
    });
    const analysis = analyseNative(data, measured);

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
        useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
        useSensor(KeyboardSensor),
    );

    const apply = (mut: (n: Native) => RowRef | null, verb: string): void => {
        const after = clone(data);
        const ref = mut(after);
        setChange(describeChange(data, after, ref, verb));
        props.onData(after);
    };

    const activate = (ref: RowRef, group: string): void =>
        apply(n => {
            const row = n[ref.regType][ref.index];
            row.enabled = true;
            row.group = group;
            if (ref.regType === 'holdingRegs') {
                row.poll = true;
            }
            return { ...ref, row };
        }, t('verbActivated'));
    const deactivate = (ref: RowRef): void =>
        apply(n => {
            const row = n[ref.regType][ref.index];
            row.enabled = false;
            return { ...ref, row };
        }, t('verbDeactivated'));
    const setGroupInterval = (name: string, v: number): void =>
        apply(n => {
            const g = n.groups.find(x => x.name === name);
            if (g) {
                g.interval = v;
            }
            return null;
        }, '');
    const addGroup = (): void => {
        const name = newGroup.trim().replace(/[^A-Za-z0-9_-]/g, '_');
        if (!name || groups.some(g => g.name === name)) {
            return;
        }
        apply(n => {
            n.groups = [
                ...(n.groups || []),
                { enabled: true, name, interval: 60, timeout: 10000, pauseAfter: 0, description: '' },
            ];
            return null;
        }, '');
        setNewGroup('');
    };
    const removeGroup = (name: string): void =>
        apply(n => {
            n.groups = n.groups.filter(g => g.name !== name);
            return null;
        }, '');

    const onDragStart = (e: DragStartEvent): void => setDragRef((e.active.data.current as any)?.ref || null);
    const onDragEnd = (e: DragEndEvent): void => {
        setDragRef(null);
        const ref = (e.active.data.current as any)?.ref as RowRef | undefined;
        const over = e.over?.id ? String(e.over.id) : '';
        if (!ref || !over) {
            return;
        }
        if (over === 'pool') {
            if (isActive(ref)) {
                deactivate(ref);
            }
            return;
        }
        if (over.startsWith('group:')) {
            const g = over.substring(6);
            if (!isActive(ref) || ref.row.group !== g) {
                activate(ref, g);
            }
        }
    };

    const q = search.trim().toLowerCase();
    const poolRefs = refs.filter(ref => {
        if (onlyFree && isActive(ref)) {
            return false;
        }
        if (theme !== 'all' && themeOf(ref.regType, ref.row) !== theme) {
            return false;
        }
        if (q) {
            const hay = `${rowLabel(ref.regType, ref.row)} ${rowDescription(ref.regType, ref.row)} ${ref.row.name} ${
                ref.row.description
            } ${docOf(ref.regType, ref.row)} ${ref.row._address}`.toLowerCase();
            return q.split(/\s+/).every(w => hay.includes(w));
        }
        return true;
    });
    const counts: Record<string, number> = {};
    for (const ref of refs) {
        const th = themeOf(ref.regType, ref.row);
        counts[th] = (counts[th] || 0) + 1;
    }
    const byTheme = THEMES.map(th => ({
        theme: th,
        refs: poolRefs
            .filter(r => themeOf(r.regType, r.row) === th)
            .sort((a, b) => {
                // registers the reference device does not answer go to the end of their topic
                const na = Object.values(metaOf(a.regType, a.row)?.tested || {}).includes('exception') ? 1 : 0;
                const nb = Object.values(metaOf(b.regType, b.row)?.tested || {}).includes('exception') ? 1 : 0;
                if (na !== nb) {
                    return na - nb;
                }
                return pairSortKey(a.regType, a.row) < pairSortKey(b.regType, b.row) ? -1 : 1;
            }),
    })).filter(x => x.refs.length);

    const activeByGroup = (name: string): RowRef[] => refs.filter(r => isActive(r) && r.row.group === name);
    const orphans = refs.filter(r => isActive(r) && !groups.some(g => g.name === r.row.group));

    return (
        <Box sx={{ width: '100%' }}>
            <DndContext
                sensors={sensors}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                onDragCancel={() => setDragRef(null)}
                accessibility={{
                    announcements: {
                        onDragStart: ({ active }) =>
                            t(
                                'ariaPick',
                                rowLabel(
                                    (active.data.current as any).ref.regType,
                                    (active.data.current as any).ref.row,
                                ),
                            ),
                        onDragOver: ({ over }) => (over ? t('ariaOver', String(over.id).replace('group:', '')) : ''),
                        onDragEnd: ({ over }) =>
                            over ? t('ariaDrop', String(over.id).replace('group:', '')) : t('ariaCancel'),
                        onDragCancel: () => t('ariaCancel'),
                    },
                    screenReaderInstructions: { draggable: t('ariaInstructions') },
                }}
            >
                <Box sx={{ position: 'sticky', top: 0, zIndex: 2, bgcolor: 'background.default', pb: 1.5 }}>
                    <BusLoadSummary
                        analysis={analysis}
                        measuredNote={Object.keys(measured).length ? t('measuredNote') : t('notMeasuredNote')}
                    />
                </Box>
                {orphans.length ? (
                    <Alert
                        severity="warning"
                        sx={{ mb: 1.5 }}
                    >
                        {t('orphans', orphans.length, [...new Set(orphans.map(o => String(o.row.group)))].join(', '))}
                    </Alert>
                ) : null}
                <Box
                    sx={{
                        display: 'grid',
                        gridTemplateColumns: { xs: '1fr', lg: 'minmax(320px, 400px) 1fr' },
                        gap: 2,
                        alignItems: 'start',
                    }}
                >
                    {/* catalog */}
                    <Box>
                        <TextField
                            fullWidth
                            size="small"
                            placeholder={t('searchPlaceholder')}
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            slotProps={{
                                input: {
                                    startAdornment: (
                                        <InputAdornment position="start">
                                            <IconSearch fontSize="small" />
                                        </InputAdornment>
                                    ),
                                },
                                htmlInput: { 'aria-label': t('searchPlaceholder') },
                            }}
                        />
                        <ToggleButtonGroup
                            size="small"
                            exclusive
                            value={theme}
                            onChange={(_e, v) => v && setTheme(v)}
                            sx={{
                                flexWrap: 'wrap',
                                mt: 1,
                                '& .MuiToggleButton-root': { textTransform: 'none', py: 0.25 },
                            }}
                            aria-label={t('themeFilter')}
                        >
                            <ToggleButton value="all">{t('theme_all')}</ToggleButton>
                            {THEMES.filter(th => counts[th]).map(th => (
                                <ToggleButton
                                    key={th}
                                    value={th}
                                >
                                    {ThemeLabel(th)}&nbsp;
                                    <Typography
                                        component="span"
                                        variant="caption"
                                        color="text.secondary"
                                    >
                                        {counts[th]}
                                    </Typography>
                                </ToggleButton>
                            ))}
                        </ToggleButtonGroup>
                        <Box sx={{ display: 'flex', alignItems: 'center', mt: 0.5, flexWrap: 'wrap' }}>
                            <FormControlLabel
                                control={
                                    <Switch
                                        size="small"
                                        checked={onlyFree}
                                        onChange={e => setOnlyFree(e.target.checked)}
                                    />
                                }
                                label={<Typography variant="body2">{t('onlyFree')}</Typography>}
                            />
                            <Box sx={{ flex: 1 }} />
                            <Button
                                size="small"
                                startIcon={<IconAdd />}
                                onClick={() => setCustom({ open: true })}
                            >
                                {t('customRegister')}
                            </Button>
                        </Box>
                        <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{ display: 'block', mb: 1 }}
                        >
                            {t('poolHint', poolRefs.length)}
                        </Typography>
                        <Pool>
                            <Box sx={{ maxHeight: { lg: '70vh' }, overflowY: { lg: 'auto' }, pr: { lg: 0.5 } }}>
                                {byTheme.map(x => (
                                    <Box
                                        key={x.theme}
                                        sx={{ mb: 1.5 }}
                                    >
                                        <Typography
                                            variant="overline"
                                            color="text.secondary"
                                            sx={{ display: 'block', lineHeight: 2 }}
                                        >
                                            {ThemeLabel(x.theme)} · {x.refs.length}
                                        </Typography>
                                        {x.refs.map(ref => (
                                            <RegisterCard
                                                key={ref.key}
                                                refRow={ref}
                                                data={data}
                                                groups={groups.filter(g => g.enabled !== false)}
                                                onActivate={activate}
                                                onDeactivate={deactivate}
                                            />
                                        ))}
                                    </Box>
                                ))}
                                {!byTheme.length ? (
                                    <Typography
                                        variant="body2"
                                        color="text.secondary"
                                        sx={{ p: 2 }}
                                    >
                                        {t('nothingFound')}
                                    </Typography>
                                ) : null}
                            </Box>
                        </Pool>
                    </Box>
                    {/* groups */}
                    <Box>
                        <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'stretch' }}>
                            {groups.map((g, i) => (
                                <GroupColumn
                                    key={g.name}
                                    group={g}
                                    index={i}
                                    analysis={analysis}
                                    refs={activeByGroup(g.name)}
                                    data={data}
                                    measured={measured[g.name]}
                                    onInterval={setGroupInterval}
                                    onDeactivate={deactivate}
                                    onActivate={activate}
                                    onRemoveGroup={
                                        ['live', 'energie', 'steuerung', 'akku', 'info'].includes(g.name)
                                            ? undefined
                                            : removeGroup
                                    }
                                    onEdit={ref => setCustom({ open: true, edit: ref })}
                                />
                            ))}
                        </Box>
                        <Box sx={{ display: 'flex', gap: 1, mt: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
                            <TextField
                                size="small"
                                label={t('newGroup')}
                                value={newGroup}
                                onChange={e => setNewGroup(e.target.value)}
                                onKeyDown={e => e.key === 'Enter' && addGroup()}
                            />
                            <Button
                                variant="outlined"
                                startIcon={<IconAdd />}
                                onClick={addGroup}
                                disabled={!newGroup.trim()}
                            >
                                {t('addGroup')}
                            </Button>
                            <Typography
                                variant="caption"
                                color="text.secondary"
                            >
                                {t('groupsHint')}
                            </Typography>
                        </Box>
                    </Box>
                </Box>
                <DragOverlay>
                    {dragRef ? (
                        <Box
                            sx={{
                                p: 1,
                                borderRadius: 2,
                                bgcolor: 'background.paper',
                                boxShadow: 6,
                                border: '1px solid',
                                borderColor: 'primary.main',
                                maxWidth: 320,
                            }}
                        >
                            <Typography
                                variant="body2"
                                sx={{ fontWeight: 600 }}
                            >
                                {rowLabel(dragRef.regType, dragRef.row)}
                            </Typography>
                            <Typography
                                variant="caption"
                                color="text.secondary"
                            >
                                {t('regNr', docOf(dragRef.regType, dragRef.row))}
                            </Typography>
                        </Box>
                    ) : null}
                </DragOverlay>
            </DndContext>
            <Snackbar
                open={!!change}
                autoHideDuration={9000}
                onClose={(_e, reason) => reason !== 'clickaway' && setChange(null)}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
            >
                {change ? (
                    <Alert
                        severity={change.severity}
                        variant="filled"
                        onClose={() => setChange(null)}
                        sx={{ maxWidth: 720 }}
                    >
                        {change.text}
                    </Alert>
                ) : undefined}
            </Snackbar>
            {custom.open ? (
                <CustomRegisterDialog
                    {...props}
                    edit={custom.edit}
                    groups={groups}
                    onClose={() => setCustom({ open: false })}
                    onSave={(regType: RegType, row: Row, index?: number) => {
                        apply(
                            n => {
                                if (index !== undefined) {
                                    n[regType][index] = row;
                                    return { regType, index, row, key: '' };
                                }
                                n[regType] = [...(n[regType] || []), row];
                                return { regType, index: n[regType].length - 1, row, key: '' };
                            },
                            index !== undefined ? t('verbChanged') : t('verbAdded'),
                        );
                        setCustom({ open: false });
                    }}
                />
            ) : null}
        </Box>
    );
}

interface CatalogState extends ConfigGenericState {
    tick: number;
}

/** jsonConfig custom component "Catalog" */
export default class Catalog extends ConfigGeneric<ConfigGenericProps, CatalogState> {
    onData = (data: Native): void => {
        this.props.onChange(data, undefined, () => {
            this.props.oContext.forceUpdate(['inputRegs', 'holdingRegs', 'groups'], data);
        });
    };

    renderItem(): React.JSX.Element {
        return (
            <CatalogView
                {...this.props}
                onData={this.onData}
            />
        );
    }
}
