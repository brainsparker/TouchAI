import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildAss, finalizeRecording } from '../../../../.github/ui-preview/lib/capture.mjs';

describe('user reads the burned-in captions', () => {
    it('user sees a title for the whole recording and one caption per step', () => {
        const ass = buildAss({
            title: 'c616766 · Settings',
            durationMs: 12000,
            steps: [
                { startMs: 500, endMs: 3000, text: 'Open Settings' },
                { startMs: 3000, endMs: 6000, text: 'Open Shortcuts' },
            ],
        });

        expect(ass).toContain('Style: Title');
        expect(ass).toContain('c616766 · Settings');
        expect(ass).toContain('0:00:00.50,0:00:03.00');
        expect(ass).toContain('0:00:03.00,0:00:06.00');
    });

    it('user never sees a caption run past the recording', () => {
        const ass = buildAss({
            durationMs: 4000,
            steps: [{ startMs: 3000, endMs: 9000, text: 'Last step' }],
        });

        expect(ass).toContain('0:00:03.00,0:00:04.00');
    });

    it('user gets a caption that cannot break the subtitle file', () => {
        const ass = buildAss({
            durationMs: 4000,
            steps: [{ startMs: 0, endMs: 1000, text: 'Click {settings} \\ done\nnext line' }],
        });

        expect(ass).toContain('Click settings \\\\ done next line');
        expect(ass).not.toContain('{\\');
    });
});

describe('user still gets a cropped recording when captions are unavailable', () => {
    it('user gets the crop fallback and a warning instead of the raw desktop', () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'touchai-ui-preview-'));
        const input = path.join(directory, 'raw.mp4');
        const output = path.join(directory, 'recording.mp4');
        const calls = [];
        fs.writeFileSync(input, 'raw-video');

        try {
            const result = finalizeRecording({
                input,
                output,
                title: 'abc1234 · Settings',
                durationMs: 2000,
                steps: [{ startMs: 0, endMs: 1000, text: 'Open Settings' }],
                crop: 'crop=1280:900:0:0',
                runFfmpeg: (_command, args) => {
                    calls.push(args);
                    const target = args[args.length - 1];

                    if (calls.length === 1) {
                        fs.writeFileSync(target, 'partial');
                        return { status: 1, stderr: 'subtitles unavailable' };
                    }

                    fs.copyFileSync(input, target);
                    return { status: 0, stderr: '' };
                },
            });

            expect(result).toEqual({
                output,
                captionsBurned: false,
                cropped: true,
            });
            expect(calls).toHaveLength(2);
            expect(calls[0][calls[0].indexOf('-vf') + 1]).toContain(
                'ass=filename=.touchai-ui-preview-'
            );
            expect(calls[0][calls[0].indexOf('-vf') + 1]).not.toContain(directory);
            expect(calls[1][calls[1].indexOf('-vf') + 1]).toBe('crop=1280:900:0:0');
            expect(fs.readFileSync(output, 'utf8')).toBe('raw-video');
        } finally {
            fs.rmSync(directory, { recursive: true, force: true });
        }
    });
});
