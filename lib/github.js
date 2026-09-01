const { Octokit } = require('octokit');

const API_VERSION = '2022-11-28';

// 409 is a stale-SHA conflict and can never succeed on retry; without this the caller
// waits out three backoff attempts (~15s) before seeing a deterministic error.
const createClient = (token) => new Octokit({
    auth: token,
    retry: { doNotRetry: [400, 401, 403, 404, 409, 422] }
});

const getFile = async (token, owner, repo, path) => {
    return createClient(token).request('GET /repos/{owner}/{repo}/contents/{path}', {
        owner,
        repo,
        path,
        headers: {
            'X-GitHub-Api-Version': API_VERSION
        }
    });
};

const createFile = async (token, owner, repo, path, content, message) => {
    return createClient(token).request('PUT /repos/{owner}/{repo}/contents/{path}', {
        owner,
        repo,
        path,
        message,
        content,
        headers: {
            'X-GitHub-Api-Version': API_VERSION
        }
    });
};

// The Contents API accepts file bodies only as base64.
const toBase64 = (string) => Buffer.from(string, 'utf-8').toString('base64');

module.exports = {
    API_VERSION,
    createClient,
    getFile,
    createFile,
    toBase64
};
