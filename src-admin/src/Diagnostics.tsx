/*
 * Diagnostics: one table with all poll groups (last round, duration, response time, requests, skipped
 * rounds, timeouts, errors, last error), connection and write statistics - live from info.*.
 */
import React from 'react';
import { Box, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tooltip, Typography } from '@mui/material';
import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';

import { type Native, LEVEL_COLORS, ago, num, t, useStates, groupColor } from './shared';

const KEYS = [
    'lastRound',
    'roundDuration',
    'lastResponseTime',
    'requestsToday',
    'skippedToday',
    'timeoutsToday',
    'errorsToday',
    'timeoutsTotal',
    'errorsTotal',
    'lastError',
];

export function DiagnosticsView(props: ConfigGenericProps): React.JSX.Element {
    const data = props.data as Native;
    const groups = (data.groups || []).filter(g => g && g.name);
    const gk = (name: string): string => `info.groups.${name.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    const ids = [
        'info.connection',
        'info.reconnects',
        'info.lastReconnect',
        'info.queueLength',
        'info.lastValueUpdate',
        'info.write.okTotal',
        'info.write.failedTotal',
        'info.write.lastError',
        'info.write.lastResponseTime',
        ...groups.flatMap(g => KEYS.map(k => `${gk(g.name)}.${k}`)),
    ];
    const s = useStates(props, ids, 5000);
    const v = (id: string): any => (s[id] ? s[id].val : undefined);
    const cell = (x: any): string => (x === undefined || x === null || x === '' ? '–' : String(x));
    return (
        <Box sx={{ width: '100%' }}>
            <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap', mb: 2 }}>
                {[
                    [t('stConnection'), v('info.connection') ? t('connected') : t('disconnected')],
                    [t('diagReconnects'), cell(v('info.reconnects'))],
                    [t('diagLastReconnect'), cell(v('info.lastReconnect'))],
                    [t('diagQueue'), cell(v('info.queueLength'))],
                    [t('stLastValues'), ago(v('info.lastValueUpdate'))],
                    [t('diagWrites'), `${cell(v('info.write.okTotal'))} / ${cell(v('info.write.failedTotal'))}`],
                ].map(([k, x]) => (
                    <Box key={k}>
                        <Typography
                            variant="caption"
                            color="text.secondary"
                        >
                            {k}
                        </Typography>
                        <Typography
                            variant="body2"
                            sx={{ fontWeight: 600 }}
                        >
                            {x}
                        </Typography>
                    </Box>
                ))}
            </Box>
            {!props.alive ? (
                <Typography
                    variant="body2"
                    color="text.secondary"
                    sx={{ mb: 1 }}
                >
                    {t('notAlive')}
                </Typography>
            ) : null}
            <TableContainer sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 3 }}>
                <Table
                    size="small"
                    aria-label={t('diagTitle')}
                >
                    <TableHead>
                        <TableRow>
                            <TableCell>{t('group')}</TableCell>
                            <TableCell>{t('diagLastRound')}</TableCell>
                            <TableCell align="right">{t('diagRound')}</TableCell>
                            <TableCell align="right">{t('diagResponse')}</TableCell>
                            <TableCell align="right">{t('diagRequests')}</TableCell>
                            <TableCell align="right">{t('diagSkipped')}</TableCell>
                            <TableCell align="right">{t('diagTimeouts')}</TableCell>
                            <TableCell align="right">{t('diagErrors')}</TableCell>
                            <TableCell>{t('diagLastError')}</TableCell>
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {groups.map((g, i) => {
                            const p = gk(g.name);
                            const bad = Number(v(`${p}.timeoutsToday`) || 0) + Number(v(`${p}.errorsToday`) || 0);
                            const sk = Number(v(`${p}.skippedToday`) || 0);
                            return (
                                <TableRow
                                    key={g.name}
                                    hover
                                >
                                    <TableCell>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                            <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: groupColor(g.name, i) }} />
                                            <span>
                                                {g.name} · {t('everyN', num(g.interval, 60))}
                                            </span>
                                        </Box>
                                    </TableCell>
                                    <TableCell>{ago(v(`${p}.lastRound`))}</TableCell>
                                    <TableCell align="right">{cell(v(`${p}.roundDuration`))} ms</TableCell>
                                    <TableCell align="right">{cell(v(`${p}.lastResponseTime`))} ms</TableCell>
                                    <TableCell align="right">{cell(v(`${p}.requestsToday`))}</TableCell>
                                    <TableCell
                                        align="right"
                                        sx={{ color: sk ? LEVEL_COLORS.warn : undefined }}
                                    >
                                        {cell(v(`${p}.skippedToday`))}
                                    </TableCell>
                                    <TableCell
                                        align="right"
                                        sx={{ color: bad ? LEVEL_COLORS.warn : undefined }}
                                    >
                                        {cell(v(`${p}.timeoutsToday`))}
                                        <Typography
                                            variant="caption"
                                            color="text.secondary"
                                        >
                                            {' '}
                                            ({cell(v(`${p}.timeoutsTotal`))})
                                        </Typography>
                                    </TableCell>
                                    <TableCell align="right">
                                        {cell(v(`${p}.errorsToday`))}
                                        <Typography
                                            variant="caption"
                                            color="text.secondary"
                                        >
                                            {' '}
                                            ({cell(v(`${p}.errorsTotal`))})
                                        </Typography>
                                    </TableCell>
                                    <TableCell sx={{ maxWidth: 280 }}>
                                        <Tooltip title={cell(v(`${p}.lastError`))}>
                                            <Typography
                                                variant="caption"
                                                noWrap
                                                sx={{ display: 'block' }}
                                            >
                                                {cell(v(`${p}.lastError`))}
                                            </Typography>
                                        </Tooltip>
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
                {t('diagHint')}
            </Typography>
        </Box>
    );
}

/** jsonConfig custom component "Diagnostics" */
export default class Diagnostics extends ConfigGeneric<ConfigGenericProps, ConfigGenericState> {
    renderItem(): React.JSX.Element {
        return <DiagnosticsView {...this.props} />;
    }
}
