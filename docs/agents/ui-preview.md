# UI Preview

Read this when changing `.github/workflows/ui-preview.yml`, `.github/ui-preview/**`, or the
preview comment a pull request receives.

## What it does

A pull request that changes desktop interface files gets one advisory comment with a native screen
recording and key screenshots from the Linux, macOS, and Windows builds. The comment is updated in
place on every commit. It is not part of `CI Required` and never blocks a merge.

## When it runs

The preview runs when at least one changed file can change what the desktop app renders:

```text
apps/desktop/src/views/**
apps/desktop/src/components/**
apps/desktop/src/styles/**
apps/desktop/src/i18n/**
apps/desktop/src/assets/**
apps/desktop/src/router/**
apps/desktop/index.html
apps/desktop/src-tauri/src/core/window/**
apps/desktop/src-tauri/tauri*.conf.json
```

Tests, docs, and the official site never trigger it, even inside those directories.

| Author | UI change | Result |
| --- | --- | --- |
| `admin`, `maintain`, or `write` | yes | Runs automatically |
| anyone else | yes | Waiting comment, nothing runs |
| anyone else, approved | yes | Runs on every later commit |
| any author, `status:ui-preview-skip` | any | Skipped, and the comment says so |

A maintainer approves by commenting `/ui-preview` on the pull request, or by adding
`status:ui-preview-approved`. The label is added automatically after a valid command so later
commits keep running. Removing the label revokes the approval. Draft pull requests wait for
`ready_for_review` unless a maintainer forces a run.

The workflow checks the actor who added `status:ui-preview-approved` or `ui-preview`. If a
non-maintainer adds either label, the run does not start and the label is removed, because the
triage role can also apply labels.

The `ui-preview` label forces a run, including on a pull request that only changed a composable.

## Trust model

The workflow is split so that no job both runs pull-request code and holds a secret.

| Job | Checks out | Secrets | Permissions |
| --- | --- | --- | --- |
| `detect` | default branch | App key | `contents: read` |
| `explore` (matrix) | pull-request head | none | `contents: read` |
| `plan` | default branch | model key | `contents: read`, `pull-requests: read` |
| `record` (matrix) | default branch | none | `contents: read` |
| `publish` | default branch | upload token, App token | `contents: read` |

`explore` is the only job that checks out the pull request, and it is the only job that builds it.
It runs once per platform. `record` runs the binary that `explore` produced on the same platform,
but drives it with scripts from the default branch, so a pull request cannot change the recorder.
`plan` and `publish` never execute pull-request code.

`UI Preview Native Validation` is a maintainer-only harness. A maintainer adds
`ui-preview-native-validation` to a same-repository pull request, it records all three platforms,
and a `publish` job posts the same comment as the App, so the author is the same bot identity as
production. A separate `token` job mints the App token from `BOT_APP_ID` and
`BOT_APP_PRIVATE_KEY`; the private key never enters a job that runs branch code. The publish job
runs the scripts from the branch under validation; it is not the production trigger and never runs
for forks.

## Pipeline

```text
detect   decide, comment, output pr/sha
explore  build on Linux, macOS, and Windows, collect test ids, an element outline, locale parity
plan     interface-only diff + outline -> validated JSON scene plan
record   seed fixture data, run the plan, capture native video and key screenshots on each platform
publish  validate each platform's evidence, upload assets, update the one comment
```

The model sees the diff of the interface files only, the description, the test ids, and an outline
of the rendered elements (test id, role, own text, below the fold). The diff is split per file
before it is cut, so a large pull request cannot push the interface files out of the window. Its
answer is data: every action is allowlisted, every click target must be a `data-testid` the build
actually rendered, and every string has a length cap. When the model is unavailable or its plan is
rejected, a deterministic plan for the changed surfaces is used instead.

A plan that only opens a window and takes one screenshot is rejected. Every scene needs at least
three interactions, the whole plan needs at least six interactions and three screenshots, and the
fallback plan types a query character by character, walks settings sections, toggles a control, and
scrolls a long list.

## Native capture

The video is a real screen capture from the platform's own capture device, not a slideshow of
screenshots. The same plan runs on all three builds.

| Platform | Capture | Display | Frames |
| --- | --- | --- | --- |
| Linux | ffmpeg `x11grab` under Xvfb | 1920x1080 | 10 fps in, 30 fps CFR out |
| macOS | ffmpeg `avfoundation` (`Capture screen 0:none`) | 1920x1080 | 30 fps in, 30 fps CFR out |
| Windows | ffmpeg `gdigrab` (`desktop`) | 1920x1080 | 10 fps in, 30 fps CFR out |

All three platforms preview at 1920x1080, which is the largest size the standard GitHub-hosted macOS
and Windows runners expose. macOS uses a Swift helper with CoreGraphics to select the best available
mode for the disposable runner session; Windows enumerates display modes. Either helper selects a
larger or 2x mode when the runner offers one, but neither upscales a smaller display. Linux starts
Xvfb at 1920x1080. The helpers export the actual display size, logical stage, and scale factor, and
the recorder fails before booting the app when the display is smaller than the physical stage.

