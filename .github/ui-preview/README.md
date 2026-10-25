# UI Preview scripts

The workflows that use these scripts are `.github/workflows/ui-preview.yml`. The behavior, trust
model, and credentials are documented in [docs/agents/ui-preview.md](../../docs/agents/ui-preview.md).

Every script is plain Node ESM with no dependencies, so the `plan`, `record`, and `publish` jobs do
not install the workspace to run them.

| File | Job | Purpose |
| --- | --- | --- |
| `detect.mjs` | `detect` | Decide, comment, emit outputs |
| `explore.mjs` | `explore` | Build facts: test ids, sections, overflow, locale parity |
| `plan.mjs` | `plan` | Model call and plan validation |
| `record.mjs` | `record` | Execute the plan, capture screenshots and mp4 |
| `publish.mjs` | `publish` | Validate evidence, upload, update the comment |
| `doctor.mjs` | manual | Preflight the credentials |
| `with-display.sh` | `explore`, `record` | Window manager and compositor for Xvfb |

`lib/` holds the pure logic, which is covered by `apps/desktop/tests/ci/ui-preview-*.test.js`.

```bash
pnpm test:unit -- ui-preview
```
