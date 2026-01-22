package expo.modules.videoconcat

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import android.content.Context
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import java.io.File
import java.nio.ByteBuffer

data class RecordingSegment(
  @Field val uri: String,
  @Field val trimStartTimeMs: Double? = null,
  @Field val trimEndTimeMs: Double? = null
) : Record

class VideoConcatModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("VideoConcat")
    
    Events("onProgress")
    
    AsyncFunction("export") { segments: List<RecordingSegment>, draftId: String ->
      val context = appContext.reactContext ?: throw Exception("React context not available")
      
      // Create output file
      val outputFile = File(context.cacheDir, "$draftId.mp4")
      if (outputFile.exists()) {
        outputFile.delete()
      }
      
      // Send initial progress
      sendEvent("onProgress", mapOf(
        "progress" to 0.0,
        "currentSegment" to 0,
        "phase" to "preparing"
      ))
      
      // Create muxer for output
      val muxer = MediaMuxer(outputFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
      var videoTrackIndex = -1
      var audioTrackIndex = -1
      var muxerStarted = false
      var rotationDegrees = 0
      
      // First pass: Add tracks from the first segment
      val firstUri = Uri.parse(segments[0].uri)
      val firstExtractor = MediaExtractor()
      
      try {
        firstExtractor.setDataSource(context, firstUri, null)
        
        for (trackIndex in 0 until firstExtractor.trackCount) {
          val format = firstExtractor.getTrackFormat(trackIndex)
          val mime = format.getString(MediaFormat.KEY_MIME) ?: continue
          
          if (mime.startsWith("video/") && videoTrackIndex == -1) {
            videoTrackIndex = muxer.addTrack(format)
            // Extract rotation metadata from the first video segment to preserve orientation
            if (format.containsKey(MediaFormat.KEY_ROTATION)) {
              rotationDegrees = format.getInteger(MediaFormat.KEY_ROTATION)
            }
          } else if (mime.startsWith("audio/") && audioTrackIndex == -1) {
            audioTrackIndex = muxer.addTrack(format)
          }
        }
        // Apply rotation hint to the muxer to preserve video orientation
        if (rotationDegrees != 0) {
          muxer.setOrientationHint(rotationDegrees)
        }
        // Start muxer after adding all tracks
        muxer.start()
        muxerStarted = true
        
      } finally {
        firstExtractor.release()
      }
      
      // Second pass: Process all segments
      var currentVideoPresentationTimeUs = 0L
      var currentAudioPresentationTimeUs = 0L
      
      for ((index, segment) in segments.withIndex()) {
        val uri = Uri.parse(segment.uri)
        val extractor = MediaExtractor()
        
        try {
          extractor.setDataSource(context, uri, null)
          
          var videoFirstSampleTimeUs = -1L
          var audioFirstSampleTimeUs = -1L
          val videoSegmentStartTime = currentVideoPresentationTimeUs
          val audioSegmentStartTime = currentAudioPresentationTimeUs
          
          // Process video track
          for (trackIndex in 0 until extractor.trackCount) {
            val format = extractor.getTrackFormat(trackIndex)
            val mime = format.getString(MediaFormat.KEY_MIME) ?: continue
            
            if (mime.startsWith("video/") && videoTrackIndex != -1) {
              extractor.selectTrack(trackIndex)
              
              // Calculate time range
              val startTimeUs = ((segment.trimStartTimeMs ?: 0.0) * 1000.0).toLong()
              val durationUs = if (format.containsKey(MediaFormat.KEY_DURATION)) {
                format.getLong(MediaFormat.KEY_DURATION)
              } else {
                Long.MAX_VALUE
              }
              val endTimeUs = (segment.trimEndTimeMs?.let { (it * 1000.0).toLong() } ?: durationUs)
              
              extractor.seekTo(startTimeUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
              
              val buffer = ByteBuffer.allocate(1024 * 1024)
              val bufferInfo = MediaCodec.BufferInfo()
              
              while (true) {
                val sampleSize = extractor.readSampleData(buffer, 0)
                if (sampleSize < 0) break
                
                val presentationTimeUs = extractor.sampleTime
                if (presentationTimeUs < startTimeUs) {
                  extractor.advance()
                  continue
                }
                if (presentationTimeUs > endTimeUs) break
                
                // Record first sample time for offset calculation
                if (videoFirstSampleTimeUs == -1L) {
                  videoFirstSampleTimeUs = presentationTimeUs
                }
                
                // Adjust presentation time for concatenation
                val adjustedPresentationTime = videoSegmentStartTime + (presentationTimeUs - videoFirstSampleTimeUs)
                
                bufferInfo.set(0, sampleSize, adjustedPresentationTime, extractor.sampleFlags)
                muxer.writeSampleData(videoTrackIndex, buffer, bufferInfo)
                
                currentVideoPresentationTimeUs = adjustedPresentationTime
                
                if (!extractor.advance()) break
              }
              
              extractor.unselectTrack(trackIndex)
            }
          }
          
          // Process audio track separately
          for (trackIndex in 0 until extractor.trackCount) {
            val format = extractor.getTrackFormat(trackIndex)
            val mime = format.getString(MediaFormat.KEY_MIME) ?: continue
            
            if (mime.startsWith("audio/") && audioTrackIndex != -1) {
              extractor.selectTrack(trackIndex)
              
              val startTimeUs = ((segment.trimStartTimeMs ?: 0.0) * 1000.0).toLong()
              val durationUs = if (format.containsKey(MediaFormat.KEY_DURATION)) {
                format.getLong(MediaFormat.KEY_DURATION)
              } else {
                Long.MAX_VALUE
              }
              val endTimeUs = (segment.trimEndTimeMs?.let { (it * 1000.0).toLong() } ?: durationUs)
              
              extractor.seekTo(startTimeUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)
              
              val buffer = ByteBuffer.allocate(1024 * 1024)
              val bufferInfo = MediaCodec.BufferInfo()
              
              while (true) {
                val sampleSize = extractor.readSampleData(buffer, 0)
                if (sampleSize < 0) break
                
                val presentationTimeUs = extractor.sampleTime
                if (presentationTimeUs < startTimeUs) {
                  extractor.advance()
                  continue
                }
                if (presentationTimeUs > endTimeUs) break
                
                // Record first sample time for offset calculation
                if (audioFirstSampleTimeUs == -1L) {
                  audioFirstSampleTimeUs = presentationTimeUs
                }
                
                // Adjust presentation time for concatenation
                val adjustedPresentationTime = audioSegmentStartTime + (presentationTimeUs - audioFirstSampleTimeUs)
                
                bufferInfo.set(0, sampleSize, adjustedPresentationTime, extractor.sampleFlags)
                muxer.writeSampleData(audioTrackIndex, buffer, bufferInfo)
                
                currentAudioPresentationTimeUs = adjustedPresentationTime
                
                if (!extractor.advance()) break
              }
              
              extractor.unselectTrack(trackIndex)
            }
          }
          
          // Send progress update
          val progress = (index + 1).toDouble() / segments.size * 0.8
          sendEvent("onProgress", mapOf(
            "progress" to progress,
            "currentSegment" to index + 1,
            "phase" to "processing"
          ))
          
        } finally {
          extractor.release()
        }
      }
      
      // Finalize
      sendEvent("onProgress", mapOf(
        "progress" to 0.9,
        "currentSegment" to segments.size,
        "phase" to "finalizing"
      ))
      
      if (muxerStarted) {
        muxer.stop()
      }
      muxer.release()
      
      // Return file URI
      Uri.fromFile(outputFile).toString()
    }
    
    AsyncFunction("cancelExport") {
      // Placeholder for cancel functionality
    }
    
    AsyncFunction("getDuration") { uri: String ->
      println("[VideoConcat] getDuration called for: $uri")
      
      val context = appContext.reactContext ?: run {
        println("[VideoConcat] React context not available")
        throw Exception("React context not available")
      }
      
      val parsedUri = try {
        Uri.parse(uri)
      } catch (e: Exception) {
        println("[VideoConcat] Invalid URI: $uri")
        throw Exception("Invalid URI: $uri")
      }
      
      val startTime = System.currentTimeMillis()
      val retriever = android.media.MediaMetadataRetriever()
      
      try {
        retriever.setDataSource(context, parsedUri)
        val durationMs = retriever.extractMetadata(
          android.media.MediaMetadataRetriever.METADATA_KEY_DURATION
        )?.toLongOrNull() ?: run {
          println("[VideoConcat] Invalid duration metadata")
          throw Exception("Invalid duration")
        }
        
        // Convert milliseconds to seconds (matching iOS implementation)
        val durationSeconds = durationMs / 1000.0
        val elapsed = System.currentTimeMillis() - startTime
        
        // Validate duration is finite and positive
        if (!durationSeconds.isFinite() || durationSeconds <= 0) {
          println("[VideoConcat] Invalid duration: $durationSeconds")
          throw Exception("Invalid duration: $durationSeconds")
        }
        
        println("[VideoConcat] Duration: ${String.format("%.2f", durationSeconds)}s (${elapsed}ms)")
        durationSeconds
      } finally {
        retriever.release()
      }
    }
  }
}