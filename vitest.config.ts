import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  // The page tests render JSX; use the automatic runtime so they need no
  // React import, matching how Next compiles the app itself.
  esbuild: { jsx: 'automatic' },
  test: { environment: 'node', include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // See src/test/server-only-stub.ts.
      'server-only': path.resolve(__dirname, 'src/test/server-only-stub.ts'),
    },
  },
});
