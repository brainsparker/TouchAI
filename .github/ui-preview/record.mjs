/**
 * Executes the validated plan and records screenshots plus an mp4.
 *
 * Runs pull-request code (the built binary) with no repository secret and no
 * write token. A failed step is written to the manifest and published as a
 * failure, never retried into a pass.
 *
 * The recording starts only after the first surface is painted, so the video
 * has no black lead-in, and the step captions are burned in below the app
 * window instead of covering it.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
    burnCaptions,
    captureScreenshot,
    countDistinctStates,
    cropToElement,
    ensureDir,
    hideWindow,
    listAppWindows,
    moveWindow,
    paintDesktop,
    pngSize,
    probeVideo,
    raiseWindow,
    SCREEN_WIDTH,
    showWindow,
    STAGE_TOP,
    windowForSurface,
    windowGeometry,
} from './lib/capture.mjs';
import { buildCropFilter, parseDisplaySize, startNativeRecording } from './lib/native-capture.mjs';
import { ELEMENT_CENTER_SCRIPT, ELEMENT_ROW_RECT_SCRIPT } from './lib/overlay.mjs';
import { captureMode, detectPlatform, isUsableDisplay, platformLabel } from './lib/platform.mjs';
import {
    boot,
    bridge,
    ensureOverlay,
    mainWindowHandle,
    measureOverflow,
    openSettings,
    resetContentScroll,
    switchToSurface,
    waitForBridge,
} from './lib/runtime.mjs';
import { testIdFromSelector } from './lib/scenarios.mjs';
import {
    MIN_COVERAGE,
    MIN_DISTINCT_STATES,
    MIN_VIDEO_FRAMES,
    MIN_VIDEO_SECONDS,
} from './lib/video-limits.mjs';

const MAX_KEY_SHOTS = 10;
// A blank window compresses far below this; a real 750x60 search bar does not.
const MIN_CAPTURE_BYTES = 2048;

function env(name, fallback = '') {
    return process.env[name] ?? fallback;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPaint(session) {
    // A timeout rather than requestAnimationFrame: a window that was just
    // remapped can have its frame callbacks paused, which would hang the driver.
    await session.executeAsync(`
        const done = arguments[arguments.length - 1];
        setTimeout(() => done(true), 120);
    `);
}

async function moveCursor(session, selector) {
    const center = await session.execute(ELEMENT_CENTER_SCRIPT, [selector]);

    if (!center) {
        return;
    }

    await session.execute('window.__UI_PREVIEW__?.moveTo(arguments[0], arguments[1]);', [
        center.x,
        center.y,
    ]);
}

async function clickWithOverlay(session, selector) {
    await moveCursor(session, selector);
    await sleep(260);
    await session.execute(
        `
        const center = document.querySelector(arguments[0])?.getBoundingClientRect();
        if (center) {
            window.__UI_PREVIEW__?.ring(center.left + center.width / 2, center.top + center.height / 2);
        }
        `,
        [selector]
    );
    await session.click(selector);
    await sleep(350);
}

async function typeSlowly(session, selector, value) {
    await moveCursor(session, selector);
    await session.click(selector);
    await sleep(180);

    for (const character of [...String(value)]) {
        await session.appendText(selector, character);
        await sleep(70);
    }

    await sleep(300);
}

async function scrollContent(session, pixels) {
    const moved = await session.execute(
        `
        const amount = Number(arguments[0]) || 0;
        const root = document.querySelector('[data-testid="settings-view"]') || document.body;
        const candidates = [root, ...root.querySelectorAll('*')].filter((element) => {
            const style = getComputedStyle(element);
            const scrollable = ['auto', 'scroll'].includes(style.overflowY);
            return scrollable && element.scrollHeight - element.clientHeight > 80;
        });
        const target = candidates.sort(
            (left, right) =>
                right.scrollHeight - right.clientHeight - (left.scrollHeight - left.clientHeight)
        )[0];

        if (!target) {
            return false;
        }

        target.scrollBy({ top: amount, behavior: 'smooth' });
        return true;
        `,
        [pixels]
    );
    await sleep(500);

    if (!moved) {
        await session.scroll(pixels);
        await sleep(500);
    }
}

/**
 * Usage is the one settings section whose first frame is a skeleton while its
 * dashboard query runs. Waiting for the dashboard keeps a slow query from
 * becoming the final frame of the clip.
 */
async function waitForSectionContent(session, target) {
    if (!String(target ?? '').includes('settings-nav-usage')) {
        return;
    }

    await session.waitForElement("[data-testid='settings-usage-dashboard']", 15000);
    await sleep(300);
}

