// captain-desk: the Mac app's hands and eyes for agents, as a small helper the
// app starts for each action (see src/lib/computer.ts, which maps an agent's
// computer_* tool call to one of these). Every command prints one JSON object
// on its last line. Coordinates are screen points on the main display, origin
// top left (the same space CGEvent, CGWindowList and Accessibility use).
//
//   captain-desk screen                      {"type":"screen","width":1512,"height":982,"scale":2,"front":"Numbers","computer":"Grace's MacBook Pro"}
//   captain-desk screenshot [maxWidth]       {"type":"image","png":"<base64>","width":…,"height":…,"screenWidth":…,"screenHeight":…,"front":"…"}
//                                            The whole main display, without Captain's own windows, scaled to at most maxWidth (default 1440).
//   captain-desk zoom x y w h [maxWidth]     The same for a region, at full resolution.
//   captain-desk click x y [left|right|middle] [count] [cmd,shift,alt,ctrl]
//   captain-desk move x y
//   captain-desk drag x1 y1 x2 y2
//   captain-desk scroll x y up|down|left|right [amount]
//   captain-desk key "<combo>" ["<combo>"…]  e.g. key cmd+l enter  (cmd, shift, alt/option, ctrl; enter, tab, escape, backspace, delete, up/down/left/right, pageup, pagedown, home, end, space, f1–f12)
//   captain-desk type [--submit]             Types stdin where the cursor is (a new line is ⇧⏎; --submit presses ⏎ after).
//   captain-desk apps                        Running apps and their windows.
//   captain-desk focus <app> [windowTitle]   Bring an app (and a window) to the front.
//   captain-desk open <app|url|path>
//   captain-desk ax [app|front] [query] [max]  The app's contents from Accessibility: {"type":"ax","app":…,"nodes":[{role,title,value,desc,x,y,w,h,enabled,focused,selected,depth}]}
//   captain-desk clipboard get | set         (set reads stdin)
//   captain-desk permissions                 {"type":"permissions","accessibility":true,"screen":false}
//   captain-desk hit x y                     What's under that point: {"type":"hit","role":"AXButton","title":"Send","desc":…,"app":"Mail"}
//                                            (the nearest button, link or menu item around it), for the gate in src/lib/gate.ts.
//   captain-desk focused                     The element with the keyboard focus: {"type":"focused","role":"AXTextField","subrole":"AXSecureTextField",…}
//
// Needs Accessibility (clicks, keys, reading apps) and Screen Recording
// (screenshots, window titles), both granted to Captain, which starts this.

import AppKit
import ApplicationServices
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object),
          let line = String(data: data, encoding: .utf8) else { return }
    print(line)
    fflush(stdout)
}

func fail(_ message: String) -> Never {
    emit(["type": "error", "message": message])
    exit(1)
}

let arguments = CommandLine.arguments
let command = arguments.count > 1 ? arguments[1] : "screen"
let rest = Array(arguments.dropFirst(2))
let captainPid = getppid()
let myPid = getpid()

func number(_ i: Int, _ fallback: Double = 0) -> Double {
    guard i < rest.count, let v = Double(rest[i]) else { return fallback }
    return v
}

func sleepMs(_ ms: Int) {
    usleep(useconds_t(ms * 1000))
}

// ------------------------------------------------------------ permissions

let ACCESSIBILITY_HELP = "Captain needs Accessibility permission to click, type and read apps. Turn on Captain in System Settings → Privacy & Security → Accessibility, then try again."
let SCREEN_HELP = "Captain needs Screen Recording permission to see the screen. Turn on Captain in System Settings → Privacy & Security → Screen Recording, then try again."

func accessibilityOK(prompt: Bool) -> Bool {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
    return AXIsProcessTrustedWithOptions(options)
}

func screenOK(prompt: Bool) -> Bool {
    if CGPreflightScreenCaptureAccess() {
        return true
    }
    if prompt {
        _ = CGRequestScreenCaptureAccess()
    }
    return false
}

func needAccessibility() {
    if !accessibilityOK(prompt: true) {
        fail(ACCESSIBILITY_HELP)
    }
}

// ------------------------------------------------------------ screen and apps

func mainBounds() -> CGRect {
    return CGDisplayBounds(CGMainDisplayID())
}

func scaleFactor() -> CGFloat {
    return NSScreen.main?.backingScaleFactor ?? 2
}

