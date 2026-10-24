/*
 * Start tab: traffic lights (instance, connection, last values, every poll group) and live tiles of the
 * most important values; tiles can be chosen and ordered by drag & drop (or the arrow buttons).
 */
import React from 'react';
import { Alert, Box, Button, Chip, IconButton, Menu, MenuItem, Tooltip, Typography } from '@mui/material';
import {
    Add as IconAdd,
    ArrowBack as IconLeft,
    ArrowForward as IconRight,
    Close as IconClose,
    DragIndicator as IconDrag,
    AutoFixHigh as IconWizard,
} from '@mui/icons-material';
import {
    DndContext,
    KeyboardSensor,
    PointerSensor,
    TouchSensor,
    closestCenter,
    useSensor,
    useSensors,
    type DragEndEvent,
} from '@dnd-kit/core';
import {
    SortableContext,
    arrayMove,
    rectSortingStrategy,
    sortableKeyboardCoordinates,
    useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';

import {
    type Level,
    type Native,
    type RegType,
    type Row,
    LEVEL_COLORS,
    ago,
    allRows,
    aliasOf,
    clone,
    fmt,
    isActive,
    num,
    rowLabel,
    rowStateId,
    t,
    unitOf,
    useStates,
} from './shared';
import Wizard from './Wizard';

const DEFAULT_TILES = ['pv', 'battery', 'soc', 'grid', 'house', 'pvToday'];

/** Fixed tiles: register(s) they need (regType, unit, column address) */
const SOURCES: Record<string, { regType: RegType; unit: number; alias: number }[]> = {
    pv: [{ regType: 'inputRegs', unit: 1, alias: 35017 }],
    soc: [{ regType: 'inputRegs', unit: 1, alias: 43023 }],
    battery: [
        { regType: 'inputRegs', unit: 1, alias: 43022 },
        { regType: 'inputRegs', unit: 1, alias: 43021 },
    ],
    grid: [{ regType: 'inputRegs', unit: 1, alias: 35601 }],
    house: [
        { regType: 'inputRegs', unit: 1, alias: 35017 },
        { regType: 'inputRegs', unit: 1, alias: 43022 },
        { regType: 'inputRegs', unit: 1, alias: 43021 },
        { regType: 'inputRegs', unit: 1, alias: 35601 },
    ],
    pvToday: [{ regType: 'inputRegs', unit: 1, alias: 43002 }],
    temp: [{ regType: 'inputRegs', unit: 1, alias: 35008 }],
    gridToday: [{ regType: 'inputRegs', unit: 1, alias: 43036 }],
    exportToday: [{ regType: 'inputRegs', unit: 1, alias: 43045 }],
};
const FIXED = Object.keys(SOURCES);

function findRow(data: Native, s: { regType: RegType; unit: number; alias: number }): Row | undefined {
    return (data[s.regType] || []).find(r => r && aliasOf(r) === s.alias && unitOf(r) === s.unit);
}

function power(w: number | undefined): string {
    if (w === undefined || !Number.isFinite(w)) {
        return '–';
    }
    return Math.abs(w) >= 1000 ? `${fmt(w / 1000, 2)} kW` : `${Math.round(w)} W`;
}

interface TileValue {
    title: string;
    value: string;
    sub?: string;
    color?: string;
    missing?: { regType: RegType; row: Row; index: number }[];
    ts?: number;
}

function SortableTile(props: {
    id: string;
    index: number;
    count: number;
    tile: TileValue;
    onMove: (from: number, to: number) => void;
    onRemove: (id: string) => void;
    onActivate: (m: { regType: RegType; index: number }[]) => void;
}): React.JSX.Element {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.id });
    const tile = props.tile;
    return (
        <Box
            ref={setNodeRef}
            style={{ transform: CSS.Transform.toString(transform), transition }}
            sx={{
                position: 'relative',
                p: 2,
                pt: 1.5,
                borderRadius: 3,
                border: '1px solid',
                borderColor: 'divider',
                bgcolor: 'background.paper',
                boxShadow: isDragging ? 8 : '0 1px 3px rgba(0,0,0,0.06)',
                zIndex: isDragging ? 3 : 1,
                minHeight: 118,
                pr: { xs: 16, md: 2 },
                '&:hover .tile-tools, &:focus-within .tile-tools': { opacity: 1 },
            }}
        >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ fontWeight: 500, flex: 1, minWidth: 0 }}
                    noWrap
                >
                    {tile.title}
                </Typography>
                <Box
                    className="tile-tools"
                    sx={{
                        display: 'flex',
                        position: 'absolute',
                        top: 6,
                        right: 6,
                        borderRadius: 2,
                        bgcolor: 'background.paper',
                        boxShadow: { md: 2 },
                        opacity: { xs: 1, md: 0 },
                        transition: 'opacity 120ms',
                    }}
                >
                    <IconButton
                        size="small"
                        aria-label={t('moveLeft', tile.title)}
                        disabled={props.index === 0}
                        onClick={() => props.onMove(props.index, props.index - 1)}
                    >
                        <IconLeft sx={{ fontSize: 16 }} />
                    </IconButton>
                    <IconButton
                        size="small"
                        aria-label={t('moveRight', tile.title)}
                        disabled={props.index === props.count - 1}
                        onClick={() => props.onMove(props.index, props.index + 1)}
                    >
                        <IconRight sx={{ fontSize: 16 }} />
                    </IconButton>
                    <IconButton
                        size="small"
                        aria-label={t('dragHandle', tile.title)}
                        {...listeners}
                        {...attributes}
                        sx={{ cursor: 'grab', touchAction: 'none' }}
                    >
                        <IconDrag sx={{ fontSize: 16 }} />
                    </IconButton>
                    <IconButton
                        size="small"
                        aria-label={t('removeTile', tile.title)}
                        onClick={() => props.onRemove(props.id)}
                    >
                        <IconClose sx={{ fontSize: 16 }} />
                    </IconButton>
                </Box>
            </Box>
            {tile.missing && tile.missing.length ? (
                <Box sx={{ mt: 1 }}>
                    <Typography
                        variant="body2"
                        color="text.secondary"
                    >
                        {t('tileMissing')}
                    </Typography>
                    <Button
                        size="small"
                        sx={{ mt: 0.5 }}
                        onClick={() => props.onActivate(tile.missing || [])}
                    >
                        {t('activateNow')}
                    </Button>
                </Box>
            ) : (
                <>
                    <Typography
                        sx={{
                            fontSize: { xs: 26, sm: 30 },
                            fontWeight: 700,
                            lineHeight: 1.2,
                            mt: 0.5,
                            color: tile.color || 'text.primary',
                            fontVariantNumeric: 'tabular-nums',
                        }}
                    >
                        {tile.value}
                    </Typography>
                    <Typography
                        variant="caption"
                        color="text.secondary"
                    >
                        {tile.sub || ''}
                    </Typography>
                </>
            )}
        </Box>
    );
}

