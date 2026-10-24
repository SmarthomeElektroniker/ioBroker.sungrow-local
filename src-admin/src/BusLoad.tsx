import React from 'react';
import { Box, Tooltip, Typography } from '@mui/material';

import { LEVEL_COLORS, type Level, fmt, t } from './shared';

/** Horizontal bar 0 … 120 % with the 80 % and 100 % marks */
export function LoadBar(props: {
    load: number;
    level: Level;
    height?: number;
    label?: string;
    showMarks?: boolean;
}): React.JSX.Element {
    const pct = Math.max(0, props.load * 100);
    const width = Math.min(100, (pct / 120) * 100);
    const h = props.height || 10;
    return (
        <Box
            role="meter"
            aria-label={props.label || t('busLoad')}
            aria-valuemin={0}
            aria-valuemax={120}
            aria-valuenow={Math.round(pct)}
            aria-valuetext={`${Math.round(pct)} % – ${t(`level_${props.level}`)}`}
            sx={{
                position: 'relative',
                height: h,
                borderRadius: h / 2,
                bgcolor: theme => (theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)'),
                overflow: 'hidden',
            }}
        >
            <Box
                sx={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: `${width}%`,
                    bgcolor: LEVEL_COLORS[props.level],
                    borderRadius: h / 2,
                    transition: 'width 250ms ease, background-color 250ms ease',
                }}
            />
            {props.showMarks !== false
                ? [80, 100].map(m => (
                      <Box
                          key={m}
                          sx={{
                              position: 'absolute',
                              top: 0,
                              bottom: 0,
                              left: `${(m / 120) * 100}%`,
                              width: '2px',
                              bgcolor: theme =>
                                  theme.palette.mode === 'dark' ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.35)',
                          }}
                      />
                  ))
                : null}
        </Box>
    );
}

/** Summary of the whole bus: requests/s against the capacity, traffic light and explanation */
export function BusLoadSummary(props: { analysis: any; measuredNote?: string }): React.JSX.Element {
    const a = props.analysis;
    const lvl: Level = a.total.level;
    return (
        <Box
            sx={{
                p: 2,
                borderRadius: 3,
                border: '1px solid',
                borderColor: 'divider',
                bgcolor: 'background.paper',
            }}
        >
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, flexWrap: 'wrap', mb: 1 }}>
                <Typography
                    variant="subtitle1"
                    sx={{ fontWeight: 600 }}
                >
                    {t('busLoad')}
                </Typography>
                <Typography
                    variant="h5"
                    sx={{ fontWeight: 700, color: LEVEL_COLORS[lvl] }}
                >
                    {Math.round(a.total.load * 100)} %
                </Typography>
                <Typography
                    variant="body2"
                    color="text.secondary"
                >
                    {t('busLoadDetail', fmt(a.total.perSecond), fmt(a.capacity), a.total.requests, a.total.registers)}
                </Typography>
                <Box sx={{ flex: 1 }} />
                <Tooltip title={t('busLoadModel')}>
                    <Typography
                        variant="body2"
                        tabIndex={0}
                        sx={{
                            color: LEVEL_COLORS[lvl],
                            fontWeight: 600,
                            cursor: 'help',
                            borderBottom: '1px dotted',
                        }}
                    >
                        {t(`level_${lvl}`)}
                    </Typography>
                </Tooltip>
            </Box>
            <LoadBar
                load={a.total.load}
                level={lvl}
                height={14}
            />
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 0.5 }}>
                <Typography
                    variant="caption"
                    color="text.secondary"
                >
                    0 %
                </Typography>
                <Typography
                    variant="caption"
                    color="text.secondary"
                >
                    {t('busLoadMarks')}
                </Typography>
            </Box>
            {props.measuredNote ? (
                <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: 'block', mt: 0.5 }}
                >
                    {props.measuredNote}
                </Typography>
            ) : null}
        </Box>
    );
}
