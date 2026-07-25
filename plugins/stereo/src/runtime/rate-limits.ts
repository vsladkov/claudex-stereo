import type { GetAccountRateLimitsResponse, RateLimitSnapshot } from '../protocol/app-server.ts';
import { withDirectAppServer } from './threads.ts';

export type AccountRateLimits = RateLimitSnapshot & {
  rateLimitsByLimitId?: GetAccountRateLimitsResponse['rateLimitsByLimitId'];
};

export async function getAccountRateLimits(cwd: string): Promise<AccountRateLimits | null> {
  try {
    return await withDirectAppServer(cwd, async (client) => {
      const response = await client.request('account/rateLimits/read', undefined);
      const snapshot = response?.rateLimits as unknown;
      if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        return null;
      }
      const byLimitId = response.rateLimitsByLimitId as unknown;
      if (byLimitId != null && (typeof byLimitId !== 'object' || Array.isArray(byLimitId))) {
        return null;
      }
      return {
        ...(snapshot as RateLimitSnapshot),
        ...(byLimitId
          ? {
              rateLimitsByLimitId: byLimitId as GetAccountRateLimitsResponse['rateLimitsByLimitId'],
            }
          : {}),
      };
    });
  } catch {
    // Quota visibility is advisory. Unsupported methods, offline runtimes,
    // malformed responses, and authentication failures must never break setup.
    return null;
  }
}
