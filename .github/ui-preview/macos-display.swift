import CoreGraphics
import Foundation

let minimumWidth = 1280
let minimumHeight = 900

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

func isUsable(_ mode: CGDisplayMode) -> Bool {
    mode.width >= minimumWidth
        && mode.height >= minimumHeight
        && mode.pixelWidth == mode.width
        && mode.pixelHeight == mode.height
}

func modeArea(_ mode: CGDisplayMode) -> Int {
    mode.width * mode.height
}

func sameMode(_ left: CGDisplayMode, _ right: CGDisplayMode) -> Bool {
    left.width == right.width
        && left.height == right.height
        && left.pixelWidth == right.pixelWidth
        && left.pixelHeight == right.pixelHeight
}

let argument = CommandLine.arguments.dropFirst().first ?? "--check"

guard ["--check", "--configure-hosted"].contains(argument) else {
    fail("Usage: swift macos-display.swift [--check|--configure-hosted]")
}

let display = CGMainDisplayID()

if argument == "--configure-hosted" {
    guard ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true" else {
        fail("Display configuration is only allowed on the disposable hosted runner")
    }

    let current = CGDisplayCopyDisplayMode(display)

    if current.map(isUsable) != true {
        let modes = CGDisplayCopyAllDisplayModes(display, nil) as? [CGDisplayMode] ?? []
        let usable = modes.filter(isUsable)
        let selected =
            usable.first {
                $0.width == 1920 && $0.height == 1080
            } ?? usable.min(by: { modeArea($0) < modeArea($1) })

        guard let selected else {
            fail(
                "No unscaled display mode at least "
                    + "\(minimumWidth)x\(minimumHeight) is available"
            )
        }

        if current.map({ sameMode($0, selected) }) != true {
            var configuration: CGDisplayConfigRef?

            guard CGBeginDisplayConfiguration(&configuration) == .success,
                  let configuration
            else {
                fail("Cannot begin display configuration")
            }

            guard CGConfigureDisplayWithDisplayMode(configuration, display, selected, nil) == .success
            else {
                CGCancelDisplayConfiguration(configuration)
                fail("Cannot select the \(selected.width)x\(selected.height) display mode")
            }

            guard CGCompleteDisplayConfiguration(configuration, .forSession) == .success else {
                fail("Cannot apply the \(selected.width)x\(selected.height) display mode")
            }
        }
    }
}

guard let actual = CGDisplayCopyDisplayMode(display) else {
    fail("No active display mode")
}

guard isUsable(actual) else {
    fail(
        "Display is \(actual.width)x\(actual.height) points, "
            + "\(actual.pixelWidth)x\(actual.pixelHeight) pixels; "
            + "native capture needs an unscaled mode at least "
            + "\(minimumWidth)x\(minimumHeight)"
    )
}

let width = actual.pixelWidth
let height = actual.pixelHeight

print("display: \(actual.width)x\(actual.height) logical, \(width)x\(height) pixels")

if let envPath = ProcessInfo.processInfo.environment["GITHUB_ENV"] {
    let lines = "UI_PREVIEW_DISPLAY_WIDTH=\(width)\nUI_PREVIEW_DISPLAY_HEIGHT=\(height)\n"

    if let handle = FileHandle(forWritingAtPath: envPath) {
        handle.seekToEndOfFile()
        handle.write(Data(lines.utf8))
        handle.closeFile()
    } else {
        try? lines.write(toFile: envPath, atomically: true, encoding: .utf8)
    }
}