func frontApp() -> NSRunningApplication? {
    if let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier != captainPid, app.activationPolicy == .regular {
        return app
    }
    // Captain itself is in front: the first ordinary window under it.
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    for info in windows {
        guard let layer = (info[kCGWindowLayer as String] as? NSNumber)?.intValue, layer == 0,
              let pid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, pid != captainPid, pid != myPid,
              let app = NSRunningApplication(processIdentifier: pid), app.activationPolicy == .regular else { continue }
        return app
    }
    return nil
}

func appNamed(_ query: String) -> NSRunningApplication? {
    let q = query.lowercased().trimmingCharacters(in: .whitespaces)
    if q.isEmpty || q == "front" {
        return frontApp()
    }
    if let pid = Int32(q), let app = NSRunningApplication(processIdentifier: pid) {
        return app
    }
    let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && $0.processIdentifier != captainPid }
    if let exact = apps.first(where: { ($0.localizedName ?? "").lowercased() == q || ($0.bundleIdentifier ?? "").lowercased() == q }) {
        return exact
    }
    return apps.first(where: { ($0.localizedName ?? "").lowercased().contains(q) || ($0.bundleIdentifier ?? "").lowercased().hasSuffix(q) })
}

func windowsInfo() -> [[String: Any]] {
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    var out: [[String: Any]] = []
    for info in windows {
        guard let layer = (info[kCGWindowLayer as String] as? NSNumber)?.intValue, layer == 0,
              let pid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, pid != captainPid, pid != myPid,
              let bounds = info[kCGWindowBounds as String] as? [String: Any] else { continue }
        let w = (bounds["Width"] as? NSNumber)?.doubleValue ?? 0
        let h = (bounds["Height"] as? NSNumber)?.doubleValue ?? 0
        if w < 40 || h < 40 { continue }
        out.append([
            "app": (info[kCGWindowOwnerName as String] as? String) ?? "",
            "pid": Int(pid),
            "title": (info[kCGWindowName as String] as? String) ?? "",
            "x": (bounds["X"] as? NSNumber)?.doubleValue ?? 0,
            "y": (bounds["Y"] as? NSNumber)?.doubleValue ?? 0,
            "w": w,
            "h": h,
        ])
    }
    return out
}

func screenInfo() -> Never {
    let b = mainBounds()
    emit(["type": "screen", "width": b.width, "height": b.height, "scale": Double(scaleFactor()), "front": frontApp()?.localizedName ?? "", "computer": Host.current().localizedName ?? ""])
    exit(0)
}

func listApps() -> Never {
    let front = frontApp()?.processIdentifier
    let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular && $0.processIdentifier != captainPid }.map { app -> [String: Any] in
        ["name": app.localizedName ?? "", "bundle": app.bundleIdentifier ?? "", "pid": Int(app.processIdentifier), "front": app.processIdentifier == front, "hidden": app.isHidden]
    }
    emit(["type": "apps", "apps": apps, "windows": windowsInfo()])
    exit(0)
}

// ------------------------------------------------------------ images

func pngBase64(_ image: CGImage, width: Int, height: Int) -> String? {
    guard width > 0, height > 0,
          let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    ctx.interpolationQuality = .high
    ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let out = ctx.makeImage() else { return nil }
    let rep = NSBitmapImageRep(cgImage: out)
    return rep.representation(using: .png, properties: [:])?.base64EncodedString()
}

// Every on-screen window except Captain's own (the little Captain, the
// panel), front to back, so the agent never sees or clicks Captain itself.
func captureWindows() -> [NSNumber] {
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
    var ids: [NSNumber] = []
    for info in windows {
        guard let pid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, pid != captainPid, pid != myPid,
              let id = info[kCGWindowNumber as String] as? NSNumber else { continue }
        ids.append(id)
    }
    return ids
}

func capture(_ rect: CGRect) -> CGImage? {
    let ids = captureWindows()
    if ids.isEmpty {
        return CGWindowListCreateImage(rect, .optionOnScreenOnly, kCGNullWindowID, [.bestResolution])
    }
    return CGWindowListCreateImageFromArray(rect, ids as CFArray, [.bestResolution])
}

