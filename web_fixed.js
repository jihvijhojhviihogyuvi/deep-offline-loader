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




function injectBaseHref(html, originalUrl) {
    if (!originalUrl) return html;
    const baseTag = `<base href="${originalUrl}">`;
    if (/<base\s+href=/i.test(html)) return html;
    if (html.includes('</head>')) return html.replace('</head>', `${baseTag}</head>`);
    if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (tag) => `${tag}<head>${baseTag}</head>`);
    return `${baseTag}${html}`;
}

function buildSitePaths(targetUrl) {
    let normalizedUrl = targetUrl;
    if (!normalizedUrl.startsWith('http')) normalizedUrl = 'https://' + normalizedUrl;
    const urlObj = new URL(normalizedUrl);

    const safeHostname = urlObj.hostname.replace(/[^a-z0-9]/gi, '_');
    const safePath = urlObj.pathname.replace(/[^a-z0-9]/gi, '_');
    const siteDir = path.join(STORAGE_DIR, safeHostname, safePath);
    const siteFile = path.join(siteDir, 'index.html');

    return { normalizedUrl, urlObj, siteDir, siteFile };
}


function getBaseDomain(hostname) {
    const parts = String(hostname || '').toLowerCase().split('.').filter(Boolean);
    if (parts.length <= 2) return parts.join('.');
    return parts.slice(-2).join('.');
}

function shouldBlockRequestUrl(requestUrl, rootHostname) {
    try {
        const parsed = new URL(requestUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) return false;

        const host = parsed.hostname.toLowerCase();
        const root = String(rootHostname || '').toLowerCase();
        const baseRoot = getBaseDomain(root);
        const baseHost = getBaseDomain(host);

        const blockedHostPatterns = [
            'doubleclick.net',
            'googlesyndication.com',
            'googleadservices.com',
            'adservice.google.com',
            'googletagmanager.com',
            'google-analytics.com',
            'facebook.net',
            'facebook.com',
            'tiktok.com',
            'hotjar.com',
            'segment.com'
        ];

        if (blockedHostPatterns.some(pattern => host === pattern || host.endsWith(`.${pattern}`))) {
            return true;
        }

        const isFirstParty = host === root || host.endsWith(`.${root}`) || (baseRoot && baseHost === baseRoot);
        if (isFirstParty) return false;

        // Allow non-ad/tracker third-party resources (CDNs/payment/game backends) for compatibility.
        return false;
    } catch (error) {
        return false;
    }
}

async function applyRequestPolicy(page, rootHostname) {
    await page.setRequestInterception(true);
    page.on('request', (request) => {
        const requestUrl = request.url();
        if (shouldBlockRequestUrl(requestUrl, rootHostname)) {
            return request.abort('blockedbyclient');
        }
        return request.continue();
    });
}


