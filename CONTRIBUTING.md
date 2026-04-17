# Contributing

We are open to, and grateful for, any contributions made by the community. By contributing to Castore, you agree to abide by the [code of conduct](https://github.com/castore-dev/castore/blob/main/CODE_OF_CONDUCT.md).

## Development setup

Castore uses **pnpm 10.33.0** with Nx and requires **Node `^22.19.0`**.

```bash
# enable pnpm via Corepack (bundled with Node ≥16.9)
corepack enable

# install — strict peer deps, fail-closed onlyBuiltDependencies allow-list
pnpm install
```

The root `preinstall: only-allow pnpm` guard will reject `npm install` or `yarn install` attempts with a clear error. If you previously worked on the repo under Yarn, run `rm -rf node_modules && pnpm install` to rematerialize the workspace under pnpm's strict linker.

## Reporting Issues and Asking Questions

Before opening an issue, please search the [issue tracker](https://github.com/castore-dev/castore/issues) to make sure your issue hasn't already been reported.
