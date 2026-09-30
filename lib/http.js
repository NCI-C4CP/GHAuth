const { logRequest } = require('./logging');
const { extractRateLimit, isRateLimitError, sendRateLimitError } = require('./rateLimit');

const setHeaders = (res) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers','Accept,Content-Type,Content-Length,Accept-Encoding,X-CSRF-Token,Authorization');
    res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
};

/**
 * Extracts the bearer token, or null when the header is missing or malformed.
 */
const extractToken = (req) => {
    const header = req.headers?.authorization;
    if (typeof header !== 'string') return null;

    const token = header.replace(/^Bearer/i, '').trim();
    return token || null;
};

/**
 * Returns the names of any required values missing from source.
 */
const missingParams = (source, names) => names.filter(name => !source?.[name]);

const sendMissingParams = (res, api, startedAt, missing) => {
    logRequest({ api, status: 400, startedAt, error: `Missing: ${missing.join(', ')}` });
    return res.status(400).json({
        error: 'Bad Request',
        message: `Missing required parameter(s): ${missing.join(', ')}`
    });
};

const sendUnauthorized = (res, api, startedAt) => {
    logRequest({ api, status: 401, startedAt, error: 'Missing or malformed Authorization header' });
    return res.status(401).json({
        error: 'Unauthorized',
        message: 'A Bearer token is required in the Authorization header'
    });
};

/**
 * Terminal error handler. Keeps rate limits distinguishable from permission errors.
 */
const sendError = (res, api, startedAt, error) => {
    if (isRateLimitError(error)) {
        logRequest({ api, status: 429, startedAt, rateLimit: extractRateLimit(error.response), error: 'Rate limit exceeded' });
        return sendRateLimitError(res, error);
    }

    console.error(`Error in ${api}:`, error);

    // Raised by our own validation, so the message is ours to show
    if (error?.status === 400) {
        logRequest({ api, status: 400, startedAt, error: error.message });
        return res.status(400).json({ error: 'Bad Request', message: error.message });
    }

    if (error?.status === 401) {
        logRequest({ api, status: 401, startedAt, error: error.message });
        return res.status(401).json({
            error: 'Unauthorized',
            message: 'Your GitHub token is invalid or has expired. Please log in again.'
        });
    }

    if (error?.status === 403) {
        logRequest({ api, status: 403, startedAt, error: error.message });
        return res.status(403).json({
            error: 'Permission denied',
            message: 'You do not have access to this repository or path'
        });
    }

    if (error?.status === 404) {
        logRequest({ api, status: 404, startedAt, error: error.message });
        return res.status(404).json({ error: 'Not Found', message: 'The requested resource does not exist' });
    }

    if (error?.status === 409) {
        logRequest({ api, status: 409, startedAt, error: error.message, conflicts: error.conflicts?.length });

        // Precondition failures carry our own message naming the paths; GitHub's 409s do not
        if (error.conflicts) {
            return res.status(409).json({ error: 'Conflict', message: error.message, conflicts: error.conflicts });
        }

        return res.status(409).json({
            error: 'Conflict',
            message: 'The file changed while this request was in flight. Refresh and try again.'
        });
    }

    if (error?.status === 422) {
        logRequest({ api, status: 422, startedAt, error: error.message });
        return res.status(422).json({ error: 'Unprocessable Entity', message: 'GitHub rejected the request as invalid' });
    }

    logRequest({ api, status: 500, startedAt, error: error?.message });
    return res.status(500).json({ error: 'Internal Server Error' });
};

module.exports = {
    setHeaders,
    extractToken,
    missingParams,
    sendMissingParams,
    sendUnauthorized,
    sendError
};
