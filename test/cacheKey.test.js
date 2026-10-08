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
        request: async (route, options) => {
            if (route === 'GET /repos/{owner}/{repo}/git/ref/{ref}') {
                return { status: 200, headers: {}, data: { object: { sha: head.commit } } };
            }

            if (route === 'GET /repos/{owner}/{repo}/git/commits/{commit_sha}') {
                return { status: 200, headers: {}, data: { tree: { sha: head.tree } } };
            }

            if (route === 'POST /repos/{owner}/{repo}/git/trees') {
                return { status: 201, headers: {}, data: { sha: 'tree-2' } };
            }

            if (route === 'POST /repos/{owner}/{repo}/git/commits') {
                return { status: 201, headers: {}, data: { sha: 'commit-2' } };
            }

            if (route === 'PATCH /repos/{owner}/{repo}/git/refs/{ref}') {
                head.commit = options.sha;
                head.tree = 'tree-2';
                return { status: 200, headers: {}, data: {} };
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

// Every write goes through commitFiles, so this covers adds, edits, deletes and imports
const WRITES = [
    { label: 'a file write', body: { files: [{ path: 'a.json', content: '{}' }] } },
    { label: 'a deletion', body: { deletions: ['a.json'] } }
];

for (const { label, body } of WRITES) {
    test(`commitFiles reports the same SHA getTree reports after ${label}`, async () => {
        client = fakeGitHub();

        const res = await call({ method: 'POST', api: 'commitFiles', body: { ...REPO, branch: 'main', message: 'm', ...body } });
        assert.strictEqual(res.statusCode, 200);

        assert.ok(res.body.commitSha, 'commitFiles must return a commitSha for the client cache');
        assert.notStrictEqual(res.body.commitSha, res.body.treeSha);
        assert.strictEqual(res.body.commitSha, await currentTreeSha());
    });
}

test('getTree reports the commit SHA, not the tree SHA', async () => {
    client = fakeGitHub();

    assert.strictEqual(await currentTreeSha(), 'commit-1');
});
