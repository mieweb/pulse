import { NativeModule, requireNativeModule } from "expo";
import { VideoPostprocessModuleEvents, PostprocessOptions } from "./VideoPostprocess.types";

declare class VideoPostprocessModule extends NativeModule<VideoPostprocessModuleEvents> {
  processClip(inputURL: string, outputURL: string, options: PostprocessOptions): Promise<string>;
  processClips(inputURLs: string[], outputDir: string, options: PostprocessOptions): Promise<string[]>;
}

export default requireNativeModule<VideoPostprocessModule>("VideoPostprocess");
