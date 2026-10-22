const test = require('node:test');
const assert = require('node:assert');

const { commitFiles, blobSha, MAX_ENTRIES_PER_COMMIT, WRITES_PER_COMMIT } = require('../domain/gitData');

const conflict = () => Object.assign(new Error('Reference already exists'), { status: 422 });
const stale = () => Object.assign(new Error('Expected branch to point to "commit-base" but it did not.'), {
    errors: [{ type: 'STALE_DATA', path: ['createCommitOnBranch'], message: 'Expected branch to point to "commit-base" but it did not.' }]
});

/**
 * Stand-in for octokit. GraphQL reads answer from `head` and `baseTree` the way GitHub does,
 * including a NOT_FOUND per missing path; tests may mutate both mid-run. Every call is recorded.
 */
const fakeGit = ({ head = { commitSha: 'commit-base', treeSha: 'tree-base' }, baseTree = [], overrides = {} } = {}) => {
    const calls = [];

    const handlers = {
        read: ({ variables }) => {
            const rateLimit = { limit: 5000, remaining: 4999, used: 1, resetAt: '2030-01-01T00:00:00Z' };
            if (!head.commitSha) return { rateLimit, repository: { ref: null } };

            const target = { oid: head.commitSha, tree: { oid: head.treeSha } };
            const errors = [];

            for (const [name, path] of Object.entries(variables)) {
                if (!/^p\d+$/.test(name)) continue;

                const alias = `f${name.slice(1)}`;
                const entry = baseTree.find(([candidate]) => candidate === path);

                target[alias] = entry ? { oid: entry[1] } : null;
                if (!entry) errors.push({ type: 'NOT_FOUND', path: ['repository', 'ref', 'target', alias], message: `Could not resolve file for path '${path}'.` });
            }

            const data = { rateLimit, repository: { ref: { target } } };
            if (errors.length > 0) throw Object.assign(new Error('Request failed due to following response errors'), { errors, data });
            return data;
        },
        commit: () => ({ createCommitOnBranch: { commit: { oid: 'commit-new', tree: { oid: 'tree-new' } } } }),
        'GET /repos/{owner}/{repo}/git/trees/{tree_sha}': () => ({
            data: { tree: baseTree.map(([path, sha]) => ({ path, sha, type: 'blob' })), truncated: false }
        }),
        'POST /repos/{owner}/{repo}/git/trees': () => ({ data: { sha: 'tree-new' } }),
        'POST /repos/{owner}/{repo}/git/commits': () => ({ data: { sha: 'commit-new' } }),
        'POST /repos/{owner}/{repo}/git/refs': () => ({ data: { ref: 'refs/heads/main' } }),
        ...overrides
    };

    const call = async (route, options) => {
        calls.push({ route, options });

        const handler = handlers[route];
        if (!handler) throw new Error(`Unexpected route: ${route}`);

        return handler(options, calls);
    };

    return {
        calls,
        callsTo: (route) => calls.filter(entry => entry.route === route),
        restCalls: () => calls.filter(entry => entry.route !== 'read' && entry.route !== 'commit'),
        request: (route, options) => call(route, options),
        graphql: (query, variables) => call(query.includes('createCommitOnBranch') ? 'commit' : 'read', { query, variables })
    };
};

const commit = (octokit, overrides = {}) => commitFiles({
    octokit,
    owner: 'o',
    repo: 'r',
    branch: 'main',
    message: 'test commit',
    files: [{ path: '123456789.json', content: JSON.stringify({ conceptID: 123456789, key: 'alpha', object_type: 'QUESTION' }) }],
    ...overrides
});

test('commitFiles rejects a non-array files argument', async () => {
    await assert.rejects(
        () => commit(fakeGit(), { files: 'nope' }),
        error => error.status === 400
    );
});

test('commitFiles rejects an empty batch', async () => {
    await assert.rejects(
        () => commit(fakeGit(), { files: [], deletions: [] }),
        error => error.status === 400 && /Nothing to commit/.test(error.message)
    );
});

test('commitFiles rejects a batch above the entry ceiling', async () => {
    const files = Array.from({ length: MAX_ENTRIES_PER_COMMIT + 1 }, (_, i) => ({
        path: `${i}.json`,
        content: '{}'
    }));

    await assert.rejects(
        () => commit(fakeGit(), { files }),
        error => error.status === 400 && /at most/.test(error.message)
    );
});

