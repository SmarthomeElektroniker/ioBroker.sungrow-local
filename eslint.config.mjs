import config from '@iobroker/eslint-config';

export default [
    ...config,
    {
        ignores: ['node_modules/**', 'admin/**', 'test/**', 'coverage/**', 'werkzeuge/**', 'lokal/**', 'docs/**', 'src-admin/**', '*.config.mjs'],
    },
    {
        // plain JavaScript with JSDoc types (checkJs is off): @typedef/@type/@property are wanted here
        rules: {
            'jsdoc/check-tag-names': ['warn', { typed: false }],
            'jsdoc/reject-any-type': 'off',
        },
    },
];
