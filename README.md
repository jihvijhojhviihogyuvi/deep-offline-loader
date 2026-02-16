# Deep Offline Loader

This project is a web application that allows you to download and archive websites for offline viewing. It uses Node.js, Express, and Puppeteer to capture the full HTML of a given URL and all its assets.

It saves the page HTML as captured (without rewriting iframe `src` to `srcdoc`) and also saves a full-page `snapshot.mhtml` using Chrome's `Page.captureSnapshot` as a fallback artifact.

Each capture now refreshes dependency downloads (cache disabled during capture) and records every HTTP(S) response requested during that run into `network_assets/` plus a `network_manifest.json`. When loading from saved HTML, known captured remote URLs are rewritten to local `/asset` URLs, and an offline replay shim rewrites runtime `fetch`/XHR/beacon requests to local assets too, while cached `index.html` remains unchanged on disk.

Capture launches now use an isolated temporary Chromium profile per run to avoid `userDataDir` lock conflicts when multiple captures are started close together.

For tunnel/proxy setups (such as ngrok), capture start requests now send `ngrok-skip-browser-warning: true` and the UI gracefully handles non-JSON HTML tunnel responses instead of crashing with `Unexpected token "<"`.
SSE responses now set anti-buffering headers and the UI safely ignores non-JSON SSE payloads, which improves reliability when traversing mobile proxies/tunnels.
When a page is marked complete, the app now loads it through local `/view-site` rendering (instead of depending on huge HTML blobs in SSE), which is more tunnel-friendly on mobile.
The frontend now falls back to `/events-poll` long-polling when SSE is blocked by a tunnel/proxy, and immediately starts polling updates on capture start to avoid first-attempt stalls over ngrok/mobile networks.

## How to Run

1.  **Install Dependencies:**
    You will need to have Node.js and npm installed. You will also need to have Chromium installed for Puppeteer to work correctly.

    *   **In Termux:**
        You will need to use a proot-distro environment like Alpine to run this application. The following instructions assume you have an Alpine container set up.

        First, install the necessary dependencies in your Alpine container:
        ```bash
        proot-distro login alpine -- sh -c "apk add --no-cache chromium-browser xvfb"
        ```

        Then, install the node modules in the project directory from within the Alpine container:
        ```bash
        proot-distro login alpine -- sh -c "cd /data/data/com.termux/files/home/deep-offline-loader && npm install"
        ```

2.  **Start the Application:**
    You can start the application by running the following command from within the Alpine container:

    ```bash
    proot-distro login alpine -- sh -c "export NODE_PATH=/data/data/com.termux/files/home/deep-offline-loader/node_modules && xvfb-run -a node /data/data/com.termux/files/home/deep-offline-loader/web_fixed.js"
    ```

3.  **Start the Tunnel (Optional):**
    If you want to access the application from a different network, you can use the provided `start_tunnel.sh` script. This script uses ngrok to create a tunnel to your local server.

    ```bash
    ./start_tunnel.sh
    ```

## Code

Here is the full code for the `web_fixed.js` file:

```javascript
const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const EventEmitter = require('events');

const app = express();
const port = 8000;

const sseEvents = new EventEmitter();
sseEvents.setMaxListeners(0); 

app.use(express.json());

const STORAGE_DIR = path.join(__dirname, 'saved_sites');
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR);

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

    // 1. Check if this specific page exists
    sseEvents.emit('update', { type: 'status', message: `Checking cache for ${targetUrl}...` });
    if (fs.existsSync(siteFile)) {
        console.log(`[LOCAL] Loading from: ${siteFile}`);
        sseEvents.emit('update', { type: 'status', message: `Loading from cache: ${siteFile}` });
        const savedHtml = fs.readFileSync(siteFile, 'utf8');
        sseEvents.emit('update', { type: 'complete', html: savedHtml, fromCache: true, path: urlObj.pathname, sitePath: siteDir, message: `Loaded from cache: ${urlObj.pathname}` });
        return;
    }

    // 2. Otherwise, download it
    console.log(`[FETCH] Capturing new page: ${targetUrl}`);
    sseEvents.emit('update', { type: 'status', message: `Fetching new page: ${targetUrl}` });
    let browser;
    try {
        sseEvents.emit('update', { type: 'status', message: 'Launching browser...' });
        console.log('[LOG] Launching browser...');
        browser = await puppeteer.launch({ 
            headless: true, 
            executablePath: '/usr/bin/chromium-browser', // Specify the path to the system Chromium
            args: [
                '--disable-web-security',
                '--no-sandbox', // Required for Docker/some Linux environments
                '--disable-setuid-sandbox' // Required for Docker/some Linux environments
            ] 
        });
        console.log('[LOG] Browser launched.');
        sseEvents.emit('update', { type: 'status', message: 'Browser launched.' });

        sseEvents.emit('update', { type: 'status', message: 'Creating new page...' });
        const page = await browser.newPage();
        console.log('[LOG] New page created.');
        sseEvents.emit('update', { type: 'status', message: 'New page created.' });

        sseEvents.emit('update', { type: 'status', message: 'Bypassing CSP...' });
        await page.setBypassCSP(true);
        console.log('[LOG] Bypassing CSP.');
        sseEvents.emit('update', { type: 'status', message: 'CSP bypassed.' });


        sseEvents.emit('update', { type: 'status', message: `Navigating to ${targetUrl}...` });
        console.log(`[LOG] Navigating to ${targetUrl}...`);
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        console.log('[LOG] Navigation complete.');
        sseEvents.emit('update', { type: 'status', message: 'Navigation complete.' });


        sseEvents.emit('update', { type: 'status', message: 'Evaluating page content...' });
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
        sseEvents.emit('update', { type: 'status', message: 'Page content evaluated.' });


        // Ensure directories exist and save
        sseEvents.emit('update', { type: 'status', message: `Ensuring directory exists: ${siteDir}` });
        if (!fs.existsSync(siteDir)) fs.mkdirSync(siteDir, { recursive: true });
        sseEvents.emit('update', { type: 'status', message: `Saving site to ${siteFile}` });
        fs.writeFileSync(siteFile, gameData);
        console.log(`[LOG] Site saved to ${siteFile}`);
        sseEvents.emit('update', { type: 'status', message: `Site saved to ${siteFile}` });

        sseEvents.emit('update', { type: 'status', message: 'Closing browser...' });
        await browser.close();
        console.log('[LOG] Browser closed.');
        sseEvents.emit('update', { type: 'status', message: 'Browser closed.' });


        sseEvents.emit('update', { type: 'complete', html: gameData, fromCache: false, path: urlObj.pathname, sitePath: siteDir, message: `Page captured: ${urlObj.pathname}` });

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

Note: local replay URL/script rewriting is enabled by default (`ENABLE_LOCAL_REPLAY = true`).

MHTML snapshot capture is best-effort; if `Page.captureSnapshot` fails on a site/browser build, capture continues and still saves HTML plus network assets.

The viewer now tracks a page version and will not reload the iframe for duplicate `complete` updates unless the saved page content actually changed.

Using saved cache now skips browser recapture by default, so opening an already-downloaded site does not relaunch Chromium unless cache is missing.

UI now includes an `UPDATE PAGE` button that forces a recapture even when a saved cache exists; regular `LOAD & SAVE` uses cached page immediately when available.

Normal `LOAD & SAVE` now checks `/check-cache` first and directly opens `/view-site` for saved pages without starting a capture job, so cached pages stay stable and do not switch to background update flow unless you press `UPDATE PAGE`.