test('commitFiles rejects a malformed file entry', async () => {
    await assert.rejects(
        () => commit(fakeGit(), { files: [{ path: 'a.json', content: { not: 'a string' } }] }),
        error => error.status === 400 && /path: string, content: string/.test(error.message)
    );
});

test('commitFiles returns the new commit and the write cost', async () => {
    const octokit = fakeGit();
    const result = await commit(octokit);

    assert.strictEqual(result.commitSha, 'commit-new');
    assert.strictEqual(result.treeSha, 'tree-new');
    assert.strictEqual(result.committed, 1);
    assert.strictEqual(result.deleted, 0);
    assert.strictEqual(result.writes, WRITES_PER_COMMIT);
});

test('commitFiles times each GitHub step so slow saves can be attributed', async () => {
    const result = await commit(fakeGit({ baseTree: [] }), { preconditions: { absent: ['123456789.json'] } });

    assert.deepStrictEqual(Object.keys(result.timings).sort(), ['check', 'read', 'write']);
    assert.ok(Object.values(result.timings).every(ms => Number.isInteger(ms) && ms >= 0));
    assert.strictEqual(result.attempts, 1);
});

test('commitFiles reports the GraphQL rate limit in the shape the client reads', async () => {
    const { rateLimit } = await commit(fakeGit());

    assert.strictEqual(rateLimit.resource, 'graphql');
    assert.strictEqual(rateLimit.limit, 5000);
    assert.strictEqual(rateLimit.remaining, 4999);
    assert.ok(rateLimit.reset instanceof Date);
});

test('commitFiles saves with one GraphQL read, one GraphQL write and no REST calls', async () => {
    const octokit = fakeGit({ baseTree: [['123456789.json', 'blob-1']] });

    await commit(octokit, { preconditions: { expected: { '123456789.json': 'blob-1' } } });

    assert.strictEqual(octokit.callsTo('read').length, 1);
    assert.strictEqual(octokit.callsTo('commit').length, 1);
    assert.deepStrictEqual(octokit.restCalls(), []);
});

const commitInput = (octokit, n = 0) => octokit.callsTo('commit')[n].options.variables.input;

const lookedUp = (octokit, n = 0) => Object.entries(octokit.callsTo('read')[n].options.variables)
    .filter(([name]) => /^p\d+$/.test(name))
    .map(([, path]) => path);

test('commitFiles commits only the given files, as base64, on top of the head it read', async () => {
    const octokit = fakeGit();
    await commit(octokit, { files: [{ path: '123456789.json', content: '{"key":"café"}' }] });

    const input = commitInput(octokit);

    assert.strictEqual(input.expectedHeadOid, 'commit-base');
    assert.deepStrictEqual(input.branch, { repositoryNameWithOwner: 'o/r', branchName: 'main' });
    assert.deepStrictEqual(input.fileChanges.additions.map(addition => addition.path), ['123456789.json']);
    assert.strictEqual(Buffer.from(input.fileChanges.additions[0].contents, 'base64').toString('utf8'), '{"key":"café"}');
});

test('commitFiles splits the message into a headline and body', async () => {
    const octokit = fakeGit();
    await commit(octokit, { message: 'Edit concept "alpha"\n\nChanged the description' });

    assert.deepStrictEqual(commitInput(octokit).message, { headline: 'Edit concept "alpha"', body: 'Changed the description' });
});

test('commitFiles skips a caller-supplied index.json so a stale copy is not rewritten', async () => {
    const octokit = fakeGit();

    await commit(octokit, {
        files: [
            { path: '1.json', content: JSON.stringify({ key: 'a', object_type: 'QUESTION' }) },
            { path: 'index.json', content: '{"_files":{"stale":{}}}' }
        ]
    });

    assert.deepStrictEqual(commitInput(octokit).fileChanges.additions.map(addition => addition.path), ['1.json']);
});

test('commitFiles sends deletions as paths', async () => {
    const octokit = fakeGit();

    const result = await commit(octokit, { files: [], deletions: ['1.json'] });

    assert.deepStrictEqual(commitInput(octokit).fileChanges, { additions: [], deletions: [{ path: '1.json' }] });
    assert.strictEqual(result.deleted, 1);
});

