import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testDirectory, '../../../..');
const workflowPath = path.join(repositoryRoot, '.github/workflows/ui-preview.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');
const nativeWorkflow = fs.readFileSync(
    path.join(repositoryRoot, '.github/workflows/ui-preview-native-validation.yml'),
    'utf8'
);
const runtime = fs.readFileSync(
    path.join(repositoryRoot, '.github/ui-preview/lib/runtime.mjs'),
    'utf8'
);

function jobBlock(name) {
    const start = workflow.indexOf(`\n    ${name}:`);
    const next = workflow.slice(start + 1).search(/\n {4}[a-z][a-z-]*:/);

    return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next);
}

function nativeJobBlock(name) {
    const start = nativeWorkflow.indexOf(`\n    ${name}:`);
    const next = nativeWorkflow.slice(start + 1).search(/\n {4}[a-z][a-z-]*:/);

    return next === -1
        ? nativeWorkflow.slice(start)
        : nativeWorkflow.slice(start, start + 1 + next);
}

describe('user opens a pull request that runs the preview', () => {
    it('user gets a preview trigger that never uses the default write token', () => {
        expect(workflow).toContain('pull_request_target');
        expect(workflow).toContain('permissions: {}');
    });

    it('user gets a superseded run cancelled instead of queued', () => {
        expect(workflow).toContain('cancel-in-progress: true');
        expect(workflow).toContain('ui-preview-${{');
    });

    it('user gets the preview run preserved when the App adds its approval label', () => {
        expect(workflow).toContain("endsWith(github.actor, '[bot]')");
        expect(workflow).toContain("'approval' || 'run'");
    });

    it('user gets the pull request code built only in a job without secrets', () => {
        const explore = jobBlock('explore');

        expect(explore).toContain('repository: ${{ needs.detect.outputs.head_repo }}');
        expect(explore).not.toContain('secrets.');
        expect(explore).not.toContain('environment:');
        expect(explore).toContain('contents: read');
    });

    it('user gets a recording job that never checks out the pull request', () => {
        const record = jobBlock('record');

        expect(record).not.toContain('needs.detect.outputs.head_repo');
        expect(record).not.toContain('secrets.');
        expect(record).not.toContain('environment:');
    });

    it('user gets native builds on Linux, macOS, and Windows', () => {
        const explore = jobBlock('explore');
        const record = jobBlock('record');

        for (const platform of ['linux', 'macos', 'windows']) {
            expect(explore).toContain(`platform: ${platform}`);
            expect(record).toContain(`platform: ${platform}`);
        }

        expect(explore).toContain('os: ubuntu-24.04');
        expect(explore).toContain('os: macos-15');
        expect(explore).toContain('os: windows-latest');
        expect(record).toContain('os: ubuntu-24.04');
        expect(record).toContain('os: macos-15');
        expect(record).toContain('os: windows-latest');
    });

    it('user gets the embedded WebDriver build instead of an external driver', () => {
        expect(workflow).toContain(
            'pnpm tauri build --debug --no-bundle --features ui-preview-webdriver'
        );
        expect(workflow).not.toContain('cargo install tauri-driver');
        expect(workflow).not.toContain('webkit2gtk-driver');
    });

    it('user gets the hosted display configured before each native run', () => {
        expect(workflow).toContain('macos-display.swift --configure-hosted');
        expect(workflow).toContain('configure-display.ps1');
        expect(workflow).toContain("UI_PREVIEW_DISPLAY_WIDTH: '1920'");
        expect(workflow).toContain("UI_PREVIEW_DISPLAY_HEIGHT: '1080'");
        expect(workflow).toContain("UI_PREVIEW_STAGE_WIDTH: '1920'");
        expect(workflow).toContain("UI_PREVIEW_STAGE_HEIGHT: '1080'");
        expect(workflow).toContain("UI_PREVIEW_SCALE_FACTOR: '1'");
        expect(workflow).toContain('-screen 0 1920x1080x24');
    });

    it('user gets every platform evidence artifact merged into one publish job', () => {
        const publish = jobBlock('publish');

        expect(publish).toContain('pattern: ui-preview-evidence-*');
        expect(publish).toContain('merge-multiple: false');
        expect(publish).toContain('UI_PREVIEW_PLATFORMS: linux,macos,windows');
    });

    it('user gets the model key only in a job that does not run pull-request code', () => {
        const plan = jobBlock('plan');

        expect(plan).toContain('environment: ui-preview');
        expect(plan).toContain('secrets.UI_PREVIEW_MODEL_API_KEY');
        expect(plan).not.toContain('head_repo');
    });

    it('user gets both publishing credentials only in the publish job', () => {
        const publish = jobBlock('publish');

        expect(publish).toContain('environment: ui-preview-publish');
        expect(publish).toContain('secrets.UI_PREVIEW_TOKEN');
        expect(publish).toContain('secrets.BOT_APP_ID');
        expect(publish).not.toContain('head_repo');
    });

    it('user gets the App identity without asking an installation token for /user', () => {
        const detect = jobBlock('detect');
        const publish = jobBlock('publish');

        expect(detect).toContain('UI_PREVIEW_BOT_LOGIN: ${{ steps.app.outputs.app-slug }}[bot]');
        expect(publish).toContain('UI_PREVIEW_BOT_LOGIN: ${{ steps.app.outputs.app-slug }}[bot]');
    });

    it('user gets the same App identity in the credential doctor', () => {
        const doctor = fs.readFileSync(
            path.join(repositoryRoot, '.github/workflows/ui-preview-doctor.yml'),
            'utf8'
        );

        expect(doctor).toContain('UI_PREVIEW_BOT_LOGIN: ${{ steps.app.outputs.app-slug }}[bot]');
    });

    it('user gets the comment edited in place rather than appended', () => {
        const publishScript = fs.readFileSync(
            path.join(repositoryRoot, '.github/ui-preview/publish.mjs'),
            'utf8'
        );

        expect(publishScript).toContain('findOwnPreviewComment');
        expect(publishScript).toContain('updateComment');
        expect(publishScript).not.toContain('edit-last');
    });

    it('user gets no credential written into the workflow or the scripts', () => {
        const directory = path.join(repositoryRoot, '.github/ui-preview');
        const files = [];
        const queue = [directory];

        while (queue.length > 0) {
            const current = queue.shift();

            for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
                const full = path.join(current, entry.name);

                if (entry.isDirectory()) {
                    queue.push(full);
                } else {
                    files.push(full);
                }
            }
        }

        for (const file of [...files, workflowPath]) {
            const text = fs.readFileSync(file, 'utf8');

            expect(text).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
            expect(text).not.toMatch(/gh[opsu]_[A-Za-z0-9]{20,}/);
            expect(text).not.toMatch(/BEGIN (RSA )?PRIVATE KEY/);
        }
    });
});

