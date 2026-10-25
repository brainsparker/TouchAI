/**
 * X11 capture helpers.
 *
 * Screenshots come from the Xvfb root and are cropped to the focused window, so
 * native transparency and rounded corners are visible against a known desktop
 * colour. The video records the whole virtual display at 30 fps.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const SCREEN_WIDTH = 1280;
export const SCREEN_HEIGHT = 900;
export const DESKTOP_COLOUR = '#2b2b2b';

function run(command, args, options = {}) {
    const result = spawnSync(command, args, { encoding: 'utf8', ...options });

    if (result.error) {
        throw new Error(`${command} failed to start: ${result.error.message}`);
    }

    return result;
}

export function hasCommand(command) {
    return spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).status === 0;
}

export function paintDesktop(display) {
    run('xsetroot', ['-solid', DESKTOP_COLOUR], { env: { ...process.env, DISPLAY: display } });
}

/**
 * Returns the geometry of the focused window, or null when no window is focused.
 */
export function focusedWindow(display) {
    const env = { ...process.env, DISPLAY: display };
    const active = run('xdotool', ['getactivewindow'], { env });

    if (active.status !== 0) {
        return null;
    }

    const id = active.stdout.trim();

    if (!id) {
        return null;
    }

    const geometry = run('xdotool', ['getwindowgeometry', '--shell', id], { env });

    if (geometry.status !== 0) {
        return null;
    }

    const values = {};

    for (const line of geometry.stdout.split('\n')) {
        const [key, value] = line.split('=');

        if (key && value !== undefined) {
            values[key.trim()] = Number(value.trim());
        }
    }

    if (!Number.isFinite(values.WIDTH) || !Number.isFinite(values.HEIGHT)) {
        return null;
    }

    const name = run('xdotool', ['getwindowname', id], { env }).stdout.trim();

    return {
        id,
        name,
        x: values.X ?? 0,
        y: values.Y ?? 0,
        width: values.WIDTH,
        height: values.HEIGHT,
    };
}

function geometryOf(display, id) {
    const env = { ...process.env, DISPLAY: display };
    const geometry = run('xdotool', ['getwindowgeometry', '--shell', id], { env });

    if (geometry.status !== 0) {
        return null;
    }

    const values = {};

    for (const line of geometry.stdout.split('\n')) {
        const [key, value] = line.split('=');

        if (key && value !== undefined) {
            values[key.trim()] = Number(value.trim());
        }
    }

    if (!Number.isFinite(values.WIDTH) || !Number.isFinite(values.HEIGHT)) {
        return null;
    }

    return {
        id,
        name: run('xdotool', ['getwindowname', id], { env }).stdout.trim(),
        x: values.X ?? 0,
        y: values.Y ?? 0,
        width: values.WIDTH,
        height: values.HEIGHT,
    };
}

/**
 * Picks the visible app window for a surface.
 *
 * The search window is 750 wide and the settings window is 1120x700, so the
 * surface decides by size. This does not depend on input focus, which is not
 * reliable when the driver drives the app instead of a person.
 */
export function windowForSurface(display, surface) {
    const env = { ...process.env, DISPLAY: display };
    const listed = run('xdotool', ['search', '--onlyvisible', '--name', 'TouchAI'], { env });
    const ids = listed.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    const candidates = ids
        .map((id) => geometryOf(display, id))
        .filter((geometry) => geometry && geometry.width >= 300 && geometry.height >= 40);

    if (candidates.length === 0) {
        return null;
    }

    const score = (geometry) =>
        surface === 'settings'
            ? (geometry.width >= 900 && geometry.height >= 500 ? 0 : 10000) +
              Math.abs(geometry.width - 1120) +
              Math.abs(geometry.height - 700)
            : (geometry.width <= 900 ? 0 : 10000) + Math.abs(geometry.width - 750);

    return candidates.sort((left, right) => score(left) - score(right))[0];
}

export function raiseWindow(display, id) {
    const env = { ...process.env, DISPLAY: display };
    run('xdotool', ['windowraise', id], { env });
    run('xdotool', ['windowfocus', id], { env });
}

export function captureScreenshot({ display, file, geometry }) {
    const scratch = `${file}.full.png`;

    const shot = run('import', ['-window', 'root', scratch], {
        env: { ...process.env, DISPLAY: display },
    });

    if (shot.status !== 0) {
        throw new Error(`import failed: ${shot.stderr.trim()}`);
    }

    const crop = `${geometry.width}x${geometry.height}+${geometry.x}+${geometry.y}`;
    const convert = hasCommand('magick') ? 'magick' : 'convert';
    const result = run(convert, [scratch, '-crop', crop, '+repage', file]);

    fs.rmSync(scratch, { force: true });

    if (result.status !== 0) {
        throw new Error(`${convert} failed: ${result.stderr.trim()}`);
    }

    return { width: geometry.width, height: geometry.height };
}

export function startRecording({ display, file }) {
    const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'x11grab',
        '-framerate',
        '30',
        '-video_size',
        `${SCREEN_WIDTH}x${SCREEN_HEIGHT}`,
        '-i',
        `${display}.0+0,0`,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        file,
    ];

    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
    });

    return {
        child,
        async stop() {
            if (child.exitCode !== null) {
                return { ok: false, stderr };
            }

            child.kill('SIGINT');
            await new Promise((resolve) => {
                const timer = setTimeout(() => {
                    child.kill('SIGKILL');
                    resolve();
                }, 8000);
                child.on('exit', () => {
                    clearTimeout(timer);
                    resolve();
                });
            });

            return { ok: fs.existsSync(file), stderr };
        },
    };
}

export function ensureDir(directory) {
    fs.mkdirSync(directory, { recursive: true });
    return path.resolve(directory);
}