function StatusCard(props: { title: string; level: Level | 'off'; text: string; sub?: string }): React.JSX.Element {
    const color = props.level === 'off' ? '#8a8f98' : LEVEL_COLORS[props.level];
    return (
        <Box
            sx={{
                p: 1.5,
                borderRadius: 3,
                border: '1px solid',
                borderColor: 'divider',
                bgcolor: 'background.paper',
                display: 'flex',
                gap: 1.25,
                alignItems: 'flex-start',
                minWidth: 0,
            }}
        >
            <Box
                aria-hidden
                sx={{
                    width: 12,
                    height: 12,
                    mt: 0.6,
                    borderRadius: '50%',
                    bgcolor: color,
                    boxShadow: `0 0 0 4px ${color}33`,
                    flexShrink: 0,
                }}
            />
            <Box sx={{ minWidth: 0 }}>
                <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: 'block' }}
                >
                    {props.title}
                </Typography>
                <Typography
                    variant="body2"
                    sx={{ fontWeight: 600 }}
                >
                    <span className="sr-only">{t(`level_${props.level}`)}: </span>
                    {props.text}
                </Typography>
                {props.sub ? (
                    <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis' }}
                    >
                        {props.sub}
                    </Typography>
                ) : null}
            </Box>
        </Box>
    );
}

