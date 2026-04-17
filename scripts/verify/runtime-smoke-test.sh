#!/usr/bin/env bash
# runtime-smoke-test.sh
#
# Builds @castore/core + @castore/event-storage-adapter-in-memory tarballs
# from the current working tree, installs them into a scratch pnpm project,
# and runs a minimal import + API call to confirm the published layout works
# under pnpm's symlinked `.pnpm/` node_modules structure.
#
# Specifically catches regressions in the `addImportExtension` Babel plugin
# where emitted .mjs/.cjs files may not resolve deep imports correctly.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
SCRATCH="$(mktemp -d -t castore-smoke.XXXXXX)"
SMOKE_VERSION="0.0.0-smoke.0"
PACKAGES=(core event-storage-adapter-in-memory)

restore_versions() {
  while IFS= read -r -d '' bak; do
    mv "$bak" "${bak%.smoke-bak}"
  done < <(find "$ROOT/packages" "$ROOT/demo" -name 'package.json.smoke-bak' -print0)
  rm -rf "$SCRATCH"
}
trap restore_versions EXIT

cd "$ROOT"

echo "[smoke] building tarballs..."
pnpm nx run-many --target=package --projects=@castore/core,@castore/event-storage-adapter-in-memory >/dev/null

# pnpm pack requires a version field and resolves workspace:* refs to exact
# versions at pack time. Set a smoke version on every package so the packed
# tarballs have consistent exact-version dependency ranges.
for pkg in "${PACKAGES[@]}"; do
  cp "packages/$pkg/package.json" "packages/$pkg/package.json.smoke-bak"
done
# Set version on all packages (not just PACKAGES[@]) so workspace:* refs in
# the packed tarballs resolve cleanly.
while IFS= read -r -d '' pj; do
  [ -f "$pj.smoke-bak" ] || cp "$pj" "$pj.smoke-bak"
  jq --arg v "$SMOKE_VERSION" '.version = $v' "$pj.smoke-bak" > "$pj"
done < <(find packages demo -mindepth 2 -maxdepth 2 -name package.json -print0)

( cd packages/core && pnpm pack --pack-destination "$SCRATCH" >/dev/null )
( cd packages/event-storage-adapter-in-memory && pnpm pack --pack-destination "$SCRATCH" >/dev/null )

CORE_TGZ="$(ls "$SCRATCH"/castore-core-*.tgz | head -1)"
IMS_TGZ="$(ls "$SCRATCH"/castore-event-storage-adapter-in-memory-*.tgz | head -1)"

echo "[smoke] setting up scratch project at $SCRATCH..."
cd "$SCRATCH"
cat > package.json <<'EOF'
{
  "name": "castore-smoke",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" }
}
EOF

pnpm add "file:$CORE_TGZ" "file:$IMS_TGZ" >/dev/null

cat > smoke-test.mjs <<'EOF'
import { EventStore, EventType, tuple } from '@castore/core';
import { InMemoryEventStorageAdapter } from '@castore/event-storage-adapter-in-memory';

const eventType = new EventType({ type: 'SMOKE_OK' });

const store = new EventStore({
  eventStoreId: 'smoke',
  eventTypes: tuple(eventType),
  reducer: (_, event) => ({ aggregateId: event.aggregateId, version: event.version, events: [event] }),
  eventStorageAdapter: new InMemoryEventStorageAdapter(),
});

const { event } = await store.pushEvent({
  aggregateId: 'a1',
  version: 1,
  type: 'SMOKE_OK',
  timestamp: new Date().toISOString(),
});

if (event.type !== 'SMOKE_OK') {
  console.error('smoke FAILED: unexpected event', event);
  process.exit(1);
}

console.log('smoke OK');
EOF

echo "[smoke] running smoke-test.mjs..."
node smoke-test.mjs