test('commitFiles commits a file that is not valid JSON without inspecting it', async () => {
    const octokit = fakeGit();
    await commit(octokit, { files: [{ path: 'broken.json', content: 'not json' }] });

    assert.deepStrictEqual(commitInput(octokit).fileChanges.additions.map(addition => addition.path), ['broken.json']);
});

test('commitFiles builds the first commit of an empty repository over REST', async () => {
    // createCommitOnBranch needs a branch to exist
    const octokit = fakeGit({ head: { commitSha: null, treeSha: null } });

    const result = await commit(octokit);

    assert.strictEqual(result.commitSha, 'commit-new');
    assert.strictEqual(result.writes, 3);
    assert.strictEqual(octokit.callsTo('commit').length, 0);
    assert.strictEqual(octokit.callsTo('POST /repos/{owner}/{repo}/git/refs').length, 1);

    const [commitCall] = octokit.callsTo('POST /repos/{owner}/{repo}/git/commits');
    assert.deepStrictEqual(commitCall.options.parents, []);

    const [treeCall] = octokit.callsTo('POST /repos/{owner}/{repo}/git/trees');
    assert.strictEqual(treeCall.options.base_tree, undefined);
});

test('commitFiles retries when another editor makes the first commit at the same time', async () => {
    const head = { commitSha: null, treeSha: null };

    const octokit = fakeGit({
        head,
        overrides: {
            'POST /repos/{owner}/{repo}/git/refs': () => {
                Object.assign(head, { commitSha: 'commit-theirs', treeSha: 'tree-theirs' });
                throw conflict();
            }
        }
    });

    const result = await commit(octokit);

    assert.strictEqual(result.attempts, 2);
    assert.strictEqual(commitInput(octokit).expectedHeadOid, 'commit-theirs');
});

test('commitFiles retries when the branch moves and succeeds on a later attempt', async () => {
    const head = { commitSha: 'commit-base', treeSha: 'tree-base' };
    let writes = 0;

    const octokit = fakeGit({
        head,
        overrides: {
            commit: () => {
                writes += 1;

                if (writes === 1) {
                    head.commitSha = 'commit-theirs';
                    throw stale();
                }

                return { createCommitOnBranch: { commit: { oid: 'commit-new', tree: { oid: 'tree-new' } } } };
            }
        }
    });

    const result = await commit(octokit);

    assert.strictEqual(result.commitSha, 'commit-new');
    assert.strictEqual(result.attempts, 2);
    // Each attempt re-reads the branch head, since a competing commit moved it
    assert.strictEqual(octokit.callsTo('read').length, 2);
    assert.deepStrictEqual(
        octokit.callsTo('commit').map(entry => entry.options.variables.input.expectedHeadOid),
        ['commit-base', 'commit-theirs']
    );
});

test('commitFiles gives up with a 409 when the branch keeps moving', async () => {
    const octokit = fakeGit({ overrides: { commit: () => { throw stale(); } } });

    await assert.rejects(
        () => commit(octokit),
        error => error.status === 409 && /branch moved/.test(error.message)
    );

    assert.strictEqual(octokit.callsTo('commit').length, 3);
});

test('commitFiles propagates a write failure that is not a conflict', async () => {
    const octokit = fakeGit({
        overrides: {
            commit: () => { throw Object.assign(new Error('Server Error'), { status: 500 }); }
        }
    });

    await assert.rejects(() => commit(octokit), error => error.status === 500);
    assert.strictEqual(octokit.callsTo('commit').length, 1);
});

test('commitFiles gives GraphQL errors the HTTP status the API layer reports', async () => {
    const graphqlError = (type) => Object.assign(new Error(type), { errors: [{ type, message: `${type} message` }] });

    const forbidden = fakeGit({ overrides: { commit: () => { throw graphqlError('FORBIDDEN'); } } });
    await assert.rejects(() => commit(forbidden), error => error.status === 403 && error.message === 'FORBIDDEN message');

    // A missing repository is not a missing path, so it must not read as "absent"
    const noRepo = fakeGit({
        overrides: {
            read: () => {
                throw Object.assign(new Error('Could not resolve to a Repository'), {
                    errors: [{ type: 'NOT_FOUND', path: ['repository'], message: 'Could not resolve to a Repository' }],
                    data: { repository: null }
                });
            }
        }
    });

    await assert.rejects(() => commit(noRepo, { preconditions: { absent: ['a.json'] } }), error => error.status === 404);
    assert.strictEqual(noRepo.callsTo('commit').length, 0);
});

