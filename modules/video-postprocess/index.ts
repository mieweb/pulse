// Reexport the native module. On web, it will be resolved to VideoPostprocessModule.web.ts
// and on native platforms to VideoPostprocessModule.ts
export { default } from './src/VideoPostprocessModule';
export * from  './src/VideoPostprocess.types';