func screenshot(maxWidth: Double) -> Never {
    if !screenOK(prompt: true) {
        fail(SCREEN_HELP)
    }
    let bounds = mainBounds()
    guard let image = capture(bounds) else {
        fail(SCREEN_HELP)
    }
    let factor = min(1, maxWidth / max(bounds.width, 1))
    let w = Int((bounds.width * factor).rounded())
    let h = Int((bounds.height * factor).rounded())
    guard let png = pngBase64(image, width: w, height: h) else {
        fail("Couldn't encode the screenshot.")
    }
    emit(["type": "image", "png": png, "width": w, "height": h, "screenWidth": bounds.width, "screenHeight": bounds.height, "front": frontApp()?.localizedName ?? ""])
    exit(0)
}

func zoom(x: Double, y: Double, w: Double, h: Double, maxWidth: Double) -> Never {
    if !screenOK(prompt: true) {
        fail(SCREEN_HELP)
    }
    let bounds = mainBounds()
    let rect = CGRect(x: x, y: y, width: max(w, 8), height: max(h, 8)).intersection(bounds)
    if rect.isNull || rect.isEmpty {
        fail("That region is off the screen.")
    }
    guard let image = capture(rect) else {
        fail(SCREEN_HELP)
    }
    // Native pixels (twice the points on Retina), capped.
    let scale = Double(scaleFactor())
    let factor = min(scale, maxWidth / max(rect.width, 1))
    let outW = Int((rect.width * factor).rounded())
    let outH = Int((rect.height * factor).rounded())
    guard let png = pngBase64(image, width: outW, height: outH) else {
        fail("Couldn't encode the image.")
    }
    emit(["type": "image", "png": png, "width": outW, "height": outH, "regionX": rect.origin.x, "regionY": rect.origin.y, "regionWidth": rect.width, "regionHeight": rect.height, "screenWidth": bounds.width, "screenHeight": bounds.height])
    exit(0)
}

// ------------------------------------------------------------ mouse

let source = CGEventSource(stateID: .hidSystemState)

func flags(_ mods: [String]) -> CGEventFlags {
    var f: CGEventFlags = []
    for m in mods {
        switch m.lowercased().trimmingCharacters(in: .whitespaces) {
        case "cmd", "command", "meta": f.insert(.maskCommand)
        case "shift": f.insert(.maskShift)
        case "alt", "option", "opt": f.insert(.maskAlternate)
        case "ctrl", "control": f.insert(.maskControl)
        default: break
        }
    }
    return f
}

func clamp(_ x: Double, _ y: Double) -> CGPoint {
    let b = mainBounds()
    return CGPoint(x: min(max(x, b.minX), b.maxX - 1), y: min(max(y, b.minY), b.maxY - 1))
}

func mouse(_ type: CGEventType, _ p: CGPoint, button: CGMouseButton, clicks: Int = 1, mods: CGEventFlags = []) {
    guard let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: button) else { return }
    e.setIntegerValueField(.mouseEventClickState, value: Int64(clicks))
    e.flags = mods
    e.post(tap: .cghidEventTap)
}

func moveTo(_ p: CGPoint) {
    mouse(.mouseMoved, p, button: .left)
}

func click(x: Double, y: Double, button: String, count: Int, mods: [String]) -> Never {
    needAccessibility()
    let p = clamp(x, y)
    let down: CGEventType
    let up: CGEventType
    let btn: CGMouseButton
    switch button {
    case "right":
        (down, up, btn) = (CGEventType.rightMouseDown, CGEventType.rightMouseUp, CGMouseButton.right)
    case "middle":
        (down, up, btn) = (CGEventType.otherMouseDown, CGEventType.otherMouseUp, CGMouseButton.center)
    default:
        (down, up, btn) = (CGEventType.leftMouseDown, CGEventType.leftMouseUp, CGMouseButton.left)
    }
    let f = flags(mods)
    moveTo(p)
    sleepMs(60)
    for n in 1...max(1, min(count, 3)) {
        mouse(down, p, button: btn, clicks: n, mods: f)
        sleepMs(30)
        mouse(up, p, button: btn, clicks: n, mods: f)
        if n < count { sleepMs(90) }
    }
    sleepMs(120)
    emit(["type": "done", "x": p.x, "y": p.y])
    exit(0)
}

