import config from '@iobroker/eslint-config';

export default [
    ...config,
    {
        ignores: ['node_modules/**', 'admin/**', 'test/**', 'coverage/**', 'werkzeuge/**', 'lokal/**', 'docs/**', '*.config.mjs'],
    },
];