describe('user checks a capture change on the native validation harness', () => {
    it('user gets the comment from the App instead of a maintainer account', () => {
        expect(nativeWorkflow).toContain('GH_TOKEN: ${{ needs.token.outputs.token }}');
        expect(nativeWorkflow).toContain(
            'UI_PREVIEW_BOT_LOGIN: ${{ needs.token.outputs.app-slug }}[bot]'
        );
        expect(nativeWorkflow).toContain('secrets.BOT_APP_ID');
        expect(nativeWorkflow).toContain('secrets.BOT_APP_PRIVATE_KEY');
        expect(nativeWorkflow).toContain('permission-issues: write');
        expect(nativeWorkflow).toContain('pull-requests: write');
        expect(nativeWorkflow).toContain('pattern: ui-preview-native-validation-*');
    });

    it('user gets the App private key only in a job that runs no pull-request code', () => {
        const token = nativeJobBlock('token');
        const publish = nativeJobBlock('publish');

        expect(token).toContain('secrets.BOT_APP_PRIVATE_KEY');
        expect(token).not.toContain('pull_request.head.sha');
        expect(publish).not.toContain('secrets.BOT_APP_PRIVATE_KEY');
        expect(publish).toContain('needs.token.outputs.token');
    });

    it('user gets the Actions bot comment only for a same-repository validation label', () => {
        expect(nativeWorkflow).toContain(
            "github.event.label.name == 'ui-preview-native-validation'"
        );
        expect(nativeWorkflow).toContain(
            'github.event.pull_request.head.repo.full_name == github.repository'
        );
    });

    it('user gets the same 1920x1080 stage on the native validation run', () => {
        expect(nativeWorkflow).toContain("UI_PREVIEW_DISPLAY_WIDTH: '1920'");
        expect(nativeWorkflow).toContain("UI_PREVIEW_DISPLAY_HEIGHT: '1080'");
        expect(nativeWorkflow).toContain("UI_PREVIEW_SCALE_FACTOR: '1'");
        expect(nativeWorkflow).toContain('-screen 0 1920x1080x24');
    });

    it('user gets a window that stays anchored while the preview app resizes', () => {
        expect(runtime).toContain("TOUCHAI_UI_PREVIEW: '1'");
    });
});
