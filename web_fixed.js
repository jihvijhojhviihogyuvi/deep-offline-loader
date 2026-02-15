const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const EventEmitter = require('events');
const crypto = require('crypto');
const os = require('os');

const app = express();
const port = 8000;

const sseEvents = new EventEmitter();
sseEvents.setMaxListeners(0);
const eventHistory = [];
let eventSeq = 0;
const ENABLE_LOCAL_REPLAY = true;

function publishUpdate(data) {
    eventSeq += 1;
    const entry = { id: eventSeq, data };
    eventHistory.push(entry);
    if (eventHistory.length > 500) eventHistory.shift();
    sseEvents.emit('update', data);
}

app.use(express.json());

const STORAGE_DIR = path.join(__dirname, 'saved_sites');
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR);



function getAssetStoragePathForUrl(baseDir, url) {
    const hash = crypto.createHash('sha1').update(url).digest('hex');
    const parsed = new URL(url);
    const safeHost = parsed.hostname.replace(/[^a-z0-9.-]/gi, '_');
    const safePath = parsed.pathname.replace(/[^a-z0-9./_-]/gi, '_') || '/';
    const normalizedPath = safePath.endsWith('/') ? `${safePath}index` : safePath;
    const relativePath = normalizedPath.startsWith('/') ? normalizedPath.slice(1) : normalizedPath;
    const extension = path.extname(relativePath) || '.bin';
    const fileName = `${path.basename(relativePath, path.extname(relativePath)) || 'asset'}_${hash.slice(0, 12)}${extension}`;
    return path.join(baseDir, safeHost, fileName);
}

function setupNetworkCapture(page, networkDir) {
    const requests = [];
    const pendingWrites = [];

    page.on('response', (response) => {
        const writeTask = (async () => {
            const req = response.request();
            const requestUrl = response.url();
            if (!requestUrl.startsWith('http://') && !requestUrl.startsWith('https://')) return;

            const targetPath = getAssetStoragePathForUrl(networkDir, requestUrl);
            await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });

            let bodyPath = null;
            let bodySize = 0;
            try {
                const body = await response.buffer();
                bodySize = body.length;
                bodyPath = `${targetPath}`;
                await fs.promises.writeFile(bodyPath, body);
            } catch (error) {
                bodyPath = null;
            }

            requests.push({
                url: requestUrl,
                method: req.method(),
                resourceType: req.resourceType(),
                status: response.status(),
                headers: response.headers(),
                timestamp: new Date().toISOString(),
                bodyPath,
                bodySize
            });
        })();

        pendingWrites.push(writeTask);
    });

    return {
        async finalize() {
            await Promise.allSettled(pendingWrites);
            return requests;
        }
    };
}


function mergeNetworkManifests(existingEntries, newEntries) {
    const mergedByKey = new Map();
    [...existingEntries, ...newEntries].forEach((entry) => {
        const key = `${entry.method || 'GET'}|${entry.url}|${entry.status}|${entry.resourceType}|${entry.bodySize || 0}`;
        mergedByKey.set(key, entry);
    });
    return Array.from(mergedByKey.values());
}



function findAssetEntry(manifest, requestedUrl, method = 'GET') {
    const normalizedMethod = (method || 'GET').toUpperCase();
    const exactMethod = manifest.find((entry) => entry.url === requestedUrl && (entry.method || 'GET').toUpperCase() === normalizedMethod && entry.bodyPath && fs.existsSync(entry.bodyPath));
    if (exactMethod) return exactMethod;
    return manifest.find((entry) => entry.url === requestedUrl && entry.bodyPath && fs.existsSync(entry.bodyPath));
}