The stage is the area the reviewer sees, not the app's layout size. A 1280x800 stage at 2x would
produce a 2560x1600 video while the Settings window keeps its 1120x700 logical layout. The profile
keeps the scale factor so a HiDPI runner can be used unchanged; the hosted runs use a 1920x1080
stage at 1x. Element crops and the minimum crop are scaled by the device pixel ratio.

The workflow does not modify TCC. On macOS it relies on the screen-capture grant and replayd
approval present in the hosted runner image. The `UI Preview Native Validation` workflow exercises
the Linux, macOS, and Windows capture path on a labeled pull request and posts the same preview
comment as the App. If capture is denied, the recorder keeps the screenshots and publishes the
capture failure instead of a video.

Linux records the 1920x1080 Xvfb root directly. macOS and Windows record the desktop and crop
the top-left physical stage while burning captions, so all three videos have the same shape for a
given profile. The video must have exactly the physical stage dimensions; publishing rejects a
recording that was resized or upscaled. If a runner's ffmpeg cannot render subtitles, the recorder
retries the crop without captions instead of publishing the uncropped desktop.

The app runs with `TOUCHAI_UI_PREVIEW=1`. In that mode a content-driven resize of the main window
keeps the top edge fixed and skips the height animation, so the window grows downwards inside the
recorded crop instead of re-centering itself and sliding out of frame while the recording runs.

## Fixture data

A fresh install has no requests, so the Usage page records as a row of zeros and the model list is
empty. `record.mjs` boots the app once to create its database, quits, and runs `seed.mjs` against
`$TOUCHAI_APP_ROOT/data/touchai.db` before the recording boot.

`seed.mjs` inserts one provider, two models, six sessions, and about ninety turns over thirty days,
then rebuilds the daily rollups. It only inserts rows into existing tables: no schema change, no
migration, and nothing outside the throwaway app root. The sequence is fixed, so the same pull
request records the same numbers twice. A seeding failure is a warning in the manifest, not a
failed recording.

## Recording quality

The recording must show a flow, not a still image with a duration.

- Recording starts only after the first surface has painted, so the video has no black lead-in.
- Windows are opened before recording starts, so a blank webview never appears in the middle of a
  scene.
- On Linux the inactive window is unmapped, because the search window hides itself when it loses
  focus. On macOS and Windows the inactive WebDriver window is moved off-screen.
- The active window is moved below the burned-in title on every platform.
- The main window is anchored in preview mode: `TOUCHAI_UI_PREVIEW=1` makes a content-driven
  resize keep the top edge and skip the height animation, so the search window grows downwards
  instead of re-centering and sliding while the user types. The recorder still puts the window on
  the stage line after every step in case a native window manager moved it.
- Opening a settings section resets the shared content scroll, so a section opened after a scroll
  does not start mid-page.
- Linux and Windows capture at 10 fps and write a constant 30 fps stream. Capturing 30 fps on the
  shared Linux runner dropped most frames and produced a video much shorter than the session.
- Step captions are burned into a strip below the window, not drawn over the UI.
- Captions use the logical stage as the subtitle canvas, so their size stays proportional if a
  runner is switched to a 2x profile.
- Captions are best-effort. The crop is mandatory when the runner desktop is larger than the stage,
  so a subtitle failure cannot change the video dimensions or hide the app window.
- The overlay draws a fading trail and a ring on each click, so a viewer can follow the path. The
  operating-system pointer is disabled in the native capture to avoid a second, unrelated cursor.
- A `shot` may name a `data-testid`; that screenshot is cropped to the element with room around it
  and a minimum size, instead of shrinking the whole window. The crop uses ffmpeg, so it works on
  every platform.
- Each scene also gets a start-of-scene screenshot unless the plan already starts with a shot. At
  most ten key screenshots are kept per platform.
- Linux screenshots are captured by window id. Cropping the root by an earlier geometry produced
  black frames when the app recentred itself after a resize. macOS and Windows use the WebDriver
  webview screenshot for the current window.

All screenshots for a platform are collected into one collapsed `Key screenshots` block in the
comment. The video stays visible above it, so the recording is the primary evidence and the stills
are available without making the comment enormous.

## Comment lifecycle

The single comment is rewritten three times at most: `waiting for a maintainer` before any build,
`recording` the moment a run starts, then the evidence. The recording note replaces the previous
commit's evidence, so a stale clip cannot be read as this commit's result.

## When a step fails

The recorder retries a failed step once and falls back to a DOM click, a DOM hover, or a window
scroll. A step that still fails is skipped, the rest of the scene and the following scenes still
run, and the comment lists every skipped step in a collapsed block. The recorder has no model key,
so it cannot ask for a new plan mid-run; a maintainer can pass one with the `plan_json` input of a
manual run.

