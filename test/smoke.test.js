const test = require('node:test');
const assert = require('node:assert');

const { ghauth } = require('../index');
const { extractToken, missingParams, sendError } = require('../lib/http');
const { extractRateLimit, isRateLimitError } = require('../lib/rateLimit');
const { toBase64 } = require('../lib/github');
const { generateConceptID } = require('../domain/conceptId');

// Handlers log a structured line per request; silence it so failures stand out.
const realLog = console.log;
const realError = console.error;
test.before(() => { console.log = () => {}; console.error = () => {}; });
test.after(() => { console.log = realLog; console.error = realError; });

const mockRes = () => {
    const res = { statusCode: null, body: null, headers: {} };
    res.header = (key, value) => { res.headers[key] = value; return res; };
    res.set = (key, value) => { res.headers[key] = value; return res; };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (payload) => { res.body = payload; return res; };
    res.send = (payload) => { res.body = payload; return res; };
    return res;
};

const mockReq = ({ method = 'GET', api, query = {}, body = {}, headers = {} } = {}) => ({
    method,
    query: { api, ...query },
    body,
    headers
});

const call = async (options) => {
    const res = mockRes();
    await ghauth(mockReq(options), res);
    return res;
};

const AUTH = { authorization: 'Bearer fake-token-not-sent-anywhere' };

// method: the verb each endpoint accepts. requires: params validated before any GitHub call.
const ENDPOINTS = [
    { api: 'accessToken',         method: 'POST', auth: false, requires: ['code', 'redirect'],                        in: 'body' },
    { api: 'getUser',             method: 'GET',  auth: true,  requires: [] },
    { api: 'addFile',             method: 'POST', auth: true,  requires: ['owner', 'repo', 'path', 'message', 'content'],        in: 'body' },
    { api: 'updateFile',          method: 'POST', auth: true,  requires: ['owner', 'repo', 'path', 'message', 'content', 'sha'], in: 'body' },
    { api: 'getRepo',             method: 'GET',  auth: true,  requires: ['owner', 'repo'],                           in: 'query' },
    { api: 'searchFiles',         method: 'GET',  auth: true,  requires: ['owner', 'repo', 'query'],                  in: 'query' },
    { api: 'getUserRepositories', method: 'GET',  auth: true,  requires: [] },
    { api: 'getFiles',            method: 'GET',  auth: true,  requires: ['owner', 'repo', 'path'],                   in: 'query' },
    { api: 'deleteFile',          method: 'POST', auth: true,  requires: ['owner', 'repo', 'path', 'message', 'sha'], in: 'body' },
    { api: 'getConcept',          method: 'GET',  auth: true,  requires: ['owner', 'repo'],                            in: 'query' },
    { api: 'getConfig',           method: 'GET',  auth: true,  requires: ['owner', 'repo', 'path'],                   in: 'query' },
    { api: 'getTree',             method: 'GET',  auth: true,  requires: ['owner', 'repo', 'ref'],                    in: 'query' },
    { api: 'getFileContent',      method: 'GET',  auth: true,  requires: ['owner', 'repo', 'path'],                   in: 'query' },
    { api: 'commitFiles',         method: 'POST', auth: true,  requires: ['owner', 'repo', 'branch', 'message'],      in: 'body' }
];

test('OPTIONS preflight returns 200 with CORS headers', async () => {
    const res = await call({ method: 'OPTIONS', api: 'getUser' });

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['Access-Control-Allow-Origin'], '*');
    assert.match(res.headers['Access-Control-Allow-Headers'], /Authorization/);
});

test('unknown endpoint returns 400 and lists supported endpoints', async () => {
    const res = await call({ api: 'notARealEndpoint' });

    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'Invalid API endpoint');
    assert.deepStrictEqual(res.body.supportedEndpoints, ENDPOINTS.map(e => e.api));
});

test('missing api parameter returns 400 rather than falling through', async () => {
    const res = await call({});
    assert.strictEqual(res.statusCode, 400);
});

