# syncpack-workspace-protocol-check.md

Determines whether `syncpack format` (currently invoked in the root
`postinstall` script) rewrites `workspace:*` dependency specifiers into
something incompatible with pnpm's protocol expectations.

## Test

In the side-worktree (already running under pnpm 10):

1. Pick `packages/command-json-schema/package.json`.
2. Rewrite `"@castore/core": "workspace:"` → `"@castore/core": "workspace:*"`
   (what PR 2 Unit 7 will do across every workspace).
3. Run `pnpm exec syncpack format`.
4. `diff` pre vs post on the `dependencies` / `devDependencies` blocks.

## Result

```
$ diff pre.json post.json | grep -E '@castore|workspace'
<no output for workspace:* — unchanged>
```

The only delta was my own manual `workspace:` → `workspace:*` edit;
syncpack left the `workspace:*` specifier untouched. Full post-state:

```json
"@castore/core": "workspace:*"
```

## Verdict

**OK — do not strip `syncpack format` from `postinstall` in PR 2 Unit 10.**

`syncpack@13.0.4` respects pnpm's `workspace:*` protocol and does not
rewrite it to a semver range (e.g. `workspace:^1.2.3`). Therefore:

- PR 2 Unit 10 keeps `"postinstall": "husky && syncpack format"`
  (with the v9 deprecation fix applied).
- PR 2 Unit 7 can bulk-rewrite `workspace:` → `workspace:*` without
  needing to coordinate with the postinstall chain.

## Edge cases verified

- `syncpack format` alphabetises keys inside `dependencies`, `devDependencies`,
  `peerDependencies`, `scripts` (pre-existing behaviour; orthogonal to the
  workspace-protocol concern).
- `syncpack` does NOT currently check version-mismatch on workspace protocol
  specifiers — consistent with the Unit 4 expectation that
  `syncpack list-mismatches` reports only external-registry range drift.

## Follow-up signal

If a future syncpack upgrade (14.x or later) changes this behaviour, the
migration docs in PR 2 Unit 12's CONTRIBUTING.md should be updated with
guidance on pinning syncpack or adjusting its config.
