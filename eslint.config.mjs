import config from '@iobroker/eslint-config';

export default [
    ...config,
    {
        ignores: ['node_modules/**', 'admin/**', 'test/**', 'coverage/**', 'werkzeuge/**', 'lokal/**', 'docs/**', 'src-admin/**', '.dev-server/**', '*.config.mjs'],
    },
    {
        // no floating promises in the adapter code: a forgotten rejection is an "unhandled promise rejection"
        // and js-controller restarts the instance. `void promise` does not count as handled.
        files: ['main.js', 'lib/**/*.js'],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname,
            },
        },
        rules: {
            '@typescript-eslint/no-floating-promises': ['error', { ignoreVoid: false }],
            '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: true } }],
        },
    },
    {
        // plain JavaScript with JSDoc types (checkJs is off): @typedef/@type/@property are wanted here
        rules: {
            'jsdoc/check-tag-names': ['warn', { typed: false }],
            'jsdoc/reject-any-type': 'off',
        },
    },
];
