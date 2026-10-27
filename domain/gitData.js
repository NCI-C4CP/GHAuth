const crypto = require('node:crypto');

const { API_VERSION } = require('../lib/github');
const { fromGraphqlRateLimit } = require('../lib/rateLimit');

// The trees endpoint caps at 100k entries / 7MB. Concept files are small, but the
// request still crosses Cloud Run, so batches are chunked well below the ceiling.
const MAX_ENTRIES_PER_COMMIT = 1000;

const BLOB_MODE = '100644';

// One createCommitOnBranch mutation. Counts against the 500/hour secondary limit, not the primary one.
const WRITES_PER_COMMIT = 1;

// A ref moves under us only when another editor commits mid-batch.
const MAX_REF_RETRIES = 3;

// Above this, one aliased lookup per path risks GraphQL query limits; read the whole tree instead
const MAX_PATH_LOOKUPS = 100;

const GRAPHQL_STATUS = { NOT_FOUND: 404, FORBIDDEN: 403, INSUFFICIENT_SCOPES: 403, UNPROCESSABLE: 422 };

/**
 * Gives a GraphQL error the HTTP status sendError understands
 */
const toHttpError = (error) => {
    if (error?.status || !Array.isArray(error?.errors)) return error;

    return Object.assign(new Error(error.errors.map(e => e.message).join('; ')), {
        status: GRAPHQL_STATUS[error.errors[0]?.type] || 500,
        cause: error
    });
};

// Paths are always passed as variables, never written into the query text
const buildReadQuery = (count) => {
    const variables = Array.from({ length: count }, (_, i) => `, $p${i}: String!`).join('');
    const lookups = Array.from({ length: count }, (_, i) => `f${i}: file(path: $p${i}) { oid }`).join(' ');

    return `query($owner: String!, $name: String!, $ref: String!${variables}) {
        rateLimit { limit remaining used resetAt }
        repository(owner: $owner, name: $name) {
            ref(qualifiedName: $ref) { target { oid ... on Commit { tree { oid } ${lookups} } } }
        }
    }`;
};

const COMMIT_MUTATION = `mutation($input: CreateCommitOnBranchInput!) {
    createCommitOnBranch(input: $input) { commit { oid tree { oid } } }
}`;

/**
 * Reads the branch head and, from that same commit, the blob sha of each named path
 *
 * @returns {Promise<Object>} `{ commitSha, treeSha, shas, rateLimit }`. `shas` maps each path
 *   that exists to its blob sha, or is null when there were too many paths to look up.
 */
const readHead = async (octokit, owner, repo, branch, paths) => {
    const lookups = paths.length <= MAX_PATH_LOOKUPS ? paths : [];
    const variables = { owner, name: repo, ref: `refs/heads/${branch}` };
    lookups.forEach((path, i) => { variables[`p${i}`] = path; });

    let data;

    try {
        data = await octokit.graphql(buildReadQuery(lookups.length), variables);
    } catch (error) {
        // A path that does not exist is a NOT_FOUND on its own field; everything else still resolved
        const onlyMissingPaths = error.errors?.every(e => e.type === 'NOT_FOUND' && /^f\d+$/.test(e.path?.at(-1)));
        if (!onlyMissingPaths || !error.data) throw toHttpError(error);
        data = error.data;
    }

    const rateLimit = fromGraphqlRateLimit(data.rateLimit);
    const target = data.repository?.ref?.target;

    // No branch yet: an empty repository, where every path is absent
    if (!target) return { commitSha: null, treeSha: null, shas: new Map(), rateLimit };

    const shas = paths.length <= MAX_PATH_LOOKUPS ? new Map() : null;
    lookups.forEach((path, i) => {
        if (target[`f${i}`]?.oid) shas.set(path, target[`f${i}`].oid);
    });

    return { commitSha: target.oid, treeSha: target.tree.oid, shas, rateLimit };
};

/**
 * Git's object ID for a blob, which is what GitHub reports as the file's sha
 */
const blobSha = (content) => {
    const body = Buffer.from(content, 'utf8');
    return crypto.createHash('sha1').update(`blob ${body.length}\0`).update(body).digest('hex');
};

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

const isStringArray = (value) => Array.isArray(value) && value.every(item => typeof item === 'string');

const validatePreconditions = (preconditions) => {
    if (!preconditions || typeof preconditions !== 'object' || Array.isArray(preconditions)) {
        throw badRequest('preconditions must be an object');
    }

    const { absent = [], present = [], expected = {}, head } = preconditions;

    if (!isStringArray(absent) || !isStringArray(present)) {
        throw badRequest('preconditions.absent and preconditions.present must be arrays of paths');
    }

    if (!expected || typeof expected !== 'object' || Array.isArray(expected) ||
        !Object.values(expected).every(sha => typeof sha === 'string')) {
        throw badRequest('preconditions.expected must map paths to blob shas');
    }

    if (head !== undefined && typeof head !== 'string') {
        throw badRequest('preconditions.head must be a commit sha');
    }
};

