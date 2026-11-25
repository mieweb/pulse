import ExpoModulesCore

private struct AiEditorPassageRecord: Record {
  @Field var id: String = ""
  @Field var text: String = ""
  @Field var durationMs: Double = 0
}

public final class AiEditorModule: Module {
  private let engine = AiEditorEngine()

  public func definition() -> ModuleDefinition {
    Name("AiEditor")

    AsyncFunction("availability") { () -> [String: Any] in
      let status = AiEditorEngine.availability()
      return ["available": status.available, "reason": status.reason, "message": status.message]
    }

    AsyncFunction("selectPassages") {
      (records: [AiEditorPassageRecord], targetDurationMs: Double, requestId: String, promise: Promise) in
      let passages = records.map {
        AiEditorPassage(id: $0.id, text: $0.text, durationMs: $0.durationMs)
      }
      Task {
        do {
          let ids = try await self.engine.select(
            passages, targetDurationMs: targetDurationMs, requestId: requestId
          )
          promise.resolve(["selectedIds": ids])
        } catch let error as AiEditorError {
          promise.reject(error.code, error.message)
        } catch {
          promise.reject("ERR_AI_GENERATION", "On-device selection failed. \(error.localizedDescription)")
        }
      }
    }

    AsyncFunction("cancel") { (requestId: String, promise: Promise) in
      Task {
        await self.engine.cancel(requestId: requestId)
        promise.resolve()
      }
    }

    OnDestroy { [engine] in
      Task { await engine.cancelAll() }
    }
  }
}