func drag(x1: Double, y1: Double, x2: Double, y2: Double) -> Never {
    needAccessibility()
    let a = clamp(x1, y1)
    let b = clamp(x2, y2)
    moveTo(a)
    sleepMs(80)
    mouse(.leftMouseDown, a, button: .left)
    sleepMs(120)
    let steps = 16
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        let p = CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
        mouse(.leftMouseDragged, p, button: .left)
        sleepMs(16)
    }
    sleepMs(120)
    mouse(.leftMouseUp, b, button: .left)
    sleepMs(100)
    emit(["type": "done"])
    exit(0)
}

func scroll(x: Double, y: Double, direction: String, amount: Int) -> Never {
    needAccessibility()
    let p = clamp(x, y)
    moveTo(p)
    sleepMs(60)
    let n = Int32(max(1, min(amount, 40)))
    var dy: Int32 = 0
    var dx: Int32 = 0
    switch direction {
    case "up": dy = n
    case "down": dy = -n
    case "left": dx = n
    case "right": dx = -n
    default: fail("Scroll up, down, left or right.")
    }
    // A few smaller events scroll more naturally than one big one.
    let parts = Int(max(1, min(n, 5)))
    for _ in 0..<parts {
        guard let e = CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 2, wheel1: dy / Int32(parts), wheel2: dx / Int32(parts), wheel3: 0) else { continue }
        e.post(tap: .cghidEventTap)
        sleepMs(25)
    }
    sleepMs(150)
    emit(["type": "done"])
    exit(0)
}

// ------------------------------------------------------------ keyboard

let KEYS: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33,
    "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
    "enter": 36, "return": 36, "tab": 48, "space": 49, "backspace": 51, "delete": 51, "forwarddelete": 117, "escape": 53, "esc": 53,
    "home": 115, "pageup": 116, "end": 119, "pagedown": 121, "left": 123, "right": 124, "down": 125, "up": 126,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]

func pressKey(_ code: CGKeyCode, _ f: CGEventFlags) {
    guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else { return }
    down.flags = f
    up.flags = f
    down.post(tap: .cghidEventTap)
    sleepMs(20)
    up.post(tap: .cghidEventTap)
}

// "cmd+shift+t", "enter", "ctrl+c". Unknown single characters are typed as text.
func pressCombo(_ combo: String) -> String? {
    let parts = combo.lowercased().split(separator: "+").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    guard let last = parts.last else { return "Nothing to press." }
    let mods = Array(parts.dropLast())
    let f = flags(mods)
    let name = ["arrowup": "up", "arrowdown": "down", "arrowleft": "left", "arrowright": "right", "del": "forwarddelete", "pgup": "pageup", "pgdn": "pagedown", "option": "alt", "spacebar": "space"][last] ?? last
    if let code = KEYS[name] {
        pressKey(code, f)
        return nil
    }
    if name.count == 1, mods.isEmpty {
        typeText(name, submit: false)
        return nil
    }
    return "Unknown key \"\(last)\"."
}

func keys(_ combos: [String]) -> Never {
    needAccessibility()
    if combos.isEmpty {
        fail("Say which keys to press.")
    }
    for combo in combos {
        if let err = pressCombo(combo) {
            fail(err)
        }
        sleepMs(60)
    }
    sleepMs(100)
    emit(["type": "done"])
    exit(0)
}

// Unicode text as key events, 20 UTF-16 units at a time; a new line is ⇧⏎
// (a line break, not "send", in chat apps).
func typeText(_ text: String, submit: Bool) {
    let lines = text.components(separatedBy: "\n")
    for (index, line) in lines.enumerated() {
        let units = Array(line.utf16)
        var at = 0
        while at < units.count {
            var chunk = Array(units[at..<min(at + 20, units.count)])
            if chunk.count == 20, let last = chunk.last, UTF16.isLeadSurrogate(last) {
                chunk.removeLast()
            }
            at += chunk.count
            for keyDown in [true, false] {
                let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: keyDown)
                event?.flags = []
                event?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
                event?.post(tap: .cghidEventTap)
            }
            usleep(12_000)
        }
        if index < lines.count - 1 {
            pressKey(36, .maskShift)
            usleep(30_000)
        }
    }
    if submit {
        usleep(80_000)
        pressKey(36, [])
    }
}

func typeCommand(submit: Bool) -> Never {
    needAccessibility()
    let input = FileHandle.standardInput.readDataToEndOfFile()
    let text = String(data: input, encoding: .utf8) ?? ""
    typeText(text, submit: submit)
    sleepMs(120)
    emit(["type": "done", "characters": text.count])
    exit(0)
}

