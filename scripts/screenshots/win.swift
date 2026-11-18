import CoreGraphics
import Foundation
let skip = Set(CommandLine.arguments.dropFirst().compactMap { Int32($0) })
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as! [[String: Any]]
var best: (Int, Double) = (0, 0)
for w in list {
  let owner = w[kCGWindowOwnerName as String] as? String ?? ""
  let pid = w[kCGWindowOwnerPID as String] as? Int32 ?? 0
  let layer = w[kCGWindowLayer as String] as? Int ?? -1
  let b = w[kCGWindowBounds as String] as? [String: Double] ?? [:]
  let area = (b["Width"] ?? 0) * (b["Height"] ?? 0)
  if layer == 0 && !skip.contains(pid) && (owner == "Code" || owner == "Electron" || owner.contains("Visual Studio")) && area > best.1 { best = ((w[kCGWindowNumber as String] as? Int) ?? 0, area) }
}
print(best.0)
