package expo.modules.videopostprocess

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class VideoPostprocessModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("VideoPostprocess")

    Events("onProgress")

    AsyncFunction("processClip") { inputURL: String, outputURL: String, options: Map<String, Any> ->
      throw UnsupportedOperationException("VideoPostprocess is not yet implemented on Android")
    }

    AsyncFunction("processClips") { inputURLs: List<String>, outputDir: String, options: Map<String, Any> ->
      throw UnsupportedOperationException("VideoPostprocess is not yet implemented on Android")
    }
  }
}
