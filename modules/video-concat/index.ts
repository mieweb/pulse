// Reexport the native module. On web, it will be resolved to VideoConcatModule.web.ts
// and on native platforms to VideoConcatModule.ts
export { default } from './src/VideoConcatModule';
export * from  './src/VideoConcat.types';
