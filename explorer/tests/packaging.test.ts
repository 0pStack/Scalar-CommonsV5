import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

/**
 * Dependency hygiene, asserted rather than assumed.
 *
 * `accounts.ts` recognises an account with `instanceof GenericAccountId`. A
 * class identity check is only sound while exactly one copy of
 * `@polkadot/types` is installed — with two copies it returns `false` for every
 * account and the explorer answers with an empty accounts list instead of an
 * error. Nothing about that failure is visible on the page, so it has to be
 * caught here: every package a source file imports must be declared, and the
 * `@polkadot/types*` packages must be pinned to the exact version
 * `@polkadot/api` itself depends on, so npm can never resolve a second copy.
 */

const root = fileURLToPath(new URL('..', import.meta.url));

interface Manifest {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Manifest;

/** Every `.ts` file under a directory, recursively. */
function sources(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(dir, entry.name))
      : entry.name.endsWith('.ts')
        ? [join(dir, entry.name)]
        : [],
  );
}

/** The package names a file imports, ignoring relative paths and node builtins. */
function importedPackages(file: string): string[] {
  const text = readFileSync(join(root, file), 'utf8');
  const names = new Set<string>();
  for (const match of text.matchAll(/^\s*(?:import|export)\b[^'"]*from '([^']+)'/gm)) {
    const specifier = match[1] ?? '';
    if (specifier.startsWith('.') || specifier.startsWith('node:')) {
      continue;
    }
    const parts = specifier.split('/');
    names.add(specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : (parts[0] ?? specifier));
  }
  return [...names];
}

describe('declared dependencies', () => {
  it('declares every package src/ imports as a runtime dependency', () => {
    for (const file of sources('src')) {
      for (const name of importedPackages(file)) {
        expect(
          Object.keys(manifest.dependencies),
          `${file} imports ${name}, which package.json does not declare as a dependency`,
        ).toContain(name);
      }
    }
  });

  it('declares every package tests/ imports, as a dependency or a dev dependency', () => {
    const declared = [...Object.keys(manifest.dependencies), ...Object.keys(manifest.devDependencies)];
    for (const file of sources('tests')) {
      for (const name of importedPackages(file)) {
        expect(declared, `${file} imports ${name}, which package.json does not declare`).toContain(name);
      }
    }
  });

  it('does not ship a runtime dependency that only the tests import', () => {
    const usedBySrc = new Set(sources('src').flatMap(importedPackages));
    for (const name of Object.keys(manifest.dependencies)) {
      expect(usedBySrc, `${name} is a runtime dependency but no file in src/ imports it`).toContain(name);
    }
  });

  it('pins @polkadot/types and @polkadot/types-codec to the version @polkadot/api resolves', () => {
    // Exact, and equal to @polkadot/api's own exact pin on them: any looser
    // range lets npm nest a second copy, which silently breaks `instanceof`.
    const api = manifest.dependencies['@polkadot/api'];
    expect(api).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.dependencies['@polkadot/types']).toBe(api);
    expect(manifest.dependencies['@polkadot/types-codec']).toBe(api);
  });
});

/** Every installed package directory, including the scoped ones, under a node_modules dir. */
function installedPackages(nodeModules: string): string[] {
  return readdirSync(nodeModules, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || entry.name.startsWith('.')) {
      return [];
    }
    const path = join(nodeModules, entry.name);
    return entry.name.startsWith('@')
      ? readdirSync(path, { withFileTypes: true })
          .filter((scoped) => scoped.isDirectory())
          .map((scoped) => join(path, scoped.name))
      : [path];
  });
}

describe('installed dependencies', () => {
  it('installs exactly one copy of @polkadot/types, so instanceof stays sound', () => {
    // A nested copy is how the class identity check silently starts returning
    // false, so the invariant is checked against what npm actually laid down,
    // not just against what package.json asks for.
    const nested = installedPackages(join(root, 'node_modules'))
      .map((path) => join(path, 'node_modules', '@polkadot', 'types'))
      .filter((path) => existsSync(path));
    expect(nested).toEqual([]);
    expect(existsSync(join(root, 'node_modules', '@polkadot', 'types'))).toBe(true);
  });
});
