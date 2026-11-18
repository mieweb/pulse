import { beforeAll, describe, expect, it } from '@jest/globals';
import { ESLint } from 'eslint';
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

  it('lets the listed pairing and onboarding files use expo-router until PR2-B', async () => {
    expect(
      await boundaryHits('src/features/onboarding/use-onboarding-redirect.ts', ROUTER),
    ).toEqual([]);
    expect(await boundaryHits('src/features/upload/pairing-sheet.tsx', ROUTER)).toEqual([]);
    // Not the rest of upload.
    expect(await boundaryHits('src/features/upload/x.tsx', ROUTER)).toHaveLength(1);
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
      expect(await boundaryHits('src/features/upload/upload-deep-link-provider.tsx', code)).toEqual(
        [],
      );
    }

    const expoLinking =
      "import { getInitialURL } from 'expo-linking';\nexport const f = getInitialURL;\n";
    expect(await boundaryHits('src/features/editor/x.ts', expoLinking)).toEqual([
      expect.stringContaining('expo-linking is for pairing'),
      expect.stringContaining('Only pairing listens for incoming links'),
    ]);
    expect(await boundaryHits('src/features/upload/pairing-sheet.tsx', expoLinking)).toEqual([]);
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
});