test('rebuildIndex is gone and rejected as unknown', async () => {
    const res = await call({ api: 'rebuildIndex' });

    assert.strictEqual(res.statusCode, 400);
    assert.ok(!res.body.supportedEndpoints.includes('rebuildIndex'));
});

test.describe('every endpoint guards auth, method, and params before calling GitHub', () => {
    for (const endpoint of ENDPOINTS) {
        const { api, method, auth, requires, in: location } = endpoint;

        if (auth) {
            test(`${api}: no Authorization header returns 401, not 500`, async () => {
                const res = await call({ api, method });

                assert.strictEqual(res.statusCode, 401, `${api} returned ${res.statusCode}`);
                assert.strictEqual(res.body.error, 'Unauthorized');
            });

            test(`${api}: malformed Authorization header returns 401`, async () => {
                const res = await call({ api, method, headers: { authorization: 'Bearer' } });
                assert.strictEqual(res.statusCode, 401);
            });
        }

        test(`${api}: wrong HTTP method returns 405`, async () => {
            const wrongMethod = method === 'GET' ? 'POST' : 'GET';
            const res = await call({ api, method: wrongMethod, headers: AUTH });

            assert.strictEqual(res.statusCode, 405, `${api} returned ${res.statusCode}`);
        });

        if (requires.length) {
            test(`${api}: missing required params returns 400 naming them`, async () => {
                const res = await call({ api, method, headers: AUTH });

                assert.strictEqual(res.statusCode, 400, `${api} returned ${res.statusCode}`);
                for (const name of requires) {
                    assert.match(res.body.message, new RegExp(name), `${api} did not report '${name}'`);
                }
            });

            test(`${api}: rejects params present but empty`, async () => {
                const blank = Object.fromEntries(requires.map(name => [name, '']));
                const res = await call({ api, method, headers: AUTH, [location]: blank });

                assert.strictEqual(res.statusCode, 400);
            });
        }
    }
});

test.describe('extractToken', () => {
    const cases = [
        [{}, null, 'no headers'],
        [{ authorization: '' }, null, 'empty header'],
        [{ authorization: 'Bearer' }, null, 'scheme with no token'],
        [{ authorization: 'Bearer   ' }, null, 'scheme with whitespace only'],
        [{ authorization: 'Bearer abc123' }, 'abc123', 'standard header'],
        [{ authorization: 'bearer abc123' }, 'abc123', 'lowercase scheme'],
        [{ authorization: 'abc123' }, 'abc123', 'bare token']
    ];

    for (const [headers, expected, label] of cases) {
        test(label, () => {
            assert.strictEqual(extractToken({ headers }), expected);
        });
    }

    test('undefined request does not throw', () => {
        assert.strictEqual(extractToken({}), null);
    });
});

test.describe('missingParams', () => {
    test('reports absent and empty values, ignores present ones', () => {
        const source = { owner: 'me', repo: '', path: undefined };
        assert.deepStrictEqual(missingParams(source, ['owner', 'repo', 'path']), ['repo', 'path']);
    });

    test('treats a missing source as everything missing', () => {
        assert.deepStrictEqual(missingParams(undefined, ['owner']), ['owner']);
    });
});

test.describe('rate limit detection', () => {
    const rateLimited = (status, headers) => ({ status, response: { headers } });

    test('403 with retry-after is a rate limit', () => {
        assert.strictEqual(isRateLimitError(rateLimited(403, { 'retry-after': '60' })), true);
    });

    test('403 with an exhausted budget is a rate limit', () => {
        assert.strictEqual(isRateLimitError(rateLimited(403, { 'x-ratelimit-remaining': '0' })), true);
    });

    test('403 with budget remaining is a permission error, not a rate limit', () => {
        assert.strictEqual(isRateLimitError(rateLimited(403, { 'x-ratelimit-remaining': '4999' })), false);
    });

    test('429 is a rate limit', () => {
        assert.strictEqual(isRateLimitError(rateLimited(429, { 'retry-after': '30' })), true);
    });

    test('404 is never a rate limit', () => {
        assert.strictEqual(isRateLimitError(rateLimited(404, {})), false);
    });

    test('a non-HTTP error does not throw', () => {
        assert.strictEqual(isRateLimitError(new Error('socket hang up')), false);
    });
});

