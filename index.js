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
const ogCache  = new Map();
const imgCache = new Map();
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

// ─────────────────────────────────────────────
// ── FILTERED STREAM ──────────────────────────
// ─────────────────────────────────────────────

// In-memory post buffer — last 500 posts, max 4 hours old
const streamBuffer = [];
const BUFFER_MAX   = 500;
const BUFFER_TTL   = 4 * 60 * 60 * 1000; // 4 hours

// Stream state
let streamActive      = false;
let streamController  = null; // AbortController for current connection
let reconnectTimer    = null;
let reconnectAttempts = 0;

// Your accounts — split into rule-sized chunks (X allows ~512 chars per rule value)
const STREAM_ACCOUNTS = [
  // Chunk 1 — personal/commentary
  ['Kalshi','KobeissiLetter','diligentdenizen','candaceowens','swordtruth','realstewpeters',
   'megynkelly','wallstreetapes','ggreenwald','jimmy_dore','timjdillon',
   'repthomasmassie','cattardslim','TuckerCarlson','RandPaul','mattgaetz'],
  // Chunk 2
  ['lauraingraham','marklevinshow','dbongino','charliekirk','benshapiro',
   'mtgreenee','jimjordan','RonDeSantis','VivekGRamaswamy','ElonMusk',
   'JDVance1','TomFitton','AOC','BernieSanders','mtaibbi'],
  // Chunk 3
  ['RaoulGMI','APompliano','unusual_whales','zerohedge','LynAldenContact',
   'saylor','VitalikButerin','cz_binance','joerogan','DaveRubin',
   'libsoftiktok','EndWokeness','TheChiefNerd','CollinRugg','RichardHanania'],
  // Chunk 4 — news orgs
  ['Reuters','AP','APnews','nytimes','nypost','washingtonpost',
   'FoxNews','CNN','BBCBreaking','axios','politico','Bloomberg',
   'BreakingNews','BNONews','disclosetv'],
  // Chunk 5 — sports
  ['Reds','CincinnatiReds','TBLightning','Bengals','TBBuccaneers',
   'AdamSchefter','RapSheet','ESPN','SportsCenter','BarstoolSports',
   'PatMcAfeeShow','MLBastian','C_Trent_Rosecrans'],
];

// Topics rule — high-signal breaking news anyone posts
const TOPICS_RULE = '(breaking OR "just in" OR developing OR BREAKING) lang:en -is:retweet';

// Build streaming rules array from account chunks
function buildStreamRules() {
  const rules = STREAM_ACCOUNTS.map((chunk, i) => ({
    value: `(from:${chunk.join(' OR from:')}) -is:retweet lang:en`,
    tag: `accounts-${i + 1}`
  }));
  rules.push({ value: TOPICS_RULE, tag: 'breaking-topics' });
  return rules;
}

// Sync rules with X — delete old, add new
async function syncStreamRules() {
  const bearer = process.env.BEARER_TOKEN;
  if (!bearer) { console.warn('[Stream] No BEARER_TOKEN — cannot set rules'); return false; }

  try {
    // Get existing rules
    const existing = await fetch('https://api.twitter.com/2/tweets/search/stream/rules', {
      headers: { 'Authorization': 'Bearer ' + bearer }
    });
    const existingData = await existing.json();
    const existingIds  = (existingData.data || []).map(r => r.id);

    // Delete all existing rules
    if (existingIds.length > 0) {
      const delRes = await fetch('https://api.twitter.com/2/tweets/search/stream/rules', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + bearer, 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete: { ids: existingIds } })
      });
      const delData = await delRes.json();
      console.log(`[Stream] Deleted ${existingIds.length} old rules:`, JSON.stringify(delData.meta || {}));
      await new Promise(r => setTimeout(r, 1000)); // let X process deletion
    }

    // Add new rules one at a time to isolate any invalid ones
    const rules = buildStreamRules();
    let created = 0;
    for (const rule of rules) {
      try {
        const addRes = await fetch('https://api.twitter.com/2/tweets/search/stream/rules', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + bearer, 'Content-Type': 'application/json' },
          body: JSON.stringify({ add: [rule] })
        });
        const addData = await addRes.json();
        if (addData.errors?.length) {
          console.error(`[Stream] Rule error (${rule.tag}):`, JSON.stringify(addData.errors[0]));
        } else {
          created++;
          console.log(`[Stream] ✅ Rule added: ${rule.tag}`);
        }
      } catch(e) { console.error(`[Stream] Rule add failed (${rule.tag}):`, e.message); }
    }
    console.log(`[Stream] Rules created: ${created}/${rules.length}`);
    if (created === 0) { console.error('[Stream] No rules created — aborting'); return false; }
    return true;
  } catch (e) {
    console.error('[Stream] Rule sync failed:', e.message);
    return false;
  }
}

