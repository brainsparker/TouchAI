# UI Preview scripts

The workflows that use these scripts are `.github/workflows/ui-preview.yml`. The behavior, trust
model, and credentials are documented in [docs/agents/ui-preview.md](../../docs/agents/ui-preview.md).

Every script is plain Node ESM with no dependencies, so the `plan`, `record`, and `publish` jobs do
not install the workspace to run them.

| File | Job | Purpose |
| --- | --- | --- |
| `detect.mjs` | `detect` | Decide, comment, emit outputs |
| `explore.mjs` | `explore` | Build facts on each platform: test ids, element outline, sections, overflow, locale parity |
| `plan.mjs` | `plan` | Model call and plan validation |
| `seed.mjs` | `record` | Fixture usage data for the throwaway app root |
| `record.mjs` | `record` | Execute the plan, capture native video and key screenshots |
| `publish.mjs` | `publish` | Validate every platform's evidence, scan for credentials, upload, update the comment |
| `doctor.mjs` | manual | Preflight the credentials |
| `with-display.sh` | `explore`, `record` | Window manager and compositor for Xvfb |
| `macos-display.swift` | `explore`, `record` | Prefer a 2x HiDPI hosted macOS mode, then fall back to 1920x1080 |
| `configure-display.ps1` | `explore`, `record` | Select the largest hosted Windows mode up to 3840x2160 |

`lib/` holds the pure logic, which is covered by `apps/desktop/tests/ci/ui-preview-*.test.js`.
`lib/video-limits.mjs` holds the minimum duration, frame count, distinct states, and coverage that
both the recorder and the publisher enforce.

`lib/profile.mjs` keeps logical stage pixels, physical capture pixels, and the scale factor separate.
The Linux workflow uses a 1280x800 logical stage at 2x (2560x1600); macOS uses the best available 2x
mode and Windows uses the largest mode its display exposes. The publisher rejects a video whose
dimensions do not match the recorded physical stage, so a resized or upscaled clip cannot be
published as high-resolution evidence.

The label-triggered `.github/workflows/ui-preview-native-validation.yml` re-runs native Linux,
macOS, and Windows capture without publishing a comment. Use it to check a capture change before
merge.

```bash
pnpm test:unit -- ui-preview
```
