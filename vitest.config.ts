import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.mts'],
    // TFTP client tests use real UDP sockets that can interfere under parallel execution
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