// ------------------------------------------------------------ apps

func activate(_ app: NSRunningApplication) -> Bool {
    if app.isHidden {
        app.unhide()
    }
    app.activate(options: [.activateIgnoringOtherApps])
    var waited = 0
    while NSWorkspace.shared.frontmostApplication?.processIdentifier != app.processIdentifier && waited < 30 {
        RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        waited += 1
    }
    return NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier
}

func axAttr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
}

func axString(_ el: AXUIElement, _ name: String) -> String? {
    guard let v = axAttr(el, name) else { return nil }
    if let s = v as? String { return s }
    if let n = v as? NSNumber { return n.stringValue }
    if let u = v as? URL { return u.absoluteString }
    if let a = v as? NSAttributedString { return a.string }
    return nil
}

func axFrame(_ el: AXUIElement) -> CGRect? {
    guard let p = axAttr(el, kAXPositionAttribute), let s = axAttr(el, kAXSizeAttribute) else { return nil }
    var point = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: point, size: size)
}

func focus(_ query: String, window: String?) -> Never {
    needAccessibility()
    guard let app = appNamed(query) else {
        fail("No running app called \"\(query)\". Use computer_open to start it, or computer_apps to see what's running.")
    }
    if !activate(app) {
        fail("Couldn't bring \(app.localizedName ?? query) to the front.")
    }
    if let title = window?.lowercased(), !title.isEmpty {
        let el = AXUIElementCreateApplication(app.processIdentifier)
        if let windows = axAttr(el, kAXWindowsAttribute) as? [AXUIElement] {
            if let match = windows.first(where: { (axString($0, kAXTitleAttribute) ?? "").lowercased().contains(title) }) {
                AXUIElementPerformAction(match, kAXRaiseAction as CFString)
                AXUIElementSetAttributeValue(match, kAXMainAttribute as CFString, kCFBooleanTrue)
            } else {
                emit(["type": "done", "app": app.localizedName ?? "", "note": "No window with \"\(window ?? "")\" in its title; the app is in front."])
                exit(0)
            }
        }
    }
    sleepMs(150)
    emit(["type": "done", "app": app.localizedName ?? ""])
    exit(0)
}

func open(_ target: String) -> Never {
    let t = target.trimmingCharacters(in: .whitespacesAndNewlines)
    if t.isEmpty {
        fail("Say what to open.")
    }
    let lower = t.lowercased()
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    if lower.hasPrefix("http://") || lower.hasPrefix("https://") || lower.hasPrefix("mailto:") {
        process.arguments = [t]
    } else if t.hasPrefix("/") || t.hasPrefix("~") {
        process.arguments = [NSString(string: t).expandingTildeInPath]
    } else if let app = appNamed(t) {
        _ = activate(app)
        emit(["type": "done", "app": app.localizedName ?? t, "alreadyRunning": true])
        exit(0)
    } else {
        process.arguments = ["-a", t]
    }
    let err = Pipe()
    process.standardError = err
    process.standardOutput = FileHandle.nullDevice
    do {
        try process.run()
    } catch {
        fail("Couldn't open \(t): \(error.localizedDescription)")
    }
    process.waitUntilExit()
    if process.terminationStatus != 0 {
        let msg = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        fail(msg.isEmpty ? "Couldn't open \(t)." : msg)
    }
    // Give it a moment to come up, then say what's in front.
    var waited = 0
    var front = frontApp()
    while waited < 40 && (front == nil || front?.localizedName?.lowercased().contains(lower) == false) {
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        front = frontApp()
        waited += 1
        if process.arguments?.first != "-a" && waited > 15 { break }
    }
    emit(["type": "done", "front": front?.localizedName ?? ""])
    exit(0)
}

// ------------------------------------------------------------ reading apps (Accessibility)

let CONTAINER_ROLES: Set<String> = ["AXGroup", "AXScrollArea", "AXSplitGroup", "AXLayoutArea", "AXLayoutItem", "AXUnknown", "AXToolbar", "AXList", "AXOutline", "AXTable", "AXRow", "AXColumn", "AXWebArea", "AXTabGroup", "AXSplitter", "AXGrowArea", "AXMatte", "AXRuler", "AXDrawer", "AXSheet"]
let SKIP_ROLES: Set<String> = ["AXMenuBar", "AXMenuBarItem"]

