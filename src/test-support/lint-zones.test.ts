import { beforeAll, describe, expect, it } from '@jest/globals';
import { ESLint } from 'eslint';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// The boundary rules in eslint.config.js, run on seeded files at real paths. The config is passed
// in, not loaded from disk: ESLint loads a config file with a dynamic import, which Jest's VM
// doesn't support.
const root = path.resolve(__dirname, '../..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const config = require('../../eslint.config.js');

const BOUNDARY_RULES = new Set([
  'no-restricted-imports',
  'no-restricted-syntax',
  'import/no-restricted-paths',
]);

let eslint: ESLint;
beforeAll(() => {
  eslint = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: config });
});

/** The boundary-rule hits for `code` linted as the file at `file` (relative to the repo). */
async function boundaryHits(file: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(root, file) });
  const fatal = result.messages.filter((m) => m.fatal);
  if (fatal.length) throw new Error(fatal.map((m) => m.message).join('\n'));
  return result.messages
    .filter((m) => m.ruleId && BOUNDARY_RULES.has(m.ruleId))
    .map((m) => `${m.ruleId}: ${m.message}`);
}

const ROUTER = "import { router } from 'expo-router';\nexport const go = () => router.back();\n";
const STATUS_BAR = "import { StatusBar } from 'expo-status-bar';\nexport const S = StatusBar;\n";
const FEATURE =
  "import type { EditorScreenProps } from '@/features/editor/contract';\n" +
  'export type P = EditorScreenProps;\n';

