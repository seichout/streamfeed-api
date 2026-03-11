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
    
    // X requires client_id:client_secret as Basic Auth header
    const clientSecret = process.env.CLIENT_SECRET || '';
    const basicAuth = Buffer.from(client_id + ':' + clientSecret).toString('base64');
    
    const response = await fetch('https://api.twitter.com/2/oauth2/token', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + basicAuth
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id,
        redirect_uri,
        code,
        code_verifier
      })
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
