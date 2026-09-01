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

const call = async ({ method = 'GET', api, query = {}, body = {} }) => {
    const res = mockRes();
    await ghauth({ method, query: { api, ...query }, body, headers: AUTH }, res);
    return res;
};

const AUTH = { authorization: 'Bearer fake-token-not-sent-anywhere' };

/**
 * Models the single GitHub behaviour this contract rests on: the trees API given a branch
 * ref answers with the resolved commit SHA, while a write reports commit and tree SHAs
 * separately. Keying the client cache on the tree SHA therefore never matches.
 */
const fakeGitHub = () => {
    const head = { commit: 'commit-1', tree: 'tree-1' };

    return {
        request: async (route) => {
            if (route.endsWith('/contents/{path}') && !route.startsWith('GET')) {
                head.commit = 'commit-2';
                head.tree = 'tree-2';
                return { status: 200, headers: {}, data: { commit: { sha: head.commit, tree: { sha: head.tree } } } };
            }

            if (route === 'GET /repos/{owner}/{repo}/git/trees/{tree_sha}') {
                return { status: 200, headers: {}, data: { sha: head.commit, tree: [], truncated: false } };
            }

            throw new Error(`Unexpected route: ${route}`);
        }
    };
};

const REPO = { owner: 'owner', repo: 'repo' };

const currentTreeSha = async () => {
    const res = await call({ api: 'getTree', query: { ...REPO, ref: 'main' } });
    assert.strictEqual(res.statusCode, 200);
    return res.body.sha;
};

const WRITES = [
    { api: 'addFile',    body: { ...REPO, path: 'a.json', message: 'm', content: 'e30=' } },
    { api: 'updateFile', body: { ...REPO, path: 'a.json', message: 'm', content: 'e30=', sha: 'blob-sha' } },
    { api: 'deleteFile', body: { ...REPO, path: 'a.json', message: 'm', sha: 'blob-sha' } }
];

for (const { api, body } of WRITES) {
    test(`${api} reports the same SHA getTree reports afterwards`, async () => {
        client = fakeGitHub();

        const res = await call({ method: 'POST', api, body });
        assert.strictEqual(res.statusCode, 200);

        assert.ok(res.body.commitSha, `${api} must return a commitSha for the client cache`);
        assert.strictEqual(res.body.commitSha, await currentTreeSha());
    });
}

test('getTree reports the commit SHA, not the tree SHA', async () => {
    client = fakeGitHub();

    assert.strictEqual(await currentTreeSha(), 'commit-1');
});
