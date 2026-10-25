import type { WebSearchResult } from '../helper';
import { resultFromGenericItem, resultLimit } from './common';
import { createSearchProviderAdapter } from './define';
import { WebSearchHttpError } from './types';

/** 免费档：无需 key，每个 IP 每天 100 次。 */
const YOUCOM_FREE_URL = 'https://api.you.com/v1/agents/search';
/** 配置 API key 后走正式接口，按账号额度计费。 */
const YOUCOM_KEYED_URL = 'https://ydc-index.io/v1/search';
const YOUCOM_USER_AGENT = 'youdotcom-integration/TouchAI-org-TouchAI';

/** 429 时最多按 `Retry-After` 等这么久再试一次，更长就交给 fallback。 */
export const YOUCOM_MAX_RETRY_AFTER_MS = 5_000;

function defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/** 把 401 / 402 / 403 / 429 转成用户看得懂的错误，其余原样抛出。 */
export function describeYoucomFailure(error: unknown, keyed: boolean): unknown {
    if (!(error instanceof WebSearchHttpError)) {
        return error;
    }
    if (error.status === 401 || error.status === 403) {
        return new Error(
            keyed
                ? 'You.com rejected the API key (HTTP ' + error.status + ')'
                : 'You.com free tier denied the request (HTTP ' + error.status + ')'
        );
    }
    if (error.status === 402) {
        return new Error(
            keyed
                ? 'You.com account is out of credits (HTTP 402)'
                : 'You.com free daily quota is used up; add an API key (HTTP 402)'
        );
    }
    if (error.status === 429) {
        return new Error('You.com rate limit reached (HTTP 429)');
    }
    return error;
}

/** 429 且 `Retry-After` 不超过上限时重试一次。 */
export async function runWithYoucomRetry<T>(
    operation: () => Promise<T>,
    sleep: (ms: number) => Promise<void> = defaultSleep
): Promise<T> {
    try {
        return await operation();
    } catch (error) {
        if (
            error instanceof WebSearchHttpError &&
            error.status === 429 &&
            error.retryAfterMs !== undefined &&
            error.retryAfterMs <= YOUCOM_MAX_RETRY_AFTER_MS
        ) {
            await sleep(error.retryAfterMs);
            return await operation();
        }
        throw error;
    }
}

/** 响应形如 `{ results: { web: [{ url, title, description, snippets }] } }`。 */
function readWebItems(payload: unknown): unknown[] {
    if (!payload || typeof payload !== 'object') {
        return [];
    }
    const results = (payload as { results?: unknown }).results;
    if (!results || typeof results !== 'object') {
        return [];
    }
    const web = (results as { web?: unknown }).web;
    return Array.isArray(web) ? web : [];
}

/** description 为空时退回到 snippets 拼接。 */
function withSnippetFallback(item: unknown): unknown {
    if (!item || typeof item !== 'object') {
        return item;
    }
    const record = item as Record<string, unknown>;
    if (typeof record.description === 'string' && record.description.trim()) {
        return record;
    }
    const snippets = Array.isArray(record.snippets)
        ? record.snippets.filter((value): value is string => typeof value === 'string')
        : [];
    return snippets.length > 0 ? { ...record, description: snippets.join(' ') } : record;
}

/**
 * You.com 无 key 时走免费档（GET），配置 key 后走 `X-API-Key` 正式接口（POST）。
 * 非 2xx（401 / 402 / 403 / 429 及 `Retry-After`）由 `fetchJson` 统一转成 `WebSearchHttpError`。
 */
export const youcomAdapter = createSearchProviderAdapter({
    id: 'youcom',
    async search({ request, settings, signal, fetchJson }) {
        const apiKey = settings.providers.youcom.apiKey.trim();
        const query =
            request.domains.length > 0
                ? `${request.query} ${request.domains.map((domain) => `site:${domain}`).join(' OR ')}`
                : request.query;
        const count = resultLimit(request);

        const sendRequest = (): Promise<unknown> => {
            if (apiKey) {
                return fetchJson(new URL(YOUCOM_KEYED_URL), signal, {
                    method: 'POST',
                    headers: {
                        'X-API-Key': apiKey,
                        'Content-Type': 'application/json',
                        'User-Agent': YOUCOM_USER_AGENT,
                    },
                    body: JSON.stringify({ query, count }),
                });
            }
            const url = new URL(YOUCOM_FREE_URL);
            url.searchParams.set('query', query);
            url.searchParams.set('count', String(count));
            return fetchJson(url, signal, {
                method: 'GET',
                headers: { 'User-Agent': YOUCOM_USER_AGENT },
            });
        };

        let payload: unknown;
        try {
            payload = await runWithYoucomRetry(sendRequest);
        } catch (error) {
            throw describeYoucomFailure(error, Boolean(apiKey));
        }

        return readWebItems(payload)
            .map((item) => resultFromGenericItem(withSnippetFallback(item), 'You.com'))
            .filter((result): result is WebSearchResult => Boolean(result));
    },
});
