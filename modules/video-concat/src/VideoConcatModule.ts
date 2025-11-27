import { RecordingSegment } from "@/components/RecordingProgressBar";
import { NativeModule, requireNativeModule } from "expo";
import { VideoConcatModuleEvents } from "./VideoConcat.types";

declare class VideoConcatModule extends NativeModule<VideoConcatModuleEvents> {
  export(segments: RecordingSegment[], draftId: string): Promise<string>;
  cancelExport(): Promise<void>;
  getVideoDuration(uri: string, inMs?: number | null, outMs?: number | null): Promise<number>;
}

export default requireNativeModule<VideoConcatModule>("VideoConcat");
