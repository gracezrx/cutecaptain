`captain-voice-<target>` and `captain-desk-<target>` are built here from
`voice/main.swift` and `desk/main.swift` by `npm run build:voice` (macOS only)
before the app is built; Tauri bundles them next to the app's executable. On
other systems empty placeholders are made so the Rust core still compiles.

- captain-voice: Apple's speech recognition and voices, and voice typing.
- captain-desk: screenshots, clicks, keys, opening apps and reading them
  through Accessibility, for agents working on this Mac.