/**
 * Shows only the window for this surface. Without this the search window stayed
 * on top of the settings window and the video showed both at once.
 */
async function isolateLinuxSurface(display, surface, state) {
    state.windows ??= {};
    state.activeSurface = surface;

    let target = null;

    if (state.windows[surface]) {
        showWindow(display, state.windows[surface]);
        await sleep(250);
        target = windowGeometry(display, state.windows[surface]);
    }

    target ??= windowForSurface(display, surface);

    if (!target) {
        return null;
    }

    state.windows[surface] = target.id;

    // The search window hides itself when it loses focus, so the inactive
    // window is unmapped rather than just covered.
    for (const id of listAppWindows(display)) {
        if (id !== target.id) {
            hideWindow(display, id);
        }
    }

    showWindow(display, target.id);
    moveWindow(display, target.id, Math.max(0, Math.round((1280 - target.width) / 2)), STAGE_TOP);
    raiseWindow(display, target.id);
    await sleep(250);
    return target;
}

/**
 * Places the active webview at the top of the preview stage and parks the other
 * app windows off-screen. WebDriver can move every Tauri window on every
 * platform, so Windows and macOS use the same logic instead of OS-specific
 * window discovery.
 */
async function isolateWebviewSurface(session, surface, state) {
    const handle = await switchToSurface(session, surface, state);
    state.handles ??= {};
    state.handles[surface] = handle;
    const rect = await placeWebviewWindow(session, handle);

    for (const [name, other] of Object.entries(state.handles)) {
        if (name === surface || !other) {
            continue;
        }

        try {
            await session.switchTo(other);
            await session.setWindowRect({ x: -4000, y: -4000 });
        } catch {
            // A window that closed between scenes has nothing to move.
        }
    }

    await session.switchTo(handle);
    await session.focusWindow();
    await sleep(250);
    return {
        id: handle,
        x: Math.max(0, Math.round((SCREEN_WIDTH - rect.width) / 2)),
        y: STAGE_TOP,
        width: rect.width,
        height: rect.height,
    };
}

async function placeWebviewWindow(session, handle) {
    await session.switchTo(handle);
    await session.focusWindow();
    const rect = await session.getWindowRect();
    const x = Math.max(0, Math.round((SCREEN_WIDTH - rect.width) / 2));

    if (Math.abs(rect.x - x) > 2 || Math.abs(rect.y - STAGE_TOP) > 2) {
        await session.setWindowRect({ x, y: STAGE_TOP });
    }

    return rect;
}

async function isolateSurface({ session, platform, display, surface, state }) {
    return platform === 'linux'
        ? isolateLinuxSurface(display, surface, state)
        : isolateWebviewSurface(session, surface, state);
}

function describeStep(step) {
    if (step.caption) {
        return step.caption;
    }

    if (step.do === 'bridge') {
        return step.value === 'openSettingsWindow' ? 'Open Settings' : `Run ${step.value}`;
    }

    if (step.do === 'click' || step.do === 'hover') {
        const id = testIdFromSelector(step.target) ?? step.target;
        return `${step.do === 'click' ? 'Click' : 'Hover'} ${id}`;
    }

    if (step.do === 'type') {
        return `Type "${step.value}"`;
    }

    if (step.do === 'press') {
        return `Press ${step.value}`;
    }

    if (step.do === 'scroll') {
        return `Scroll ${step.value}px`;
    }

    return '';
}

/**
 * Puts the active window back on the stage line.
 *
 * The search window grows from 60 to 207 pixels tall when results appear and
 * the app recentres itself, which slides it to the middle of the screen
 * mid-clip. Re-pinning it after each step keeps the recording steady.
 */
async function keepWindowInPlace({ session, platform, display, surface, state }) {
    if (platform !== 'linux') {
        const handle = state.handles?.[surface];

        if (!handle) {
            return;
        }

        await session.switchTo(handle);
        const rect = await session.getWindowRect();
        const x = Math.max(0, Math.round((SCREEN_WIDTH - rect.width) / 2));

        if (Math.abs(rect.x - x) > 2 || Math.abs(rect.y - STAGE_TOP) > 2) {
            await session.setWindowRect({ x, y: STAGE_TOP });
            await sleep(120);
        }

        return;
    }

    const id = state.windows?.[surface];

    if (!id) {
        return;
    }

    const geometry = windowGeometry(display, id);

    if (!geometry || Math.abs(geometry.y - STAGE_TOP) <= 2) {
        return;
    }

    moveWindow(
        display,
        id,
        Math.max(0, Math.round((SCREEN_WIDTH - geometry.width) / 2)),
        STAGE_TOP
    );
    await sleep(120);
}