// Parse a raw stream line into a post object StreamFeed can use
function parseStreamPost(line) {
  try {
    const data = JSON.parse(line);
    if (!data?.data?.id) return null;

    const tweet   = data.data;
    const users   = data.includes?.users  || [];
    const media   = data.includes?.media  || [];
    const author  = users.find(u => u.id === tweet.author_id) || {};
    const metrics = tweet.public_metrics || {};

    // Determine source tag from matching rule
    const matchingRules = data.matching_rules || [];
    const tag = matchingRules[0]?.tag || 'stream';
    const source = tag === 'breaking-topics' ? 'TRENDING'
                 : tag.startsWith('accounts') ? 'ACCOUNT'
                 : 'STREAM';

    // Media
    const mediaKeys  = tweet.attachments?.media_keys || [];
    const mediaItem  = mediaKeys.length ? media.find(m => m.media_key === mediaKeys[0]) : null;
    const mediaUrl   = mediaItem?.url || mediaItem?.preview_image_url || null;
    const mediaType  = mediaItem?.type || null;

    // Clean text — strip trailing t.co links
    let text = tweet.note_tweet?.text || tweet.text || '';
    text = text.replace(/https:\/\/t\.co\/\S+$/, '').trim();

    // Extract linked URL from entities
    const urls     = tweet.entities?.urls || [];
    const postUrl  = `https://twitter.com/i/web/status/${tweet.id}`;
    const linkedUrl = urls.find(u => u.expanded_url && !/twitter\.com|x\.com/i.test(u.expanded_url))?.expanded_url || null;

    return {
      id:         tweet.id,
      user:       author.name       || author.username || 'Unknown',
      handle:     '@' + (author.username || ''),
      avatar:     author.profile_image_url || null,
      text,
      likes:      metrics.like_count    || 0,
      retweets:   metrics.retweet_count || 0,
      replies:    metrics.reply_count   || 0,
      replyCount: metrics.reply_count   || 0,
      source,
      createdAt:  tweet.created_at || new Date().toISOString(),
      postUrl,
      linkedUrl,
      mediaUrl,
      mediaType,
      isSports:   tag === 'accounts-5',
      _streamedAt: Date.now(),
    };
  } catch (e) {
    return null;
  }
}

// Add post to buffer — dedup + TTL trim
function bufferPost(post) {
  if (!post) return;
  // Dedup by ID
  if (streamBuffer.some(p => p.id === post.id)) return;
  streamBuffer.unshift(post);
  // Trim to max size
  if (streamBuffer.length > BUFFER_MAX) streamBuffer.splice(BUFFER_MAX);
}

// Connect to X filtered stream
async function connectStream() {
  const bearer = process.env.BEARER_TOKEN;
  if (!bearer) { console.warn('[Stream] No BEARER_TOKEN — not connecting'); return; }

  if (streamController) { streamController.abort(); streamController = null; }
  streamController = new AbortController();
  streamActive = true;

  const fields = 'tweet.fields=public_metrics,created_at,author_id,note_tweet,entities,attachments,referenced_tweets' +
                 '&expansions=author_id,attachments.media_keys,referenced_tweets.id' +
                 '&media.fields=url,preview_image_url,type' +
                 '&user.fields=name,username,profile_image_url';

  console.log('[Stream] Connecting...');

  try {
    const response = await fetch(
      `https://api.twitter.com/2/tweets/search/stream?${fields}`,
      { headers: { 'Authorization': 'Bearer ' + bearer }, signal: streamController.signal }
    );

    if (!response.ok) {
      const err = await response.text();
      console.error('[Stream] Connect failed:', response.status, err.slice(0, 200));
      scheduleReconnect();
      return;
    }

    console.log('[Stream] ✅ Connected — listening for posts');
    reconnectAttempts = 0;

    // Read the stream line by line
    let buf = '';
    for await (const chunk of response.body) {
      buf += chunk.toString('utf-8');
      const lines = buf.split('\n');
      buf = lines.pop(); // keep incomplete last line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue; // heartbeat keep-alive
        const post = parseStreamPost(trimmed);
        if (post) {
          bufferPost(post);
          console.log(`[Stream] +1 post from @${post.handle} (buffer: ${streamBuffer.length})`);
        }
      }
    }

    console.log('[Stream] Connection closed — scheduling reconnect');
    scheduleReconnect();

  } catch (e) {
    if (e.name === 'AbortError') {
      console.log('[Stream] Aborted intentionally');
      return;
    }
    console.error('[Stream] Error:', e.message);
    scheduleReconnect();
  }
}

