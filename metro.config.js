const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
// Let Metro resolve Drizzle's generated .sql migration files.
config.resolver.sourceExts.push('sql');

// Local native modules (git submodules under modules/) are autolinked by Expo from that folder and
// aren't npm dependencies, so point their bare import at the TypeScript source — nothing is built.
// Their own node_modules (if a submodule was ever installed standalone) are blocked so shared deps
// like react-native always resolve to this app's single copy.
const modulesDir = path.resolve(__dirname, 'modules');
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SEP = '[\\\\/]';
const localModules = {
  'react-native-video-trim': path.resolve(
    __dirname,
    'modules/react-native-video-trim/src/index.tsx',
  ),
  '@mieweb/pulse-editor': path.resolve(__dirname, 'modules/pulse-editor/src/index.tsx'),
};
config.resolver.blockList = [
  ...[].concat(config.resolver.blockList ?? []),
  // Either path separator, so the pattern also matches Metro's paths on Windows.
  new RegExp(
    `^${modulesDir.split(path.sep).map(escape).join(SEP)}${SEP}[^\\\\/]+${SEP}(node_modules|example)${SEP}.*`,
  ),
];
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const local = localModules[moduleName];
  if (local) return { type: 'sourceFile', filePath: local };
  return (defaultResolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
