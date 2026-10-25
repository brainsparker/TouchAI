import { describe, expect, it, vi } from 'vitest';

import { WebSearchHttpError } from '@/services/BuiltInToolService/tools/webSearch/providers/types';
import {
    describeYoucomFailure,
    runWithYoucomRetry,
    YOUCOM_MAX_RETRY_AFTER_MS,
} from '@/services/BuiltInToolService/tools/webSearch/providers/youcom';

describe('You.com search provider errors', () => {
    it('retries once after a short Retry-After on 429', async () => {
        const sleep = vi.fn(async () => undefined);
        const operation = vi
            .fn<() => Promise<string>>()
            .mockRejectedValueOnce(
                new WebSearchHttpError(429, 'Too Many Requests', { retryAfterMs: 1200 })
            )
            .mockResolvedValueOnce('ok');

        await expect(runWithYoucomRetry(operation, sleep)).resolves.toBe('ok');
        expect(sleep).toHaveBeenCalledWith(1200);
        expect(operation).toHaveBeenCalledTimes(2);
    });

    it('does not wait when Retry-After is longer than the cap', async () => {
        const sleep = vi.fn(async () => undefined);
        const error = new WebSearchHttpError(429, 'Too Many Requests', {
            retryAfterMs: YOUCOM_MAX_RETRY_AFTER_MS + 1,
        });
        const operation = vi.fn<() => Promise<string>>().mockRejectedValue(error);

        await expect(runWithYoucomRetry(operation, sleep)).rejects.toBe(error);
        expect(sleep).not.toHaveBeenCalled();
        expect(operation).toHaveBeenCalledTimes(1);
    });

    it('does not retry auth or quota failures', async () => {
        for (const status of [401, 402, 403]) {
            const sleep = vi.fn(async () => undefined);
            const operation = vi
                .fn<() => Promise<string>>()
                .mockRejectedValue(new WebSearchHttpError(status, 'err', { retryAfterMs: 0 }));
            await expect(runWithYoucomRetry(operation, sleep)).rejects.toBeInstanceOf(
                WebSearchHttpError
            );
            expect(operation).toHaveBeenCalledTimes(1);
        }
    });

    it('explains auth, quota and rate-limit failures', () => {
        const message = (status: number, keyed: boolean) =>
            (describeYoucomFailure(new WebSearchHttpError(status, ''), keyed) as Error).message;

        expect(message(401, true)).toContain('rejected the API key');
        expect(message(403, false)).toContain('free tier denied');
        expect(message(402, false)).toContain('add an API key');
        expect(message(402, true)).toContain('out of credits');
        expect(message(429, false)).toContain('rate limit');
        const other = new WebSearchHttpError(500, 'boom');
        expect(describeYoucomFailure(other, false)).toBe(other);
    });
});
