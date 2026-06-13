import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Component tests for UI logic (E3.S2/S3): vitest + @testing-library/react in
// a jsdom environment, with `fetch` mocked per test — the API behavior itself
// is integration-tested server-side via app.inject (server/test/web). Chosen
// over a browser harness for speed and zero extra infrastructure (NFR-2).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Resolve the workspace package to TS source so tests don't require a prior build.
      '@ynab-clone/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
  },
});