struct AxNode {
    var role: String
    var title: String
    var value: String
    var desc: String
    var frame: CGRect
    var enabled: Bool
    var focused: Bool
    var selected: Bool
    var depth: Int
}

func readApp(_ query: String, filter: String?, max: Int) -> Never {
    needAccessibility()
    guard let app = appNamed(query) else {
        fail(query.isEmpty || query == "front" ? "There's no app in front to read." : "No running app called \"\(query)\".")
    }
    let el = AXUIElementCreateApplication(app.processIdentifier)
    // Chrome and Electron apps only build their accessibility tree once an assistive client asks.
    AXUIElementSetAttributeValue(el, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(el, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    AXUIElementSetMessagingTimeout(el, 2)
    let screen = mainBounds()
    let q = (filter ?? "").lowercased()
    var nodes: [AxNode] = []
    var visited = 0
    let deadline = Date().addingTimeInterval(8)

    func walk(_ e: AXUIElement, depth: Int) {
        if visited > 12_000 || nodes.count >= max * 3 || Date() > deadline { return }
        visited += 1
        let role = axString(e, kAXRoleAttribute) ?? ""
        if SKIP_ROLES.contains(role) { return }
        let frame = axFrame(e)
        if let f = frame, depth > 0 {
            // Off the screen (scrolled away, another display, zero size): nothing to see.
            if f.width <= 0 || f.height <= 0 || !f.intersects(screen) { return }
        }
        let title = axString(e, kAXTitleAttribute) ?? ""
        var value = axString(e, kAXValueAttribute) ?? ""
        let desc = axString(e, kAXDescriptionAttribute) ?? axString(e, kAXPlaceholderValueAttribute) ?? ""
        if value.count > 400 { value = String(value.prefix(400)) + "…" }
        let hasText = !(title.isEmpty && value.isEmpty && desc.isEmpty)
        let interactive = !CONTAINER_ROLES.contains(role)
        if let f = frame, depth > 0, (hasText || (interactive && role != "AXStaticText" && role != "AXImage")), role != "AXApplication" {
            let text = "\(title) \(value) \(desc)".lowercased()
            if q.isEmpty || text.contains(q) || role.lowercased().contains(q) {
                let enabled = (axAttr(e, kAXEnabledAttribute) as? Bool) ?? true
                let focused = (axAttr(e, kAXFocusedAttribute) as? Bool) ?? false
                let selected = (axAttr(e, kAXSelectedAttribute) as? Bool) ?? false
                nodes.append(AxNode(role: role, title: title, value: value, desc: desc, frame: f, enabled: enabled, focused: focused, selected: selected, depth: depth))
            }
        }
        if depth > 40 { return }
        // Text fields and web areas can have thousands of tiny children: the value says it all.
        if role == "AXTextArea" || role == "AXTextField" || role == "AXComboBox" { return }
        if let children = axAttr(e, kAXChildrenAttribute) as? [AXUIElement] {
            for c in children.prefix(400) {
                walk(c, depth: depth + 1)
            }
        }
    }
    walk(el, depth: 0)

    let out = nodes.prefix(max).map { n -> [String: Any] in
        var d: [String: Any] = ["role": n.role, "x": n.frame.origin.x, "y": n.frame.origin.y, "w": n.frame.width, "h": n.frame.height, "depth": n.depth]
        if !n.title.isEmpty { d["title"] = n.title }
        if !n.value.isEmpty { d["value"] = n.value }
        if !n.desc.isEmpty { d["desc"] = n.desc }
        if !n.enabled { d["enabled"] = false }
        if n.focused { d["focused"] = true }
        if n.selected { d["selected"] = true }
        return d
    }
    emit(["type": "ax", "app": app.localizedName ?? "", "pid": Int(app.processIdentifier), "nodes": out, "total": nodes.count, "truncated": nodes.count > max, "windows": windowsInfo().filter { ($0["pid"] as? Int) == Int(app.processIdentifier) }])
    exit(0)
}

// ------------------------------------------------------------ what's there (for the gate)

func asElement(_ v: AnyObject?) -> AXUIElement? {
    guard let v = v, CFGetTypeID(v) == AXUIElementGetTypeID() else { return nil }
    return (v as! AXUIElement)
}

func describe(_ el: AXUIElement) -> [String: Any] {
    var pid: pid_t = 0
    AXUIElementGetPid(el, &pid)
    return [
        "role": axString(el, kAXRoleAttribute) ?? "",
        "subrole": axString(el, kAXSubroleAttribute) ?? "",
        "title": axString(el, kAXTitleAttribute) ?? "",
        "desc": axString(el, kAXDescriptionAttribute) ?? "",
        "help": axString(el, kAXHelpAttribute) ?? "",
        "placeholder": axString(el, kAXPlaceholderValueAttribute) ?? "",
        "app": NSRunningApplication(processIdentifier: pid)?.localizedName ?? "",
    ]
}

let PRESSABLE_ROLES: Set<String> = ["AXButton", "AXMenuItem", "AXLink", "AXMenuButton", "AXPopUpButton", "AXCheckBox", "AXRadioButton"]

func hitTest(x: Double, y: Double) -> Never {
    needAccessibility()
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 2)
    var found: AXUIElement?
    let p = clamp(x, y)
    guard AXUIElementCopyElementAtPosition(system, Float(p.x), Float(p.y), &found) == .success, let start = found else {
        emit(["type": "hit", "role": ""])
        exit(0)
    }
    // A button's label often sits on a child (its text or image): climb to the button.
    var current: AXUIElement? = start
    var best = start
    var steps = 0
    while let c = current, steps < 6 {
        if PRESSABLE_ROLES.contains(axString(c, kAXRoleAttribute) ?? "") {
            best = c
            break
        }
        current = asElement(axAttr(c, kAXParentAttribute))
        steps += 1
    }
    var out = describe(best)
    out["type"] = "hit"
    emit(out)
    exit(0)
}

func focusedElement() -> Never {
    needAccessibility()
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 2)
    guard let el = asElement(axAttr(system, kAXFocusedUIElementAttribute)) else {
        emit(["type": "focused", "role": ""])
        exit(0)
    }
    var out = describe(el)
    out["type"] = "focused"
    emit(out)
    exit(0)
}

