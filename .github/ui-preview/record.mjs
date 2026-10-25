/**
 * Executes the validated plan and records screenshots plus an mp4.
 *
 * Runs pull-request code (the built binary) with no repository secret and no
 * write token. A failed step is written to the manifest and published as a
 * failure, never retried into a pass.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
    captureScreenshot,
    ensureDir,
    paintDesktop,
    raiseWindow,
    startRecording,
    windowForSurface,
} from './lib/capture.mjs';
import { ELEMENT_CENTER_SCRIPT } from './lib/overlay.mjs';
import {
    boot,
    bridge,
    ensureOverlay,
    mainWindowHandle,
    measureOverflow,
    openSettings,
    switchToSurface,
    waitForBridge,
} from './lib/runtime.mjs';

function env(name, fallback = '') {
    return process.env[name] ?? fallback;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function moveCursor(session, selector, caption) {
    const center = await session.execute(ELEMENT_CENTER_SCRIPT, [selector]);

    if (!center) {
        return;
    }

    await session.execute('window.__UI_PREVIEW__?.moveTo(arguments[0], arguments[1]);', [
        center.x,
        center.y,
    ]);

    if (caption) {
        await session.execute('window.__UI_PREVIEW__?.caption(arguments[0]);', [caption]);
    }
}

async function clickWithOverlay(session, selector, caption) {
    await moveCursor(session, selector, caption);
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

async function runStep(session, step) {
    if (step.caption) {
        await session.execute('window.__UI_PREVIEW__?.caption(arguments[0]);', [step.caption]);
    }

    if (step.do === 'bridge') {
        await bridge(session, step.value, step.args ?? []);
        await sleep(400);
        return;
    }

    if (step.do === 'click') {
        await clickWithOverlay(session, step.target, step.caption);
        return;
    }

    if (step.do === 'hover') {
        await moveCursor(session, step.target, step.caption);
        await session.hover(step.target);
        await sleep(400);
        return;
    }

    if (step.do === 'type') {
        await moveCursor(session, step.target, step.caption);
        await session.type(step.target, step.value);
        await sleep(350);
        return;
    }

    if (step.do === 'press') {
        await session.press(step.value);
        await sleep(300);
        return;
    }

    if (step.do === 'scroll') {
        await session.scroll(step.value);
        await sleep(400);
        return;
    }

    if (step.do === 'wait') {
        await sleep(Number(step.value));
        return;
    }

    if (step.do === 'shot') {
        await sleep(260);
    }
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

async function main() {
    const application = env('UI_PREVIEW_APP_BINARY');
    const outDir = path.resolve(env('UI_PREVIEW_OUT', 'ui-preview-out'));
    const evidenceDir = ensureDir(path.join(outDir, 'evidence'));
    const display = env('DISPLAY', ':99');
    const sha = env('UI_PREVIEW_SHA');
    const appRoot = env('TOUCHAI_APP_ROOT');
    const facts = JSON.parse(fs.readFileSync(path.join(outDir, 'facts.json'), 'utf8'));
    const plan = JSON.parse(fs.readFileSync(path.join(outDir, 'plan.json'), 'utf8'));

    if (!application || !fs.existsSync(application)) {
        throw new Error(`UI_PREVIEW_APP_BINARY does not exist: ${application}`);
    }

    paintDesktop(display);

    const scenes = [...plan.scenes].sort((left, right) => {
        if (left.surface === right.surface) {
            return 0;
        }
        return left.surface === 'search' ? -1 : 1;
    });

    const manifest = {
        version: 1,
        sha,
        pr: Number(env('UI_PREVIEW_PR', '0')),
        runUrl: env('UI_PREVIEW_RUN_URL'),
        trigger: env('UI_PREVIEW_TRIGGER'),
        source: plan.source ?? 'model',
        summary: plan.summary ?? '',
        mismatch: plan.mismatch ?? '',
        unseen: plan.unseen ?? '',
        warnings: plan.warnings ?? [],
        scenes: [],
        checks: [],
        video: null,
        failure: null,
    };

    const runtime = await boot({ application });
    const { session } = runtime;
    const consoleErrors = [];
    const videoFile = path.join(evidenceDir, 'recording.mp4');
    let recording = null;

    try {
        await waitForBridge(session);
        const mainHandle = await mainWindowHandle(session);
        await ensureOverlay(session);
        recording = startRecording({ display, file: videoFile });
        await sleep(600);

        const state = { mainHandle };

        for (const scene of scenes) {
            const recorded = { title: scene.title, surface: scene.surface, shots: [] };
            manifest.scenes.push(recorded);

            try {
                await switchToSurface(session, scene.surface, state);

                for (const step of scene.steps) {
                    if (step.do === 'bridge' && step.value === 'openSettingsWindow') {
                        const opened = await openSettings(session);
                        state.settingsHandle = opened.settings;
                        await sleep(600);
                        continue;
                    }

                    if (step.do === 'shot') {
                        const overflow = await measureOverflow(session);
                        const geometry = windowForSurface(display, scene.surface);
                        const file = `${scene.surface}-${step.name}.png`;

                        if (!geometry) {
                            throw new Error(`no visible ${scene.surface} window to capture`);
                        }

                        raiseWindow(display, geometry.id);
                        await sleep(250);
                        // The overlay helps the video, but it must not cover the
                        // pixels a reviewer judges in a still.
                        await session.execute('window.__UI_PREVIEW__?.hide();');
                        await sleep(250);
                        const size = captureScreenshot({
                            display,
                            file: path.join(evidenceDir, file),
                            geometry,
                        });
                        await session.execute('window.__UI_PREVIEW__?.show();');

                        recorded.shots.push({
                            file,
                            caption: step.caption ?? '',
                            width: size.width,
                            height: size.height,
                        });

                        manifest.checks.push({
                            name: `No horizontal overflow at ${overflow.innerWidth}px (${scene.title})`,
                            status: overflow.overflowX > 1 ? 'fail' : 'pass',
                            detail:
                                overflow.overflowX > 1
                                    ? `${overflow.overflowX}px wider than the window`
                                    : '',
                        });
                        continue;
                    }

                    await runStep(session, step);
                }
            } catch (error) {
                manifest.failure = {
                    step: `${scene.title}: ${scene.steps.at(-1)?.do ?? 'scene'}`,
                    message: error.message,
                };
                break;
            }
        }

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
    } finally {
        if (recording) {
            const result = await recording.stop();

            if (result.ok) {
                manifest.video = path.basename(videoFile);
            } else {
                console.log(`recording failed: ${result.stderr.slice(0, 500)}`);
            }
        }

        await runtime.close();
    }

    const logErrors = findLogErrors(appRoot);
    const shots = manifest.scenes.flatMap((scene) => scene.shots);

    manifest.checks.push(
        {
            name: 'Screenshots captured',
            status: shots.length > 0 ? 'pass' : 'fail',
            detail: `${shots.length} shot(s)`,
        },
        {
            name: 'Recording captured',
            status: manifest.video ? 'pass' : 'not checked',
            detail: manifest.video ? '' : 'ffmpeg did not produce an mp4',
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

    fs.writeFileSync(
        path.join(outDir, 'manifest.json'),
        `${JSON.stringify({ ...manifest, consoleErrors, logErrors }, null, 2)}\n`
    );

    if (manifest.failure) {
        console.log(`recording stopped: ${manifest.failure.message}`);
    }

    console.log(`evidence: ${shots.length} screenshot(s), video=${manifest.video ?? 'none'}`);
}

main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exit(1);
});
