/**
 * Validates the model's scene plan before any of it is executed.
 *
 * The plan is untrusted: it is derived from a diff, a pull-request description,
 * and page text, any of which a contributor can write. Every action is
 * allowlisted, every click target must be a `data-testid` that the explore job
 * actually saw, and every string has a length cap.
 */

export const SURFACES = ['search', 'settings'];
export const ALLOWED_ACTIONS = [
    'bridge',
    'click',
    'hover',
    'type',
    'press',
    'scroll',
    'wait',
    'shot',
];
export const ALLOWED_BRIDGE_METHODS = ['openSettingsWindow', 'setSearchQuery'];
export const ALLOWED_KEYS = [
    'Enter',
    'Escape',
    'Tab',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Backspace',
];

export const LIMITS = {
    scenes: 5,
    stepsPerScene: 25,
    scenesWithShots: 12,
    selectorLength: 200,
    valueLength: 200,
    captionLength: 200,
    summaryLength: 600,
    scrollPixels: 2000,
    waitMs: 5000,
};

const SHOT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const TEST_ID_SELECTOR = /^\[data-testid=['"]?([A-Za-z0-9_.:-]+)['"]?\]$/;

export function testIdFromSelector(selector) {
    const match = TEST_ID_SELECTOR.exec(String(selector ?? '').trim());
    return match ? match[1] : null;
}

function singleLine(value, maxLength) {
    return (
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= maxLength &&
        !/[\r\n]/.test(value)
    );
}

/**
 * @param {object} plan
 * @param {{ testIds?: Record<string, string[]>, surfaces?: string[] }} facts
 */
export function validatePlan(plan, facts = {}) {
    const errors = [];
    const testIds = facts.testIds ?? {};
    const surfaces = facts.surfaces ?? SURFACES;

    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
        return { ok: false, errors: ['the plan is not an object'], plan: null };
    }

    if (typeof plan.ui_change !== 'boolean') {
        errors.push('ui_change must be a boolean');
    }

    if (!singleLine(plan.summary, LIMITS.summaryLength)) {
        errors.push('summary must be one line of at most 600 characters');
    }

    if (plan.mismatch != null && typeof plan.mismatch !== 'string') {
        errors.push('mismatch must be a string');
    }

    if (plan.unseen != null && typeof plan.unseen !== 'string') {
        errors.push('unseen must be a string');
    }

    const scenes = Array.isArray(plan.scenes) ? plan.scenes : [];

    if (scenes.length === 0) {
        errors.push('scenes must contain at least one scene');
    }

    if (scenes.length > LIMITS.scenes) {
        errors.push(`at most ${LIMITS.scenes} scenes are allowed`);
    }

    let shotCount = 0;
    const accepted = [];

    scenes.forEach((scene, sceneIndex) => {
        const label = `scene ${sceneIndex + 1}`;

        if (!scene || typeof scene !== 'object') {
            errors.push(`${label} is not an object`);
            return;
        }

        if (!singleLine(scene.title, LIMITS.captionLength)) {
            errors.push(`${label} needs a one-line title`);
        }

        if (!surfaces.includes(scene.surface)) {
            errors.push(`${label} has an unknown surface`);
        }

        const steps = Array.isArray(scene.steps) ? scene.steps : [];

        if (steps.length === 0) {
            errors.push(`${label} has no steps`);
        }

        if (steps.length > LIMITS.stepsPerScene) {
            errors.push(`${label} has more than ${LIMITS.stepsPerScene} steps`);
        }

        const acceptedSteps = [];

        steps.forEach((step, stepIndex) => {
            const stepLabel = `${label} step ${stepIndex + 1}`;

            if (!step || typeof step !== 'object') {
                errors.push(`${stepLabel} is not an object`);
                return;
            }

            if (!ALLOWED_ACTIONS.includes(step.do)) {
                errors.push(`${stepLabel} uses an action that is not allowed`);
                return;
            }

            if (step.caption != null && !singleLine(step.caption, LIMITS.captionLength)) {
                errors.push(`${stepLabel} has an unusable caption`);
                return;
            }

            const needsTarget = ['click', 'hover', 'type'].includes(step.do);

            if (needsTarget) {
                if (!singleLine(step.target, LIMITS.selectorLength)) {
                    errors.push(`${stepLabel} needs a target selector`);
                    return;
                }

                const testId = testIdFromSelector(step.target);
                const known = testIds[scene.surface] ?? [];

                if (!testId) {
                    errors.push(`${stepLabel} must target a data-testid`);
                    return;
                }

                if (!known.includes(testId)) {
                    errors.push(`${stepLabel} targets a test id that this build does not render`);
                    return;
                }
            }

            if (step.do === 'type' && !singleLine(step.value, LIMITS.valueLength)) {
                errors.push(`${stepLabel} needs a one-line value`);
                return;
            }

            if (step.do === 'press' && !ALLOWED_KEYS.includes(step.value)) {
                errors.push(`${stepLabel} presses a key that is not allowed`);
                return;
            }

            if (step.do === 'scroll') {
                const pixels = Number(step.value);

                if (!Number.isFinite(pixels) || Math.abs(pixels) > LIMITS.scrollPixels) {
                    errors.push(`${stepLabel} scrolls out of range`);
                    return;
                }
            }

            if (step.do === 'wait') {
                const ms = Number(step.value);

                if (!Number.isFinite(ms) || ms < 0 || ms > LIMITS.waitMs) {
                    errors.push(`${stepLabel} waits out of range`);
                    return;
                }
            }

            if (step.do === 'bridge') {
                if (!ALLOWED_BRIDGE_METHODS.includes(step.value)) {
                    errors.push(`${stepLabel} calls a bridge method that is not allowed`);
                    return;
                }

                const args = step.args ?? [];

                if (
                    !Array.isArray(args) ||
                    args.length > 3 ||
                    args.some((arg) => typeof arg !== 'string' || arg.length > LIMITS.valueLength)
                ) {
                    errors.push(`${stepLabel} has unusable bridge arguments`);
                    return;
                }
            }

            if (step.do === 'shot') {
                if (!SHOT_NAME.test(String(step.name ?? ''))) {
                    errors.push(
                        `${stepLabel} needs a shot name of lowercase letters, digits, and dashes`
                    );
                    return;
                }

                shotCount += 1;

                if (shotCount > LIMITS.scenesWithShots) {
                    errors.push(`at most ${LIMITS.scenesWithShots} screenshots are allowed`);
                    return;
                }
            }

            acceptedSteps.push(step);
        });

        if (acceptedSteps.length > 0) {
            accepted.push({ ...scene, steps: acceptedSteps });
        }
    });

    return {
        ok: errors.length === 0,
        errors,
        plan: errors.length === 0 ? { ...plan, scenes: accepted } : null,
    };
}

/**
 * A deterministic plan for when the model is unavailable or its answer is
 * rejected. It always produces evidence for the surfaces the diff touched.
 */
export function defaultPlan(facts = {}) {
    const scenes = [];
    const touchedSettings = Boolean(facts.touchedSettings);
    const touchedSearch = Boolean(facts.touchedSearch);
    const wantsSettings = touchedSettings || !touchedSearch;
    const wantsSearch = touchedSearch || !touchedSettings;

    if (wantsSearch) {
        scenes.push({
            title: 'Search',
            surface: 'search',
            steps: [
                {
                    do: 'bridge',
                    value: 'setSearchQuery',
                    args: ['touchai'],
                    caption: 'Type a query',
                },
                { do: 'wait', value: 900, caption: 'Wait for results' },
                { do: 'shot', name: 'search-results', caption: 'Search window with results' },
            ],
        });
    }

    if (wantsSettings) {
        scenes.push({
            title: 'Settings',
            surface: 'settings',
            steps: [
                { do: 'bridge', value: 'openSettingsWindow', caption: 'Open settings' },
                { do: 'wait', value: 1200, caption: 'Wait for the window' },
                { do: 'shot', name: 'settings-general', caption: 'Settings, general section' },
            ],
        });
    }

    return {
        ui_change: true,
        summary: 'The diff changes interface files; the default scene shows the affected surfaces.',
        mismatch: '',
        unseen: '',
        scenes,
        source: 'default',
    };
}
