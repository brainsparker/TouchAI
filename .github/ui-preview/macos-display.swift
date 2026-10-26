import CoreGraphics
import Foundation

let minimumLogicalWidth = 1280
let minimumLogicalHeight = 800
let maximumPixelWidth = 3840
let maximumPixelHeight = 2160

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func pixelRatio(_ mode: CGDisplayMode) -> Double {
    guard mode.width > 0, mode.height > 0 else {
        return 1
    }

    return Double(mode.pixelWidth) / Double(mode.width)
}

func isWithinCaptureLimit(_ mode: CGDisplayMode) -> Bool {
    mode.pixelWidth <= maximumPixelWidth && mode.pixelHeight <= maximumPixelHeight
}

func isHiDpi(_ mode: CGDisplayMode) -> Bool {
    let ratio = pixelRatio(mode)

    return ratio >= 1.99
        && ratio <= 2.01
        && mode.width >= minimumLogicalWidth
        && mode.height >= minimumLogicalHeight
        && isWithinCaptureLimit(mode)
}

func isUnscaled(_ mode: CGDisplayMode) -> Bool {
    mode.width >= minimumLogicalWidth
        && mode.height >= minimumLogicalHeight
        && mode.pixelWidth == mode.width
        && mode.pixelHeight == mode.height
        && isWithinCaptureLimit(mode)
}

func isUsable(_ mode: CGDisplayMode) -> Bool {
    isHiDpi(mode) || isUnscaled(mode)
}

func modeArea(_ mode: CGDisplayMode) -> Int {
    mode.pixelWidth * mode.pixelHeight
}

func sameMode(_ left: CGDisplayMode, _ right: CGDisplayMode) -> Bool {
    left.width == right.width
        && left.height == right.height
        && left.pixelWidth == right.pixelWidth
        && left.pixelHeight == right.pixelHeight
}

func describe(_ mode: CGDisplayMode) -> String {
    "\(mode.width)x\(mode.height) points, \(mode.pixelWidth)x\(mode.pixelHeight) pixels, \(String(format: "%.2f", pixelRatio(mode)))x"
}

func selectCandidates(_ modes: [CGDisplayMode]) -> [CGDisplayMode] {
    var candidates: [CGDisplayMode] = []

    // A true 2x mode keeps the same logical layout while capturing twice the
    // detail. Prefer the largest one that still fits a 4K capture budget.
    if let hiDpi = modes.filter(isHiDpi).max(by: { modeArea($0) < modeArea($1) }) {
        candidates.append(hiDpi)
    }

    if let preferred = modes.first(where: {
        $0.width == 1920 && $0.height == 1080 && isUnscaled($0)
    }), !candidates.contains(where: { sameMode($0, preferred) }) {
        candidates.append(preferred)
    }

    for mode in modes.filter(isUnscaled).sorted(by: { modeArea($0) < modeArea($1) }) {
        if !candidates.contains(where: { sameMode($0, mode) }) {
            candidates.append(mode)
        }
    }

    return candidates
}

let argument = CommandLine.arguments.dropFirst().first ?? "--check"

guard ["--check", "--configure-hosted", "--list"].contains(argument) else {
    fail("Usage: swift macos-display.swift [--check|--configure-hosted|--list]")
}

let display = CGMainDisplayID()
let modes = (CGDisplayCopyAllDisplayModes(display, nil) as? [CGDisplayMode]) ?? []

if argument == "--list" {
    for mode in modes.sorted(by: { modeArea($0) > modeArea($1) }) {
        print("\(isUsable(mode) ? "usable" : "skip") \(describe(mode))")
    }
    exit(0)
}

if argument == "--configure-hosted" {
    guard ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true" else {
        fail("Display configuration is only allowed on the disposable hosted runner")
    }

    let candidates = selectCandidates(modes)

    guard !candidates.isEmpty else {
        fail(
            "No display mode at least "
                + "\(minimumLogicalWidth)x\(minimumLogicalHeight) is available"
        )
    }

    let current = CGDisplayCopyDisplayMode(display)
    var applied = current.map { sameMode($0, candidates[0]) } ?? false

    for selected in candidates where !applied {
        var configuration: CGDisplayConfigRef?

        guard CGBeginDisplayConfiguration(&configuration) == .success,
              let configuration
        else {
            print("cannot begin display configuration")
            continue
        }

        guard CGConfigureDisplayWithDisplayMode(configuration, display, selected, nil) == .success
        else {
            CGCancelDisplayConfiguration(configuration)
            print("cannot select the \(describe(selected)) display mode")
            continue
        }

        guard CGCompleteDisplayConfiguration(configuration, .forSession) == .success else {
            print("cannot apply the \(describe(selected)) display mode")
            continue
        }

        applied = true
        Thread.sleep(forTimeInterval: 1)
    }

    if !applied {
        fail("Cannot apply any usable display mode")
    }
}

guard let actual = CGDisplayCopyDisplayMode(display) else {
    fail("No active display mode")
}

guard isUsable(actual) else {
    fail(
        "Display is \(describe(actual)); "
            + "native capture needs a 2x HiDPI mode or an unscaled mode at least "
            + "\(minimumLogicalWidth)x\(minimumLogicalHeight)"
    )
}

let scale = Int(pixelRatio(actual).rounded())
let stageWidth = scale > 1 ? actual.width : actual.pixelWidth
let stageHeight = scale > 1 ? actual.height : actual.pixelHeight
let stageTop = min(64, max(32, Int((Double(stageHeight) * 0.05).rounded())))

print(
    "display: \(describe(actual)); stage: "
        + "\(stageWidth)x\(stageHeight) logical, "
        + "\(stageWidth * scale)x\(stageHeight * scale) pixels"
)

if let envPath = ProcessInfo.processInfo.environment["GITHUB_ENV"] {
    let lines = [
        "UI_PREVIEW_DISPLAY_WIDTH=\(actual.pixelWidth)",
        "UI_PREVIEW_DISPLAY_HEIGHT=\(actual.pixelHeight)",
        "UI_PREVIEW_STAGE_WIDTH=\(stageWidth)",
        "UI_PREVIEW_STAGE_HEIGHT=\(stageHeight)",
        "UI_PREVIEW_STAGE_TOP=\(stageTop)",
        "UI_PREVIEW_SCALE_FACTOR=\(scale)",
    ].joined(separator: "\n") + "\n"

    if let handle = FileHandle(forWritingAtPath: envPath) {
        handle.seekToEndOfFile()
        handle.write(Data(lines.utf8))
        handle.closeFile()
    } else {
        try? lines.write(toFile: envPath, atomically: true, encoding: .utf8)
    }
}
