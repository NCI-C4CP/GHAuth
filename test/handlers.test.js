const test = require('node:test');
const assert = require('node:assert');

// Swapped in before ../index loads, because auth.js destructures createClient at require time.
const githubPath = require.resolve('../lib/github');
const realGithub = require('../lib/github');

let client = null;
require.cache[githubPath].exports = { ...realGithub, createClient: () => client };

const { ghauth } = require('../index');

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

const AUTH = { authorization: 'Bearer fake-token-not-sent-anywhere' };
const REPO = { owner: 'owner', repo: 'repo' };

const call = async ({ method = 'GET', api, query = {}, body = {} }) => {
    const res = mockRes();
    await ghauth({ method, query: { api, ...query }, body, headers: AUTH }, res);
    return res;
};

const commit = (body) => call({
    method: 'POST',
    api: 'commitFiles',
    body: { ...REPO, branch: 'main', message: 'm', ...body }
});

// A branch at commit-1 where only existing.json exists; counts every call that reaches GitHub
const fakeGitHub = () => {
    const calls = { read: 0, commit: 0, request: 0 };

    return {
        calls,
        graphql: async (query, variables) => {
            if (query.includes('createCommitOnBranch')) {
                calls.commit++;
                return { createCommitOnBranch: { commit: { oid: 'commit-2', tree: { oid: 'tree-2' } } } };
            }

            calls.read++;
            const target = { oid: 'commit-1', tree: { oid: 'tree-1' } };
            Object.entries(variables)
                .filter(([key, path]) => /^p\d+$/.test(key) && path === 'existing.json')
                .forEach(([key]) => { target[`f${key.slice(1)}`] = { oid: 'blob-1' }; });

            return { repository: { ref: { target } } };
        },
        request: async () => {
            calls.request++;
            throw new Error('Unexpected REST call');
        }
    };
};

test.describe('commitFiles responses the client depends on', () => {
    test('a failed precondition returns 409 listing each conflict, and writes nothing', async () => {
        client = fakeGitHub();

        const res = await commit({
            files: [{ path: 'existing.json', content: '{}' }],
            preconditions: { absent: ['existing.json'], present: ['gone.json'], head: 'commit-0' }
        });

        assert.strictEqual(res.statusCode, 409);
        assert.strictEqual(res.body.error, 'Conflict');
        assert.match(res.body.message, /existing\.json already exists/);
        assert.deepStrictEqual(res.body.conflicts, [
            { path: null, reason: 'moved' },
            { path: 'existing.json', reason: 'exists' },
            { path: 'gone.json', reason: 'missing' }
        ]);
        assert.strictEqual(client.calls.commit, 0);
    });

    test('a changed blob sha is reported as changed', async () => {
        client = fakeGitHub();

        const res = await commit({
            files: [{ path: 'existing.json', content: '{}' }],
            preconditions: { expected: { 'existing.json': 'blob-0' } }
        });

        assert.strictEqual(res.statusCode, 409);
        assert.deepStrictEqual(res.body.conflicts, [{ path: 'existing.json', reason: 'changed' }]);
        assert.strictEqual(client.calls.commit, 0);
    });

    const INVALID = [
        ['nothing to commit', {}, /Nothing to commit/],
        ['files that are not an array', { files: 'a.json' }, /must be arrays/],
        ['a file without content', { files: [{ path: 'a.json' }] }, /path: string, content: string/],
        ['preconditions that are not an object', { files: [{ path: 'a.json', content: '{}' }], preconditions: [] }, /must be an object/]
    ];

    for (const [label, body, message] of INVALID) {
        test(`${label} returns 400 with the reason, before calling GitHub`, async () => {
            client = fakeGitHub();

            const res = await commit(body);

            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(res.body.error, 'Bad Request');
            assert.match(res.body.message, message);
            assert.deepStrictEqual(client.calls, { read: 0, commit: 0, request: 0 });
        });
    }
});

test.describe('getTree on a repository with no commits', () => {
    test('GitHub\'s empty repository 409 becomes an empty listing', async () => {
        client = {
            request: async () => { throw Object.assign(new Error('Git Repository is empty.'), { status: 409 }); }
        };

        const res = await call({ api: 'getTree', query: { ...REPO, ref: 'main' } });

        assert.strictEqual(res.statusCode, 200);
        assert.deepStrictEqual(res.body, { data: [], sha: null, truncated: false, status: 200 });
    });

    test('other GitHub errors still surface', async () => {
        client = {
            request: async () => { throw Object.assign(new Error('Not Found'), { status: 404 }); }
        };

        const res = await call({ api: 'getTree', query: { ...REPO, ref: 'main' } });

        assert.strictEqual(res.statusCode, 404);
    });
});