test('blobSha matches git hash-object, counting bytes rather than characters', () => {
    // printf '{"key":"café"}\n' | git hash-object --stdin
    assert.strictEqual(blobSha('{"key":"café"}\n'), '12ea9265091769d0bc05cbe8b89c9352efee3849');
});

test('commitFiles returns the blob sha and size of each written file', async () => {
    const content = '{"key":"café"}\n';
    const result = await commit(fakeGit(), { files: [{ path: 'a.json', content }] });

    assert.deepStrictEqual(result.files, [
        { path: 'a.json', sha: '12ea9265091769d0bc05cbe8b89c9352efee3849', size: 16 }
    ]);
});

test('commitFiles looks up no paths when there are no preconditions', async () => {
    const octokit = fakeGit();
    await commit(octokit);

    assert.deepStrictEqual(lookedUp(octokit), []);
    assert.deepStrictEqual(octokit.restCalls(), []);
});

test('commitFiles commits when every precondition holds', async () => {
    const octokit = fakeGit({ baseTree: [['edited.json', 'blob-1'], ['target.json', 'blob-2']] });

    const result = await commit(octokit, {
        files: [
            { path: 'edited.json', content: '{}' },
            { path: 'new.json', content: '{}' }
        ],
        preconditions: {
            absent: ['new.json'],
            present: ['target.json'],
            expected: { 'edited.json': 'blob-1' }
        }
    });

    assert.strictEqual(result.commitSha, 'commit-new');
    assert.deepStrictEqual(lookedUp(octokit).sort(), ['edited.json', 'new.json', 'target.json']);
    assert.deepStrictEqual(octokit.restCalls(), []);
});

test('commitFiles rejects each kind of failed precondition without writing anything', async () => {
    const octokit = fakeGit({ baseTree: [['taken.json', 'blob-1'], ['edited.json', 'blob-theirs']] });

    await assert.rejects(
        () => commit(octokit, {
            preconditions: {
                absent: ['taken.json'],
                present: ['deleted.json'],
                expected: { 'edited.json': 'blob-mine', 'gone.json': 'blob-old' }
            }
        }),
        error => {
            assert.strictEqual(error.status, 409);
            assert.deepStrictEqual(error.conflicts, [
                { path: 'taken.json', reason: 'exists' },
                { path: 'deleted.json', reason: 'missing' },
                { path: 'edited.json', reason: 'changed' },
                { path: 'gone.json', reason: 'missing' }
            ]);
            assert.match(error.message, /deleted\.json no longer exists/);
            return true;
        }
    );

    assert.strictEqual(octokit.callsTo('commit').length, 0);
});

test('commitFiles re-checks preconditions after the branch moves', async () => {
    // Editor A's delete lands between our check and our write
    const head = { commitSha: 'commit-base', treeSha: 'tree-base' };
    const baseTree = [['primary.json', 'blob-p']];

    const octokit = fakeGit({
        head,
        baseTree,
        overrides: {
            commit: () => {
                head.commitSha = 'commit-theirs';
                baseTree.length = 0;
                throw stale();
            }
        }
    });

    await assert.rejects(
        () => commit(octokit, { preconditions: { present: ['primary.json'] } }),
        error => error.status === 409 && error.conflicts?.[0]?.reason === 'missing'
    );

    assert.strictEqual(octokit.callsTo('commit').length, 1);
    assert.strictEqual(octokit.callsTo('read').length, 2);
});

const manyPaths = (count) => Array.from({ length: count }, (_, i) => `${i}.json`);

test('commitFiles checks more than 100 paths against the whole tree instead of one lookup each', async () => {
    const octokit = fakeGit({ baseTree: [['5.json', 'blob-5']] });

    await assert.rejects(
        () => commit(octokit, { preconditions: { absent: manyPaths(101) } }),
        error => error.status === 409 && error.conflicts.length === 1 && error.conflicts[0].path === '5.json'
    );

    assert.deepStrictEqual(lookedUp(octokit), []);

    const [treeRead] = octokit.callsTo('GET /repos/{owner}/{repo}/git/trees/{tree_sha}');
    assert.strictEqual(treeRead.options.tree_sha, 'tree-base');
});

test('commitFiles looks up as many as 100 paths in the query itself', async () => {
    const octokit = fakeGit();
    await commit(octokit, { preconditions: { absent: manyPaths(100) } });

    assert.strictEqual(lookedUp(octokit).length, 100);
    assert.deepStrictEqual(octokit.restCalls(), []);
});