function persistChromiumCache(userDataDir, siteDir) {
    if (!userDataDir || !fs.existsSync(userDataDir)) return;
    const targets = [
        ['Default/Cache', 'browser_cache/Default/Cache'],
        ['Default/Code Cache', 'browser_cache/Default/Code Cache'],
        ['Default/Service Worker', 'browser_cache/Default/Service Worker'],
        ['Default/IndexedDB', 'browser_cache/Default/IndexedDB'],
        ['Default/Local Storage', 'browser_cache/Default/Local Storage']
    ];

    targets.forEach(([sourceRel, destRel]) => {
        const source = path.join(userDataDir, sourceRel);
        const dest = path.join(siteDir, destRel);
        if (!fs.existsSync(source)) return;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.cpSync(source, dest, { recursive: true, force: true });
    });
}

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
      if (!rawUrl) return rawUrl;
      const text = String(rawUrl);
      if (text.startsWith('/replay-resource?') || text.startsWith('/asset?')) return rawUrl;
      const absolute = new URL(text, window.location.href);
      if (/\/replay-resource\?/i.test(absolute.pathname + absolute.search) || /\/asset\?/i.test(absolute.pathname + absolute.search)) return rawUrl;
      if (!/^https?:$/i.test(absolute.protocol)) return rawUrl;
      return '/replay-resource?sitePath=' + encodeURIComponent(sitePath) + '&url=' + encodeURIComponent(absolute.href) + '&method=' + encodeURIComponent((method || 'GET').toUpperCase());
    } catch (_) {
      return rawUrl;
    }
  };

  const shouldRewrite = (value) => {
    if (!value) return false;
    const trimmed = String(value).trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('#')) return false;
    if (/^(data:|blob:|javascript:|mailto:|tel:)/i.test(trimmed)) return false;
    return true;
  };

  const rewriteNodeUrl = (node, attribute) => {
    const value = node.getAttribute(attribute);
    if (!shouldRewrite(value)) return;
    node.setAttribute(attribute, toReplayUrl(value, 'GET'));
  };

  const rewriteSrcSet = (node) => {
    const srcset = node.getAttribute('srcset');
    if (!srcset) return;
    const rewritten = srcset
      .split(',')
      .map((part) => {
        const trimmed = part.trim();
        if (!trimmed) return trimmed;
        const [url, descriptor] = trimmed.split(/\s+/, 2);
        if (!shouldRewrite(url)) return trimmed;
        return descriptor ? toReplayUrl(url, 'GET') + ' ' + descriptor : toReplayUrl(url, 'GET');
      })
      .join(', ');
    node.setAttribute('srcset', rewritten);
  };

  const rewriteTree = (root) => {
    if (!root || !root.querySelectorAll) return;
    if (root.matches) {
      if (root.hasAttribute && root.hasAttribute('src')) rewriteNodeUrl(root, 'src');
      if (root.hasAttribute && root.hasAttribute('href')) rewriteNodeUrl(root, 'href');
      if (root.hasAttribute && root.hasAttribute('action')) rewriteNodeUrl(root, 'action');
      if (root.hasAttribute && root.hasAttribute('poster')) rewriteNodeUrl(root, 'poster');
      if (root.hasAttribute && root.hasAttribute('srcset')) rewriteSrcSet(root);
    }
    root.querySelectorAll('[src]').forEach((node) => rewriteNodeUrl(node, 'src'));
    root.querySelectorAll('[href]').forEach((node) => rewriteNodeUrl(node, 'href'));
    root.querySelectorAll('[action]').forEach((node) => rewriteNodeUrl(node, 'action'));
    root.querySelectorAll('[poster]').forEach((node) => rewriteNodeUrl(node, 'poster'));
    root.querySelectorAll('[srcset]').forEach((node) => rewriteSrcSet(node));
  };

  rewriteTree(document.documentElement || document);

  if (typeof MutationObserver === 'function') {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.target) {
          const attr = mutation.attributeName;
          if (attr === 'src' || attr === 'href' || attr === 'action' || attr === 'poster') {
            rewriteNodeUrl(mutation.target, attr);
          }
          if (attr === 'srcset') rewriteSrcSet(mutation.target);
        }
        mutation.addedNodes.forEach((node) => {
          if (node && node.nodeType === 1) rewriteTree(node);
        });
      });
    });
    observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'href', 'action', 'poster', 'srcset']
    });
  }

  document.addEventListener('DOMContentLoaded', () => rewriteTree(document.documentElement || document));

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

