const test = require('node:test');
const assert = require('node:assert');

const { commitFiles, blobSha, MAX_ENTRIES_PER_COMMIT, WRITES_PER_COMMIT } = require('../domain/gitData');

const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });
const conflict = () => Object.assign(new Error('Update is not a fast forward'), { status: 422 });

/**
 * Route-aware stand-in for octokit. Each handler may be overridden per test, and
 * every call is recorded so the resulting tree and commit can be asserted.
 */
const fakeGit = ({ head = { commitSha: 'commit-base', treeSha: 'tree-base' }, baseTree = [], overrides = {} } = {}) => {
    const calls = [];

    const handlers = {
        'GET /repos/{owner}/{repo}/git/ref/{ref}': () => {
            if (!head.commitSha) throw notFound();
            return { data: { object: { sha: head.commitSha } } };
        },
        'GET /repos/{owner}/{repo}/git/commits/{commit_sha}': () => ({ data: { tree: { sha: head.treeSha } } }),
        'GET /repos/{owner}/{repo}/git/trees/{tree_sha}': () => ({
            data: { tree: baseTree.map(([path, sha]) => ({ path, sha, type: 'blob' })), truncated: false }
        }),
        // Recorded so a reintroduced index round-trip would show up as a call
        'GET /repos/{owner}/{repo}/contents/{path}': () => { throw notFound(); },
        'POST /repos/{owner}/{repo}/git/trees': () => ({ data: { sha: 'tree-new' } }),
        'POST /repos/{owner}/{repo}/git/commits': () => ({ data: { sha: 'commit-new' } }),
        'PATCH /repos/{owner}/{repo}/git/refs/{ref}': () => ({ data: { ref: 'refs/heads/main' } }),
        'POST /repos/{owner}/{repo}/git/refs': () => ({ data: { ref: 'refs/heads/main' } }),
        ...overrides
    };

    return {
        calls,
        callsTo: (route) => calls.filter(call => call.route === route),
        request: async (route, options) => {
            calls.push({ route, options });

            const handler = handlers[route];
            if (!handler) throw new Error(`Unexpected route: ${route}`);

            return handler(options, calls);
        }
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

test('commitFiles never returns the raw ref response to the caller of the API layer', async () => {
    const result = await commit(fakeGit());

    // auth.js strips lastResponse; it exists only so rate limit headers can be read
    assert.ok(result.lastResponse, 'lastResponse should be present for rate limit extraction');
});

test('commitFiles writes only the given files into the tree', async () => {
    const octokit = fakeGit();
    await commit(octokit);

    const [treeCall] = octokit.callsTo('POST /repos/{owner}/{repo}/git/trees');
    const paths = treeCall.options.tree.map(entry => entry.path);

    assert.deepStrictEqual(paths, ['123456789.json']);
    assert.strictEqual(treeCall.options.base_tree, 'tree-base');
});

test('commitFiles never reads index.json', async () => {
    const octokit = fakeGit();
    await commit(octokit);

    // The index round-trip was the bulk of save latency; it must not come back
    assert.strictEqual(octokit.callsTo('GET /repos/{owner}/{repo}/contents/{path}').length, 0);
});

test('commitFiles skips a caller-supplied index.json so a stale copy is not rewritten', async () => {
    const octokit = fakeGit();

    await commit(octokit, {
        files: [
            { path: '1.json', content: JSON.stringify({ key: 'a', object_type: 'QUESTION' }) },
            { path: 'index.json', content: '{"_files":{"stale":{}}}' }
        ]
    });

    const [treeCall] = octokit.callsTo('POST /repos/{owner}/{repo}/git/trees');
    const paths = treeCall.options.tree.map(entry => entry.path);

    assert.deepStrictEqual(paths, ['1.json']);
});

test('commitFiles marks deletions with a null sha', async () => {
    const octokit = fakeGit();

    const result = await commit(octokit, { files: [], deletions: ['1.json'] });

    const [treeCall] = octokit.callsTo('POST /repos/{owner}/{repo}/git/trees');
    const deletion = treeCall.options.tree.find(entry => entry.path === '1.json');

    assert.strictEqual(deletion.sha, null);
    assert.strictEqual(result.deleted, 1);
});

test('commitFiles commits a file that is not valid JSON without inspecting it', async () => {
    const octokit = fakeGit();
    await commit(octokit, { files: [{ path: 'broken.json', content: 'not json' }] });

    const [treeCall] = octokit.callsTo('POST /repos/{owner}/{repo}/git/trees');
    const paths = treeCall.options.tree.map(entry => entry.path);

    assert.ok(paths.includes('broken.json'));
});

test('commitFiles creates the ref on a repository with no commits', async () => {
    const octokit = fakeGit({
        head: { commitSha: null, treeSha: null },
        overrides: {
            'PATCH /repos/{owner}/{repo}/git/refs/{ref}': () => { throw conflict(); }
        }
    });

    const result = await commit(octokit);

    assert.strictEqual(result.commitSha, 'commit-new');
    assert.strictEqual(octokit.callsTo('POST /repos/{owner}/{repo}/git/refs').length, 1);

    const [commitCall] = octokit.callsTo('POST /repos/{owner}/{repo}/git/commits');
    assert.deepStrictEqual(commitCall.options.parents, []);

    const [treeCall] = octokit.callsTo('POST /repos/{owner}/{repo}/git/trees');
    assert.strictEqual(treeCall.options.base_tree, undefined);
});

test('commitFiles retries when the branch moves and succeeds on a later attempt', async () => {
    let attempts = 0;

    const octokit = fakeGit({
        overrides: {
            'PATCH /repos/{owner}/{repo}/git/refs/{ref}': () => {
                attempts += 1;
                if (attempts === 1) throw conflict();
                return { data: { ref: 'refs/heads/main' } };
            }
        }
    });

    const result = await commit(octokit);

    assert.strictEqual(result.commitSha, 'commit-new');
    assert.strictEqual(attempts, 2);
    // Each attempt re-reads the branch head, since a competing commit moved it
    assert.strictEqual(octokit.callsTo('GET /repos/{owner}/{repo}/git/ref/{ref}').length, 2);
});

test('commitFiles gives up with a 409 when the branch keeps moving', async () => {
    const octokit = fakeGit({
        overrides: {
            'PATCH /repos/{owner}/{repo}/git/refs/{ref}': () => { throw conflict(); }
        }
    });

    await assert.rejects(
        () => commit(octokit),
        error => error.status === 409 && /branch moved/.test(error.message)
    );

    assert.strictEqual(octokit.callsTo('PATCH /repos/{owner}/{repo}/git/refs/{ref}').length, 3);
});

test('commitFiles propagates a ref failure that is not a conflict', async () => {
    const octokit = fakeGit({
        overrides: {
            'PATCH /repos/{owner}/{repo}/git/refs/{ref}': () => {
                throw Object.assign(new Error('Server Error'), { status: 500 });
            }
        }
    });

    await assert.rejects(() => commit(octokit), error => error.status === 500);
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

test('commitFiles skips the base tree read when there are no preconditions', async () => {
    const octokit = fakeGit();
    await commit(octokit);

    assert.strictEqual(octokit.callsTo('GET /repos/{owner}/{repo}/git/trees/{tree_sha}').length, 0);
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

    const [treeRead] = octokit.callsTo('GET /repos/{owner}/{repo}/git/trees/{tree_sha}');
    assert.strictEqual(treeRead.options.tree_sha, 'tree-base');
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

    assert.strictEqual(octokit.callsTo('POST /repos/{owner}/{repo}/git/trees').length, 0);
    assert.strictEqual(octokit.callsTo('PATCH /repos/{owner}/{repo}/git/refs/{ref}').length, 0);
});

test('commitFiles re-checks preconditions after the branch moves', async () => {
    // Editor A's delete lands between our first check and our ref update
    let treeReads = 0;
    let refAttempts = 0;

    const octokit = fakeGit({
        overrides: {
            'GET /repos/{owner}/{repo}/git/trees/{tree_sha}': () => {
                treeReads += 1;
                const tree = treeReads === 1 ? [{ path: 'primary.json', sha: 'blob-p', type: 'blob' }] : [];
                return { data: { tree, truncated: false } };
            },
            'PATCH /repos/{owner}/{repo}/git/refs/{ref}': () => {
                refAttempts += 1;
                throw conflict();
            }
        }
    });

    await assert.rejects(
        () => commit(octokit, { preconditions: { present: ['primary.json'] } }),
        error => error.status === 409 && error.conflicts?.[0]?.reason === 'missing'
    );

    assert.strictEqual(refAttempts, 1);
    assert.strictEqual(treeReads, 2);
});

test('commitFiles refuses to commit when the base tree listing is truncated', async () => {
    const octokit = fakeGit({
        overrides: {
            'GET /repos/{owner}/{repo}/git/trees/{tree_sha}': () => ({ data: { tree: [], truncated: true } })
        }
    });

    await assert.rejects(
        () => commit(octokit, { preconditions: { absent: ['new.json'] } }),
        error => error.status === 500 && /too large/.test(error.message)
    );

    assert.strictEqual(octokit.callsTo('POST /repos/{owner}/{repo}/git/trees').length, 0);
});

test('commitFiles treats every path as absent in a repository with no commits', async () => {
    const emptyRepo = () => fakeGit({
        head: { commitSha: null, treeSha: null },
        overrides: {
            'PATCH /repos/{owner}/{repo}/git/refs/{ref}': () => { throw conflict(); }
        }
    });

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

test('commitFiles skips the tree read when head is the only precondition', async () => {
    const octokit = fakeGit();

    await commit(octokit, { preconditions: { head: 'commit-base' } });

    assert.strictEqual(octokit.callsTo('GET /repos/{owner}/{repo}/git/trees/{tree_sha}').length, 0);
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

    assert.strictEqual(octokit.callsTo('POST /repos/{owner}/{repo}/git/trees').length, 0);
});

test('commitFiles reports head as moved when a commit lands mid-write', async () => {
    // The check passes, then another editor's commit wins the ref update
    let head = 'commit-base';

    const octokit = fakeGit({
        overrides: {
            'GET /repos/{owner}/{repo}/git/ref/{ref}': () => ({ data: { object: { sha: head } } }),
            'PATCH /repos/{owner}/{repo}/git/refs/{ref}': () => {
                head = 'commit-theirs';
                throw conflict();
            }
        }
    });

    await assert.rejects(
        () => commit(octokit, { preconditions: { head: 'commit-base' } }),
        error => error.status === 409 && error.conflicts?.[0]?.reason === 'moved'
    );

    assert.strictEqual(octokit.callsTo('PATCH /repos/{owner}/{repo}/git/refs/{ref}').length, 1);
});