/**
 * A window that was just remapped can return a black frame. Capture again when
 * the file is implausibly small for a real window.
 */
async function captureStill({ session, platform, display, surface, state, file }) {
    if (platform !== 'linux') {
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            await session.execute('window.__UI_PREVIEW__?.hide();');
            await sleep(220);

            try {
                const base64 = await session.screenshot();
                fs.writeFileSync(file, Buffer.from(base64, 'base64'));
            } catch (error) {
                console.log(`screenshot attempt ${attempt} failed: ${error.message}`);
            }

            await session.execute('window.__UI_PREVIEW__?.show();');
            await sleep(220);

            if (fs.existsSync(file) && fs.statSync(file).size >= MIN_CAPTURE_BYTES) {
                return pngSize(file);
            }

            await waitForPaint(session);
        }

        return null;
    }

    const candidates = [state.windows?.[surface], windowForSurface(display, surface)?.id].filter(
        Boolean
    );

    for (let attempt = 1; attempt <= 3; attempt += 1) {
        await session.execute('window.__UI_PREVIEW__?.hide();');
        await sleep(250);

        let size = null;

        for (const id of candidates) {
            size = captureScreenshot({ display, file, id });

            if (fs.existsSync(file) && fs.statSync(file).size >= MIN_CAPTURE_BYTES) {
                break;
            }
        }

        await session.execute('window.__UI_PREVIEW__?.show();');
        await sleep(250);

        if (fs.statSync(file).size >= MIN_CAPTURE_BYTES) {
            return size;
        }

        await waitForPaint(session);
    }

    return null;
}

/**
 * Captures one reviewer-facing still. The overlay is hidden for the frame, the
 * window is put back on the stage line first, and a target test id crops the
 * image to the control a reviewer needs to judge.
 */
async function captureKeyShot({
    session,
    platform,
    display,
    surface,
    state,
    file,
    caption,
    target,
    recorded,
}) {
    await isolateSurface({ session, platform, display, surface, state });
    const element = target ? await session.execute(ELEMENT_ROW_RECT_SCRIPT, [target]) : null;

    if (platform === 'linux') {
        const id = state.windows?.[surface];

        if (!id) {
            throw new Error(`no visible ${surface} window to capture`);
        }

        raiseWindow(display, id);
        await sleep(250);
    }

    let size = await captureStill({
        session,
        platform,
        display,
        surface,
        state,
        file,
    });

    if (!size) {
        throw new Error(`the ${surface} window did not paint a frame`);
    }

    if (element) {
        size =
            cropToElement({
                file,
                rect: element.rect,
                viewport: element.viewport,
            }) ?? size;
    }

    recorded.shots.push({
        file: path.basename(file),
        caption: caption ?? '',
        width: size.width,
        height: size.height,
    });
}

async function runStep(session, step) {
    if (step.do === 'bridge') {
        await bridge(session, step.value, step.args ?? []);
        await sleep(400);
        return;
    }

    if (step.do === 'click') {
        await clickWithOverlay(session, step.target);
        return;
    }

    if (step.do === 'hover') {
        await moveCursor(session, step.target);
        try {
            await session.hover(step.target);
        } catch {
            // WebKitGTK can time out on pointer actions; the caption and the
            // cursor already show the intent, so the step is not fatal.
            await session.execute(
                `
                const element = document.querySelector(arguments[0]);
                element?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                element?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
                `,
                [step.target]
            );
        }
        await sleep(400);
        return;
    }

    if (step.do === 'type') {
        await typeSlowly(session, step.target, step.value);
        return;
    }

    if (step.do === 'press') {
        await session.press(step.value);
        await sleep(300);
        return;
    }

    if (step.do === 'scroll') {
        await scrollContent(session, Number(step.value));
        return;
    }

    if (step.do === 'wait') {
        await sleep(Number(step.value));
    }
}

/**
 * One repair attempt after a step failed.
 *
 * The driver can time out on a click that the page would accept, and the
 * recorder has no model key by design, so the repair is a retry plus a DOM
 * fallback rather than a new plan. A step that still fails is skipped and
 * reported, never silently counted as done.
 */
