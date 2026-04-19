import rootConfig from '../../eslint.config.js';

export default [
  // Extend the root configuration
  ...rootConfig,
  // Package-wide overrides: only relax rules that are genuinely inapplicable
  // to every TS file here. Rules that only conflict with a couple of files
  // are narrowed further below.
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // Drizzle's generic column / query-builder types surface as `any` at
      // the boundaries (e.g. `PgDatabase<any, any, any>`), so `unsafe-*`
      // checks produce noise across the whole package without catching
      // bugs. Same for the explicit `any` in dialect adapter type aliases
      // and the type assertions used to narrow driver row shapes.
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/consistent-type-assertions': 'off',

      // Allow empty interfaces for Drizzle generic types.
      '@typescript-eslint/no-empty-interface': 'off',

      // Allow non-null assertions when working with DB results.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  // Narrowly-scoped exception for the three dialect adapter files only.
  //
  // These files aggregate dialect-specific SQL construction, transaction
  // wiring, and the `EventStorageAdapter` interface surface into a single
  // conceptual unit. Each one is still over the repo-wide `max-lines: 200`
  // limit after extracting every duplicated helper into `src/common/` —
  // what remains is genuinely dialect-specific code (SQL builders for
  // INSERT values / force-update SETs, per-dialect timestamp coercion,
  // per-dialect transaction semantics, duplicate-key detection) that
  // would only obscure the adapter's behaviour if fragmented further.
  //
  // Scope the disable to just these three files so every other file in
  // the package (schema, contract, common helpers, tests) still enforces
  // the repo baseline.
  {
    files: [
      '**/src/pg/adapter.ts',
      '**/src/mysql/adapter.ts',
      '**/src/sqlite/adapter.ts',
    ],
    rules: {
      'max-lines': 'off',
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
  // Relax `max-lines` for test files and the shared conformance harness.
  // Splitting integration-style tests across files fragments setup/teardown
  // and Docker-container lifecycle management in a way that obscures more
  // than it helps; the root config already disables `complexity` for tests
  // for the same reason.
  {
    files: [
      '**/*.test.{ts,tsx}',
      '**/src/__tests__/**/*.{ts,tsx}',
      '**/examples/**/*.{ts,tsx}',
    ],
    rules: {
      'max-lines': 'off',
    },
  },
];