test.describe('sendError status mapping', () => {
    const map = async (error) => {
        const res = mockRes();
        sendError(res, 'test', Date.now(), error);
        return res;
    };

    test('a rate limited 403 surfaces as 429 saying rate limit, not permissions', async () => {
        const res = await map({ status: 403, response: { headers: { 'retry-after': '42' } } });

        assert.strictEqual(res.statusCode, 429);
        assert.match(res.body.message, /rate limit/i);
        assert.strictEqual(res.body.retryAfter, 42);
        assert.strictEqual(res.headers['Retry-After'], '42');
    });

    test('a genuine 403 surfaces as a permission error', async () => {
        const res = await map({ status: 403, response: { headers: { 'x-ratelimit-remaining': '4999' } } });

        assert.strictEqual(res.statusCode, 403);
        assert.match(res.body.error, /Permission/);
    });

    // An expired token used to fall through to 500, so the client could not tell the
    // user to log in again and validateToken reported the dead token as still valid.
    test('a 401 from GitHub surfaces as 401, not a generic server error', async () => {
        const res = await map({ status: 401, message: 'Bad credentials' });

        assert.strictEqual(res.statusCode, 401);
        assert.strictEqual(res.body.error, 'Unauthorized');
        assert.match(res.body.message, /log in again/i);
    });

    test('409 explains the conflict is a concurrent edit', async () => {
        const res = await map({ status: 409 });

        assert.strictEqual(res.statusCode, 409);
        assert.match(res.body.message, /changed while/i);
    });

    for (const status of [404, 422]) {
        test(`${status} passes through`, async () => {
            assert.strictEqual((await map({ status })).statusCode, status);
        });
    }

    test('an unrecognised error becomes 500 without leaking internals', async () => {
        const res = await map(new Error('connect ECONNREFUSED 10.0.0.1:443'));

        assert.strictEqual(res.statusCode, 500);
        assert.deepStrictEqual(res.body, { error: 'Internal Server Error' });
    });
});

test.describe('extractRateLimit', () => {
    test('reads GitHub headers including resource', () => {
        const reset = Math.floor(Date.now() / 1000) + 600;
        const limit = extractRateLimit({
            headers: {
                'x-ratelimit-limit': '5000',
                'x-ratelimit-remaining': '4321',
                'x-ratelimit-used': '679',
                'x-ratelimit-resource': 'core',
                'x-ratelimit-reset': String(reset)
            }
        });

        assert.strictEqual(limit.limit, 5000);
        assert.strictEqual(limit.remaining, 4321);
        assert.strictEqual(limit.used, 679);
        assert.strictEqual(limit.resource, 'core');
        assert.ok(limit.resetIn > 0 && limit.resetIn <= 600);
    });

    test('falls back cleanly when headers are absent', () => {
        const limit = extractRateLimit(undefined, 30);

        assert.strictEqual(limit.limit, 30);
        assert.strictEqual(limit.reset, null);
        assert.strictEqual(limit.resetIn, null);
    });
});

test.describe('helpers', () => {
    test('toBase64 round-trips non-ASCII content', () => {
        const original = 'café — “smart quotes” • 日本語';
        const decoded = Buffer.from(toBase64(original), 'base64').toString('utf-8');

        assert.strictEqual(decoded, original);
    });

    test('generateConceptID stays in the 9 digit range', () => {
        for (let i = 0; i < 1000; i++) {
            const id = generateConceptID();
            assert.ok(id >= 100000000 && id < 1000000000, `out of range: ${id}`);
            assert.strictEqual(Number.isInteger(id), true);
        }
    });
});