/**
 * Every path the preconditions name, once each
 */
const preconditionPaths = ({ absent = [], present = [], expected = {} } = {}) =>
    [...new Set([...absent, ...present, ...Object.keys(expected)])];

/**
 * Lists what the preconditions got wrong about the base commit, or nothing if they all hold
 *
 * Uses the shas read alongside the head, so both describe one commit. Falls back to
 * reading the tree by sha, which is immutable, when there were too many paths to look up.
 */
const findConflicts = async (octokit, owner, repo, base, { absent = [], present = [], expected = {}, head }) => {
    const conflicts = [];

    // The caller vouched for the whole repository at this commit, not for named files
    if (head !== undefined && head !== base.commitSha) {
        conflicts.push({ path: null, reason: 'moved' });
    }

    if (absent.length + present.length + Object.keys(expected).length === 0) return conflicts;

    let shas = base.shas;

    if (!shas) {
        shas = new Map();

        const response = await octokit.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
            owner,
            repo,
            tree_sha: base.treeSha,
            headers: { 'X-GitHub-Api-Version': API_VERSION }
        });

        // A partial listing cannot prove a path is absent
        if (response.data.truncated) {
            throw Object.assign(new Error('Repository tree is too large to verify this commit'), { status: 500 });
        }

        for (const entry of response.data.tree || []) {
            if (entry.type === 'blob') shas.set(entry.path, entry.sha);
        }
    }

    for (const path of absent) {
        if (shas.has(path)) conflicts.push({ path, reason: 'exists' });
    }

    for (const path of present) {
        if (!shas.has(path)) conflicts.push({ path, reason: 'missing' });
    }

    for (const [path, sha] of Object.entries(expected)) {
        if (!shas.has(path)) conflicts.push({ path, reason: 'missing' });
        else if (shas.get(path) !== sha) conflicts.push({ path, reason: 'changed' });
    }

    return conflicts;
};

const describeConflict = ({ path, reason }) => ({
    exists: `${path} already exists`,
    missing: `${path} no longer exists`,
    changed: `${path} was changed by someone else`,
    moved: 'The repository changed after it was checked'
})[reason];

/**
 * Writes one commit on top of `expectedHead`; GitHub rejects it if the branch has moved
 */
const commitOnBranch = async (octokit, owner, repo, branch, expectedHead, message, written, deletions) => {
    const [headline, ...rest] = message.split('\n');
    const body = rest.join('\n').trim();

    try {
        const result = await octokit.graphql(COMMIT_MUTATION, {
            input: {
                branch: { repositoryNameWithOwner: `${owner}/${repo}`, branchName: branch },
                expectedHeadOid: expectedHead,
                message: { headline, ...(body ? { body } : {}) },
                fileChanges: {
                    additions: written.map(file => ({ path: file.path, contents: Buffer.from(file.content, 'utf8').toString('base64') })),
                    deletions: deletions.map(path => ({ path }))
                }
            }
        });

        const { oid, tree } = result.createCommitOnBranch.commit;
        return { commitSha: oid, treeSha: tree.oid, writes: WRITES_PER_COMMIT };
    } catch (error) {
        if (error.errors?.some(e => e.type === 'STALE_DATA')) throw Object.assign(error, { moved: true });
        throw toHttpError(error);
    }
};

/**
 * createCommitOnBranch needs an existing branch, so a repository's first commit is built by hand
 */
const createFirstCommit = async (octokit, owner, repo, branch, message, written) => {
    const headers = { 'X-GitHub-Api-Version': API_VERSION };

    const createdTree = await octokit.request('POST /repos/{owner}/{repo}/git/trees', {
        owner,
        repo,
        tree: written.map(file => ({ path: file.path, mode: BLOB_MODE, type: 'blob', content: file.content })),
        headers
    });

    const createdCommit = await octokit.request('POST /repos/{owner}/{repo}/git/commits', {
        owner,
        repo,
        message,
        tree: createdTree.data.sha,
        parents: [],
        headers
    });

    try {
        await octokit.request('POST /repos/{owner}/{repo}/git/refs', {
            owner,
            repo,
            ref: `refs/heads/${branch}`,
            sha: createdCommit.data.sha,
            headers
        });
    } catch (error) {
        // Another editor made the first commit while this one was being built
        if (error.status === 422) throw Object.assign(error, { moved: true });
        throw error;
    }

    return { commitSha: createdCommit.data.sha, treeSha: createdTree.data.sha, writes: 3 };
};

