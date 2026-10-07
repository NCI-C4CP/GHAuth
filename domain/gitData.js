const crypto = require('node:crypto');

const { API_VERSION } = require('../lib/github');

// The trees endpoint caps at 100k entries / 7MB. Concept files are small, but the
// request still crosses Cloud Run, so batches are chunked well below the ceiling.
const MAX_ENTRIES_PER_COMMIT = 1000;

const BLOB_MODE = '100644';

// trees + commits + refs. Counts against the 500/hour secondary limit, not the primary one.
const WRITES_PER_COMMIT = 3;

// A ref moves under us only when another editor commits mid-batch.
const MAX_REF_RETRIES = 3;

const readBranchHead = async (octokit, owner, repo, branch) => {
    try {
        const ref = await octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', {
            owner,
            repo,
            ref: `heads/${branch}`,
            headers: { 'X-GitHub-Api-Version': API_VERSION }
        });

        const commitSha = ref.data.object.sha;

        const commit = await octokit.request('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', {
            owner,
            repo,
            commit_sha: commitSha,
            headers: { 'X-GitHub-Api-Version': API_VERSION }
        });

        return { commitSha, treeSha: commit.data.tree.sha };
    } catch (error) {
        // A repository with no commits has no ref and no base tree
        if (error.status === 404 || error.status === 409) return { commitSha: null, treeSha: null };
        throw error;
    }
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
 * Lists what the preconditions got wrong about the base commit, or nothing if they all hold
 *
 * Read by tree sha, which is immutable, so GitHub's read-after-write lag cannot apply.
 */
const findConflicts = async (octokit, owner, repo, base, { absent = [], present = [], expected = {}, head }) => {
    const conflicts = [];

    // The caller vouched for the whole repository at this commit, not for named files
    if (head !== undefined && head !== base.commitSha) {
        conflicts.push({ path: null, reason: 'moved' });
    }

    if (absent.length + present.length + Object.keys(expected).length === 0) return conflicts;

    const shas = new Map();

    if (base.treeSha) {
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
 * Commits any number of files as a single commit via the Git Data API.
 *
 * Replaces the per-file Contents API loop, which cost 2 writes per concept against
 * GitHub's 500-writes-per-hour secondary limit.
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
 * @returns {Promise<Object>} `{ commitSha, treeSha, files, committed, deleted }`, where
 *   `files` lists each written `{ path, sha, size }`
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

    let lastConflict = null;

    for (let attempt = 0; attempt < MAX_REF_RETRIES; attempt++) {
        const { commitSha: baseCommitSha, treeSha: baseTreeSha } = await readBranchHead(octokit, owner, repo, branch);

        // Re-checked on every attempt: a retry means the base moved and may now violate them
        if (preconditions) {
            const conflicts = await findConflicts(octokit, owner, repo, { commitSha: baseCommitSha, treeSha: baseTreeSha }, preconditions);

            if (conflicts.length > 0) {
                const error = new Error(`${conflicts.map(describeConflict).join('; ')}. Refresh and try again.`);
                error.status = 409;
                error.conflicts = conflicts;
                throw error;
            }
        }

        // index.json is no longer maintained; skipped so a stale copy is never rewritten
        const written = files.filter(file => file.path !== 'index.json');
        const tree = written.map(file => ({ path: file.path, mode: BLOB_MODE, type: 'blob', content: file.content }));

        // A null sha removes the path from the resulting tree
        for (const path of deletions) {
            tree.push({ path, mode: BLOB_MODE, type: 'blob', sha: null });
        }

        const createdTree = await octokit.request('POST /repos/{owner}/{repo}/git/trees', {
            owner,
            repo,
            tree,
            ...(baseTreeSha ? { base_tree: baseTreeSha } : {}),
            headers: { 'X-GitHub-Api-Version': API_VERSION }
        });

        const createdCommit = await octokit.request('POST /repos/{owner}/{repo}/git/commits', {
            owner,
            repo,
            message,
            tree: createdTree.data.sha,
            parents: baseCommitSha ? [baseCommitSha] : [],
            headers: { 'X-GitHub-Api-Version': API_VERSION }
        });

        let refResponse;

        try {
            refResponse = await octokit.request('PATCH /repos/{owner}/{repo}/git/refs/{ref}', {
                owner,
                repo,
                ref: `heads/${branch}`,
                sha: createdCommit.data.sha,
                force: false,
                headers: { 'X-GitHub-Api-Version': API_VERSION }
            });
        } catch (error) {
            // Non-fast-forward: another commit landed since this attempt read the head
            if (error.status === 422 && baseCommitSha) {
                lastConflict = error;
                continue;
            }

            // A repo with no commits yet has no ref to patch
            if (error.status === 422 && !baseCommitSha) {
                refResponse = await octokit.request('POST /repos/{owner}/{repo}/git/refs', {
                    owner,
                    repo,
                    ref: `refs/heads/${branch}`,
                    sha: createdCommit.data.sha,
                    headers: { 'X-GitHub-Api-Version': API_VERSION }
                });
            } else {
                throw error;
            }
        }

        return {
            commitSha: createdCommit.data.sha,
            treeSha: createdTree.data.sha,
            files: written.map(file => ({
                path: file.path,
                sha: blobSha(file.content),
                size: Buffer.byteLength(file.content, 'utf8')
            })),
            committed: files.length,
            deleted: deletions.length,
            writes: WRITES_PER_COMMIT,
            lastResponse: refResponse
        };
    }

    const error = new Error('The branch moved while this batch was being written. Retry the operation.');
    error.status = 409;
    error.cause = lastConflict;
    throw error;
};

module.exports = {
    commitFiles,
    blobSha,
    MAX_ENTRIES_PER_COMMIT,
    WRITES_PER_COMMIT
};