test('commitFiles refuses to commit when the fallback tree listing is truncated', async () => {
    const octokit = fakeGit({
        overrides: {
            'GET /repos/{owner}/{repo}/git/trees/{tree_sha}': () => ({ data: { tree: [], truncated: true } })
        }
    });

    await assert.rejects(
        () => commit(octokit, { preconditions: { absent: manyPaths(101) } }),
        error => error.status === 500 && /too large/.test(error.message)
    );

    assert.strictEqual(octokit.callsTo('commit').length, 0);
});

test('commitFiles treats every path as absent in a repository with no commits', async () => {
    const emptyRepo = () => fakeGit({ head: { commitSha: null, treeSha: null } });

    const result = await commit(emptyRepo(), { preconditions: { absent: ['123456789.json'] } });
    assert.strictEqual(result.commitSha, 'commit-new');

    await assert.rejects(
        () => commit(emptyRepo(), { preconditions: { present: ['target.json'] } }),
        error => error.status === 409
    );
});

test('commitFiles rejects malformed preconditions', async () => {
    for (const preconditions of [
        null,
        { absent: 'a.json' },
        { present: [1] },
        { expected: ['a.json'] },
        { expected: { 'a.json': 1 } },
        { head: 123 }
    ]) {
        await assert.rejects(
            () => commit(fakeGit(), { preconditions }),
            error => error.status === 400,
            `accepted ${JSON.stringify(preconditions)}`
        );
    }
});

test('commitFiles deletes when the branch is still at the commit the caller scanned', async () => {
    const octokit = fakeGit({ baseTree: [['x.json', 'blob-x']] });

    const result = await commit(octokit, {
        files: [],
        deletions: ['x.json'],
        preconditions: { expected: { 'x.json': 'blob-x' }, head: 'commit-base' }
    });

    assert.strictEqual(result.deleted, 1);
});

test('commitFiles looks up no paths when head is the only precondition', async () => {
    const octokit = fakeGit();

    await commit(octokit, { preconditions: { head: 'commit-base' } });

    assert.deepStrictEqual(lookedUp(octokit), []);
    assert.deepStrictEqual(octokit.restCalls(), []);
});

test('commitFiles rejects without writing when the branch moved past the scanned commit', async () => {
    const octokit = fakeGit({ baseTree: [['x.json', 'blob-x']] });

    await assert.rejects(
        () => commit(octokit, {
            files: [],
            deletions: ['x.json'],
            preconditions: { expected: { 'x.json': 'blob-x' }, head: 'commit-scanned' }
        }),
        error => {
            assert.strictEqual(error.status, 409);
            assert.deepStrictEqual(error.conflicts, [{ path: null, reason: 'moved' }]);
            return true;
        }
    );

    assert.strictEqual(octokit.callsTo('commit').length, 0);
});

test('commitFiles reports head as moved when a commit lands mid-write', async () => {
    // The check passes, then another editor's commit wins the write
    const head = { commitSha: 'commit-base', treeSha: 'tree-base' };

    const octokit = fakeGit({
        head,
        overrides: {
            commit: () => {
                head.commitSha = 'commit-theirs';
                throw stale();
            }
        }
    });

    await assert.rejects(
        () => commit(octokit, { preconditions: { head: 'commit-base' } }),
        error => error.status === 409 && error.conflicts?.[0]?.reason === 'moved'
    );

    assert.strictEqual(octokit.callsTo('commit').length, 1);
});

test('commitFiles sends paths as query variables, never as query text', async () => {
    const octokit = fakeGit();
    const path = 'we"ird") { oid } evil: viewer { login } x: file(path: "y.json';

    await commit(octokit, { preconditions: { absent: [path] } });

    const [read] = octokit.callsTo('read');
    assert.strictEqual(read.options.variables.p0, path);
    assert.ok(!read.options.query.includes('we"ird'));
});

test('commitFiles looks up each path once when preconditions name it more than once', async () => {
    const octokit = fakeGit({ baseTree: [['a.json', 'blob-a']] });

    await commit(octokit, { preconditions: { present: ['a.json'], expected: { 'a.json': 'blob-a' } } });

    assert.deepStrictEqual(lookedUp(octokit), ['a.json']);
});