function rewriteHtmlAttributesToReplayProxy(html, siteDir, originalUrl) {
    if (!ENABLE_LOCAL_REPLAY || !originalUrl) return html;

    const shouldRewrite = (value) => {
        if (!value) return false;
        const trimmed = String(value).trim();
        if (!trimmed || trimmed.startsWith('#')) return false;
        if (/^(data:|blob:|javascript:|mailto:|tel:)/i.test(trimmed)) return false;
        return true;
    };

    const toAbsolute = (value) => {
        try {
            return new URL(value, originalUrl).href;
        } catch (error) {
            return null;
        }
    };

    const rewriteValue = (value, method = 'GET') => {
        if (!shouldRewrite(value)) return value;
        if (/^(\/replay-resource\?|\/asset\?)/i.test(value)) return value;
        const absolute = toAbsolute(value);
        if (!absolute || !/^https?:/i.test(absolute)) return value;
        return makeReplayProxyUrl(siteDir, absolute, method);
    };

    let rewritten = html;
    rewritten = rewritten.replace(/\b(src|href|poster)=(['"])(.*?)\2/gi, (match, attr, quote, value) => {
        return `${attr}=${quote}${rewriteValue(value, 'GET')}${quote}`;
    });

    rewritten = rewritten.replace(/\baction=(['"])(.*?)\1/gi, (match, quote, value) => {
        return `action=${quote}${rewriteValue(value, 'POST')}${quote}`;
    });

    rewritten = rewritten.replace(/\bsrcset=(['"])(.*?)\1/gi, (match, quote, value) => {
        const updated = value
            .split(',')
            .map((part) => {
                const trimmed = part.trim();
                if (!trimmed) return trimmed;
                const [rawUrl, descriptor] = trimmed.split(/\s+/, 2);
                const transformed = rewriteValue(rawUrl, 'GET');
                return descriptor ? `${transformed} ${descriptor}` : transformed;
            })
            .join(', ');
        return `srcset=${quote}${updated}${quote}`;
    });

    return rewritten;
}

function prepareHtmlForOfflineReplay(html, siteDir, originalUrl = null) {
    if (!ENABLE_LOCAL_REPLAY) return html;
    const rewrittenKnown = rewriteHtmlToLocalAssets(html, siteDir);
    const rewrittenWithRelativeUrls = rewriteHtmlAttributesToReplayProxy(rewrittenKnown, siteDir, originalUrl);
    return injectOfflineReplayScript(rewrittenWithRelativeUrls, siteDir);
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


function upsertManifestEntry(siteDir, entry) {
    const manifestFile = path.join(siteDir, 'network_manifest.json');
    const existing = loadNetworkManifest(siteDir);
    const merged = mergeNetworkManifests(existing, [entry]);
    fs.writeFileSync(manifestFile, JSON.stringify(merged, null, 2));
}

function findSavedAsset(siteDir, requestedUrl, method = 'GET') {
    const manifest = loadNetworkManifest(siteDir);
    return findAssetEntry(manifest, requestedUrl, method);
}

function makeReplayProxyUrl(siteDir, rawUrl, method = 'GET') {
    return `/replay-resource?sitePath=${encodeURIComponent(siteDir)}&url=${encodeURIComponent(rawUrl)}&method=${encodeURIComponent((method || 'GET').toUpperCase())}`;
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
                <button id="updateButton">UPDATE PAGE</button>
                <button class="download-button" onclick="downloadCurrentSite()">DOWNLOAD CURRENT</button>
                <div id="status">Ready</div>
            </div>
            <div id="gameViewport">
                <iframe id="displayFrame" style="display: none;"></iframe>
            </div>

            <script>
                let currentSitePath = null;

                document.addEventListener('DOMContentLoaded', () => {
                    const loadButton = document.getElementById('loadButton');
                    const updateButton = document.getElementById('updateButton');
                    loadButton.addEventListener('click', () => loadGame());
                    updateButton.addEventListener('click', () => loadGame(undefined, true));
                });

                async function loadFromCacheOnly(url, status, iframe) {
                    const cacheResponse = await fetch('/check-cache', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Accept': 'application/json',
                            'ngrok-skip-browser-warning': 'true'
                        },
                        body: JSON.stringify({ url })
                    });

                    if (!cacheResponse.ok) {
                        status.innerText = "❌ Cache check failed. Choose another site.";
                        return true;
                    }

                    const cacheResult = await cacheResponse.json();
                    if (cacheResult.hit && cacheResult.sitePath) {
                        iframe.style.display = 'block';
                        iframe.src = '/view-site?sitePath=' + encodeURIComponent(cacheResult.sitePath) + '&url=' + encodeURIComponent(url.startsWith('http') ? url : 'https://' + url);
                        currentSitePath = cacheResult.sitePath;
                        status.innerText = "📁 [LOCAL] " + (cacheResult.path || '/');
                        return true;
                    }

                    status.innerText = "ℹ️ Offline and this site is not saved. Choose another site.";
                    return true;
                }

                async function loadGame(targetUrl, forceRefresh = false) {
                    const url = targetUrl || document.getElementById('urlInput').value;
                    if (!url) return;
                    if (targetUrl) document.getElementById('urlInput').value = targetUrl;

                    const status = document.getElementById('status');
                    const iframe = document.getElementById('displayFrame');

                    status.innerText = forceRefresh ? "🔄 Updating page..." : "⏳ Checking saved cache...";
                    iframe.style.display = "none";
                    currentSitePath = null;

                    try {
                        if (!navigator.onLine) {
                            if (forceRefresh) {
                                status.innerText = "ℹ️ Offline mode: cannot update right now. Choose another site or reconnect.";
                                return;
                            }
                            await loadFromCacheOnly(url, status, iframe);
                            return;
                        }

                        const response = await fetch('/capture', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Accept': 'application/json',
                                'ngrok-skip-browser-warning': 'true'
                            },
                            body: JSON.stringify({ url, forceRefresh })
                        });

                        const data = await response.json();
                        if (!response.ok) {
                            status.innerText = "❌ Error: " + (data.error || ('HTTP ' + response.status));
                            return;
                        }

                        if (data.html) {
                            status.innerText = data.fromCache ? "📁 [LOCAL] " + data.path : "🌐 [SAVED] " + data.path;
                            iframe.style.display = 'block';
                            iframe.srcdoc = data.html;
                            currentSitePath = data.sitePath;

                            window.onmessage = (e) => {
                                if (e.data.type === 'navigate') loadGame(e.data.url);
                            };
                        }
                    } catch (err) {
                        status.innerText = "❌ Error: " + err.message;
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
    const originalUrl = typeof req.query.url === 'string' ? req.query.url : null;
    const preparedReplayHtml = prepareHtmlForOfflineReplay(savedHtml, sitePath, originalUrl);
    const preparedHtml = injectBaseHref(preparedReplayHtml, originalUrl);
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

app.all('/replay-resource', async (req, res) => {
    const sitePath = req.query.sitePath;
    const requestedUrl = req.query.url;
    const method = (req.query.method || req.method || 'GET').toUpperCase();

    if (!isSafeSitePath(sitePath) || !requestedUrl) {
        return res.status(400).send('Invalid replay request.');
    }

    if (shouldBlockRequestUrl(requestedUrl, new URL(requestedUrl).hostname)) {
        return res.status(204).end();
    }

    const cached = findSavedAsset(sitePath, requestedUrl, method);
    if (cached && cached.bodyPath && fs.existsSync(cached.bodyPath)) {
        const resolved = path.resolve(cached.bodyPath);
        if (!resolved.startsWith(sitePath)) return res.status(400).send('Invalid cached path.');
        const contentType = cached.headers && (cached.headers['content-type'] || cached.headers['Content-Type']);
        if (contentType) res.setHeader('Content-Type', contentType);
        return res.sendFile(resolved);
    }

    try {
        const response = await fetch(requestedUrl, { method: method === 'GET' ? 'GET' : method });
        const buf = Buffer.from(await response.arrayBuffer());
        const networkDir = path.join(sitePath, 'network_assets');
        const bodyPath = getAssetStoragePathForUrl(networkDir, requestedUrl);
        await fs.promises.mkdir(path.dirname(bodyPath), { recursive: true });
        await fs.promises.writeFile(bodyPath, buf);

        const headers = {};
        response.headers.forEach((v, k) => { headers[k] = v; });
        upsertManifestEntry(sitePath, {
            url: requestedUrl,
            method,
            resourceType: 'replay',
            status: response.status,
            headers,
            timestamp: new Date().toISOString(),
            bodyPath,
            bodySize: buf.length
        });

        const contentType = headers['content-type'];
        if (contentType) res.setHeader('Content-Type', contentType);
        return res.status(response.status).send(buf);
    } catch (error) {
        return res.status(502).send('Replay fetch failed');
    }
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


app.post('/check-cache', (req, res) => {
    try {
        const targetUrl = req.body.url;
        if (!targetUrl) return res.status(400).json({ hit: false, message: 'Missing url.' });

        const { normalizedUrl, urlObj, siteDir, siteFile } = buildSitePaths(targetUrl);
        const hit = fs.existsSync(siteFile);

        if (!hit) return res.json({ hit: false });

        const pageVersion = String(fs.statSync(siteFile).mtimeMs);
        return res.json({ hit: true, sitePath: siteDir, path: urlObj.pathname, pageVersion, originalUrl: normalizedUrl });
    } catch (error) {
        return res.status(400).json({ hit: false, message: error.message });
    }
});

app.post('/capture', async (req, res) => {
    let targetUrl = req.body.url;
    const forceRefresh = Boolean(req.body.forceRefresh);

    try {
        const { normalizedUrl, urlObj, siteDir, siteFile } = buildSitePaths(targetUrl);
        targetUrl = normalizedUrl;

        if (fs.existsSync(siteFile) && !forceRefresh) {
            const savedHtml = fs.readFileSync(siteFile, 'utf8');
            return res.json({ html: savedHtml, fromCache: true, path: urlObj.pathname, sitePath: siteDir });
        }

        let browser;
        let userDataDir = null;
        try {
            const executablePath = resolveBrowserExecutable();
            userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dol-puppeteer-profile-'));
            const launchOptions = {
                headless: true,
                userDataDir,
                args: ['--disable-web-security', '--no-sandbox', '--disable-setuid-sandbox']
            };
            if (executablePath) launchOptions.executablePath = executablePath;

            browser = await puppeteer.launch(launchOptions);
            const page = await browser.newPage();
            await page.setCacheEnabled(false);
            await applyRequestPolicy(page, urlObj.hostname);
            const networkDir = path.join(siteDir, 'network_assets');
            const networkCapture = setupNetworkCapture(page, networkDir);
            await page.setBypassCSP(true);
            await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });

            const gameData = await page.evaluate(() => {
                document.querySelectorAll('a').forEach(link => {
                    link.onclick = (e) => {
                        e.preventDefault();
                        window.parent.postMessage({type: 'navigate', url: link.href}, '*');
                    };
                });
                return document.documentElement.outerHTML;
            });

            let snapshotData = null;
            try {
                const cdpSession = await page.target().createCDPSession();
                await cdpSession.send('Page.enable');
                const snapshot = await cdpSession.send('Page.captureSnapshot', { format: 'mhtml' });
                snapshotData = snapshot.data;
            } catch (snapshotError) {
                console.warn('[WARN] /capture snapshot unavailable:', snapshotError.message);
            }

            const capturedRequests = await networkCapture.finalize();
            const networkManifestFile = path.join(siteDir, 'network_manifest.json');
            if (!fs.existsSync(siteDir)) fs.mkdirSync(siteDir, { recursive: true });
            fs.writeFileSync(siteFile, gameData);
            if (snapshotData) fs.writeFileSync(path.join(siteDir, 'snapshot.mhtml'), snapshotData);

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

            await browser.close();
            browser = null;
            persistChromiumCache(userDataDir, siteDir);
            fs.rmSync(userDataDir, { recursive: true, force: true });

            return res.json({ html: gameData, fromCache: false, path: urlObj.pathname, sitePath: siteDir });
        } catch (error) {
            if (browser) await browser.close();
            if (typeof userDataDir === 'string') {
                persistChromiumCache(userDataDir, siteDir);
                fs.rmSync(userDataDir, { recursive: true, force: true });
            }
            return res.status(500).json({ error: error.message });
        }
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }
});

// New endpoint to start the capture process in the background
app.post('/capture-start', (req, res) => {
    const targetUrl = req.body.url;
    const requestId = req.body.requestId || null;
    const forceRefresh = Boolean(req.body.forceRefresh);
    console.log(`[API] /capture-start endpoint hit for URL: ${targetUrl} (forceRefresh=${forceRefresh})`);

    // Immediately respond to the client that the capture has started
    res.json({ status: 'started', message: 'Capture process initiated.' });

    // Launch the capture process in the background
    setImmediate(async () => {
        await captureSite(targetUrl, requestId, forceRefresh);
    });
});

async function captureSite(targetUrl, requestId = null, forceRefresh = false) {
    console.log(`[CAPTURE] captureSite function started for URL: ${targetUrl}`);
    publishUpdate( { type: 'status', requestId, message: `Starting capture for ${targetUrl}...` });

    const { normalizedUrl, urlObj, siteDir, siteFile } = buildSitePaths(targetUrl);
    targetUrl = normalizedUrl;
    const snapshotFile = path.join(siteDir, 'snapshot.mhtml');

    const hasCachedHtml = fs.existsSync(siteFile);
    let cachedHtml = null;
    if (hasCachedHtml && !forceRefresh) {
        cachedHtml = fs.readFileSync(siteFile, 'utf8');
        const cachedPageVersion = String(fs.statSync(siteFile).mtimeMs);
        publishUpdate( { type: 'complete', requestId, fromCache: true, path: urlObj.pathname, sitePath: siteDir, originalUrl: targetUrl, pageVersion: cachedPageVersion, message: `Loaded from saved cache: ${urlObj.pathname}` });
        publishUpdate( { type: 'status', requestId, message: 'Using saved site (browser refresh skipped).' });
        return;
    }

    if (hasCachedHtml && forceRefresh) {
        publishUpdate( { type: 'status', requestId, message: 'Forced refresh requested: recapturing page and assets.' });
    }
    publishUpdate( { type: 'status', requestId, message: `Fetching new page: ${targetUrl}` });
    console.log(`[FETCH] Capturing new page: ${targetUrl}`);
    let browser;
    let userDataDir = null;
    try {
        publishUpdate( { type: 'status', requestId, message: 'Launching browser...' });
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
            publishUpdate( { type: 'status', requestId, message: `Using browser executable at ${executablePath}` });
        } else {
            console.log('[LOG] No system Chromium found, using Puppeteer default executable resolution.');
            publishUpdate( { type: 'status', requestId, message: 'No system Chromium found, using Puppeteer default executable.' });
        }

        browser = await puppeteer.launch(launchOptions);
        console.log('[LOG] Browser launched.');
        publishUpdate( { type: 'status', requestId, message: 'Browser launched.' });

        publishUpdate( { type: 'status', requestId, message: 'Creating new page...' });
        const page = await browser.newPage();
        console.log('[LOG] New page created.');
        publishUpdate( { type: 'status', requestId, message: 'New page created.' });

        await page.setCacheEnabled(false);
        await applyRequestPolicy(page, urlObj.hostname);
        const networkDir = path.join(siteDir, 'network_assets');
        const networkCapture = setupNetworkCapture(page, networkDir);
        publishUpdate( { type: 'status', requestId, message: 'Network capture enabled (saving all requested assets).' });

        publishUpdate( { type: 'status', requestId, message: 'Bypassing CSP...' });
        await page.setBypassCSP(true);
        console.log('[LOG] Bypassing CSP.');
        publishUpdate( { type: 'status', requestId, message: 'CSP bypassed.' });


        publishUpdate( { type: 'status', requestId, message: `Navigating to ${targetUrl}...` });
        console.log(`[LOG] Navigating to ${targetUrl}...`);
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
        console.log('[LOG] Navigation complete.');
        publishUpdate( { type: 'status', requestId, message: 'Navigation complete.' });


        publishUpdate( { type: 'status', requestId, message: 'Evaluating page content...' });
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
        publishUpdate( { type: 'status', requestId, message: 'Page content evaluated.' });

        publishUpdate( { type: 'status', requestId, message: 'Capturing full page snapshot (including iframe content)...' });
        let snapshotData = null;
        try {
            const cdpSession = await page.target().createCDPSession();
            await cdpSession.send('Page.enable');
            const snapshot = await cdpSession.send('Page.captureSnapshot', { format: 'mhtml' });
            snapshotData = snapshot.data;
            console.log('[LOG] Full MHTML snapshot captured.');
            publishUpdate( { type: 'status', requestId, message: 'Full page snapshot captured.' });
        } catch (snapshotError) {
            console.warn('[WARN] MHTML snapshot failed, continuing without snapshot.mhtml:', snapshotError.message);
            publishUpdate( { type: 'status', requestId, message: `MHTML snapshot unavailable (${snapshotError.message}). Continuing...` });
        }

        publishUpdate( { type: 'status', requestId, message: 'Finalizing network asset capture...' });
        const capturedRequests = await networkCapture.finalize();
        const networkManifestFile = path.join(siteDir, 'network_manifest.json');


        // Ensure directories exist and save
        publishUpdate( { type: 'status', requestId, message: `Ensuring directory exists: ${siteDir}` });
        if (!fs.existsSync(siteDir)) fs.mkdirSync(siteDir, { recursive: true });

        const htmlToStore = hasCachedHtml && cachedHtml ? cachedHtml : gameData;
        if (!hasCachedHtml) {
            publishUpdate( { type: 'status', requestId, message: `Saving site to ${siteFile}` });
            fs.writeFileSync(siteFile, htmlToStore);
        } else {
            publishUpdate( { type: 'status', requestId, message: 'Keeping cached HTML and updating dependency files only.' });
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
        publishUpdate( { type: 'status', requestId, message: `Dependencies refreshed (${capturedRequests.length} new requests, ${mergedManifest.length} total tracked).` });

        publishUpdate( { type: 'status', requestId, message: 'Closing browser...' });
        await browser.close();
        browser = null;
        persistChromiumCache(userDataDir, siteDir);
        fs.rmSync(userDataDir, { recursive: true, force: true });
        console.log('[LOG] Browser closed.');
        publishUpdate( { type: 'status', requestId, message: 'Browser closed.' });


        if (!hasCachedHtml) {
            const savedPageVersion = String(fs.statSync(siteFile).mtimeMs);
            publishUpdate( { type: 'complete', requestId, fromCache: false, path: urlObj.pathname, sitePath: siteDir, originalUrl: targetUrl, pageVersion: savedPageVersion, message: `Page captured with ${capturedRequests.length} assets: ${urlObj.pathname}` });
        } else {
            publishUpdate( { type: 'status', requestId, message: `Dependency refresh complete for cached page: ${urlObj.pathname}` });
        }

    } catch (error) {
        console.error('[ERROR] An error occurred during capture:', error);
        publishUpdate( { type: 'error', requestId, message: `Capture failed: ${error.message}` });
        if (browser) {
            publishUpdate( { type: 'status', requestId, message: 'Closing browser due to error...' });
            await browser.close();
        }
        if (typeof userDataDir === 'string') {
            persistChromiumCache(userDataDir, siteDir);
            fs.rmSync(userDataDir, { recursive: true, force: true });
        }
    }
}


app.listen(port, () => {
    console.log(`🚀 Deep Downloader: http://localhost:${port}`);
});
