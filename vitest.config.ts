import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      // text: visible in any CI log with no extra tooling. html: browsable
      // locally (coverage/index.html) without needing a third-party service.
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      // Generated at build time, never hand-written -- nothing to cover.
      exclude: ['src/**/*.d.ts'],
    },
  },
});
