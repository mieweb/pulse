"""Regression checks for moving excerpts versus held stages of the same drawing."""

from itertools import groupby
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
DRAWING = HERE.parents[2] / "screenshots/validation/ai-edit/beatlapse/drawing-source.mp4"


class StyleTests(unittest.TestCase):
    def run_preview(self, parent, style, *options, source=DRAWING):
        destination = Path(parent) / style
        subprocess.run([sys.executable, "-B", HERE / "preview.py", source, destination,
                        "--style", style, *options], check=True, capture_output=True)
        return destination, json.loads((destination / "edit.json").read_text())

    def test_action_keeps_work_including_last_strokes_at_original_speed(self):
        with tempfile.TemporaryDirectory() as work:
            directory, edit = self.run_preview(work, "action", "--speed", "1")
            self.assertEqual(edit["playbackRate"], 1)
            self.assertEqual(len(edit["intervals"]), 4)
            last = edit["intervals"][-1]
            self.assertLessEqual(last["start"], 25)
            self.assertGreaterEqual(last["end"], 29)
            duration = float(subprocess.check_output([
                "ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "csv=p=0", directory / "beatlapse.mp4",
            ]))
            kept = sum(i["end"] - i["start"] for i in edit["intervals"])
            self.assertAlmostEqual(duration, kept, places=3)

    def test_stages_display_three_distinct_color_frames_for_equal_holds(self):
        with tempfile.TemporaryDirectory() as work:
            directory, edit = self.run_preview(work, "stages", "--max-stages", "3", "--budget", "8")
            self.assertEqual([i["sourceTime"] for i in edit["stills"]], [7.5, 23.5, 30.0])
            checksums = subprocess.check_output([
                "ffmpeg", "-v", "error", "-i", directory / "beatlapse.mp4",
                "-f", "framemd5", "-",
            ], text=True)
            hashes = [line.rsplit(",", 1)[1].strip() for line in checksums.splitlines()
                      if line and not line.startswith("#")]
            runs = [(value, len(list(group))) for value, group in groupby(hashes)]
            self.assertEqual(len(set(hashes)), 3)
            self.assertEqual([length for _, length in runs], [80, 80, 80])

    def test_continuous_keeps_whole_source_range_and_requested_duration(self):
        with tempfile.TemporaryDirectory() as work:
            directory, edit = self.run_preview(work, "continuous", "--budget", "8")
            self.assertEqual(edit["intervals"], [{"start": 0, "end": 32}])
            self.assertEqual(edit["playbackRate"], 4)
            duration = subprocess.check_output([
                "ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "csv=p=0", directory / "beatlapse.mp4",
            ])
            self.assertEqual(float(duration), 8)


if __name__ == "__main__":
    unittest.main()
