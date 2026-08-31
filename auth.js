const { Octokit } = require('octokit');
const {
    setHeaders,
    extractToken,
    missingParams,
    sendMissingParams,
    sendUnauthorized,
    sendError
} = require('./lib/http');
const { extractRateLimit } = require('./lib/rateLimit');
const { logRequest } = require('./lib/logging');
const { fetchSecrets } = require('./lib/secrets');
const { API_VERSION, createClient, getFile, createFile, toBase64 } = require('./lib/github');
const { commitFiles } = require('./domain/gitData');
const { getBaseConfig } = require('./domain/config');
const { generateConceptID } = require('./domain/conceptId');

const ghauth = async (req, res) => {
    setHeaders(res);
    
    if(req.method === 'OPTIONS') return res.status(200).json({code: 200});

    const api = req.query.api;
    const startedAt = Date.now();

    // Define valid API endpoints in one place
    const validEndpoints = [
        'accessToken',
        'getUser',
        'addFile', 
        'updateFile',
        'getRepo',
        'searchFiles',
        'getUserRepositories',
        'getFiles',
        'deleteFile',
        'getConcept',
        'getConfig',
        'getTree',
        'getFileContent',
        'commitFiles'
    ];

    // Early validation for invalid API endpoints
    if (!validEndpoints.includes(api)) {
        logRequest({ api, status: 400, startedAt, error: 'Invalid API endpoint' });
        return res.status(400).json({
            error: 'Invalid API endpoint',
            message: `API endpoint '${api}' is not supported`,
            supportedEndpoints: validEndpoints
        });
    }

    if (api === 'accessToken') {
        try {
            if (req.method !== 'POST') return res.status(405).json({error: 'Method Not Allowed'});

            const missing = missingParams(req.body, ['code', 'redirect']);
            if (missing.length) return sendMissingParams(res, api, startedAt, missing);

            const environment = req.query.environment;
            const local = environment === 'dev' ? true : false;

            const secrets = await fetchSecrets(local);

            const code = req.body.code;
            const redirect = req.body.redirect;

            const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'application/json'
                },
                body: JSON.stringify({
                    client_id: secrets.client_id,
                    client_secret: secrets.client_secret,
                    code: code,
                    redirect_uri: redirect,
                })
            });
    
            const response = await tokenResponse.json();
            logRequest({ api, status: 200, startedAt });
            res.status(200).json(response);

        } catch (error) {
            return sendError(res, api, startedAt, error);
        }
    }

    if (api === 'getUser') {
        try {
            if (req.method !== 'GET') return res.status(405).json({error: 'Method Not Allowed'});

            const token = extractToken(req);
            if (!token) return sendUnauthorized(res, api, startedAt);

            const octokit = new Octokit({
                auth: token
            });

            const response = await octokit.request('GET /user');
            const rateLimit = extractRateLimit(response);

            logRequest({ api, status: 200, startedAt, rateLimit });
            res.status(200).json({
                data: response.data,
                status: response.status,
                rateLimit
            });
        } catch (error) {
            return sendError(res, api, startedAt, error);
        }
    }

    if (api === 'addFile') {
        try {
            if (req.method !== 'POST') return res.status(405).json({error: 'Method Not Allowed'});

            const token = extractToken(req);
            if (!token) return sendUnauthorized(res, api, startedAt);

            const missing = missingParams(req.body, ['owner', 'repo', 'path', 'message', 'content']);
            if (missing.length) return sendMissingParams(res, api, startedAt, missing);

            const octokit = new Octokit({
                auth: token
            });

            const { owner, repo, path, message, content } = req.body;

            // Step 1: Add the new file
            const response = await octokit.request(`PUT /repos/{owner}/{repo}/contents/{path}`, {
                owner,
                repo,
                path,
                message,
                content,
                headers: {
                  'X-GitHub-Api-Version': '2022-11-28'
                }
            });

            const rateLimit = extractRateLimit(response);
            logRequest({ api, status: 200, startedAt, rateLimit });
            res.status(200).json({
                data: response.data,
                // Lets the client re-key its concept cache without re-reading the repository
                treeSha: response.data.commit?.tree?.sha || null,
                status: response.status,
                rateLimit
            });
        } catch (error) {
            return sendError(res, api, startedAt, error);
        }
    }

    if (api === 'commitFiles') {
        try {
            if (req.method !== 'POST') return res.status(405).json({error: 'Method Not Allowed'});

            const token = extractToken(req);
            if (!token) return sendUnauthorized(res, api, startedAt);

            const missing = missingParams(req.body, ['owner', 'repo', 'branch', 'message']);
            if (missing.length) return sendMissingParams(res, api, startedAt, missing);

            const octokit = createClient(token);

            const { owner, repo, branch, message, files, deletions } = req.body;

            const { lastResponse, ...result } = await commitFiles({
                octokit,
                owner,
                repo,
                branch,
                message,
                files: files || [],
                deletions: deletions || []
            });

            const rateLimit = extractRateLimit(lastResponse);

            logRequest({ api, status: 200, startedAt, rateLimit, files: result.committed, deleted: result.deleted, writes: result.writes });
            res.status(200).json({ ...result, status: 200, rateLimit });
        } catch (error) {
            return sendError(res, api, startedAt, error);
        }
    }

    if (api === 'updateFile') {
        try {
            if (req.method !== 'POST') return res.status(405).json({error: 'Method Not Allowed'});

            const token = extractToken(req);
            if (!token) return sendUnauthorized(res, api, startedAt);

            const missing = missingParams(req.body, ['owner', 'repo', 'path', 'message', 'content', 'sha']);
            if (missing.length) return sendMissingParams(res, api, startedAt, missing);

            const octokit = new Octokit({
                auth: token
            });

            const { owner, repo, path, message, content, sha } = req.body;

            const response = await octokit.request(`PUT /repos/{owner}/{repo}/contents/{path}`, {
                owner,
                repo,
                path,
                message,
                content,
                sha,
                headers: {
                  'X-GitHub-Api-Version': '2022-11-28'
                }
            });

            const rateLimit = extractRateLimit(response);
            logRequest({ api, status: 200, startedAt, rateLimit });
            res.status(200).json({
                data: response.data,
                treeSha: response.data.commit?.tree?.sha || null,
                status: response.status,
                rateLimit
            });
        } catch (error) {
            return sendError(res, api, startedAt, error);
        }
    }

    if (api === 'getRepo') {
        try {
            if (req.method !== 'GET') return res.status(405).json({error: 'Method Not Allowed'});

            const token = extractToken(req);
            if (!token) return sendUnauthorized(res, api, startedAt);

            const missing = missingParams(req.query, ['owner', 'repo']);
            if (missing.length) return sendMissingParams(res, api, startedAt, missing);

            const octokit = new Octokit({
                auth: token
            });

            const { owner, repo, ref } = req.query;

            // An omitted ref expands to an empty path segment, which GitHub reads as the default branch.
            const response = await octokit.request('GET /repos/{owner}/{repo}/zipball/{ref}', {
                owner,
                repo,
                ref: ref || '',
                headers: {
                  'X-GitHub-Api-Version': '2022-11-28'
                }
            });

            const zipData = Buffer.from(response.data);

            logRequest({ api, status: 200, startedAt, rateLimit: extractRateLimit(response), bytes: zipData.length });
            res.set('Content-Type', 'application/zip');
            res.status(200).send(zipData);
        } catch (error) {
            return sendError(res, api, startedAt, error);
        }
    }

    if (api === 'searchFiles') {
        try {
            if (req.method !== 'GET') return res.status(405).json({error: 'Method Not Allowed'});

            const token = extractToken(req);
            if (!token) return sendUnauthorized(res, api, startedAt);

            const missing = missingParams(req.query, ['owner', 'repo', 'query']);
            if (missing.length) return sendMissingParams(res, api, startedAt, missing);

            const { owner, repo, query } = req.query;

            const octokit = new Octokit({
                auth: token
            });

            // Use GitHub Search API to find JSON files containing the query term
            const searchQuery = `${query} in:file extension:json repo:${owner}/${repo}`;
            
            const searchResponse = await octokit.request('GET /search/code', {
                q: searchQuery,
                per_page: 100, // Maximum allowed by GitHub
                headers: {
                    'X-GitHub-Api-Version': '2022-11-28'
                }
            });

            // Filter out reference/index files and extract file paths and relevant information
            const matchingFiles = searchResponse.data.items
                .filter(item => {
                    // Exclude index.json and config.json files
                    const fileName = item.name.toLowerCase();
                    const queryFileName = `${query.toLowerCase()}.json`;

                    return !['index.json', 'config.json'].includes(fileName) &&
                           fileName !== queryFileName; // Exclude the file that matches the query itself
                })
                .map(item => ({
                    path: item.path,
                    name: item.name,
                    sha: item.sha,
                    url: item.html_url,
                    score: item.score,
                    repository: item.repository.full_name
                }));

            const rateLimit = extractRateLimit(searchResponse, 30); // Search API limit is 30/min

            logRequest({ api, status: 200, startedAt, rateLimit });
            res.status(200).json({
                query: query,
                totalCount: searchResponse.data.total_count,
                incomplete_results: searchResponse.data.incomplete_results,
                files: matchingFiles,
                rateLimit
            });

        } catch (error) {
            return sendError(res, api, startedAt, error);
        }
    }

    if (api === 'getUserRepositories') {
        try {
            if (req.method !== 'GET') return res.status(405).json({error: 'Method Not Allowed'});

            const token = extractToken(req);
            if (!token) return sendUnauthorized(res, api, startedAt);

            const octokit = new Octokit({
                auth: token
            });

            const response = await octokit.request('GET /user/repos', {
                affiliation: 'owner, collaborator',
                per_page: 100,
                headers: {
                  'X-GitHub-Api-Version': '2022-11-28'
                }
            });
            
            const rateLimit = extractRateLimit(response);
            logRequest({ api, status: 200, startedAt, rateLimit });
            res.status(200).json({
                data: response.data,
                status: response.status,
                rateLimit
            });
        }
        catch (error) {
            return sendError(res, api, startedAt, error);
        }
    }

    if (api === 'getFiles') {
        try {
            if (req.method !== 'GET') return res.status(405).json({error: 'Method Not Allowed'});

            const token = extractToken(req);
            if (!token) return sendUnauthorized(res, api, startedAt);

            const missing = missingParams(req.query, ['owner', 'repo', 'path']);
            if (missing.length) return sendMissingParams(res, api, startedAt, missing);

            const octokit = new Octokit({
                auth: token
            });

            const { owner, repo, path } = req.query;

            const response = await octokit.request(`GET /repos/{owner}/{repo}/contents/{path}`, {
                owner,
                repo,
                path,
                headers: {
                  'X-GitHub-Api-Version': '2022-11-28'
                }
            });

            const rateLimit = extractRateLimit(response);
            logRequest({ api, status: 200, startedAt, rateLimit });
            res.status(200).json({
                data: response.data,
                status: response.status,
                rateLimit
            });
        } catch (error) {
            // A genuinely absent path is an empty repository; every other failure must surface
            if (error.status === 404) {
                logRequest({ api, status: 200, startedAt, error: 'Path not found - treated as empty' });
                return res.status(200).json({
                    data: [],
                    status: 200,
                    message: 'Path not found - empty repository or file does not exist'
                });
            }

            return sendError(res, api, startedAt, error);
        }
    }

    if (api === 'deleteFile') {
        try {
            if (req.method !== 'POST') return res.status(405).json({error: 'Method Not Allowed'});

            const token = extractToken(req);
            if (!token) return sendUnauthorized(res, api, startedAt);

            const missing = missingParams(req.body, ['owner', 'repo', 'path', 'message', 'sha']);
            if (missing.length) return sendMissingParams(res, api, startedAt, missing);

            const octokit = new Octokit({
                auth: token
            });

            const { owner, repo, path, message, sha } = req.body;

            const response = await octokit.request(`DELETE /repos/{owner}/{repo}/contents/{path}`, {
                owner,
                repo,
                path,
                message,
                sha,
                headers: {
                  'X-GitHub-Api-Version': '2022-11-28'
                }
            });

            const rateLimit = extractRateLimit(response);
            logRequest({ api, status: 200, startedAt, rateLimit });
            res.status(200).json({
                data: response.data,
                treeSha: response.data.commit?.tree?.sha || null,
                status: response.status,
                rateLimit
            });
        } catch (error) {
            return sendError(res, api, startedAt, error);
        }
    }

    if (api === 'getConcept') {
        if (req.method !== 'GET') return res.status(405).json({error: 'Method Not Allowed'});

        const token = extractToken(req);
        if (!token) return sendUnauthorized(res, api, startedAt);

        const conceptMissing = missingParams(req.query, ['owner', 'repo']);
        if (conceptMissing.length) return sendMissingParams(res, api, startedAt, conceptMissing);

        const { owner, repo } = req.query;

        try {
            const octokit = new Octokit({
                auth: token
            });

            // Concept files are named for their ID, so the tree listing is the set of
            // taken IDs. HEAD resolves the default branch without a second lookup.
            const response = await octokit.request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
                owner,
                repo,
                tree_sha: 'HEAD',
                recursive: '1',
                headers: {
                    'X-GitHub-Api-Version': API_VERSION
                }
            });

            const taken = new Set(
                (response.data.tree || [])
                    .filter(entry => entry.type === 'blob' && entry.path.endsWith('.json'))
                    .map(entry => entry.path.replace(/^.*\//, '').replace(/\.json$/i, ''))
            );

            let conceptID;

            do {
                conceptID = generateConceptID();
            } while (taken.has(conceptID.toString()));

            const rateLimit = extractRateLimit(response);

            logRequest({ api, status: 200, startedAt, rateLimit, taken: taken.size, truncated: response.data.truncated === true });
            res.status(200).json({ conceptID, rateLimit });
        } catch (error) {
            // 409 is GitHub's "Git Repository is empty" — every ID is available
            if (error.status === 409 || error.status === 404) {
                const conceptID = generateConceptID();
                logRequest({ api, status: 200, startedAt, empty: true });
                return res.status(200).json({ conceptID });
            }

            return sendError(res, api, startedAt, error);
        }
    }

    if (api === 'getConfig') {
        if (req.method !== 'GET') return res.status(405).json({error: 'Method Not Allowed'});

        const token = extractToken(req);
        if (!token) return sendUnauthorized(res, api, startedAt);

        const configMissing = missingParams(req.query, ['owner', 'repo', 'path']);
        if (configMissing.length) return sendMissingParams(res, api, startedAt, configMissing);

        const { owner, repo, path } = req.query;

        try {
            const response = await getFile(token, owner, repo, path);

            const rateLimit = extractRateLimit(response);

            logRequest({ api, status: 200, startedAt, rateLimit });
            res.status(200).json({ data: response.data, status: response.status, rateLimit });
        } catch (error) {

            if (error.status === 404) {

                const content = JSON.stringify(getBaseConfig(), null, 2);
                const fileResponse = await createFile(token, owner, repo, path, toBase64(content), 'Create config file');
                const rateLimit = extractRateLimit(fileResponse);

                logRequest({ api, status: 200, startedAt, rateLimit, error: 'Config missing - created' });
                return res.status(200).json({ data: fileResponse.data, status: fileResponse.status, rateLimit });
            }
            
            return sendError(res, api, startedAt, error);
        }
    }

    if (api === 'getTree') {
        try {
            if (req.method !== 'GET') return res.status(405).json({error: 'Method Not Allowed'});

            const token = extractToken(req);
            if (!token) return sendUnauthorized(res, api, startedAt);

            const missing = missingParams(req.query, ['owner', 'repo', 'ref']);
            if (missing.length) return sendMissingParams(res, api, startedAt, missing);

            const { owner, repo, ref } = req.query;

            // The contents API caps a directory listing at 1,000 entries; the trees API
            // returns up to 100,000 and reports truncation explicitly.
            const response = await createClient(token).request('GET /repos/{owner}/{repo}/git/trees/{tree_sha}', {
                owner,
                repo,
                tree_sha: ref,
                recursive: '1',
                headers: {
                    'X-GitHub-Api-Version': API_VERSION
                }
            });

            // Trimmed to three fields: full entries for 8,000 concepts are ~1MB of Cloud Run egress.
            const data = (response.data.tree || [])
                .filter(entry => entry.type === 'blob' && !entry.path.includes('/') && entry.path.endsWith('.json'))
                .map(entry => ({ path: entry.path, sha: entry.sha, size: entry.size }));

            const rateLimit = extractRateLimit(response);
            logRequest({ api, status: 200, startedAt, rateLimit, entries: data.length, truncated: response.data.truncated === true });
            res.status(200).json({
                data,
                // Tree SHA, not commit SHA: this changes only when file content changes,
                // so it is the cache key clients should key concept data on.
                sha: response.data.sha,
                truncated: response.data.truncated === true,
                status: response.status,
                rateLimit
            });
        } catch (error) {
            // 409 is GitHub's "Git Repository is empty" — a new repo, not a failure
            if (error.status === 409) {
                logRequest({ api, status: 200, startedAt, error: 'Empty repository' });
                return res.status(200).json({ data: [], sha: null, truncated: false, status: 200 });
            }

            return sendError(res, api, startedAt, error);
        }
    }

    if (api === 'getFileContent') {
        try {
            if (req.method !== 'GET') return res.status(405).json({error: 'Method Not Allowed'});

            const token = extractToken(req);
            if (!token) return sendUnauthorized(res, api, startedAt);

            const missing = missingParams(req.query, ['owner', 'repo', 'path']);
            if (missing.length) return sendMissingParams(res, api, startedAt, missing);

            const { owner, repo, path } = req.query;

            // The raw media type reads up to 100MB. The default JSON representation
            // returns content:"" above 1MB with a 200, which is indistinguishable from an empty file.
            const response = await createClient(token).request('GET /repos/{owner}/{repo}/contents/{path}', {
                owner,
                repo,
                path,
                headers: {
                    'X-GitHub-Api-Version': API_VERSION,
                    accept: 'application/vnd.github.raw'
                }
            });

            const rateLimit = extractRateLimit(response);
            logRequest({ api, status: 200, startedAt, rateLimit });
            res.status(200).json({
                content: typeof response.data === 'string' ? response.data : JSON.stringify(response.data),
                status: response.status,
                rateLimit
            });
        } catch (error) {
            return sendError(res, api, startedAt, error);
        }
    }
}

module.exports = {
    ghauth
}