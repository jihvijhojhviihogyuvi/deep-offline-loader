const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const EventEmitter = require('events');
const crypto = require('crypto');

const app = express();
const port = 8000;

const sseEvents = new EventEmitter();
sseEvents.setMaxListeners(0); 

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
                const eventSource = new EventSource('/events');
                eventSource.onmessage = function(event) {
                    const data = JSON.parse(event.data);
                    const status = document.getElementById('status');
                    const iframe = document.getElementById('displayFrame');

                    status.innerText = '📡 ' + data.message;
                    if (data.type === 'complete' && data.html) {
                        iframe.style.display = 'block';
                        iframe.srcdoc = data.html;
                        currentSitePath = data.sitePath; // Store for download
                        status.innerText = data.fromCache ? "📁 [LOCAL] " + data.path : "🌐 [SAVED] " + data.path;

                        window.onmessage = (e) => {
                            if(e.data.type === 'navigate') loadGame(e.data.url);
                        };
                    } else if (data.type === 'error') {
                        status.innerText = "❌ Error: " + data.message;
                    }
                };
                eventSource.onerror = function(err) {
                    console.error('EventSource failed:', err);
                    document.getElementById('status').innerText = '❌ Lost connection to updates.';
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
                        // Send a non-blocking request to start capture
                        const response = await fetch('/capture-start', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ url })
                        });
                        const result = await response.json();
                        if (result.status === 'started') {
                            status.innerText = "📡 Server is capturing...";
                            // Further updates will come via SSE
                        } else {
                            status.innerText = "❌ Server failed to start capture: " + (result.message || 'Unknown error');
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

// New route to download the currently viewed site as a zip file
app.get('/download-current-site', async (req, res) => {
    const sitePath = req.query.sitePath;
    console.log(`[DOWNLOAD] Request to download site from: ${sitePath}`);

    // Security: Ensure the path is within the STORAGE_DIR
    if (!sitePath || !sitePath.startsWith(STORAGE_DIR) || sitePath.includes('..')) {
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
    sseEvents.emit('update', { type: 'status', message: `Starting capture for ${targetUrl}...` });

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
        sseEvents.emit('update', { type: 'complete', html: cachedHtml, fromCache: true, path: urlObj.pathname, sitePath: siteDir, message: `Loaded cached HTML, refreshing dependencies: ${urlObj.pathname}` });
    }

    // Refresh dependency capture every run while preserving existing cached HTML unless missing.
    sseEvents.emit('update', { type: 'status', message: `Refreshing assets for ${targetUrl}...` });
    console.log(`[FETCH] Refreshing dependency capture for: ${targetUrl}`);
    sseEvents.emit('update', { type: 'status', message: `Fetching new page: ${targetUrl}` });
    let browser;
    try {
        sseEvents.emit('update', { type: 'status', message: 'Launching browser...' });
        console.log('[LOG] Launching browser...');
        const executablePath = resolveBrowserExecutable();
        const launchOptions = {
            headless: true,
            args: [
                '--disable-web-security',
                '--no-sandbox', // Required for Docker/some Linux environments
                '--disable-setuid-sandbox' // Required for Docker/some Linux environments
            ]
        };

        if (executablePath) {
            launchOptions.executablePath = executablePath;
            console.log(`[LOG] Using browser executable at ${executablePath}`);
            sseEvents.emit('update', { type: 'status', message: `Using browser executable at ${executablePath}` });
        } else {
            console.log('[LOG] No system Chromium found, using Puppeteer default executable resolution.');
            sseEvents.emit('update', { type: 'status', message: 'No system Chromium found, using Puppeteer default executable.' });
        }

        browser = await puppeteer.launch(launchOptions);
        console.log('[LOG] Browser launched.');
        sseEvents.emit('update', { type: 'status', message: 'Browser launched.' });

        sseEvents.emit('update', { type: 'status', message: 'Creating new page...' });
        const page = await browser.newPage();
        console.log('[LOG] New page created.');
        sseEvents.emit('update', { type: 'status', message: 'New page created.' });

        await page.setCacheEnabled(false);
        const networkDir = path.join(siteDir, 'network_assets');
        const networkCapture = setupNetworkCapture(page, networkDir);
        sseEvents.emit('update', { type: 'status', message: 'Network capture enabled (saving all requested assets).' });

        sseEvents.emit('update', { type: 'status', message: 'Bypassing CSP...' });
        await page.setBypassCSP(true);
        console.log('[LOG] Bypassing CSP.');
        sseEvents.emit('update', { type: 'status', message: 'CSP bypassed.' });


        sseEvents.emit('update', { type: 'status', message: `Navigating to ${targetUrl}...` });
        console.log(`[LOG] Navigating to ${targetUrl}...`);
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        console.log('[LOG] Navigation complete.');
        sseEvents.emit('update', { type: 'status', message: 'Navigation complete.' });


        sseEvents.emit('update', { type: 'status', message: 'Inlining iframe content for offline use...' });
        const mainFrame = page.mainFrame();
        const frameDepth = (frame) => {
            let depth = 0;
            let current = frame;
            while (current.parentFrame()) {
                depth += 1;
                current = current.parentFrame();
            }
            return depth;
        };

        const frameHtmlByUrl = new Map();
        const nonMainFrames = page.frames().filter(frame => frame !== mainFrame);
        nonMainFrames.sort((a, b) => frameDepth(b) - frameDepth(a));

        for (const frame of nonMainFrames) {
            const childSnapshots = frame.childFrames()
                .map(child => ({ url: child.url(), html: frameHtmlByUrl.get(child.url()) }))
                .filter(snapshot => snapshot.url && snapshot.html);

            await frame.evaluate((snapshots) => {
                const snapshotsByUrl = new Map();
                snapshots.forEach(snapshot => {
                    if (!snapshotsByUrl.has(snapshot.url)) snapshotsByUrl.set(snapshot.url, []);
                    snapshotsByUrl.get(snapshot.url).push(snapshot.html);
                });

                document.querySelectorAll('iframe').forEach((iframe) => {
                    const sourceUrl = iframe.src;
                    const queue = snapshotsByUrl.get(sourceUrl);
                    if (!queue || queue.length === 0) return;
                    const html = queue.shift();
                    iframe.setAttribute('data-offline-src', sourceUrl);
                    iframe.setAttribute('srcdoc', html);
                    iframe.removeAttribute('src');
                });
            }, childSnapshots);

            const frameHtml = await frame.content();
            if (frame.url() && frameHtml) frameHtmlByUrl.set(frame.url(), frameHtml);
        }

        sseEvents.emit('update', { type: 'status', message: 'Evaluating page content...' });
        const topLevelChildSnapshots = mainFrame.childFrames()
            .map(child => ({ url: child.url(), html: frameHtmlByUrl.get(child.url()) }))
            .filter(snapshot => snapshot.url && snapshot.html);

        const gameData = await page.evaluate((snapshots) => {
            const snapshotsByUrl = new Map();
            snapshots.forEach(snapshot => {
                if (!snapshotsByUrl.has(snapshot.url)) snapshotsByUrl.set(snapshot.url, []);
                snapshotsByUrl.get(snapshot.url).push(snapshot.html);
            });

            document.querySelectorAll('iframe').forEach((iframe) => {
                const sourceUrl = iframe.src;
                const queue = snapshotsByUrl.get(sourceUrl);
                if (!queue || queue.length === 0) return;
                const html = queue.shift();
                iframe.setAttribute('data-offline-src', sourceUrl);
                iframe.setAttribute('srcdoc', html);
                iframe.removeAttribute('src');
            });

            // Hijack links to keep them in our system
            document.querySelectorAll('a').forEach(link => {
                link.onclick = (e) => {
                    e.preventDefault();
                    window.parent.postMessage({type: 'navigate', url: link.href}, '*');
                };
            });
            return document.documentElement.outerHTML;
        }, topLevelChildSnapshots);
        console.log('[LOG] Page evaluated.');
        sseEvents.emit('update', { type: 'status', message: 'Page content evaluated with iframe content inlined.' });

        sseEvents.emit('update', { type: 'status', message: 'Capturing full page snapshot (including iframe content)...' });
        const cdpSession = await page.target().createCDPSession();
        await cdpSession.send('Page.enable');
        const snapshot = await cdpSession.send('Page.captureSnapshot', { format: 'mhtml' });
        console.log('[LOG] Full MHTML snapshot captured.');
        sseEvents.emit('update', { type: 'status', message: 'Full page snapshot captured.' });

        sseEvents.emit('update', { type: 'status', message: 'Finalizing network asset capture...' });
        const capturedRequests = await networkCapture.finalize();
        const networkManifestFile = path.join(siteDir, 'network_manifest.json');


        // Ensure directories exist and save
        sseEvents.emit('update', { type: 'status', message: `Ensuring directory exists: ${siteDir}` });
        if (!fs.existsSync(siteDir)) fs.mkdirSync(siteDir, { recursive: true });

        const htmlToStore = hasCachedHtml && cachedHtml ? cachedHtml : gameData;
        if (!hasCachedHtml) {
            sseEvents.emit('update', { type: 'status', message: `Saving site to ${siteFile}` });
            fs.writeFileSync(siteFile, htmlToStore);
        } else {
            sseEvents.emit('update', { type: 'status', message: 'Keeping cached HTML and updating dependency files only.' });
        }

        fs.writeFileSync(snapshotFile, snapshot.data);

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
        sseEvents.emit('update', { type: 'status', message: `Dependencies refreshed (${capturedRequests.length} new requests, ${mergedManifest.length} total tracked).` });

        sseEvents.emit('update', { type: 'status', message: 'Closing browser...' });
        await browser.close();
        console.log('[LOG] Browser closed.');
        sseEvents.emit('update', { type: 'status', message: 'Browser closed.' });


        if (!hasCachedHtml) {
            sseEvents.emit('update', { type: 'complete', html: gameData, fromCache: false, path: urlObj.pathname, sitePath: siteDir, message: `Page captured with ${capturedRequests.length} assets: ${urlObj.pathname}` });
        } else {
            sseEvents.emit('update', { type: 'status', message: `Dependency refresh complete for cached page: ${urlObj.pathname}` });
        }

    } catch (error) {
        console.error('[ERROR] An error occurred during capture:', error);
        sseEvents.emit('update', { type: 'error', message: `Capture failed: ${error.message}` });
        if (browser) {
            sseEvents.emit('update', { type: 'status', message: 'Closing browser due to error...' });
            await browser.close();
        }
    }
}


app.listen(port, () => {
    console.log(`🚀 Deep Downloader: http://localhost:${port}`);
});