function injectOfflineReplayScript(html, siteDir) {
    if (!ENABLE_LOCAL_REPLAY) return html;
    const replayScript = `
<script>
(() => {
  const sitePath = ${JSON.stringify(siteDir)};
  const toReplayUrl = (rawUrl, method = 'GET') => {
    try {
      const absolute = new URL(rawUrl, window.location.href);
      if (!/^https?:$/i.test(absolute.protocol)) return rawUrl;
      return '/asset?sitePath=' + encodeURIComponent(sitePath) + '&url=' + encodeURIComponent(absolute.href) + '&method=' + encodeURIComponent((method || 'GET').toUpperCase());
    } catch (_) {
      return rawUrl;
    }
  };

  const originalFetch = window.fetch ? window.fetch.bind(window) : null;
  if (originalFetch) {
    window.fetch = (input, init = {}) => {
      const method = (init && init.method) || (input && input.method) || 'GET';
      if (typeof input === 'string') {
        return originalFetch(toReplayUrl(input, method), init);
      }
      if (input && typeof input.url === 'string') {
        return originalFetch(toReplayUrl(input.url, method), init);
      }
      return originalFetch(input, init);
    };
  }

  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    const rewritten = typeof url === 'string' ? toReplayUrl(url, method) : url;
    return originalOpen.call(this, method, rewritten, ...rest);
  };

  if (navigator && typeof navigator.sendBeacon === 'function') {
    const originalSendBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => originalSendBeacon(toReplayUrl(url, 'POST'), data);
  }
})();
</script>
`;

    if (html.includes('</head>')) return html.replace('</head>', `${replayScript}</head>`);
    if (html.includes('<body')) return html.replace(/<body[^>]*>/i, (tag) => `${tag}${replayScript}`);
    return `${replayScript}${html}`;
}

function prepareHtmlForOfflineReplay(html, siteDir) {
    if (!ENABLE_LOCAL_REPLAY) return html;
    const rewritten = rewriteHtmlToLocalAssets(html, siteDir);
    return injectOfflineReplayScript(rewritten, siteDir);
}

function isSafeSitePath(sitePath) {
    return Boolean(sitePath) && sitePath.startsWith(STORAGE_DIR) && !sitePath.includes('..');
}

