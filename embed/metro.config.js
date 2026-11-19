const fs = require('fs');
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

// The embedded build bundles the app's own code (../src) with the app's single node_modules, so
// there is one copy of every dependency and nothing to keep in step.
const repo = path.resolve(__dirname, '..');
const config = getDefaultConfig(__dirname);
// Real paths: a worktree may link node_modules from another checkout.
const nodeModules = fs.realpathSync(path.join(repo, 'node_modules'));
const pulseEditor = fs.realpathSync(path.join(repo, 'modules/pulse-editor'));
config.watchFolders = [repo, nodeModules, pulseEditor];
config.resolver.nodeModulesPaths = [nodeModules];
config.resolver.disableHierarchicalLookup = true;
// Drizzle's generated .sql migration files.
config.resolver.sourceExts.push('sql');

// Modules the embedded build leaves out (B6; embed/package.json doesn't link them): the host app
// owns notifications, background work and incoming links; react-native-background-actions'
// service assumes a React Native host app (it crashes in others); and async-storage (the old
// library's one-time move), the clipboard (pairing, About, the upload link the app's Export route
// hands the upload manager) and the document picker (.pulse import, library restore) serve only
// the Pulse app. Code the embed still reaches gets a stub that does nothing, where the missing
// native module would crash it as it loads; the clipboard's is a guard, as nothing the embed
// imports reaches it now.
const stubs = {
  'expo-notifications': path.join(__dirname, 'src/stubs/expo-notifications.ts'),
  'react-native-background-actions': path.join(__dirname, 'src/stubs/background-actions.ts'),
  '@react-native-async-storage/async-storage': path.join(__dirname, 'src/stubs/async-storage.ts'),
  'expo-clipboard': path.join(__dirname, 'src/stubs/clipboard.ts'),
  'expo-document-picker': path.join(__dirname, 'src/stubs/document-picker.ts'),
  // Only pairing (src/features/upload/pairing) and the Pulse app's routes use it, and the embed
  // bundles neither: a guard, should one reach the bundle.
  'expo-linking': path.join(__dirname, 'src/stubs/linking.ts'),
  // The submodule, bundled from its TypeScript source as the app does.
  '@mieweb/pulse-editor': path.join(pulseEditor, 'src/index.tsx'),
};
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SEP = '[\\\\/]';
const modulesDir = path.join(repo, 'modules');
config.resolver.blockList = [
  ...[].concat(config.resolver.blockList ?? []),
  new RegExp(
    `^${modulesDir.split(path.sep).map(escape).join(SEP)}${SEP}[^\\\\/]+${SEP}(node_modules|example)${SEP}.*`,
  ),
];
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const stub = stubs[moduleName];
  if (stub) return { type: 'sourceFile', filePath: stub };
  return (defaultResolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