export function OverviewView(props: ConfigGenericProps & { onData: (d: Native) => void }): React.JSX.Element {
    const data = props.data as Native;
    const [wizard, setWizard] = React.useState(!String(data.host || '').trim());
    const [addMenu, setAddMenu] = React.useState<HTMLElement | null>(null);
    const tiles: string[] = Array.isArray(data.overviewTiles) && data.overviewTiles.length ? data.overviewTiles : DEFAULT_TILES;
    const groups = (data.groups || []).filter(g => g && g.name && g.enabled !== false);
    const gk = (name: string): string => `info.groups.${name.replace(/[^A-Za-z0-9_-]/g, '_')}`;

    // state IDs: tiles + diagnostics
    const tileIds = new Set<string>();
    for (const id of tiles) {
        if (id.startsWith('reg:')) {
            tileIds.add(id.substring(4));
        }
        for (const s of SOURCES[id] || []) {
            const row = findRow(data, s);
            if (row) {
                tileIds.add(rowStateId(s.regType, row));
            }
        }
    }
    const diagIds = [
        'info.connection',
        'info.lastValueUpdate',
        'info.reconnects',
        ...groups.flatMap(g => [
            `${gk(g.name)}.lastRound`,
            `${gk(g.name)}.timeoutsToday`,
            `${gk(g.name)}.errorsToday`,
            `${gk(g.name)}.skippedToday`,
            `${gk(g.name)}.roundDuration`,
        ]),
    ];
    const states = useStates(props, [...tileIds, ...diagIds], 3000);
    const val = (s: { regType: RegType; unit: number; alias: number }): number | undefined => {
        const row = findRow(data, s);
        if (!row) {
            return undefined;
        }
        const st = states[rowStateId(s.regType, row)];
        return st && typeof st.val === 'number' ? st.val : undefined;
    };
    const missingOf = (id: string): { regType: RegType; row: Row; index: number }[] => {
        const out: { regType: RegType; row: Row; index: number }[] = [];
        for (const s of SOURCES[id] || []) {
            const index = (data[s.regType] || []).findIndex(r => r && aliasOf(r) === s.alias && unitOf(r) === s.unit);
            if (index < 0) {
                continue;
            }
            const ref = { regType: s.regType, index, row: data[s.regType][index], key: '' };
            if (!isActive(ref)) {
                out.push(ref);
            }
        }
        return out;
    };

    const battSigned = (): number | undefined => {
        const p = val(SOURCES.battery[0]);
        const i = val(SOURCES.battery[1]);
        if (p === undefined) {
            return undefined;
        }
        // 13022 battery power is an absolute value - the sign of the battery current gives the direction
        return i !== undefined && i < 0 ? -Math.abs(p) : Math.abs(p);
    };

    const tileValue = (id: string): TileValue => {
        const missing = missingOf(id);
        const title = id.startsWith('reg:') ? '' : t(`tile_${id}`);
        if (missing.length && FIXED.includes(id)) {
            return { title, value: '', missing };
        }
        switch (id) {
            case 'pv': {
                const v = val(SOURCES.pv[0]);
                return { title, value: power(v), color: v ? '#e0a100' : undefined, sub: t('tileSub_pv') };
            }
            case 'soc': {
                const v = val(SOURCES.soc[0]);
                return { title, value: v === undefined ? '–' : `${fmt(v, 1)} %`, sub: t('tileSub_soc') };
            }
            case 'battery': {
                const b = battSigned();
                return {
                    title,
                    value: power(b === undefined ? undefined : Math.abs(b)),
                    color: b === undefined || b === 0 ? undefined : b > 0 ? '#2e9d57' : '#2e7dd7',
                    sub: b === undefined || Math.abs(b) < 1 ? t('battIdle') : b > 0 ? t('battCharging') : t('battDischarging'),
                };
            }
            case 'grid': {
                const v = val(SOURCES.grid[0]);
                return {
                    title,
                    value: power(v === undefined ? undefined : Math.abs(v)),
                    color: v === undefined || v === 0 ? undefined : v > 0 ? '#d64545' : '#2e9d57',
                    sub: v === undefined || Math.abs(v) < 1 ? t('gridIdle') : v > 0 ? t('gridImport') : t('gridExport'),
                };
            }
            case 'house': {
                const pv = val(SOURCES.pv[0]);
                const b = battSigned();
                const g = val(SOURCES.grid[0]);
                const v = pv === undefined || b === undefined || g === undefined ? undefined : Math.max(0, pv - b + g);
                return { title, value: power(v), sub: t('tileSub_house') };
            }
            case 'pvToday':
            case 'gridToday':
            case 'exportToday': {
                const v = val(SOURCES[id][0]);
                return { title, value: v === undefined ? '–' : `${fmt(v, 1)} kWh`, sub: t('today') };
            }
            case 'temp': {
                const v = val(SOURCES.temp[0]);
                return { title, value: v === undefined ? '–' : `${fmt(v, 1)} °C` };
            }
            default: {
                const sid = id.substring(4);
                const ref = allRows(data).find(r => rowStateId(r.regType, r.row) === sid);
                const st = states[sid];
                if (!ref) {
                    return { title: sid, value: '–', sub: t('tileGone') };
                }
                const unit = ref.row.unit ? ` ${String(ref.row.unit)}` : '';
                return {
                    title: rowLabel(ref.regType, ref.row),
                    value: st ? `${typeof st.val === 'number' ? fmt(st.val, Number.isInteger(st.val) ? 0 : 1) : String(st.val)}${unit}` : '–',
                    sub: st ? ago(st.ts) : '',
                    missing: isActive(ref) ? undefined : [{ regType: ref.regType, row: ref.row, index: ref.index }],
                };
            }
        }
    };

    const setTiles = (list: string[]): void => {
        const out = clone(data);
        out.overviewTiles = list;
        props.onData(out);
    };
    const activate = (m: { regType: RegType; index: number }[]): void => {
        const out = clone(data);
        for (const x of m) {
            out[x.regType][x.index].enabled = true;
            if (x.regType === 'holdingRegs') {
                out[x.regType][x.index].poll = true;
            }
        }
        props.onData(out);
    };

    const sensors = useSensors(
        useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
        useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
        useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
    );
    const onDragEnd = (e: DragEndEvent): void => {
        if (e.over && e.active.id !== e.over.id) {
            setTiles(arrayMove(tiles, tiles.indexOf(String(e.active.id)), tiles.indexOf(String(e.over.id))));
        }
    };

    // traffic lights
    const now = Date.now();
    const conn = states['info.connection'];
    const lastVal = states['info.lastValueUpdate'];
    const cards: { title: string; level: Level | 'off'; text: string; sub?: string }[] = [];
    cards.push({
        title: t('stInstance'),
        level: props.alive ? 'ok' : 'off',
        text: props.alive ? t('running') : t('stopped'),
        sub: String(data.host || '') ? `${String(data.host)}:${String(data.port || 502)}` : t('noHost'),
    });
    cards.push({
        title: t('stConnection'),
        level: !props.alive ? 'off' : conn?.val ? 'ok' : 'over',
        text: conn?.val ? t('connected') : t('disconnected'),
        sub: states['info.reconnects'] ? t('reconnects', String(states['info.reconnects'].val)) : undefined,
    });
    const lastTs = typeof lastVal?.val === 'number' ? lastVal.val : undefined;
    const minInterval = Math.min(...groups.map(g => num(g.interval, 60)), 3600);
    const lastAge = lastTs ? (now - lastTs) / 1000 : Infinity;
    // the state of a value is derived from its age compared with its interval - no interval is shown
    const stateText = (level: Level | 'off', hasData: boolean): string =>
        !hasData ? t('stateWaiting') : level === 'ok' ? t('stateCurrent') : level === 'warn' ? t('stateDelayed') : t('stateError');
    const lastLevel: Level = lastAge < minInterval * 3 ? 'ok' : lastAge < minInterval * 10 ? 'warn' : 'over';
    cards.push({
        title: t('stLastValues'),
        level: !props.alive ? 'off' : lastLevel,
        text: props.alive ? stateText(lastLevel, !!lastTs) : '–',
    });
    for (const g of groups) {
        const lr = states[`${gk(g.name)}.lastRound`];
        const to = Number(states[`${gk(g.name)}.timeoutsToday`]?.val || 0);
        const er = Number(states[`${gk(g.name)}.errorsToday`]?.val || 0);
        const sk = Number(states[`${gk(g.name)}.skippedToday`]?.val || 0);
        if (!lr) {
            continue; // group without registers has no diagnostics
        }
        const ts = typeof lr.val === 'number' ? lr.val : 0;
        const age = ts ? (now - ts) / 1000 : Infinity;
        const iv = num(g.interval, 60);
        const level: Level = age < iv * 2.5 + 5 ? 'ok' : age < iv * 6 + 10 ? 'warn' : 'over';
        const shown: Level = level === 'ok' && (to || er) ? 'warn' : level;
        cards.push({
            title: t('stGroupName', g.name),
            level: props.alive ? shown : 'off',
            text: props.alive ? stateText(level, !!ts) : '–',
            sub: to || er || sk ? t('groupProblems', to, er, sk) : t('groupFine'),
        });
    }

    const addable = [
        ...FIXED.filter(f => !tiles.includes(f)).map(f => ({ id: f, label: t(`tile_${f}`) })),
        ...allRows(data)
            .filter(r => isActive(r) && !tiles.includes(`reg:${rowStateId(r.regType, r.row)}`))
            .map(r => ({ id: `reg:${rowStateId(r.regType, r.row)}`, label: rowLabel(r.regType, r.row) })),
    ];

    return (
        <Box sx={{ width: '100%' }}>
            <style>{'.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}'}</style>
            {wizard ? (
                <Box sx={{ mb: 3 }}>
                    {String(data.host || '').trim() ? (
                        <Alert
                            severity="warning"
                            sx={{ mb: 1 }}
                        >
                            {t('wizardOverwrite')}
                        </Alert>
                    ) : null}
                    <Wizard
                        {...props}
                        onClose={String(data.host || '').trim() ? () => setWizard(false) : undefined}
                    />
                </Box>
            ) : null}
            <Box sx={{ display: 'flex', alignItems: 'center', mb: 1, gap: 1, flexWrap: 'wrap' }}>
                <Typography
                    variant="h6"
                    sx={{ fontWeight: 600 }}
                >
                    {t('statusTitle')}
                </Typography>
                <Box sx={{ flex: 1 }} />
                {!wizard ? (
                    <Button
                        size="small"
                        startIcon={<IconWizard />}
                        onClick={() => setWizard(true)}
                    >
                        {t('wizardTitle')}
                    </Button>
                ) : null}
            </Box>
            <Box
                sx={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                    gap: 1.5,
                    mb: 3,
                }}
            >
                {cards.map(c => (
                    <StatusCard
                        key={c.title}
                        {...c}
                    />
                ))}
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', mb: 1, gap: 1, flexWrap: 'wrap' }}>
                <Typography
                    variant="h6"
                    sx={{ fontWeight: 600 }}
                >
                    {t('liveTitle')}
                </Typography>
                {!props.alive ? (
                    <Chip
                        size="small"
                        label={t('notAliveShort')}
                    />
                ) : null}
                <Box sx={{ flex: 1 }} />
                <Button
                    size="small"
                    startIcon={<IconAdd />}
                    onClick={e => setAddMenu(e.currentTarget)}
                    aria-haspopup="menu"
                >
                    {t('addTile')}
                </Button>
                <Menu
                    open={!!addMenu}
                    anchorEl={addMenu}
                    onClose={() => setAddMenu(null)}
                    slotProps={{ paper: { sx: { maxHeight: 420 } } }}
                >
                    {addable.map(a => (
                        <MenuItem
                            key={a.id}
                            onClick={() => {
                                setAddMenu(null);
                                setTiles([...tiles, a.id]);
                            }}
                        >
                            {a.label}
                        </MenuItem>
                    ))}
                </Menu>
            </Box>
            <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={onDragEnd}
            >
                <SortableContext
                    items={tiles}
                    strategy={rectSortingStrategy}
                >
                    <Box
                        sx={{
                            display: 'grid',
                            gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
                            gap: 1.5,
                        }}
                    >
                        {tiles.map((id, i) => (
                            <SortableTile
                                key={id}
                                id={id}
                                index={i}
                                count={tiles.length}
                                tile={tileValue(id)}
                                onMove={(from, to) => setTiles(arrayMove(tiles, from, to))}
                                onRemove={x => setTiles(tiles.filter(y => y !== x))}
                                onActivate={activate}
                            />
                        ))}
                    </Box>
                </SortableContext>
            </DndContext>
            <Typography
                variant="caption"
                color="text.secondary"
                sx={{ display: 'block', mt: 1 }}
            >
                {t('tilesHint')}
            </Typography>
        </Box>
    );
}

/** jsonConfig custom component "Overview" */
export default class Overview extends ConfigGeneric<ConfigGenericProps, ConfigGenericState> {
    onData = (data: Native): void => {
        this.props.onChange(data, undefined, () => {
            this.props.oContext.forceUpdate(['inputRegs', 'holdingRegs', 'groups', 'host', 'port', 'overviewTiles'], data);
        });
    };

    renderItem(): React.JSX.Element {
        return (
            <OverviewView
                {...this.props}
                onData={this.onData}
            />
        );
    }
}
