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

// Modules the embedded build leaves out: the host app owns notifications and background work, and
// react-native-background-actions' service assumes a React Native host app (it crashes in others).
const stubs = {
  'expo-notifications': path.join(__dirname, 'src/stubs/expo-notifications.ts'),
  'react-native-background-actions': path.join(__dirname, 'src/stubs/background-actions.ts'),
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
