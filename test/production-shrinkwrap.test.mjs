import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CANONICAL_SHRINKWRAP_PATH,
  createProductionManifest,
  createStagedSourceLock,
  materializeCanonicalShrinkwrap,
  verifyCanonicalShrinkwrap,
  verifyProductionShrinkwrap,
} from '../release/production-shrinkwrap.mjs';

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(
  readFileSync(join(repositoryRoot, 'package.json'), 'utf8'),
);
const sourceLock = JSON.parse(
  readFileSync(join(repositoryRoot, 'package-lock.json'), 'utf8'),
);
const shrinkwrap = JSON.parse(readFileSync(CANONICAL_SHRINKWRAP_PATH, 'utf8'));

test('canonical shrinkwrap is production-only and pins the tested graph', () => {
  const materialized = materializeCanonicalShrinkwrap(shrinkwrap, manifest);
  assert.equal(verifyProductionShrinkwrap(materialized, manifest, sourceLock), true);

  const entries = Object.entries(shrinkwrap.packages);
  assert.equal(entries.some(([, metadata]) => metadata.dev === true), false);
  assert.equal(entries.some(([, metadata]) => metadata.devOptional === true), false);
  assert.equal(entries.some(([, metadata]) => metadata.link === true), false);
  assert.equal(entries.some(([path]) => path.startsWith('packages/')), false);
  assert.equal(shrinkwrap.packages[''].devDependencies, undefined);
  assert.equal(shrinkwrap.packages[''].workspaces, undefined);
});

test('canonical shrinkwrap materializes version-only releases without mutation', () => {
  const stale = structuredClone(shrinkwrap);
  stale.version = '0.0.0';
  stale.packages[''].version = '0.0.0';

  assert.throws(
    () => verifyProductionShrinkwrap(stale, manifest, sourceLock),
    /Shrinkwrap package version is stale/,
  );

  const materialized = materializeCanonicalShrinkwrap(stale, manifest);
  assert.equal(materialized.version, manifest.version);
  assert.equal(materialized.packages[''].version, manifest.version);
  assert.equal(stale.version, '0.0.0');
  assert.equal(stale.packages[''].version, '0.0.0');
  assert.equal(verifyProductionShrinkwrap(materialized, manifest, sourceLock), true);
  assert.equal(
    verifyCanonicalShrinkwrap(stale, materialized, manifest, sourceLock),
    true,
  );
});

test('canonical version materialization still requires a synchronized source lock', () => {
  const generated = materializeCanonicalShrinkwrap(shrinkwrap, manifest);
  const staleTopLevel = structuredClone(sourceLock);
  staleTopLevel.version = '0.0.0';
  assert.throws(
    () => verifyCanonicalShrinkwrap(shrinkwrap, generated, manifest, staleTopLevel),
    /package-lock\.json package version is stale/,
  );

  const staleRoot = structuredClone(sourceLock);
  staleRoot.packages[''].version = '0.0.0';
  assert.throws(
    () => verifyCanonicalShrinkwrap(shrinkwrap, generated, manifest, staleRoot),
    /package-lock\.json root package version is stale/,
  );
});

test('canonical verification still rejects identity and dependency graph drift', () => {
  const generated = materializeCanonicalShrinkwrap(shrinkwrap, manifest);
  const renamed = structuredClone(shrinkwrap);
  renamed.name = 'not-tau';
  assert.throws(
    () => verifyCanonicalShrinkwrap(renamed, generated, manifest, sourceLock),
    /Shrinkwrap package name is stale/,
  );

  const incomplete = structuredClone(shrinkwrap);
  const removedPath = Object.keys(incomplete.packages).find(
    path => path && incomplete.packages[path].optional !== true,
  );
  assert.ok(removedPath, 'expected a required production package entry');
  delete incomplete.packages[removedPath];
  assert.throws(
    () => verifyCanonicalShrinkwrap(incomplete, generated, manifest, sourceLock),
    /Production shrinkwrap is stale/,
  );
});

test('canonical shrinkwrap retains optional packages for every supported platform', () => {
  for (const packageName of Object.keys(manifest.optionalDependencies)) {
    assert.ok(
      shrinkwrap.packages[`node_modules/${packageName}`],
      `missing direct optional package ${packageName}`,
    );
  }

  // The property under test is that optional packages for platforms OTHER
  // than the generating host survive the prune — otherwise a shrinkwrap built
  // on Windows would starve a macOS install of its native binary. sharp is
  // the multi-platform native dependency that proves it; the @cortexkit/aft-*
  // trio that used to be asserted here went with the AFT tools.
  assert.ok(shrinkwrap.packages['node_modules/fsevents']);
  assert.ok(shrinkwrap.packages['node_modules/@img/sharp-win32-x64']);
  assert.ok(shrinkwrap.packages['node_modules/@img/sharp-darwin-arm64']);
  assert.ok(shrinkwrap.packages['node_modules/@img/sharp-linux-x64']);
});

test('staging inputs remove development and workspace metadata before pruning', () => {
  const productionManifest = createProductionManifest(manifest);
  const stagedLock = createStagedSourceLock(sourceLock);

  assert.equal(productionManifest.devDependencies, undefined);
  assert.equal(productionManifest.workspaces, undefined);
  assert.equal(stagedLock.packages[''].devDependencies, undefined);
  assert.equal(stagedLock.packages[''].workspaces, undefined);
  assert.equal(stagedLock.packages['packages/tau-installer'], undefined);
  assert.equal(
    stagedLock.packages['node_modules/@abdoknbgit/tau-installer'],
    undefined,
  );
});
