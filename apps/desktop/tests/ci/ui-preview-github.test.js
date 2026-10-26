import { describe, expect, it, vi } from 'vitest';

import { resolveBotLogin } from '../../../../.github/ui-preview/lib/github.mjs';

describe('user resolves the preview bot identity', () => {
    it('user gets the workflow App slug without calling GET /user', async () => {
        const client = {
            getAuthenticatedUser: vi.fn(),
        };

        await expect(resolveBotLogin(client, 'touchai-ui-preview[bot]')).resolves.toBe(
            'touchai-ui-preview[bot]'
        );
        expect(client.getAuthenticatedUser).not.toHaveBeenCalled();
    });

    it('user gets the local token identity when no App slug is configured', async () => {
        const client = {
            getAuthenticatedUser: vi.fn().mockResolvedValue({ login: 'local-user' }),
        };

        await expect(resolveBotLogin(client, '')).resolves.toBe('local-user');
        expect(client.getAuthenticatedUser).toHaveBeenCalledOnce();
    });
});
