import { RecordingSegment } from "@/components/RecordingProgressBar";
import { NativeModule, requireNativeModule } from "expo";
import { VideoConcatModuleEvents } from "./VideoConcat.types";

declare class VideoConcatModule extends NativeModule<VideoConcatModuleEvents> {
  getDuration(uri: string): Promise<number>;
  export(segments: RecordingSegment[], draftId: string): Promise<string>;
  cancelExport(): Promise<void>;
}

export default requireNativeModule<VideoConcatModule>("VideoConcat");
