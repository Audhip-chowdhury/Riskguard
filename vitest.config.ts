import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['tests/setup.ts'],
    testTimeout: 10000,
    env: {
      DATABASE_PATH: './data/riskguard-test.db',
      NODE_ENV: 'test',
      PORT: '3002',
      LOG_LEVEL: 'silent',
    },
  },
});
