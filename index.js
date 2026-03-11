const express = require('express');
const fetch = require('node-fetch');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.post('/token', async (req, res) => {
  try {
    const { code, code_verifier, redirect_uri, client_id } = req.body;
    
    const clientSecret = process.env.CLIENT_SECRET || '';
    
    // Build headers and body based on whether we have a secret
    // Public clients (PKCE only): client_id in body, no Authorization header
    // Confidential clients: Basic Auth with client_id:secret
    let headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
    let bodyParams = { grant_type: 'authorization_code', client_id, redirect_uri, code, code_verifier };
    
    if (clientSecret) {
      // Confidential client — use Basic Auth
      const basicAuth = Buffer.from(client_id + ':' + clientSecret).toString('base64');
      headers['Authorization'] = 'Basic ' + basicAuth;
    }
    // If no secret, just send client_id in body (public client / PKCE)
    
    console.log('[Token] clientSecret present:', !!clientSecret);
    
    const response = await fetch('https://api.twitter.com/2/oauth2/token', {
      method: 'POST',
      headers,
      body: new URLSearchParams(bodyParams)
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api', async (req, res) => {
  try {
    const { url, token } = req.body;
    const response = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + token }
    });
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Fetch and extract article text for summarization
app.post('/fetch-article', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'No URL' });

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; StreamFeed/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });
    if (!response.ok) return res.status(response.status).json({ error: 'Fetch failed' });

    const html = await response.text();

    // Extract readable text — strip all HTML tags, scripts, styles
    let text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s{2,}/g, ' ')
      .trim();

    // Return first 4000 chars — enough for Claude to summarize
    res.json({ text: text.slice(0, 4000), url });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Proxy image fetch for Claude Vision (bypasses CORS on X CDN)
app.post('/fetch-image', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'No URL' });
    const response = await fetch(url);
    if (!response.ok) return res.status(response.status).json({ error: 'Fetch failed' });
    const buffer = await response.buffer();
    const base64 = buffer.toString('base64');
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    res.json({ base64, contentType });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => res.send('StreamFeed API running!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('StreamFeed API on port', PORT));
