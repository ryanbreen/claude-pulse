import Cocoa

class BadgeWindow: NSWindow {
  override var canBecomeKey: Bool { false }
  override var canBecomeMain: Bool { false }
}

class BadgeDelegate: NSObject, NSApplicationDelegate {
  var label: NSTextField!
  var window: BadgeWindow!
  var timer: Timer?
  let stateFile = "/tmp/claude-pulse-state.json"

  func applicationDidFinishLaunching(_ notification: Notification) {
    // Create a small borderless floating window
    let size = NSSize(width: 42, height: 42)
    let screen = NSScreen.main!.frame
    // Position: top-right corner, below menu bar
    let origin = NSPoint(x: screen.maxX - size.width - 12, y: screen.maxY - size.height - 40)

    window = BadgeWindow(
      contentRect: NSRect(origin: origin, size: size),
      styleMask: .borderless,
      backing: .buffered,
      defer: false
    )
    window.level = .floating
    window.isOpaque = false
    window.backgroundColor = .clear
    window.hasShadow = false
    window.collectionBehavior = [.canJoinAllSpaces, .stationary]
    window.ignoresMouseEvents = true

    // Background circle
    let bgView = NSView(frame: NSRect(origin: .zero, size: size))
    bgView.wantsLayer = true
    bgView.layer?.cornerRadius = size.width / 2
    bgView.layer?.backgroundColor = NSColor(white: 0.1, alpha: 0.85).cgColor
    bgView.layer?.borderColor = NSColor(white: 0.3, alpha: 0.5).cgColor
    bgView.layer?.borderWidth = 1.0

    // Number label
    label = NSTextField(labelWithString: "0")
    label.font = NSFont.monospacedSystemFont(ofSize: 18, weight: .bold)
    label.textColor = NSColor(red: 0.3, green: 0.85, blue: 0.4, alpha: 1.0)
    label.alignment = .center
    label.frame = NSRect(x: 0, y: 8, width: size.width, height: 26)

    bgView.addSubview(label)
    window.contentView = bgView
    window.orderFrontRegardless()

    // Poll state file every 2 seconds
    timer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
      self?.updateBadge()
    }
    updateBadge()
  }

  func updateBadge() {
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: stateFile)),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let active = json["activeCount"] as? Int,
          let _ = json["totalCount"] as? Int else {
      label.stringValue = "?"
      label.textColor = NSColor.gray
      return
    }

    label.stringValue = "\(active)"

    // Color: green when active sessions exist, dim gray when all idle
    if active > 0 {
      // Pulsing green - brighter with more active
      let intensity = min(Double(active) / 10.0, 1.0) * 0.4 + 0.6
      label.textColor = NSColor(red: 0.2, green: CGFloat(intensity), blue: 0.3, alpha: 1.0)

      // Resize badge if number gets big
      let bgView = window.contentView!
      bgView.layer?.borderColor = NSColor(red: 0.2, green: 0.6, blue: 0.3, alpha: 0.6).cgColor
    } else {
      label.textColor = NSColor(white: 0.45, alpha: 1.0)
      let bgView = window.contentView!
      bgView.layer?.borderColor = NSColor(white: 0.3, alpha: 0.5).cgColor
    }
  }
}

// Launch as accessory app (no dock icon, no menu bar)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = BadgeDelegate()
app.delegate = delegate
app.run()