// ------------------------------------------------------------ clipboard

func clipboard(_ action: String) -> Never {
    let pb = NSPasteboard.general
    if action == "set" {
        let input = FileHandle.standardInput.readDataToEndOfFile()
        let text = String(data: input, encoding: .utf8) ?? ""
        pb.clearContents()
        pb.setString(text, forType: .string)
        emit(["type": "done", "characters": text.count])
    } else {
        let text = pb.string(forType: .string) ?? ""
        emit(["type": "clipboard", "text": String(text.prefix(60_000))])
    }
    exit(0)
}

// ------------------------------------------------------------ main

switch command {
case "screen":
    screenInfo()
case "permissions":
    emit(["type": "permissions", "accessibility": accessibilityOK(prompt: false), "screen": screenOK(prompt: false)])
    exit(0)
case "screenshot":
    screenshot(maxWidth: number(0, 1440))
case "zoom":
    zoom(x: number(0), y: number(1), w: number(2, 200), h: number(3, 200), maxWidth: number(4, 1440))
case "click":
    click(x: number(0), y: number(1), button: rest.count > 2 ? rest[2] : "left", count: Int(number(3, 1)), mods: rest.count > 4 ? rest[4].split(separator: ",").map(String.init) : [])
case "move":
    needAccessibility()
    moveTo(clamp(number(0), number(1)))
    emit(["type": "done"])
    exit(0)
case "drag":
    drag(x1: number(0), y1: number(1), x2: number(2), y2: number(3))
case "scroll":
    scroll(x: number(0), y: number(1), direction: rest.count > 2 ? rest[2] : "down", amount: Int(number(3, 5)))
case "key":
    keys(rest)
case "type":
    typeCommand(submit: rest.contains("--submit"))
case "apps":
    listApps()
case "focus":
    focus(rest.first ?? "", window: rest.count > 1 ? rest[1] : nil)
case "open":
    open(rest.joined(separator: " "))
case "ax":
    readApp(rest.first ?? "front", filter: rest.count > 1 ? rest[1] : nil, max: Int(number(2, 400)))
case "clipboard":
    clipboard(rest.first ?? "get")
case "hit":
    hitTest(x: number(0), y: number(1))
case "focused":
    focusedElement()
default:
    fail("Unknown command \(command).")
}