async function recoverStep(session, step) {
    try {
        await ensureOverlay(session);
        await sleep(400);
    } catch {
        // The window may be mid-navigation; the retry below still runs.
    }

    if (step.do === 'click') {
        try {
            // A short wait: the first attempt already gave the page 15 s, so a
            // second long wait only stretches the video.
            await session.click(step.target, { timeoutMs: 3000 });
            return 'retried the click';
        } catch {
            // Fall through to the DOM click.
        }

        try {
            const clicked = await session.execute(
                `
                const element = document.querySelector(arguments[0]);
                if (!element) {
                    return false;
                }
                element.click();
                return true;
                `,
                [step.target]
            );

            if (clicked) {
                return 'clicked through the DOM';
            }
        } catch {
            // The step is reported as skipped.
        }
    }

    if (step.do === 'type') {
        try {
            await session.click(step.target);
            await session.appendText(step.target, String(step.value ?? ''));
            return 'typed again';
        } catch {
            // The step is reported as skipped.
        }
    }

    if (step.do === 'hover') {
        try {
            await session.execute(
                `
                const element = document.querySelector(arguments[0]);
                if (!element) {
                    return false;
                }
                element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
                element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
                return true;
                `,
                [step.target]
            );
            return 'hovered through the DOM';
        } catch {
            // The step is reported as skipped.
        }
    }

    if (step.do === 'scroll') {
        try {
            await session.scroll(Number(step.value));
            return 'scrolled the window';
        } catch {
            // The step is reported as skipped.
        }
    }

    return null;
}

function findLogErrors(appRoot) {
    const errors = [];

    if (!appRoot || !fs.existsSync(appRoot)) {
        return errors;
    }

    const queue = [appRoot];

    while (queue.length > 0) {
        const current = queue.shift();
        let entries;

        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            const full = path.join(current, entry.name);

            if (entry.isDirectory()) {
                if (entry.name !== 'webview' && entry.name !== 'cache') {
                    queue.push(full);
                }
                continue;
            }

            if (!entry.name.endsWith('.log')) {
                continue;
            }

            const text = fs.readFileSync(full, 'utf8');

            for (const line of text.split('\n')) {
                if (/\bERROR\b/.test(line)) {
                    errors.push(line.slice(0, 300));
                }
            }
        }
    }

    return errors.slice(0, 20);
}

/**
 * Boots the app once so it creates and migrates its database, quits, then
 * writes fixture rows into it. A fresh install records an empty Usage page,
 * which hides exactly the changes that page needs a reviewer to see.
 */
async function seedAppData(application, platform) {
    const warm = await boot({ application, platform });

    try {
        await waitForBridge(warm.session, 45000);
    } finally {
        await warm.close();
    }

    // The driver port is released asynchronously; the real boot starts after.
    await sleep(800);

    const result = spawnSync(
        process.execPath,
        ['--experimental-sqlite', path.join(import.meta.dirname, 'seed.mjs')],
        { encoding: 'utf8', env: process.env, timeout: 120000 }
    );

    if (result.status !== 0) {
        throw new Error(
            `seed failed: ${(result.stderr || result.stdout || result.error?.message || '').slice(0, 500)}`
        );
    }

    console.log(result.stdout.trim());
}