Publishing re-checks the numbers and fails closed. A recording must be at least 6 seconds, at least
60 frames, at least 5 distinct visual states, and cover at least 80% of the recording session. A
missing `videoInfo` block is an error, not a pass, and the reported capture mode must match the
manifest's native capture device. This is what stops a one-frame mp4, or a screenshot sequence
disguised as a recording, from being published as evidence.

Publishing also refuses evidence that contains something shaped like a credential, and posts a
comment saying that nothing was published.

Each platform has its own manifest and evidence directory. Publishing validates every manifest,
uploads at most ten screenshots and one video per platform, and builds one comment with a section
per platform. A platform whose recording job produced no manifest is reported as missing instead of
being silently omitted.

## Credentials

Publishing needs two credentials because GitHub's upload endpoint and comment API accept different
identity classes.

| Name | Kind | Used for |
| --- | --- | --- |
| `UI_PREVIEW_MODEL_API_KEY` | secret, `ui-preview` | the model call |
| `UI_PREVIEW_MODEL_BASE_URL`, `UI_PREVIEW_MODEL` | variables, `ui-preview` | endpoint and model |
| `UI_PREVIEW_TOKEN` | secret, `ui-preview-publish` | `POST /user-attachments/assets` only |
| `BOT_APP_ID`, `BOT_APP_PRIVATE_KEY` | secrets, `ui-preview-publish` | the comment only |

The upload endpoint returns `404` for GitHub App installation tokens and for App user-to-server
tokens. It needs a token that belongs to a user with `admin`, `maintain` or `write` on the
repository. The comment endpoints accept an App installation token with `Issues: write` or
`Pull requests: write`. An upload has no author field, so the asset URL carries no attribution and
the comment carries the bot identity.

The workflow passes `steps.app.outputs.app-slug` as `UI_PREVIEW_BOT_LOGIN`, so comment lookup does
not call `GET /user`. Installation tokens cannot use that endpoint. The scripts only fall back to
`GET /user` for local runs with a user token.

Screenshots use standard Markdown image syntax (`![caption](url)`) so they render inside the
collapsed block instead of appearing as links. The video stays as a bare URL on its own line,
because that is what makes GitHub render its inline player.

Both environments restrict deployments to protected branches, so only a workflow running from the
default branch can read them.

## The comment

There is exactly one comment per pull request, identified by `<!-- touchai-ui-preview -->` on its
first line. Publishing:

1. lists the pull-request comments;
2. keeps only comments whose author is the token's own account;
3. picks the oldest one that starts with the marker;
4. patches it, or creates one when none exists;
5. skips the write when the rendered body is identical.

Filtering on the author is required: a contributor can put the marker in their own comment, and the
API refuses an edit to a comment the token does not own. `gh pr comment --edit-last` is not used
because it edits the last comment by the token's account, which is not necessarily the preview.

## Local verification

```bash
pnpm test:unit -- ui-preview
node .github/ui-preview/doctor.mjs --mode=model
node .github/ui-preview/doctor.mjs --mode=publish
```

The `UI Preview Doctor` workflow runs the same checks from Actions, where the secrets live: dispatch
it and read the two jobs. `doctor` proves the model endpoint, the bot identity, and the upload
credential, and names the credential class that failed. It never posts a comment. Run it after
rotating a secret and before the first preview on a real pull request.

The Linux recorder needs `xvfb`, `openbox`, `picom`, `ffmpeg`, `imagemagick`, and `xdotool`. The app
is built with `--features ui-preview-webdriver`, which starts the embedded WebDriver server in a
debug build. The feature is rejected in non-debug builds. macOS and Windows use the same embedded
server and need no external driver.

## Failure behavior

A failed step is written to the manifest and published as `Recording stopped: <step>`. The comment
then shows the evidence that exists and states that it does not claim the change works. The
recording is never retried into a pass.

## Limitations

- The app still renders through WebKitGTK on Linux, WebView2 on Windows, and WKWebView on macOS, so
  fonts and native window chrome can differ.
- The desktop search and settings surfaces are covered. Tray and popup windows need test-only
  openers and get their own follow-up.
- Locale coverage is a static key-parity check, not a rendered comparison in both languages.
- Video is the physical preview stage. Linux uses the whole 1920x1080 Xvfb root; macOS and Windows
  crop the top-left stage from a larger hosted desktop when needed.
- Standard GitHub-hosted macOS and Windows runners do not guarantee more than 1920x1080. A 4K
  capture needs a larger or self-hosted runner whose display actually exposes 3840x2160; the
  helpers select it when present, but do not upscale a smaller display.
- macOS and Windows screenshots are webview-only, so native shadows and desktop pixels are not part
  of the still. The recording still shows them.
- The Linux desktop behind the window is black. This Xvfb and picom combination ignores a root
  colour, so a light background is not available without changing the compositor.

## Disabling

Add `status:ui-preview-skip` to the pull request. To stop the mechanism for the repository, disable
the `UI Preview` workflow; nothing else depends on it.
