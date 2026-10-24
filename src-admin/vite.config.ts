import react from '@vitejs/plugin-react';
import commonjs from 'vite-plugin-commonjs';
import { federation } from '@module-federation/vite';
import { moduleFederationShared } from '@iobroker/gui-components/modulefederation.admin.config';
import pack from './package.json' with { type: 'json' };

/**
 * The admin (>= 8.2) provides React, MUI and the ioBroker libraries as singletons: no fallback copies in
 * this bundle (import: false). @mui/icons-material is not shared by the admin and is bundled directly.
 */
function hostShared(): Record<string, any> {
    const shared: Record<string, any> = moduleFederationShared(pack);
    // the admin does not share the icons: bundle only the few used ones (tree-shaken) instead of a 5 MB fallback
    delete shared['@mui/icons-material'];
    for (const [name, cfg] of Object.entries(shared)) {
        shared[name] = { ...cfg, import: false };
    }
    return shared;
}

const config = {
    plugins: [
        federation({
            manifest: true,
            name: 'ConfigCustomSungrowLocalSet',
            filename: 'customComponents.js',
            exposes: {
                './Components': './src/Components.tsx',
            },
            dts: false,
            remotes: {},
            shared: hostShared(),
        }),
        react(),
        commonjs(),
    ],
    server: {
        port: 3000,
        proxy: {
            '/files': 'http://localhost:8081',
            '/adapter': 'http://localhost:8081',
            '/session': 'http://localhost:8081',
            '/log': 'http://localhost:8081',
            '/lib': 'http://localhost:8081',
        },
    },
    base: './',
    build: {
        target: 'chrome89',
        outDir: './build',
        commonjsOptions: { include: [/lib\//, /node_modules/] },
        rollupOptions: {
            onwarn(warning: { code: string }, warn: (warning: { code: string }) => void): void {
                if (warning.code === 'MODULE_LEVEL_DIRECTIVE') {
                    return;
                }
                warn(warning);
            },
        },
    },
};

export default config;
