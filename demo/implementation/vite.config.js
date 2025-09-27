import { defineConfig } from 'vitest/config';

import { testConfig } from '../../commonConfiguration/vite.config';

export default defineConfig({
  test: testConfig,
  resolve: {
    alias: {
      '~': __dirname,
    },
  },
});
