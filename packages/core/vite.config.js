import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

import { testConfig } from '../../commonConfiguration/vite.config';

export default defineConfig({
  test: testConfig,
  plugins: [tsconfigPaths()],
});
