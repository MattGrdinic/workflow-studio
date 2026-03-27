import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'json', 'lcov', 'cobertura'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/claude-executor.ts'], // External CLI wrapper, tested via integration
    },
    reporters: ['default', 'junit'],
    outputFile: { junit: 'coverage/junit.xml' },
    testTimeout: 15000,
  },
});
