// Lightweight unit-test runner for the project's PURE logic (timeline math, transcription
// decisions, model catalog) — no React/React Native rendering. Files are transformed with the
// project's Babel config, and the `@/` path alias is mapped to `src/`.

// Under embed/: generated native projects, test hosts (they get a copied web bundle on cap sync)
// and build output. Nothing in them is a Pulse test or a module Pulse resolves.
const embedIgnored = [
  '<rootDir>/embed/hosts/',
  '<rootDir>/embed/ios/',
  '<rootDir>/embed/android/',
  '<rootDir>/embed/artifacts/',
  '<rootDir>/embed/packages/[^/]+/dist/',
];

module.exports = {
  testEnvironment: 'node',
  // `.mjs` too: the embed scripts' libraries are ES modules, and jest runs CommonJS.
  transform: { '^.+\\.m?[jt]sx?$': 'babel-jest' },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // The host package from source, as the tsconfig path alias does (`/react` → `src/react/index`).
    '^@mieweb/pulse-embed$': '<rootDir>/embed/packages/pulse-embed/src/index',
    '^@mieweb/pulse-embed/(react|testing)$': '<rootDir>/embed/packages/pulse-embed/src/$1/index',
  },
  testMatch: [
    '<rootDir>/src/**/*.test.ts',
    '<rootDir>/embed/**/*.test.ts',
    '<rootDir>/modules/expo-ai-editor/src/*.test.ts',
  ],
  testPathIgnorePatterns: ['/node_modules/', ...embedIgnored],
  // Independent git submodules with their own package.json — exclude them from
  // haste-map scanning so jest doesn't see a naming collision with this app's own
  // package.json (both happen to be named "pulse").
  modulePathIgnorePatterns: [
    '<rootDir>/pulse-mieweb',
    '<rootDir>/pulsevault-mieweb',
    ...embedIgnored,
  ],
  watchPathIgnorePatterns: ['<rootDir>/pulse-mieweb', '<rootDir>/pulsevault-mieweb'],
};