describe('lint zones', () => {
  it('fails expo-router and expo-status-bar in a feature', async () => {
    expect(await boundaryHits('src/features/editor/x.tsx', ROUTER)).toEqual([
      expect.stringContaining('expo-router belongs to the standalone shell'),
    ]);
    expect(await boundaryHits('src/features/editor/x.tsx', STATUS_BAR)).toEqual([
      expect.stringContaining('expo-status-bar belongs to the standalone shell'),
    ]);
  });

  it('holds the components, hooks and constants the features draw with to the same rules', async () => {
    for (const file of ['src/components/x.tsx', 'src/hooks/x.ts', 'src/constants/x.ts']) {
      expect(await boundaryHits(file, ROUTER)).toEqual([
        expect.stringContaining('expo-router belongs to the standalone shell'),
      ]);
    }
  });

  it('passes the same imports in the standalone shell', async () => {
    expect(await boundaryHits('src/app/x.tsx', ROUTER)).toEqual([]);
    expect(await boundaryHits('src/app/x.tsx', STATUS_BAR)).toEqual([]);
    expect(await boundaryHits('src/shell/standalone/x.ts', ROUTER)).toEqual([]);
  });

  it('fails a feature importing the app or the embed shell, by alias or relative path', async () => {
    const app = "import Home from '@/app/index';\nexport const H = Home;\n";
    const relative = "import Home from '../../app/index';\nexport const H = Home;\n";
    const embed =
      "import { PulseEmbed } from '@mieweb/pulse-embed';\nexport const E = PulseEmbed;\n";
    for (const code of [app, relative]) {
      expect(await boundaryHits('src/features/editor/x.tsx', code)).toEqual([
        expect.stringContaining('src/app is the standalone shell'),
      ]);
    }
    expect(await boundaryHits('src/features/editor/x.tsx', embed)).toEqual([
      expect.stringContaining('embed/ is the embed shell'),
    ]);
  });

  it('fails db, core and utils importing a feature; a feature may', async () => {
    for (const file of ['src/db/x.ts', 'src/core/x.ts', 'src/utils/x.ts']) {
      expect(await boundaryHits(file, FEATURE)).toEqual([
        expect.stringContaining('core, db and utils never import a feature'),
      ]);
    }
    expect(await boundaryHits('src/features/export/x.ts', FEATURE)).toEqual([]);
  });

  it('fails a feature the embed runs importing a standalone-only one (rule 2)', async () => {
    const transfer =
      "import { useDraftTransfer } from '@/features/draft-transfer/use-draft-transfer';\n" +
      'export const t = useDraftTransfer;\n';
    const about =
      "import { compatLabel } from '@/features/about/details';\nexport const c = compatLabel;\n";
    const onboarding =
      "import { OnboardingScreen } from '@/features/onboarding/onboarding-screen';\n" +
      'export const O = OnboardingScreen;\n';
    for (const [file, code, name] of [
      ['src/features/editor/x.tsx', transfer, 'draft-transfer'],
      ['src/features/recorder/x.tsx', onboarding, 'onboarding'],
      ['src/features/upload/core/x.tsx', about, 'about'],
      ['src/features/export/x.tsx', about, 'about'],
    ]) {
      expect(await boundaryHits(file, code)).toEqual([
        expect.stringContaining(`${name} is standalone-only`),
      ]);
    }
    // Home is a standalone screen: it may. So may pairing, standalone-only itself (the
    // destinations sheet shows About's compatibility labels).
    expect(await boundaryHits('src/features/drafts/x.tsx', transfer)).toEqual([]);
    expect(await boundaryHits('src/features/upload/pairing/destinations-sheet.tsx', about)).toEqual(
      [],
    );
  });

  it('fails a shell package loaded by require() or import() in a feature', async () => {
    const required = "export const r = require('expo-router');\n";
    const subpath = "export const r = require('expo-router/build/hooks');\n";
    const dynamic = "export const load = () => import('expo-status-bar');\n";
    const importEquals = "import r = require('expo-router');\nexport const R = r;\n";
    for (const [code, name] of [
      [required, 'expo-router'],
      [subpath, 'expo-router'],
      [dynamic, 'expo-status-bar'],
      [importEquals, 'expo-router'],
    ]) {
      expect(await boundaryHits('src/features/editor/x.ts', code)).toEqual([
        expect.stringContaining(`${name} belongs to the standalone shell`),
      ]);
    }
    // Not a package that only starts with the same name; and the shell may.
    const other = "export const r = require('expo-router-extra');\n";
    expect(await boundaryHits('src/features/editor/x.ts', other)).toEqual([]);
    expect(await boundaryHits('src/app/x.tsx', required)).toEqual([]);
    expect(await boundaryHits('src/features/onboarding/onboarding-screen.tsx', required)).toEqual(
      [],
    );
  });

  it('lets pairing and the listed onboarding files use expo-router', async () => {
    for (const file of [
      'src/features/onboarding/use-onboarding-redirect.ts',
      'src/features/upload/pairing/pairing-sheet.tsx',
      'src/features/upload/pairing/x.ts',
    ]) {
      expect(await boundaryHits(file, ROUTER)).toEqual([]);
    }
    // Not upload's core, nor the rest of onboarding.
    for (const file of ['src/features/upload/core/x.tsx', 'src/features/onboarding/x.ts']) {
      expect(await boundaryHits(file, ROUTER)).toEqual([
        expect.stringContaining('expo-router belongs to the standalone shell'),
      ]);
    }
  });

  it('keeps upload/pairing to the standalone side, by alias or relative path', async () => {
    const pairing =
      "import { poolProvider } from '@/features/upload/pairing/pool-provider';\n" +
      'export const p = poolProvider;\n';
    const relative =
      "import { poolProvider } from '../pairing/pool-provider';\nexport const p = poolProvider;\n";
    for (const [file, code] of [
      ['src/features/upload/core/x.ts', pairing],
      ['src/features/upload/core/x.ts', relative],
      // The export screen takes its targets and picker from the shell's provider.
      ['src/features/export/x.tsx', pairing],
      ['src/features/recorder/x.tsx', pairing],
      ['src/components/x.tsx', pairing],
      ['src/hooks/x.ts', pairing],
      ['embed/src/shell/x.tsx', pairing],
    ]) {
      expect(await boundaryHits(file, code)).toEqual([
        expect.stringContaining('upload/pairing is standalone-only'),
      ]);
    }
    // Pairing builds on core; the standalone shell and the standalone-only screens may import it.
    const core =
      "import { uploads } from '@/features/upload/core/upload-manager';\n" +
      'export const u = uploads;\n';
    expect(await boundaryHits('src/features/upload/pairing/x.ts', core)).toEqual([]);
    for (const file of [
      'src/app/x.tsx',
      'src/shell/standalone/x.ts',
      'src/features/drafts/x.tsx',
      'src/features/about/x.ts',
    ]) {
      expect(await boundaryHits(file, pairing)).toEqual([]);
    }
  });

  it('allows opening a URL or Settings anywhere, and link listeners only in pairing', async () => {
    const open =
      "import { Linking } from 'react-native';\n" +
      'export const settings = () => Linking.openSettings();\n' +
      "export const site = () => Linking.openURL('https://example.org');\n";
    expect(await boundaryHits('src/features/recorder/x.ts', open)).toEqual([]);

    const initial =
      "import { Linking } from 'react-native';\n" +
      'export const first = () => Linking.getInitialURL();\n';
    const listen =
      "import { Linking } from 'react-native';\n" +
      'export const on = () => Linking.addEventListener("url", () => {});\n';
    for (const code of [initial, listen]) {
      expect(await boundaryHits('src/features/editor/x.ts', code)).toEqual([
        expect.stringContaining('Only pairing listens for incoming links'),
      ]);
      expect(
        await boundaryHits('src/features/upload/pairing/upload-deep-link-provider.tsx', code),
      ).toEqual([]);
      // Not upload's core.
      expect(await boundaryHits('src/features/upload/core/x.ts', code)).toEqual([
        expect.stringContaining('Only pairing listens for incoming links'),
      ]);
    }

    const expoLinking =
      "import { getInitialURL } from 'expo-linking';\nexport const f = getInitialURL;\n";
    expect(await boundaryHits('src/features/editor/x.ts', expoLinking)).toEqual([
      expect.stringContaining('expo-linking is for pairing'),
      expect.stringContaining('Only pairing listens for incoming links'),
    ]);
    expect(
      await boundaryHits('src/features/upload/pairing/pairing-sheet.tsx', expoLinking),
    ).toEqual([]);

    // Destructured or renamed, a listener is still a listener.
    const destructured =
      "import { Linking } from 'react-native';\n" +
      'const { addEventListener } = Linking;\n' +
      'export const on = () => addEventListener("url", () => {});\n';
    expect(await boundaryHits('src/features/editor/x.ts', destructured)).toEqual([
      expect.stringContaining('Only pairing listens for incoming links'),
    ]);
    const renamed =
      "import { Linking as L } from 'react-native';\n" +
      'export const first = () => L.getInitialURL();\n';
    expect(await boundaryHits('src/features/editor/x.ts', renamed)).toEqual([
      expect.stringContaining('Use Linking under its own name'),
    ]);
    // Reached through a namespace import.
    const namespaced =
      "import * as RN from 'react-native';\n" +
      'export const first = () => RN.Linking.getInitialURL();\n' +
      'export const settings = () => RN.Linking.openSettings();\n';
    expect(await boundaryHits('src/features/editor/x.ts', namespaced)).toEqual([
      expect.stringContaining('Only pairing listens for incoming links'),
    ]);
    expect(await boundaryHits('src/features/upload/pairing/pairing-sheet.tsx', namespaced)).toEqual(
      [],
    );
  });

  it('keeps the embed entry to its one static import (rule 4)', async () => {
    const roots =
      "import { setStorageRoots } from '@/utils/storage-root';\nexport const s = setStorageRoots;\n";
    const more = "import { CONTRACT } from '@/features/embed/host';\nexport const c = CONTRACT;\n";
    expect(await boundaryHits('embed/src/embed-root.tsx', roots)).toEqual([]);
    expect(await boundaryHits('embed/src/embed-root.tsx', more)).toEqual([
      expect.stringContaining('embed-root.tsx statically imports only'),
    ]);
  });

  // Rule 4 on the file itself (npm run lint checks it too): as it is, it passes; one more static
  // import of Pulse code, and it fails.
  it('holds the real embed-root.tsx to rule 4', async () => {
    const file = 'embed/src/embed-root.tsx';
    const source = readFileSync(path.join(root, file), 'utf8');
    expect(await boundaryHits(file, source)).toEqual([]);
    const withMore = "import { log } from '@/features/logs/logger';\nvoid log;\n" + source;
    expect(await boundaryHits(file, withMore)).toEqual([
      expect.stringContaining('embed-root.tsx statically imports only'),
    ]);
  });
});
