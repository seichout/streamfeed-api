const express = require('express');
const fetch = require('node-fetch');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Small in-memory cache — avoids re-fetching the same URL twice ──
const ogCache  = new Map(); // url → { title, description, siteName, resolvedUrl }
const imgCache = new Map(); // url → { base64, contentType }
const CACHE_TTL = 30 * 60 * 1000; // 30 min

function getCached(map, key) {
  const e = map.get(key);
  if (e && Date.now() - e.ts < CACHE_TTL) return e.data;
  return null;
}
function setCached(map, key, data) {
  if (map.size > 500) map.delete(map.keys().next().value);
  map.set(key, { data, ts: Date.now() });
}

// ── /token — OAuth 2.0 PKCE exchange ──
app.post('/token', async (req, res) => {
  try {
    const { code, code_verifier, redirect_uri, client_id } = req.body;
    const clientSecret = process.env.CLIENT_SECRET || '';
    let headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    let bodyParams = { grant_type: 'authorization_code', client_id, redirect_uri, code, code_verifier };
    if (clientSecret) {
      headers['Authorization'] = 'Basic ' + Buffer.from(client_id + ':' + clientSecret).toString('base64');
    }
    console.log('[Token] clientSecret present:', !!clientSecret);
    const response = await fetch('https://api.twitter.com/2/oauth2/token', {
      method: 'POST', headers, body: new URLSearchParams(bodyParams)
    });
    res.json(await response.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── /api — X API proxy ──
app.post('/api', async (req, res) => {
  try {
    const { url, token } = req.body;
    const response = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    res.json(await response.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── /og — Resolve URL + extract og:title, description, site name ──
// The main article context endpoint.
// Flow: t.co/abc → resolve redirect → fetch page head → extract meta tags
// Returns { title, description, siteName, resolvedUrl }
// Works on ~95% of news sites (Bloomberg, NYPost, Reuters, Fox, CNN, WaPo, etc.)
app.post('/og', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'No URL' });

    const hit = getCached(ogCache, url);
    if (hit) return res.json(hit);

    // Step 1: Resolve shortened/redirected URL
    let resolvedUrl = url;
    try {
      const r = await fetch(url, {
        method: 'HEAD', redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StreamFeed/1.0)' },
      });
      resolvedUrl = r.url || url;
    } catch(e) {
      try {
        const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StreamFeed/1.0)' } });
        resolvedUrl = r.url || url;
      } catch(e2) { /* use original */ }
    }

    // Step 2: Fetch only first 25KB — meta tags live in <head>, never need full page
    let html = '';
    try {
      const r = await fetch(resolvedUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        redirect: 'follow',
      });
      const chunks = [];
      let bytes = 0;
      for await (const chunk of r.body) {
        chunks.push(chunk);
        bytes += chunk.length;
        if (bytes > 25000) break;
      }
      html = Buffer.concat(chunks).toString('utf-8');
    } catch(e) {
      return res.json({ title: null, description: null, siteName: null, resolvedUrl });
    }

    // Step 3: Extract meta tags — og: first, twitter: second, plain <title> last
    const extract = (patterns) => {
      for (const re of patterns) {
        const m = html.match(re);
        if (m?.[1]) return decodeHtml(m[1].trim().slice(0, 250));
      }
      return null;
    };

    const title = extract([
      /property=["']og:title["'][^>]*content=["']([^"']{5,}?)["']/i,
      /content=["']([^"']{5,}?)["'][^>]*property=["']og:title["']/i,
      /name=["']twitter:title["'][^>]*content=["']([^"']{5,}?)["']/i,
      /content=["']([^"']{5,}?)["'][^>]*name=["']twitter:title["']/i,
      /<title[^>]*>([^<]{5,200})<\/title>/i,
    ]);

    const description = extract([
      /property=["']og:description["'][^>]*content=["']([^"']{5,}?)["']/i,
      /content=["']([^"']{5,}?)["'][^>]*property=["']og:description["']/i,
      /name=["']description["'][^>]*content=["']([^"']{5,}?)["']/i,
      /content=["']([^"']{5,}?)["'][^>]*name=["']description["']/i,
    ]);

    const siteName = extract([
      /property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i,
      /content=["']([^"']+)["'][^>]*property=["']og:site_name["']/i,
    ]) || getDomainName(resolvedUrl);

    const result = { title, description, siteName, resolvedUrl };
    setCached(ogCache, url, result);
    console.log('[OG]', url.slice(0,50), '→', title?.slice(0,70) || '(no title)');
    res.json(result);

  } catch(e) {
    console.error('[OG] Error:', e.message);
    res.json({ title: null, description: null, siteName: null, error: e.message });
  }
});

// ── /fetch-image — Proxy image bytes for Claude Vision (bypasses CORS) ──
app.post('/fetch-image', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'No URL' });
    const hit = getCached(imgCache, url);
    if (hit) return res.json(hit);
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StreamFeed/1.0)' } });
    if (!r.ok) return res.status(r.status).json({ error: 'Fetch failed: ' + r.status });
    const buffer = await r.buffer();
    const result = { base64: buffer.toString('base64'), contentType: r.headers.get('content-type') || 'image/jpeg' };
    setCached(imgCache, url, result);
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── /fetch-parent — Fetch a parent tweet by ID for reply context ──
// When Massie replies to WaPo, we know WHO he replied to but not WHAT they said.
// This fetches the parent tweet text so Nova can properly set the scene:
// "Washington Post reported X. Massie responded: [his words]"
app.post('/fetch-parent', async (req, res) => {
  try {
    const { tweetId, token } = req.body;
    if (!tweetId || !token) return res.status(400).json({ error: 'Missing tweetId or token' });

    const fields = 'tweet.fields=text,author_id,note_tweet,entities,attachments&expansions=author_id,attachments.media_keys&user.fields=name,username&media.fields=url,type';
    const r = await fetch(`https://api.twitter.com/2/tweets/${tweetId}?${fields}`, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    if (!r.ok) return res.status(r.status).json({ error: 'X API error: ' + r.status });

    const data = await r.json();
    if (!data.data) return res.status(404).json({ error: 'Tweet not found' });

    const tweet = data.data;
    const author = (data.includes?.users || []).find(u => u.id === tweet.author_id);
    const text = tweet.note_tweet?.text || tweet.text || '';
    const mediaKeys = tweet.attachments?.media_keys || [];
    const media = data.includes?.media || [];
    const mediaItem = mediaKeys.length ? media.find(m => m.media_key === mediaKeys[0]) : null;
    const urlMatch = text.match(/https?:\/\/\S+/);
    const linkedUrl = urlMatch ? urlMatch[0].replace(/[)\].,'"]+$/, '') : null;

    res.json({
      id: tweet.id,
      text: text.slice(0, 500),
      user: author?.name || author?.username || 'Unknown',
      handle: author?.username ? '@' + author.username : '',
      mediaUrl: mediaItem?.url || mediaItem?.preview_image_url || null,
      mediaType: mediaItem?.type || null,
      linkedUrl,
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Helpers ──
function decodeHtml(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/g, "'").replace(/&#x2F;/g, '/').trim();
}

function getDomainName(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const names = {
      'nytimes.com':'New York Times','nypost.com':'New York Post','washingtonpost.com':'Washington Post',
      'foxnews.com':'Fox News','fox19.com':'Fox 19','cnn.com':'CNN','bbc.com':'BBC','bbc.co.uk':'BBC',
      'reuters.com':'Reuters','apnews.com':'AP News','bloomberg.com':'Bloomberg',
      'wsj.com':'Wall Street Journal','ft.com':'Financial Times','axios.com':'Axios',
      'politico.com':'Politico','thehill.com':'The Hill','dailymail.co.uk':'Daily Mail',
      'theguardian.com':'The Guardian','nbcnews.com':'NBC News','abcnews.go.com':'ABC News',
      'cbsnews.com':'CBS News','npr.org':'NPR','marketwatch.com':'MarketWatch',
      'cnbc.com':'CNBC','forbes.com':'Forbes','theatlantic.com':'The Atlantic',
      'breitbart.com':'Breitbart','thedailywire.com':'Daily Wire','zerohedge.com':'Zero Hedge',
      'substack.com':'Substack','youtube.com':'YouTube','youtu.be':'YouTube',
      'wlwt.com':'WLWT','tampabay.com':'Tampa Bay Times','10news.com':'10 Tampa Bay',
    };
    return names[host] || host;
  } catch(e) { return null; }
}

app.get('/', (req, res) => res.send('StreamFeed API v2.5 running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('StreamFeed API v2.5 on port', PORT));