/**
 * Commits any number of files as a single commit with GraphQL's createCommitOnBranch.
 *
 * One read gives the branch head and the named paths at that commit; one write commits
 * only if the branch is still at that head. Replaces six sequential REST calls.
 *
 * @param {Object} params
 * @param {Object} params.octokit - Authenticated client
 * @param {string} params.owner - Repository owner
 * @param {string} params.repo - Repository name
 * @param {string} params.branch - Branch to commit onto
 * @param {string} params.message - Commit message
 * @param {Array<Object>} [params.files=[]] - `{path, content}` entries, content as UTF-8 text
 * @param {Array<string>} [params.deletions=[]] - Paths to remove
 * @param {Object} [params.preconditions] - Must hold at the base commit or nothing is written:
 *   `absent` paths, `present` paths, `expected` path-to-blob-sha pairs, and `head`, the
 *   commit the branch must still point at
 * @returns {Promise<Object>} `{ commitSha, treeSha, files, committed, deleted, writes, attempts,
 *   timings, rateLimit }`, where `files` lists each written `{ path, sha, size }`
 * @throws {Error} If validation fails, a precondition fails (409 with `conflicts`), or the
 *   ref still conflicts after retrying
 */
const commitFiles = async ({ octokit, owner, repo, branch, message, files = [], deletions = [], preconditions }) => {
    if (!Array.isArray(files) || !Array.isArray(deletions)) {
        const error = new Error('files and deletions must be arrays');
        error.status = 400;
        throw error;
    }

    if (files.length === 0 && deletions.length === 0) {
        const error = new Error('Nothing to commit: provide at least one file or deletion');
        error.status = 400;
        throw error;
    }

    if (files.length + deletions.length > MAX_ENTRIES_PER_COMMIT) {
        const error = new Error(`A single commit accepts at most ${MAX_ENTRIES_PER_COMMIT} entries; split the batch`);
        error.status = 400;
        throw error;
    }

    for (const file of files) {
        if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') {
            const error = new Error('Each file must be { path: string, content: string }');
            error.status = 400;
            throw error;
        }
    }

    if (preconditions !== undefined) validatePreconditions(preconditions);

    // index.json is no longer maintained; skipped so a stale copy is never rewritten
    const written = files.filter(file => file.path !== 'index.json');
    const paths = preconditions ? preconditionPaths(preconditions) : [];

    let lastConflict = null;

    // Milliseconds per GitHub step, summed across retries, so slow saves can be attributed
    const timings = {};
    const timed = async (step, run) => {
        const started = Date.now();
        try {
            return await run();
        } finally {
            timings[step] = (timings[step] || 0) + Date.now() - started;
        }
    };

    for (let attempt = 0; attempt < MAX_REF_RETRIES; attempt++) {
        const base = await timed('read', () => readHead(octokit, owner, repo, branch, paths));

        // Re-checked on every attempt: a retry means the base moved and may now violate them
        if (preconditions) {
            const conflicts = await timed('check', () => findConflicts(octokit, owner, repo, base, preconditions));

            if (conflicts.length > 0) {
                const error = new Error(`${conflicts.map(describeConflict).join('; ')}. Refresh and try again.`);
                error.status = 409;
                error.conflicts = conflicts;
                error.timings = timings;
                throw error;
            }
        }

        let commit;

        try {
            commit = await timed('write', () => base.commitSha
                ? commitOnBranch(octokit, owner, repo, branch, base.commitSha, message, written, deletions)
                : createFirstCommit(octokit, owner, repo, branch, message, written));
        } catch (error) {
            // Another commit landed since this attempt read the head
            if (error.moved) {
                lastConflict = error;
                continue;
            }

            throw error;
        }

        return {
            commitSha: commit.commitSha,
            treeSha: commit.treeSha,
            files: written.map(file => ({
                path: file.path,
                sha: blobSha(file.content),
                size: Buffer.byteLength(file.content, 'utf8')
            })),
            committed: files.length,
            deleted: deletions.length,
            writes: commit.writes,
            attempts: attempt + 1,
            timings,
            rateLimit: base.rateLimit
        };
    }

    const error = new Error('The branch moved while this batch was being written. Retry the operation.');
    error.status = 409;
    error.cause = lastConflict;
    error.timings = timings;
    throw error;
};

module.exports = {
    commitFiles,
    blobSha,
    toHttpError,
    MAX_ENTRIES_PER_COMMIT,
    WRITES_PER_COMMIT
};
