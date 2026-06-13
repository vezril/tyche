import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Dev: Vite serves the SPA and proxies /api to the Fastify server (architecture §4).
// Prod: `vite build` output is copied into the single app image and served by Fastify (NFR-2, ADR-001).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@ynab-clone/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
});