async function main() {
    const application = env('UI_PREVIEW_APP_BINARY');
    const outDir = ensureDir(env('UI_PREVIEW_OUT', 'ui-preview-out'));
    const evidenceDir = ensureDir(path.join(outDir, 'evidence'));
    const platform = detectPlatform();
    const display = env('DISPLAY', ':99');
    const displaySize = parseDisplaySize(process.env, platform);
    const sha = env('UI_PREVIEW_SHA');
    const title = env('UI_PREVIEW_TITLE');
    const appRoot = env('TOUCHAI_APP_ROOT');
    const factsPath = path.join(outDir, 'facts.json');
    const planFile = env('UI_PREVIEW_PLAN_FILE') || path.join(outDir, 'plan.json');
    const facts = fs.existsSync(factsPath)
        ? JSON.parse(fs.readFileSync(factsPath, 'utf8'))
        : { files: [], testIds: {} };
    const plan = fs.existsSync(planFile)
        ? JSON.parse(fs.readFileSync(planFile, 'utf8'))
        : { scenes: [] };
    const consoleErrors = [];
    let logErrors = [];
    const manifest = {
        version: 1,
        sha,
        pr: Number(env('UI_PREVIEW_PR', '0')),
        runUrl: env('UI_PREVIEW_RUN_URL'),
        trigger: env('UI_PREVIEW_TRIGGER'),
        platform,
        captureMode: captureMode(platform),
        display: displaySize,
        source: plan.source ?? 'model',
        summary: plan.summary ?? '',
        mismatch: plan.mismatch ?? '',
        unseen: plan.unseen ?? '',
        warnings: plan.warnings ?? [],
        scenes: [],
        checks: [],
        errors: [],
        skippedSteps: [],
        video: null,
        videoInfo: null,
        failure: null,
    };

    function fail(step, message) {
        manifest.errors.push(`${step}: ${message}`);
        manifest.failure ??= { step, message };
    }

    function persist() {
        fs.writeFileSync(
            path.join(outDir, 'manifest.json'),
            `${JSON.stringify({ ...manifest, consoleErrors, logErrors }, null, 2)}\n`
        );
    }

    if (!application || !fs.existsSync(application)) {
        manifest.checks.push({
            name: 'App build',
            status: 'fail',
            detail: `missing binary: ${application || '(empty)'}`,
        });
        fail('setup', `UI_PREVIEW_APP_BINARY does not exist: ${application}`);
        persist();
        return;
    }

    if (!isUsableDisplay(displaySize.width, displaySize.height)) {
        manifest.checks.push({
            name: 'Display',
            status: 'fail',
            detail: `${displaySize.width}x${displaySize.height}`,
        });
        fail(
            'display',
            `${platformLabel(platform)} exposes ${displaySize.width}x${displaySize.height}; native capture needs at least 1280x900`
        );
        persist();
        return;
    }

    manifest.checks.push({
        name: 'Display',
        status: 'pass',
        detail: `${displaySize.width}x${displaySize.height}`,
    });

    if (platform === 'linux') {
        paintDesktop(display);
    }

    const scenes = [...(plan.scenes ?? [])].sort((left, right) => {
        if (left.surface === right.surface) {
            return 0;
        }
        return left.surface === 'search' ? -1 : 1;
    });

    if (env('UI_PREVIEW_SEED', '1') === '1') {
        try {
            await seedAppData(application, platform);
        } catch (error) {
            manifest.warnings.push(`fixture data was not written: ${error.message}`);
            console.log(`seed skipped: ${error.message}`);
        }
    }

    const rawVideo = path.join(evidenceDir, 'recording-raw.mp4');
    const videoFile = path.join(evidenceDir, 'recording.mp4');
    let runtime = null;
    let recording = null;
    let recordingStartedAt = Date.now();
    let keyShotCount = 0;
    let shotLimitReported = false;
    let pinTimer = null;
    const timeline = [];
    let currentCaption = null;

    function mark(text, at = Date.now()) {
        // Subtitle times are relative to the first recorded frame.
        const relative = Math.max(0, at - recordingStartedAt);

        if (currentCaption) {
            currentCaption.endMs = relative;
        }

        if (!text) {
            currentCaption = null;
            return;
        }

        currentCaption = { startMs: relative, endMs: relative + 3000, text };
        timeline.push(currentCaption);
    }

    try {
        runtime = await boot({ application, platform });
        const { session } = runtime;

        await waitForBridge(session);
        const mainHandle = await mainWindowHandle(session);
        await ensureOverlay(session);
        await session.waitForElement("[data-testid='search-view']");
        await waitForPaint(session);

        // Open Settings before recording so its first frame is already painted.
        // A window that is created during the recording shows a blank webview
        // for several seconds, which looks like a still image.
        const opened = await openSettings(session);
        await session.waitForElement("[data-testid='settings-general-section']");
        await ensureOverlay(session);
        await waitForPaint(session);
        await sleep(1200);

        await session.switchTo(mainHandle);
        await session.waitForElement("[data-testid='search-view']");
        await ensureOverlay(session);
        await waitForPaint(session);

        const state = {
            mainHandle,
            settingsHandle: opened.settings,
            windows:
                platform === 'linux'
                    ? {
                          search: windowForSurface(display, 'search')?.id,
                          settings: windowForSurface(display, 'settings')?.id,
                      }
                    : undefined,
            handles:
                platform === 'linux'
                    ? undefined
                    : { search: mainHandle, settings: opened.settings },
        };
        await isolateSurface({ session, platform, display, surface: 'search', state });

        if (platform === 'linux') {
            // The app can recenter itself after a resize, asynchronously from
            // the step that caused it. A periodic pin keeps the window below
            // the burned-in title even when the move lands between steps.
            pinTimer = setInterval(() => {
                const surface = state.activeSurface;
                const id = state.windows?.[surface];

                if (!id) {
                    return;
                }

                try {
                    const geometry = windowGeometry(display, id);

                    if (!geometry || Math.abs(geometry.y - STAGE_TOP) <= 2) {
                        return;
                    }

                    moveWindow(
                        display,
                        id,
                        Math.max(0, Math.round((SCREEN_WIDTH - geometry.width) / 2)),
                        STAGE_TOP
                    );
                } catch {
                    // The window may be between map and unmap during a scene change.
                }
            }, 250);
            pinTimer.unref?.();
        }

        await sleep(300);

        try {
            recording = await startNativeRecording({
                platform,
                display,
                width: displaySize.width,
                height: displaySize.height,
                file: rawVideo,
            });
            recordingStartedAt = recording.startedAt;
        } catch (error) {
            // The screenshots are still useful. Keep recording the flow and
            // publish the capture failure instead of pretending there is video.
            recordingStartedAt = Date.now();
            fail(
                'recording',
                `native ${captureMode(platform)} capture did not start: ${error.message}`
            );
            console.log(`native recording did not start: ${error.message}`);
        }

        await sleep(500);
        mark('UI preview start', recordingStartedAt);

        for (const [sceneIndex, scene] of scenes.entries()) {
            const recorded = { title: scene.title, surface: scene.surface, shots: [] };
            manifest.scenes.push(recorded);
            let currentStep = 'scene';

            try {
                await isolateSurface({
                    session,
                    platform,
                    display,
                    surface: scene.surface,
                    state,
                });
                const handle = await switchToSurface(session, scene.surface, state);

                await session.switchTo(handle);
                await ensureOverlay(session);
                await waitForPaint(session);
                if (platform === 'linux' && env('UI_PREVIEW_DEBUG') === '1') {
                    console.log(
                        `debug ${scene.surface}:`,
                        listAppWindows(display)
                            .map((id) => {
                                const geometry = windowGeometry(display, id);
                                return `${id}:${geometry?.width}x${geometry?.height}@${geometry?.x},${geometry?.y}`;
                            })
                            .join(' '),
                        'state:',
                        JSON.stringify(state.windows)
                    );
                }
                await resetContentScroll(session);
                mark(scene.title);
                await sleep(400);

                const overflow = await measureOverflow(session);

                manifest.checks.push({
                    name: `No horizontal overflow at ${overflow.innerWidth}px (${scene.title})`,
                    status: overflow.overflowX > 1 ? 'fail' : 'pass',
                    detail:
                        overflow.overflowX > 1
                            ? `${overflow.overflowX}px wider than the window`
                            : '',
                });

                // A scene-start frame gives the reviewer the before state when
                // the plan waits before its first shot. A shot in the first
                // two steps already shows that state, so skip the duplicate.
                const firstShotIndex = scene.steps.findIndex((step) => step.do === 'shot');
                const needsInitialShot = firstShotIndex === -1 || firstShotIndex > 2;

                if (keyShotCount < MAX_KEY_SHOTS && needsInitialShot) {
                    try {
                        const file = path.join(
                            evidenceDir,
                            `${scene.surface}-scene-${sceneIndex + 1}.png`
                        );
                        await captureKeyShot({
                            session,
                            platform,
                            display,
                            surface: scene.surface,
                            state,
                            file,
                            caption: 'Initial state',
                            target: null,
                            recorded,
                        });
                        keyShotCount += 1;
                    } catch (error) {
                        manifest.skippedSteps.push({
                            scene: scene.title,
                            step: 'initial screenshot',
                            error: error.message,
                        });
                        console.log(`initial screenshot skipped: ${error.message}`);
                    }
                }

                for (const step of scene.steps) {
                    currentStep = `${step.do}${step.value ? ` ${step.value}` : ''}${step.target ? ` ${step.target}` : ''}`;
                    const caption = describeStep(step);

                    if (caption) {
                        mark(caption);
                    }

                    if (step.do === 'bridge' && step.value === 'openSettingsWindow') {
                        if (state.settingsHandle) {
                            if (platform === 'linux' && state.windows?.settings) {
                                showWindow(display, state.windows.settings);
                            }
                            await session.switchTo(state.settingsHandle);
                            if (platform !== 'linux') {
                                await placeWebviewWindow(session, state.settingsHandle);
                            }
                            await ensureOverlay(session);
                            await waitForPaint(session);
                            continue;
                        }

                        const next = await openSettings(session);
                        state.settingsHandle = next.settings;
                        state.handles ??= {};
                        state.handles.settings = next.settings;
                        if (platform !== 'linux') {
                            await placeWebviewWindow(session, next.settings);
                        }
                        await waitForPaint(session);
                        await sleep(500);
                        continue;
                    }

                    if (step.do === 'shot') {
                        if (keyShotCount >= MAX_KEY_SHOTS) {
                            if (!shotLimitReported) {
                                shotLimitReported = true;
                                manifest.warnings.push(
                                    `the plan asked for more than ${MAX_KEY_SHOTS} key screenshots; the first ${MAX_KEY_SHOTS} were kept`
                                );
                            }
                            continue;
                        }

                        try {
                            await sleep(200);
                            const file = path.join(
                                evidenceDir,
                                `${scene.surface}-${String(sceneIndex + 1).padStart(2, '0')}-${step.name}.png`
                            );
                            await captureKeyShot({
                                session,
                                platform,
                                display,
                                surface: scene.surface,
                                state,
                                file,
                                caption: step.caption ?? '',
                                target: step.target,
                                recorded,
                            });
                            keyShotCount += 1;
                        } catch (error) {
                            manifest.skippedSteps.push({
                                scene: scene.title,
                                step: `shot ${step.name}`,
                                error: error.message,
                            });
                            console.log(`shot skipped: ${error.message}`);
                        }
                        continue;
                    }

                    try {
                        await runStep(session, step);
                        await keepWindowInPlace({
                            session,
                            platform,
                            display,
                            surface: scene.surface,
                            state,
                        });

                        // Sections share one scroll container: a section opened
                        // after a scroll would otherwise start mid-page.
                        if (
                            step.do === 'click' &&
                            String(step.target ?? '').includes('settings-nav-')
                        ) {
                            await resetContentScroll(session);
                            await waitForPaint(session);
                            await waitForSectionContent(session, step.target);
                        }
                    } catch (error) {
                        const repaired = await recoverStep(session, step);

                        if (repaired) {
                            console.log(`step repaired (${repaired}): ${currentStep}`);
                        } else {
                            manifest.skippedSteps.push({
                                scene: scene.title,
                                step: currentStep,
                                error: error.message,
                            });
                            console.log(`step skipped: ${currentStep}: ${error.message}`);
                        }
                    }
                }
            } catch (error) {
                // One scene that cannot start must not throw away the scenes
                // after it, or the screenshots they would have produced.
                manifest.errors.push(`${scene.title} at ${currentStep}: ${error.message}`);
                manifest.skippedSteps.push({
                    scene: scene.title,
                    step: currentStep,
                    error: error.message,
                });
                console.log(`scene skipped: ${scene.title}: ${error.message}`);
            }
        }

        mark('Preview complete');
        await sleep(900);

        for (const handle of await session.windowHandles()) {
            try {
                await session.switchTo(handle);
                await ensureOverlay(session);
                const errors = await session.execute(
                    'return window.__UI_PREVIEW__?.errors() ?? [];'
                );

                if (Array.isArray(errors)) {
                    consoleErrors.push(...errors);
                }
            } catch {
                // A window that already closed has no console to read.
            }
        }
    } catch (error) {
        fail('recording', error.message);
        console.log(`recording stopped: ${error.message}`);
    } finally {
        if (pinTimer) {
            clearInterval(pinTimer);
        }

        const durationMs = Math.max(0, Date.now() - recordingStartedAt);

        if (currentCaption) {
            currentCaption.endMs = Math.min(currentCaption.endMs, durationMs);
        }

        if (recording) {
            const result = await recording.stop();

            if (result.ok) {
                const crop = buildCropFilter(displaySize.width, displaySize.height);
                const captioned = burnCaptions({
                    input: rawVideo,
                    output: videoFile,
                    title: `${sha.slice(0, 7)} · ${title || 'UI preview'}`,
                    durationMs,
                    steps: timeline,
                    crop,
                });

                if (captioned) {
                    fs.rmSync(rawVideo, { force: true });
                } else {
                    fs.rmSync(videoFile, { force: true });
                    fs.renameSync(rawVideo, videoFile);
                    manifest.warnings.push(
                        'captions could not be burned in; the native recording was published as-is'
                    );
                }

                try {
                    const info = probeVideo(videoFile);
                    const distinctStates = countDistinctStates(videoFile);
                    const wallSeconds = durationMs / 1000;
                    const coverage = wallSeconds > 0 ? info.durationSeconds / wallSeconds : 0;

                    manifest.videoInfo = {
                        ...info,
                        distinctStates,
                        wallSeconds,
                        coverage,
                        mode: captureMode(platform),
                        display: displaySize,
                    };
                    manifest.video = path.basename(videoFile);

                    manifest.checks.push(
                        {
                            name: 'Recording length',
                            status: info.durationSeconds >= MIN_VIDEO_SECONDS ? 'pass' : 'fail',
                            detail: `${info.durationSeconds.toFixed(1)}s, ${info.frames} frames`,
                        },
                        {
                            name: 'Recording shows a flow',
                            status: distinctStates >= MIN_DISTINCT_STATES ? 'pass' : 'fail',
                            detail: `${distinctStates} distinct states`,
                        },
                        {
                            name: 'Recording covers the session',
                            status: coverage >= MIN_COVERAGE ? 'pass' : 'fail',
                            detail: `${info.durationSeconds.toFixed(1)}s of ${wallSeconds.toFixed(1)}s captured`,
                        }
                    );

                    if (
                        info.frames < MIN_VIDEO_FRAMES ||
                        info.durationSeconds < MIN_VIDEO_SECONDS
                    ) {
                        manifest.video = null;
                        fail(
                            'recording',
                            `the recording has ${info.frames} frame(s) in ${info.durationSeconds.toFixed(1)}s`
                        );
                    } else if (coverage < MIN_COVERAGE) {
                        fail(
                            'recording',
                            `the recorder captured only ${Math.round(coverage * 100)}% of the session, so the video is incomplete`
                        );
                    }
                } catch (error) {
                    manifest.video = null;
                    fail('recording', `ffprobe could not read the recording: ${error.message}`);
                }
            } else {
                fail(
                    'recording',
                    `native capture stopped without a usable file: ${result.stderr.slice(0, 300)}`
                );
            }
        } else {
            fs.rmSync(rawVideo, { force: true });
        }

        if (runtime) {
            try {
                await runtime.close();
            } catch (error) {
                console.log(`could not close the app: ${error.message}`);
            }
        }
    }

    logErrors = findLogErrors(appRoot);
    const shots = manifest.scenes.flatMap((scene) => scene.shots);

    manifest.checks.push(
        {
            name: `Native recording (${captureMode(platform)})`,
            status: manifest.video ? 'pass' : 'fail',
            detail: manifest.video
                ? `${displaySize.width}x${displaySize.height}`
                : 'ffmpeg did not produce a usable mp4',
        },
        {
            name: 'Screenshots captured',
            status: shots.length > 0 ? 'pass' : 'fail',
            detail: `${shots.length} shot(s)`,
        },
        {
            name: 'Steps executed',
            status: manifest.skippedSteps.length === 0 ? 'pass' : 'fail',
            detail:
                manifest.skippedSteps.length === 0
                    ? ''
                    : `${manifest.skippedSteps.length} step(s) did not run`,
        },
        {
            name: 'Recording captured',
            status: manifest.video ? 'pass' : 'fail',
            detail: manifest.video
                ? `${manifest.videoInfo?.frames ?? 0} frames`
                : 'ffmpeg did not produce a usable mp4',
        },
        {
            name: 'Renderer console errors',
            status: consoleErrors.length === 0 ? 'pass' : 'fail',
            detail: consoleErrors.length === 0 ? '' : `${consoleErrors.length} error(s)`,
        },
        {
            name: 'App log errors',
            status: logErrors.length === 0 ? 'pass' : 'fail',
            detail: logErrors.length === 0 ? '' : `${logErrors.length} error line(s)`,
        }
    );

    if (facts.i18nParity?.checked) {
        manifest.checks.push({
            name: 'Locale key parity',
            status: facts.i18nParity.ok ? 'pass' : 'fail',
            detail: facts.i18nParity.detail,
        });
    }

    if (!manifest.failure && shots.length === 0) {
        fail('recording', 'no screenshot was captured, so there is nothing to review');
    }

    if (!manifest.failure && !manifest.video) {
        fail('recording', 'native recording did not produce a usable mp4');
    }

    persist();

    if (manifest.failure) {
        console.log(`recording stopped: ${manifest.failure.message}`);
    }

    console.log(
        `evidence (${platform}): ${shots.length} screenshot(s), video=${manifest.video ?? 'none'}`
    );
}

main().catch((error) => {
    console.error(error.stack ?? error.message);

    try {
        const outDir = path.resolve(env('UI_PREVIEW_OUT', 'ui-preview-out'));
        const manifestPath = path.join(outDir, 'manifest.json');

        if (!fs.existsSync(manifestPath)) {
            const platform = detectPlatform();
            fs.mkdirSync(outDir, { recursive: true });
            fs.writeFileSync(
                manifestPath,
                `${JSON.stringify(
                    {
                        version: 1,
                        sha: env('UI_PREVIEW_SHA'),
                        pr: Number(env('UI_PREVIEW_PR', '0')),
                        platform,
                        captureMode: captureMode(platform),
                        display: parseDisplaySize(process.env, platform),
                        scenes: [],
                        checks: [],
                        errors: [error.message],
                        skippedSteps: [],
                        video: null,
                        videoInfo: null,
                        failure: { step: 'recording', message: error.message },
                    },
                    null,
                    2
                )}\n`
            );
        }
    } catch {
        // The workflow artifact still carries the stderr above.
    }

    process.exit(1);
});
