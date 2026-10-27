const test = require('node:test');
const assert = require('node:assert');

const { readHistory, readCommit, HISTORY_PAGE_SIZE, MAX_DETAIL_FILES, MAX_PATCH_CHARS } = require('../domain/history');

const REPO = { owner: 'owner', repo: 'repo' };

const node = (oid, extra = {}) => ({
    oid,
    messageHeadline: `Edit QUESTION "q" (${oid})`,
    messageBody: 'Changed: key',
    committedDate: '2026-10-27T17:23:45Z',
    changedFilesIfAvailable: 1,
    author: { name: 'Ada Lovelace', user: { login: 'ada', avatarUrl: 'https://avatars.example/ada' } },
    ...extra
});

const graphqlClient = (respond) => {
    const calls = [];
    return {
        calls,
        graphql: async (query, variables) => {
            calls.push(variables);
            return respond(variables);
        }
    };
};

const historyPage = (nodes, pageInfo = { hasNextPage: false, endCursor: null }) => ({
    rateLimit: { limit: 5000, remaining: 4990, used: 10, resetAt: new Date(Date.now() + 60000).toISOString() },
    repository: { ref: { target: { history: { pageInfo, nodes } } } }
});

test.describe('readHistory', () => {
    test('returns a page of commits with the cursor for the next one', async () => {
        const client = graphqlClient(() => historyPage([node('abc1234')], { hasNextPage: true, endCursor: 'cursor-25' }));

        const page = await readHistory(client, { ...REPO, branch: 'main' });

        assert.deepStrictEqual(page.commits, [{
            sha: 'abc1234',
            headline: 'Edit QUESTION "q" (abc1234)',
            body: 'Changed: key',
            date: '2026-10-27T17:23:45Z',
            filesChanged: 1,
            author: { login: 'ada', name: 'Ada Lovelace', avatarUrl: 'https://avatars.example/ada' }
        }]);
        assert.strictEqual(page.hasMore, true);
        assert.strictEqual(page.cursor, 'cursor-25');
        assert.strictEqual(page.rateLimit.resource, 'graphql');
    });

    test('asks for one page of the branch, from the cursor, limited to the path', async () => {
        const client = graphqlClient(() => historyPage([]));

        await readHistory(client, { ...REPO, branch: 'main', path: '444444444.json', cursor: 'cursor-25' });

        assert.deepStrictEqual(client.calls[0], {
            owner: 'owner',
            name: 'repo',
            ref: 'refs/heads/main',
            first: HISTORY_PAGE_SIZE,
            after: 'cursor-25',
            path: '444444444.json'
        });
    });

    test('a repository with no commits has an empty history', async () => {
        const client = graphqlClient(() => ({ rateLimit: null, repository: { ref: null } }));

        const { commits, hasMore, cursor } = await readHistory(client, { ...REPO, branch: 'main' });

        assert.deepStrictEqual({ commits, hasMore, cursor }, { commits: [], hasMore: false, cursor: null });
    });

    test('names an author with no linked GitHub account by the git name', async () => {
        const client = graphqlClient(() => historyPage([node('abc1234', { author: { name: 'Someone', user: null } })]));

        const [commit] = (await readHistory(client, { ...REPO, branch: 'main' })).commits;

        assert.deepStrictEqual(commit.author, { login: null, name: 'Someone', avatarUrl: null });
    });

    test('a GraphQL error becomes an HTTP status', async () => {
        const client = { graphql: async () => { throw Object.assign(new Error('x'), { errors: [{ type: 'NOT_FOUND', message: 'no repo' }] }); } };

        await assert.rejects(readHistory(client, { ...REPO, branch: 'main' }), { status: 404 });
    });
});

test.describe('readCommit', () => {
    const restClient = (files) => {
        const calls = [];
        return {
            calls,
            request: async (route, params) => {
                calls.push({ route, params });
                return { status: 200, headers: {}, data: { sha: 'abc1234def', files } };
            }
        };
    };

    const file = (filename, patch, extra = {}) => ({ filename, status: 'modified', additions: 1, deletions: 1, patch, ...extra });

    test('returns each changed file with its diff', async () => {
        const client = restClient([file('444444444.json', '@@ -1 +1 @@\n-a\n+b'), file('old.json', undefined, { status: 'renamed', previous_filename: 'older.json' })]);

        const detail = await readCommit(client, { ...REPO, sha: 'abc1234' });

        assert.deepStrictEqual(detail.files, [
            { path: '444444444.json', previousPath: null, status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b', patchOmitted: false },
            { path: 'old.json', previousPath: 'older.json', status: 'renamed', additions: 1, deletions: 1, patch: null, patchOmitted: true }
        ]);
        assert.strictEqual(detail.filesShown, 2);
        assert.strictEqual(client.calls[0].params.per_page, MAX_DETAIL_FILES);
    });

    test('stops including diffs once the commit\'s diff text passes the cap', async () => {
        const big = 'x'.repeat(MAX_PATCH_CHARS / 2 + 1);
        const client = restClient([file('a.json', big), file('b.json', big), file('c.json', 'small')]);

        const { files } = await readCommit(client, { ...REPO, sha: 'abc1234' });

        assert.deepStrictEqual(files.map(f => f.patchOmitted), [false, true, false]);
    });

    for (const sha of ['', 'main', 'abc', 'abc1234; rm -rf', '../../etc']) {
        test(`rejects ${JSON.stringify(sha)} as a sha without calling GitHub`, async () => {
            const client = restClient([]);

            await assert.rejects(readCommit(client, { ...REPO, sha }), { status: 400 });
            assert.strictEqual(client.calls.length, 0);
        });
    }
});