// Exponential backoff reconnect: 5s → 10s → 20s → 60s max
function scheduleReconnect() {
  if (!streamActive) return;
  const delay = Math.min(5000 * Math.pow(2, reconnectAttempts), 60000);
  reconnectAttempts++;
  console.log(`[Stream] Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempts})`);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectStream, delay);
}

// ── /stream-start — call once to sync rules + connect ──
app.post('/stream-start', async (req, res) => {
  try {
    if (streamActive && streamBuffer.length > 0) {
      return res.json({ ok: true, status: 'already_running', buffered: streamBuffer.length });
    }
    const rulesOk = await syncStreamRules();
    if (!rulesOk) return res.status(500).json({ error: 'Failed to set stream rules' });
    connectStream(); // fire and forget
    res.json({ ok: true, status: 'connecting', message: 'Stream starting — posts will arrive shortly' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── /stream-feed — get buffered posts ──
app.get('/stream-feed', (req, res) => {
  // Evict posts older than TTL
  const cutoff = Date.now() - BUFFER_TTL;
  const fresh  = streamBuffer.filter(p => p._streamedAt > cutoff);
  if (fresh.length !== streamBuffer.length) {
    streamBuffer.length = 0;
    streamBuffer.push(...fresh);
  }

  res.json({
    ok:      true,
    posts:   streamBuffer,
    count:   streamBuffer.length,
    active:  streamActive,
    oldest:  streamBuffer.length ? streamBuffer[streamBuffer.length - 1]?.createdAt : null,
    newest:  streamBuffer.length ? streamBuffer[0]?.createdAt : null,
  });
});

// ── /stream-status — lightweight health check ──
app.get('/stream-status', (req, res) => {
  res.json({
    active:   streamActive,
    buffered: streamBuffer.length,
    attempts: reconnectAttempts,
  });
});

// ── /stream-stop — graceful stop ──
app.post('/stream-stop', (req, res) => {
  streamActive = false;
  clearTimeout(reconnectTimer);
  if (streamController) { streamController.abort(); streamController = null; }
  res.json({ ok: true, status: 'stopped' });
});

// Auto-start stream on server boot
setTimeout(async () => {
  console.log('[Stream] Auto-starting on boot...');
  const rulesOk = await syncStreamRules();
  if (rulesOk) connectStream();
}, 3000); // 3s delay to let server fully start

// ─────────────────────────────────────────────
// ── EXISTING ENDPOINTS (unchanged) ───────────
// ─────────────────────────────────────────────

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
app.post('/og', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'No URL' });
    const hit = getCached(ogCache, url);
    if (hit) return res.json(hit);
    let resolvedUrl = url;
    try {
      const r = await fetch(url, { method: 'HEAD', redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StreamFeed/1.0)' } });
      resolvedUrl = r.url || url;
    } catch(e) {
      try {
        const r = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; StreamFeed/1.0)' } });
        resolvedUrl = r.url || url;
      } catch(e2) {}
    }
    let html = '';
    try {
      const r = await fetch(resolvedUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'en-US,en;q=0.5' },
        redirect: 'follow',
      });
      const chunks = []; let bytes = 0;
      for await (const chunk of r.body) {
        chunks.push(chunk); bytes += chunk.length;
        if (bytes > 25000) break;
      }
      html = Buffer.concat(chunks).toString('utf-8');
    } catch(e) {
      return res.json({ title: null, description: null, siteName: null, resolvedUrl });
    }
    const extract = (patterns) => {
      for (const re of patterns) { const m = html.match(re); if (m?.[1]) return decodeHtml(m[1].trim().slice(0, 250)); }
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

// ── /fetch-image — Proxy image bytes for Claude Vision ──
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
      id: tweet.id, text: text.slice(0, 500),
      user: author?.name || author?.username || 'Unknown',
      handle: author?.username ? '@' + author.username : '',
      mediaUrl: mediaItem?.url || mediaItem?.preview_image_url || null,
      mediaType: mediaItem?.type || null, linkedUrl,
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

app.get('/', (req, res) => res.send('StreamFeed API v3.0 — stream active: ' + streamActive));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('StreamFeed API v3.0 on port', PORT));
