import Foundation
import Vision

struct Selection: Encodable {
  let startIndex: Int
  let reason: String
}

func featurePrint(_ url: URL) throws -> VNFeaturePrintObservation {
  let request = VNGenerateImageFeaturePrintRequest()
  request.revision = VNGenerateImageFeaturePrintRequestRevision2
  request.imageCropAndScaleOption = .scaleFit
  try VNImageRequestHandler(url: url).perform([request])
  guard let result = request.results?.first as? VNFeaturePrintObservation else {
    throw NSError(domain: "Beatlapse", code: 1, userInfo: [
      NSLocalizedDescriptionKey: "Missing Vision feature print for \(url.lastPathComponent)"
    ])
  }
  return result
}

// Row w gives every source picture's distance to its closest picture in window w.
// For each source picture, slide a minimum across the other pictures in time order.
func windowDistances(_ prints: [VNFeaturePrintObservation], span: Int) throws -> [[Float]] {
  let count = prints.count
  var windows = Array(repeating: [Float](repeating: 0, count: count), count: count - span + 1)
  for (source, observation) in prints.enumerated() {
    var distances = [Float](repeating: 0, count: count)
    var minima = [Int]()
    var head = 0
    for index in prints.indices {
      try observation.computeDistance(&distances[index], to: prints[index])
      while minima.count > head && distances[minima.last!] >= distances[index] {
        minima.removeLast()
      }
      minima.append(index)
      if minima[head] <= index - span { head += 1 }
      if index >= span - 1 { windows[index - span + 1][source] = distances[minima[head]] }
    }
  }
  return windows
}

func selectWindows(_ prints: [VNFeaturePrintObservation], span: Int, limit: Int) throws -> [Selection] {
  if prints.count <= span { return [Selection(startIndex: 0, reason: "whole recording")] }
  var kept = [Selection(startIndex: 0, reason: "opening")]
  if limit >= 2 && prints.count >= 2 * span {
    kept.append(Selection(startIndex: prints.count - span, reason: "closing"))
  }
  if kept.count >= limit { return kept }
  let distances = try windowDistances(prints, span: span)
  var nearest = distances[0]
  for window in kept.dropFirst() {
    for i in nearest.indices { nearest[i] = min(nearest[i], distances[window.startIndex][i]) }
  }
  var candidates = distances.indices.filter { start in
    kept.allSatisfy { abs(start - $0.startIndex) >= span }
  }
  while kept.count < limit && !candidates.isEmpty {
    var bestGain = 0.000001
    var winner: Int?
    for start in candidates {
      let window = distances[start]
      var gain = 0.0
      for i in nearest.indices where window[i] < nearest[i] {
        gain += Double(nearest[i]) - Double(window[i])
      }
      if gain > bestGain {
        bestGain = gain
        winner = start
      }
    }
    guard let start = winner else { break }
    kept.append(Selection(startIndex: start, reason: "added visual coverage"))
    for i in nearest.indices { nearest[i] = min(nearest[i], distances[start][i]) }
    candidates.removeAll { abs($0 - start) < span }
  }
  return kept.sorted { $0.startIndex < $1.startIndex }
}

// preview.py supplies bounded, validated kernel arguments after sampling the video.
let args = CommandLine.arguments
guard args.count == 5, let span = Int(args[2]), span > 0, let limit = Int(args[3]), limit > 0,
  let maxSamples = Int(args[4]), maxSamples > 0
else { exit(2) }
do {
  let urls = try FileManager.default.contentsOfDirectory(
    at: URL(fileURLWithPath: args[1]), includingPropertiesForKeys: nil
  ).filter { $0.pathExtension == "jpg" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
  guard !urls.isEmpty && urls.count <= maxSamples else { exit(2) }
  let prints = try urls.map { url in try autoreleasepool { try featurePrint(url) } }
  let result = try selectWindows(prints, span: span, limit: limit)
  FileHandle.standardOutput.write(try JSONEncoder().encode(result))
} catch {
  FileHandle.standardError.write(Data("Vision selection failed: \(error.localizedDescription)\n".utf8))
  exit(1)
}
