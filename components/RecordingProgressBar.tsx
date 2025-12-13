import React from "react";
import { StyleSheet, View } from "react-native";

export interface RecordingSegment {
  id: string;
  recordedDurationSeconds: number; // Duration of the recorded segment in seconds
  uri: string;
  trimStartTimeMs?: number; // Optional start trim point in milliseconds
  trimEndTimeMs?: number; // Optional end trim point in milliseconds
}

interface RecordingProgressBarProps {
  segments: RecordingSegment[];
  maxDurationLimitSeconds: number; // Maximum allowed duration limit in seconds
  activeRecordingDurationSeconds?: number; // Currently recording segment duration in seconds
}

export default function RecordingProgressBar({
  segments,
  maxDurationLimitSeconds,
  activeRecordingDurationSeconds = 0,
}: RecordingProgressBarProps) {
  const totalRecordedDurationSeconds = segments.reduce(
    (total, segment) => total + segment.recordedDurationSeconds,
    0
  );

  const totalUsedDurationSeconds = totalRecordedDurationSeconds + activeRecordingDurationSeconds;
  const progressPercentage = Math.min(
    (totalUsedDurationSeconds / maxDurationLimitSeconds) * 100,
    100
  );

  return (
    <View style={styles.container}>
      <View style={styles.progressBarBackground}>
        <View
          style={[styles.progressBarFill, { width: `${progressPercentage}%` }]}
        />

        {/* Render segment dividers */}
        {segments.map((segment, index) => {
          const segmentEndPercentage = Math.min(
            (segments
              .slice(0, index + 1)
              .reduce((total, seg) => total + seg.recordedDurationSeconds, 0) /
              maxDurationLimitSeconds) *
              100,
            100
          );

          return (
            <View
              key={segment.id}
              style={[
                styles.segmentDivider,
                { left: `${segmentEndPercentage}%` },
              ]}
            />
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    top: 60,
    left: 20,
    right: 20,
    zIndex: 10,
  },
  progressBarBackground: {
    height: 6,
    backgroundColor: "rgba(255, 255, 255, 0.3)",
    borderRadius: 3,
    position: "relative",
  },
  progressBarFill: {
    height: "100%",
    backgroundColor: "#ff0000",
    borderRadius: 3,
  },
  segmentDivider: {
    position: "absolute",
    top: -2,
    width: 2,
    height: 8,
    backgroundColor: "#ffffff",
    borderRadius: 1,
  },
});
