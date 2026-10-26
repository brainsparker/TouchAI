/**
 * Asks the model for a scene plan and refuses anything that does not validate.
 *
 * Runs trusted code only: it reads the diff through the API, never checks the
 * pull request out, and the model key never reaches a job that runs pull-request
 * code.
 */

import fs from 'node:fs';
import path from 'node:path';

import { createClient } from './lib/github.mjs';
import { buildPrompt, requestPlan } from './lib/model.mjs';
import { defaultPlan, validatePlan } from './lib/scenarios.mjs';

function env(name, fallback = '') {
    return process.env[name] ?? fallback;
}

async function main() {
    const outDir = path.resolve(env('UI_PREVIEW_OUT', 'ui-preview-out'));
    const factsPath = path.join(outDir, 'facts.json');

    if (!fs.existsSync(factsPath)) {
        throw new Error('facts.json is missing; the explore job did not finish');
    }

    const facts = JSON.parse(fs.readFileSync(factsPath, 'utf8'));
    const [owner, repo] = String(env('GITHUB_REPOSITORY')).split('/');
    const token = env('GH_TOKEN');
    const pr = Number(env('UI_PREVIEW_PR'));
    const client = createClient({ token, owner, repo });
    const pull = await client.getPullRequest(pr);
    const diff = await client.getDiff(pr);

    const prompt = buildPrompt({
        title: pull.title,
        body: pull.body,
        files: facts.files,
        diff,
        outline: facts,
    });

    let plan = null;
    const warnings = [];

    if (env('UI_PREVIEW_MODEL_API_KEY') && env('UI_PREVIEW_MODEL')) {
        const response = await requestPlan({
            baseUrl: env('UI_PREVIEW_MODEL_BASE_URL', 'https://qai.qianc.top/v1'),
            apiKey: env('UI_PREVIEW_MODEL_API_KEY'),
            model: env('UI_PREVIEW_MODEL'),
            prompt,
        });

        if (!response.ok) {
            warnings.push(`the model did not return a plan: ${response.errors.join('; ')}`);
        } else {
            const validation = validatePlan(response.plan, {
                testIds: facts.testIds,
                surfaces: ['search', 'settings'],
            });

            if (validation.ok) {
                plan = { ...validation.plan, source: 'model' };
            } else {
                warnings.push(
                    `the model plan was rejected: ${validation.errors.slice(0, 5).join('; ')}`
                );
            }
        }
    } else {
        warnings.push('no model is configured; the default scene was used');
    }

    if (!plan) {
        plan = defaultPlan({
            touchedSettings: facts.files.some((file) =>
                file.startsWith('apps/desktop/src/views/SettingsView/')
            ),
            touchedSearch: facts.files.some((file) =>
                file.startsWith('apps/desktop/src/views/SearchView/')
            ),
            testIds: facts.testIds,
        });
    }

    if (warnings.length > 0) {
        plan.warnings = warnings;
        console.log(`plan warnings: ${warnings.join(' | ')}`);
    }

    fs.writeFileSync(path.join(outDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
    console.log(`plan: ${plan.scenes.length} scene(s) from ${plan.source}`);
}

main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exit(1);
});
