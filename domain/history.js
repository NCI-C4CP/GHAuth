const { API_VERSION } = require('../lib/github');
const { extractRateLimit, fromGraphqlRateLimit } = require('../lib/rateLimit');
const { toHttpError } = require('./gitData');

const HISTORY_PAGE_SIZE = 25;

// GitHub lists at most this many files per page of a commit
const MAX_DETAIL_FILES = 300;

// Diff text across all files; a 500-concept import would otherwise send megabytes
const MAX_PATCH_CHARS = 100 * 1024;

const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

const HISTORY_QUERY = `query($owner: String!, $name: String!, $ref: String!, $first: Int!, $after: String, $path: String) {
    rateLimit { limit remaining used resetAt }
    repository(owner: $owner, name: $name) {
        ref(qualifiedName: $ref) {
            target {
                ... on Commit {
                    history(first: $first, after: $after, path: $path) {
                        pageInfo { hasNextPage endCursor }
                        nodes {
                            oid messageHeadline messageBody committedDate changedFilesIfAvailable
                            author { name user { login avatarUrl } }
                        }
                    }
                }
            }
        }
    }
}`;

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

// `user` is the linked GitHub account; it is null when the commit email matches none
const toAuthor = (name, user) => ({
    login: user?.login || null,
    name: name || user?.login || null,
    avatarUrl: user?.avatarUrl || null
});

/**
 * One page of the branch's history, newest first, optionally only commits touching `path`
 *
 * @returns {Promise<Object>} `{ commits, hasMore, cursor, rateLimit }`; pass `cursor` back for the next page
 */
const readHistory = async (octokit, { owner, repo, branch, path, cursor }) => {
    let data;

    try {
        data = await octokit.graphql(HISTORY_QUERY, {
            owner,
            name: repo,
            ref: `refs/heads/${branch}`,
            first: HISTORY_PAGE_SIZE,
            after: cursor || null,
            path: path || null
        });
    } catch (error) {
        throw toHttpError(error);
    }

    const rateLimit = fromGraphqlRateLimit(data.rateLimit);
    const history = data.repository?.ref?.target?.history;

    // No branch yet: a repository with no commits
    if (!history) return { commits: [], hasMore: false, cursor: null, rateLimit };

    return {
        commits: history.nodes.map(node => ({
            sha: node.oid,
            headline: node.messageHeadline,
            body: node.messageBody,
            date: node.committedDate,
            filesChanged: node.changedFilesIfAvailable ?? null,
            author: toAuthor(node.author?.name, node.author?.user)
        })),
        hasMore: history.pageInfo.hasNextPage,
        cursor: history.pageInfo.endCursor,
        rateLimit
    };
};

/**
 * One commit's changed files with their diffs, the diff text capped across the whole commit
 *
 * @returns {Promise<Object>} `{ sha, files, filesShown, rateLimit }`; a file whose diff was left
 *   out has `patch: null` and `patchOmitted: true`
 */
const readCommit = async (octokit, { owner, repo, sha }) => {
    if (!SHA_PATTERN.test(sha)) throw badRequest('sha must be a commit hash');

    const response = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}', {
        owner,
        repo,
        ref: sha,
        per_page: MAX_DETAIL_FILES,
        headers: { 'X-GitHub-Api-Version': API_VERSION }
    });

    let budget = MAX_PATCH_CHARS;

    const files = (response.data.files || []).map(file => {
        // GitHub itself leaves out the patch for binary and very large files
        const fits = typeof file.patch === 'string' && file.patch.length <= budget;
        if (fits) budget -= file.patch.length;

        return {
            path: file.filename,
            previousPath: file.previous_filename || null,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            patch: fits ? file.patch : null,
            patchOmitted: !fits
        };
    });

    return {
        sha: response.data.sha,
        files,
        filesShown: files.length,
        rateLimit: extractRateLimit(response)
    };
};

module.exports = {
    readHistory,
    readCommit,
    HISTORY_PAGE_SIZE,
    MAX_DETAIL_FILES,
    MAX_PATCH_CHARS
};