function loadNetworkManifest(siteDir) {
    const networkManifestFile = path.join(siteDir, 'network_manifest.json');
    if (!fs.existsSync(networkManifestFile)) return [];
    try {
        const parsed = JSON.parse(fs.readFileSync(networkManifestFile, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        return [];
    }
}

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteHtmlToLocalAssets(html, siteDir) {
    if (!ENABLE_LOCAL_REPLAY) return html;
    const manifest = loadNetworkManifest(siteDir);
    if (!manifest.length) return html;

    let rewritten = html;
    manifest.forEach((entry) => {
        if (!entry || !entry.url || !entry.bodyPath) return;
        const localUrl = `/asset?sitePath=${encodeURIComponent(siteDir)}&url=${encodeURIComponent(entry.url)}`;
        rewritten = rewritten.replace(new RegExp(escapeRegExp(entry.url), 'g'), localUrl);
    });

    return rewritten;
}

function resolveBrowserExecutable() {
    const candidates = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable'
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }

    return null;
}


app.get('/events', (req, res) => {
    console.log('[SSE] Client connected to event stream.');
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    req.socket.setNoDelay(true); // Disable Nagle's algorithm for immediate sending
    res.flushHeaders();

    // Send a connection confirmation event immediately
    res.write(`data: ${JSON.stringify({ type: 'status', message: 'Connection established.' })}\n\n`);

    const listener = (data) => {
        console.log(`[SSE] Sending event: ${JSON.stringify(data).substring(0, 100)}...`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    sseEvents.on('update', listener);
    console.log('[SSE] Event listener attached.');

    const pingInterval = setInterval(() => {
        res.write(': ping\n\n'); // SSE comment for keep-alive
    }, 5000); // Send a ping every 5 seconds

    req.on('close', () => {
        console.log('[SSE] Client disconnected.');
        sseEvents.removeListener('update', listener);
        clearInterval(pingInterval);
    });
});

app.get('/events-poll', (req, res) => {
    const sinceRaw = req.query.since;
    const since = Number.isFinite(Number(sinceRaw)) ? Number(sinceRaw) : 0;
    const events = eventHistory.filter((entry) => entry.id > since);
    res.json({ latest: eventSeq, events });
});


app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Deep Offline Loader</title>
            <style>
                body, html { margin: 0; padding: 0; height: 100%; width: 100%; font-family: sans-serif; background: #1a1a1a; color: white; overflow: hidden; display: flex; flex-direction: column; }
                #navbar { display: flex; align-items: center; justify-content: center; padding: 10px; background: #2d2d2d; z-index: 10; border-bottom: 2px solid #444; }
                input { flex-grow: 1; padding: 10px; border-radius: 4px 0 0 4px; border: 1px solid #444; background: #333; color: white; outline: none; }
                button { padding: 10px 20px; border-radius: 0 4px 4px 0; border: none; background: #007bff; color: white; cursor: pointer; font-weight: bold; }
                .download-button { border-radius: 4px; margin-left: 10px; }
                #status { margin-left: 20px; color: #00ff00; font-family: monospace; }
                #gameViewport { flex-grow: 1; width: 100%; background: #000; }
                iframe { width: 100%; height: 100%; border: none; }
            </style>
        </head>
        <body>
            <div id="navbar">
                <input type="text" id="urlInput" placeholder="Enter full URL (e.g. site.com/game)">
                <button id="loadButton">LOAD & SAVE</button>
                <button class="download-button" onclick="downloadCurrentSite()">DOWNLOAD CURRENT</button>
                <div id="status">Ready</div>
            </div>
            <div id="gameViewport">
                <iframe id="displayFrame" style="display: none;"></iframe>
            </div>

            <script>
                let usePolling = false;
                let latestEventId = 0;
                let currentRenderedSitePath = null;
                let currentRenderedPageVersion = null;

                function applyUpdate(data) {
                    const status = document.getElementById('status');
                    const iframe = document.getElementById('displayFrame');

                    status.innerText = '📡 ' + data.message;
                    if (data.type === 'complete') {
                        iframe.style.display = 'block';
                        currentSitePath = data.sitePath || null; // Store for download

                        const nextSitePath = data.sitePath || null;
                        const nextPageVersion = data.pageVersion || null;
                        const shouldReloadFrame = currentRenderedSitePath !== nextSitePath || currentRenderedPageVersion !== nextPageVersion;

                        if (shouldReloadFrame) {
                            if (data.sitePath) {
                                iframe.src = '/view-site?sitePath=' + encodeURIComponent(data.sitePath);
                            } else if (data.html) {
                                iframe.srcdoc = data.html;
                            }
                            currentRenderedSitePath = nextSitePath;
                            currentRenderedPageVersion = nextPageVersion;
                        }

                        status.innerText = data.fromCache ? "📁 [LOCAL] " + data.path : "🌐 [SAVED] " + data.path;

                        window.onmessage = (e) => {
                            if(e.data.type === 'navigate') loadGame(e.data.url);
                        };
                    } else if (data.type === 'error') {
                        status.innerText = "❌ Error: " + data.message;
                    }
                }

                async function syncLatestEventCursor() {
                    try {
                        const response = await fetch('/events-poll?since=0', {
                            headers: { 'Accept': 'application/json', 'ngrok-skip-browser-warning': 'true' }
                        });
                        if (!response.ok) return;
                        const payload = await response.json();
                        latestEventId = payload.latest || 0;
                    } catch (error) {
                        console.warn('Failed to sync latest event cursor:', error.message);
                    }
                }

                function ensurePolling() {
                    if (usePolling) return;
                    usePolling = true;
                    pollEvents();
                }

                async function pollEvents() {
                    if (!usePolling) return;
                    try {
                        const response = await fetch('/events-poll?since=' + latestEventId, {
                            headers: { 'Accept': 'application/json', 'ngrok-skip-browser-warning': 'true' }
                        });
                        if (response.ok) {
                            const payload = await response.json();
                            latestEventId = payload.latest || latestEventId;
                            (payload.events || []).forEach((entry) => applyUpdate(entry.data));
                        }
                    } catch (error) {
                        console.warn('Polling events failed:', error.message);
                    } finally {
                        setTimeout(pollEvents, 1000);
                    }
                }

                const eventSource = new EventSource('/events?ngrok-skip-browser-warning=true');
                eventSource.onmessage = function(event) {
                    let data;
                    try {
                        data = JSON.parse(event.data);
                    } catch (parseError) {
                        console.warn('Non-JSON SSE payload received:', event.data?.slice?.(0, 120));
                        return;
                    }
                    applyUpdate(data);
                };
                eventSource.onerror = function(err) {
                    console.error('EventSource failed:', err);
                    document.getElementById('status').innerText = 'ℹ️ Using polling updates (SSE unavailable on this connection).';
                    ensurePolling();
                };

                document.addEventListener('DOMContentLoaded', () => {
                    const loadButton = document.getElementById('loadButton');
                    loadButton.addEventListener('click', () => loadGame());
                });

                let currentSitePath = null;

                async function loadGame(targetUrl) {
                    const url = targetUrl || document.getElementById('urlInput').value;
                    if (!url) return;
                    if (targetUrl) document.getElementById('urlInput').value = targetUrl;
                    
                    const status = document.getElementById('status');
                    const iframe = document.getElementById('displayFrame');

                    status.innerText = "⏳ Requesting capture...";
                    iframe.style.display = "none";
                    currentSitePath = null; // Reset on new load

                    try {
                        await syncLatestEventCursor();
                        // Send a non-blocking request to start capture
                        const response = await fetch('/capture-start', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Accept': 'application/json',
                                'ngrok-skip-browser-warning': 'true'
                            },
                            body: JSON.stringify({ url })
                        });

                        if (response.ok) {
                            status.innerText = "📡 Server is capturing...";
                            // Further updates will come via SSE or polling fallback
                            ensurePolling();
                        } else {
                            status.innerText = "❌ Server failed to start capture (HTTP " + response.status + ").";
                        }
                    } catch (err) {
                        status.innerText = "❌ Client error: " + err.message;
                    }
                }

                function downloadCurrentSite() {
                    if (currentSitePath) {
                        window.location.href = '/download-current-site?sitePath=' + encodeURIComponent(currentSitePath);
                    } else {
                        document.getElementById('status').innerText = "ℹ️ No site is currently loaded to download.";
                    }
                }
            </script>
        </body>
        </html>
    `);
});

app.get('/view-site', (req, res) => {
    const sitePath = req.query.sitePath;
    if (!isSafeSitePath(sitePath)) {
        return res.status(400).send('Invalid site path.');
    }

    const siteFile = path.join(sitePath, 'index.html');
    if (!fs.existsSync(siteFile)) {
        return res.status(404).send('Saved page not found.');
    }

    const savedHtml = fs.readFileSync(siteFile, 'utf8');
    const preparedHtml = prepareHtmlForOfflineReplay(savedHtml, sitePath);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(preparedHtml);
});

// New route to download the currently viewed site as a zip file
app.get('/download-current-site', async (req, res) => {
    const sitePath = req.query.sitePath;
    console.log(`[DOWNLOAD] Request to download site from: ${sitePath}`);

    // Security: Ensure the path is within the STORAGE_DIR
    if (!isSafeSitePath(sitePath)) {
        console.error(`[DOWNLOAD] Invalid site path attempted: ${sitePath}`);
        return res.status(400).send('Invalid site path.');
    }

    if (!fs.existsSync(sitePath)) {
        console.error(`[DOWNLOAD] Site directory not found: ${sitePath}`);
        return res.status(404).send('Site not found.');
    }

    const zipFileName = path.basename(sitePath) + '.zip';
    const archive = archiver('zip', {
        zlib: { level: 9 }
    });

    res.attachment(zipFileName);
    archive.pipe(res);

    archive.directory(sitePath, false); // Append the directory contents to the archive
    archive.finalize();

    archive.on('warning', function(err) {
        if (err.code === 'ENOENT') {
            console.warn('[ARCHIVER] Warning:', err);
        } else {
            console.error('[ARCHIVER] Error:', err);
            // Don't send status here, as headers might already be sent
        }
    });

    archive.on('error', function(err) {
        console.error('[ARCHIVER] Critical error:', err);
        if (!res.headersSent) { // Only send error if headers haven't been sent yet
            res.status(500).send({ error: err.message });
        }
    });
});

app.get('/asset', (req, res) => {
    const sitePath = req.query.sitePath;
    const requestedUrl = req.query.url;

    if (!isSafeSitePath(sitePath) || !requestedUrl) {
        return res.status(400).send('Invalid asset request.');
    }

    const manifest = loadNetworkManifest(sitePath);
    const assetEntry = findAssetEntry(manifest, requestedUrl, req.query.method || 'GET');

    if (!assetEntry) {
        return res.status(404).send('Asset not found.');
    }

    const resolvedAssetPath = path.resolve(assetEntry.bodyPath);
    if (!resolvedAssetPath.startsWith(sitePath)) {
        return res.status(400).send('Invalid asset path.');
    }

    const contentType = assetEntry.headers && (assetEntry.headers['content-type'] || assetEntry.headers['Content-Type']);
    if (contentType) res.setHeader('Content-Type', contentType);
    return res.sendFile(resolvedAssetPath);
});

// DEPRECATED: This route downloads all saved sites.
app.get('/download-all-sites-DEPRECATED', async (req, res) => {
    const zipFileName = 'saved_sites.zip';
    const archive = archiver('zip', {
        zlib: { level: 9 } // Sets the compression level.
    });

    res.attachment(zipFileName); // Set the file name for download
    archive.pipe(res); // Pipe the archive to the response

    // Append all files from the STORAGE_DIR
    archive.directory(STORAGE_DIR, false); 

    archive.finalize(); // Finalize the archive (ie: we are done appending files)

    archive.on('warning', function(err) {
        if (err.code === 'ENOENT') {
            console.warn('[ARCHIVER] Warning:', err);
        } else {
            console.error('[ARCHIVER] Error:', err);
        }
    });

    archive.on('error', function(err) {
        console.error('[ARCHIVER] Critical error:', err);
        if (!res.headersSent) {
            res.status(500).send({ error: err.message });
        }
    });
});


// New endpoint to start the capture process in the background
app.post('/capture-start', (req, res) => {
    const targetUrl = req.body.url;
    console.log(`[API] /capture-start endpoint hit for URL: ${targetUrl}`);

    // Immediately respond to the client that the capture has started
    res.json({ status: 'started', message: 'Capture process initiated.' });

    // Launch the capture process in the background
    setImmediate(async () => {
        await captureSite(targetUrl);
    });
});

async function captureSite(targetUrl) {
    console.log(`[CAPTURE] captureSite function started for URL: ${targetUrl}`);
    publishUpdate( { type: 'status', message: `Starting capture for ${targetUrl}...` });

    if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;
    
    const urlObj = new URL(targetUrl);
    
    const safeHostname = urlObj.hostname.replace(/[^a-z0-9]/gi, '_');
    const safePath = urlObj.pathname.replace(/[^a-z0-9]/gi, '_');
    const siteDir = path.join(STORAGE_DIR, safeHostname, safePath);
    const siteFile = path.join(siteDir, 'index.html');
    const snapshotFile = path.join(siteDir, 'snapshot.mhtml');

    const hasCachedHtml = fs.existsSync(siteFile);
    let cachedHtml = null;
    if (hasCachedHtml) {
        cachedHtml = fs.readFileSync(siteFile, 'utf8');
        const cachedPageVersion = String(fs.statSync(siteFile).mtimeMs);
        publishUpdate( { type: 'complete', fromCache: true, path: urlObj.pathname, sitePath: siteDir, pageVersion: cachedPageVersion, message: `Loaded from saved cache: ${urlObj.pathname}` });
        publishUpdate( { type: 'status', message: 'Using saved site (browser refresh skipped).' });
        return;
    }

    publishUpdate( { type: 'status', message: `Fetching new page: ${targetUrl}` });
    console.log(`[FETCH] Capturing new page: ${targetUrl}`);
    let browser;
    let userDataDir = null;
    try {
        publishUpdate( { type: 'status', message: 'Launching browser...' });
        console.log('[LOG] Launching browser...');
        const executablePath = resolveBrowserExecutable();
        userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dol-puppeteer-profile-'));
        const launchOptions = {
            headless: true,
            userDataDir,
            args: [
                '--disable-web-security',
                '--no-sandbox', // Required for Docker/some Linux environments
                '--disable-setuid-sandbox' // Required for Docker/some Linux environments
            ]
        };

        if (executablePath) {
            launchOptions.executablePath = executablePath;
            console.log(`[LOG] Using browser executable at ${executablePath}`);
            publishUpdate( { type: 'status', message: `Using browser executable at ${executablePath}` });
        } else {
            console.log('[LOG] No system Chromium found, using Puppeteer default executable resolution.');
            publishUpdate( { type: 'status', message: 'No system Chromium found, using Puppeteer default executable.' });
        }

        browser = await puppeteer.launch(launchOptions);
        console.log('[LOG] Browser launched.');
        publishUpdate( { type: 'status', message: 'Browser launched.' });

        publishUpdate( { type: 'status', message: 'Creating new page...' });
        const page = await browser.newPage();
        console.log('[LOG] New page created.');
        publishUpdate( { type: 'status', message: 'New page created.' });

        await page.setCacheEnabled(false);
        const networkDir = path.join(siteDir, 'network_assets');
        const networkCapture = setupNetworkCapture(page, networkDir);
        publishUpdate( { type: 'status', message: 'Network capture enabled (saving all requested assets).' });

        publishUpdate( { type: 'status', message: 'Bypassing CSP...' });
        await page.setBypassCSP(true);
        console.log('[LOG] Bypassing CSP.');
        publishUpdate( { type: 'status', message: 'CSP bypassed.' });


        publishUpdate( { type: 'status', message: `Navigating to ${targetUrl}...` });
        console.log(`[LOG] Navigating to ${targetUrl}...`);
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        console.log('[LOG] Navigation complete.');
        publishUpdate( { type: 'status', message: 'Navigation complete.' });


        publishUpdate( { type: 'status', message: 'Evaluating page content...' });
        const gameData = await page.evaluate(() => {
            // Hijack links to keep them in our system
            document.querySelectorAll('a').forEach(link => {
                link.onclick = (e) => {
                    e.preventDefault();
                    window.parent.postMessage({type: 'navigate', url: link.href}, '*');
                };
            });
            return document.documentElement.outerHTML;
        });
        console.log('[LOG] Page evaluated.');
        publishUpdate( { type: 'status', message: 'Page content evaluated.' });

        publishUpdate( { type: 'status', message: 'Capturing full page snapshot (including iframe content)...' });
        let snapshotData = null;
        try {
            const cdpSession = await page.target().createCDPSession();
            await cdpSession.send('Page.enable');
            const snapshot = await cdpSession.send('Page.captureSnapshot', { format: 'mhtml' });
            snapshotData = snapshot.data;
            console.log('[LOG] Full MHTML snapshot captured.');
            publishUpdate( { type: 'status', message: 'Full page snapshot captured.' });
        } catch (snapshotError) {
            console.warn('[WARN] MHTML snapshot failed, continuing without snapshot.mhtml:', snapshotError.message);
            publishUpdate( { type: 'status', message: `MHTML snapshot unavailable (${snapshotError.message}). Continuing...` });
        }

        publishUpdate( { type: 'status', message: 'Finalizing network asset capture...' });
        const capturedRequests = await networkCapture.finalize();
        const networkManifestFile = path.join(siteDir, 'network_manifest.json');


        // Ensure directories exist and save
        publishUpdate( { type: 'status', message: `Ensuring directory exists: ${siteDir}` });
        if (!fs.existsSync(siteDir)) fs.mkdirSync(siteDir, { recursive: true });

        const htmlToStore = hasCachedHtml && cachedHtml ? cachedHtml : gameData;
        if (!hasCachedHtml) {
            publishUpdate( { type: 'status', message: `Saving site to ${siteFile}` });
            fs.writeFileSync(siteFile, htmlToStore);
        } else {
            publishUpdate( { type: 'status', message: 'Keeping cached HTML and updating dependency files only.' });
        }

        if (snapshotData) fs.writeFileSync(snapshotFile, snapshotData);

        let existingManifest = [];
        if (fs.existsSync(networkManifestFile)) {
            try {
                existingManifest = JSON.parse(fs.readFileSync(networkManifestFile, 'utf8'));
                if (!Array.isArray(existingManifest)) existingManifest = [];
            } catch (error) {
                existingManifest = [];
            }
        }

        const mergedManifest = mergeNetworkManifests(existingManifest, capturedRequests);
        fs.writeFileSync(networkManifestFile, JSON.stringify(mergedManifest, null, 2));

        console.log(`[LOG] Dependency refresh complete for ${siteFile}`);
        publishUpdate( { type: 'status', message: `Dependencies refreshed (${capturedRequests.length} new requests, ${mergedManifest.length} total tracked).` });

        publishUpdate( { type: 'status', message: 'Closing browser...' });
        await browser.close();
        browser = null;
        fs.rmSync(userDataDir, { recursive: true, force: true });
        console.log('[LOG] Browser closed.');
        publishUpdate( { type: 'status', message: 'Browser closed.' });


        if (!hasCachedHtml) {
            const savedPageVersion = String(fs.statSync(siteFile).mtimeMs);
            publishUpdate( { type: 'complete', fromCache: false, path: urlObj.pathname, sitePath: siteDir, pageVersion: savedPageVersion, message: `Page captured with ${capturedRequests.length} assets: ${urlObj.pathname}` });
        } else {
            publishUpdate( { type: 'status', message: `Dependency refresh complete for cached page: ${urlObj.pathname}` });
        }

    } catch (error) {
        console.error('[ERROR] An error occurred during capture:', error);
        publishUpdate( { type: 'error', message: `Capture failed: ${error.message}` });
        if (browser) {
            publishUpdate( { type: 'status', message: 'Closing browser due to error...' });
            await browser.close();
        }
        if (typeof userDataDir === 'string') {
            fs.rmSync(userDataDir, { recursive: true, force: true });
        }
    }
}


app.listen(port, () => {
    console.log(`🚀 Deep Downloader: http://localhost:${port}`);
});
