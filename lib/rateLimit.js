const extractRateLimit = (response, defaultLimit = 5000) => {
    const headers = response?.headers || {};
    const reset = parseInt(headers['x-ratelimit-reset']);

    return {
        limit: parseInt(headers['x-ratelimit-limit']) || defaultLimit,
        remaining: parseInt(headers['x-ratelimit-remaining']) || 0,
        used: parseInt(headers['x-ratelimit-used']) || 0,
        resource: headers['x-ratelimit-resource'] || 'core',
        reset: Number.isNaN(reset) ? null : new Date(reset * 1000),
        resetIn: Number.isNaN(reset) ? null : reset - Math.floor(Date.now() / 1000)
    };
};

/**
 * Same shape as extractRateLimit, from GraphQL's rateLimit field, which has no response headers
 */
const fromGraphqlRateLimit = (rateLimit) => {
    if (!rateLimit) return null;

    const reset = Math.floor(new Date(rateLimit.resetAt).getTime() / 1000);

    return {
        limit: rateLimit.limit,
        remaining: rateLimit.remaining,
        used: rateLimit.used,
        resource: 'graphql',
        reset: Number.isNaN(reset) ? null : new Date(reset * 1000),
        resetIn: Number.isNaN(reset) ? null : reset - Math.floor(Date.now() / 1000)
    };
};

/**
 * GitHub signals secondary rate limits with 403/429 plus retry-after or an exhausted budget,
 * which is indistinguishable from a permission error unless these headers are checked.
 */
const isRateLimitError = (error) => {
    if (error?.status !== 403 && error?.status !== 429) return false;

    const headers = error.response?.headers || {};
    return Boolean(headers['retry-after']) || headers['x-ratelimit-remaining'] === '0';
};

const sendRateLimitError = (res, error) => {
    const headers = error.response?.headers || {};
    const rateLimit = extractRateLimit(error.response);
    const retryAfter = parseInt(headers['retry-after']) || rateLimit.resetIn || 60;

    res.set('Retry-After', String(retryAfter));

    return res.status(429).json({
        error: 'Rate limit exceeded',
        message: `GitHub ${rateLimit.resource} rate limit reached. Retry in ${retryAfter} seconds.`,
        retryAfter,
        rateLimit
    });
};

module.exports = {
    extractRateLimit,
    fromGraphqlRateLimit,
    isRateLimitError,
    sendRateLimitError
};
