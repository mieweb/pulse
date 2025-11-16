import { EventEmitter } from "expo";

const emitter = new EventEmitter({} as any);

export default {
  processClip(inputURL: string, outputURL: string, options: any): Promise<string> {
    return Promise.reject(new Error("VideoPostprocess is not supported on web"));
  },
  processClips(inputURLs: string[], outputDir: string, options: any): Promise<string[]> {
    return Promise.reject(new Error("VideoPostprocess is not supported on web"));
  },
  addListener: emitter.addListener.bind(emitter),
  removeListeners: emitter.removeListeners.bind(emitter),
};
