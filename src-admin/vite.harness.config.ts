// Standalone build of the development harness (src/App.tsx with a simulated socket): used for the smoke
// test and for screenshots without ioBroker. Not part of the adapter package.
import react from '@vitejs/plugin-react';
import commonjs from 'vite-plugin-commonjs';

export default {
    plugins: [react(), commonjs()],
    base: './',
    server: { port: 4173 },
    build: {
        target: 'chrome89',
        outDir: './build-harness',
        chunkSizeWarningLimit: 8000,
        commonjsOptions: { include: [/lib\//, /node_modules/] },
        // one script file - inlined into a single HTML page by preview.mjs
        assetsInlineLimit: 100000000,
        rollupOptions: { output: { inlineDynamicImports: true } },
    },
};
