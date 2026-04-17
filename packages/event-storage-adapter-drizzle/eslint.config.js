import rootConfig from '../../eslint.config.js';

export default [
  // Extend the root configuration
  ...rootConfig,
  // Override rules for this specific package
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // Disable unsafe member access/assignment/call rules since we're working with Drizzle types
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',

      // Allow type assertions since we need them for Drizzle row types
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/consistent-type-assertions': 'off',

      // Allow empty interfaces for Drizzle generic types
      '@typescript-eslint/no-empty-interface': 'off',

      // Disable max-lines warning since DB adapters tend to be larger
      'max-lines': 'off',

      // Allow non-null assertions when working with DB results
      '@typescript-eslint/no-non-null-assertion': 'off',

      // Allow boolean type coercion for DB values
      '@typescript-eslint/strict-boolean-expressions': 'off',
    },
  },
  // The shared conformance suite under src/__tests__/ is a plain `.ts` file
  // (not `.unit.test.ts` — vitest mustn't pick it up directly), but it is
  // test-support code, not shipped source. Treat it like tests for the
  // devDependencies rule so it can import `lodash.omit`, testcontainers, etc.
  {
    files: ['**/src/__tests__/**/*.{ts,tsx}'],
    rules: {
      'import/no-extraneous-dependencies': [
        'error',
        {
          devDependencies: true,
          optionalDependencies: false,
          peerDependencies: true,
        },
      ],
    },
  },
];
