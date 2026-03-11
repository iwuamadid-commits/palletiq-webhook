const express = require('express');
const crypto  = require('crypto');
const app     = express();

app.use(express.json());

// ── CORS — allow PalletIQ HTML file to call this server ────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Config (set these in Render → Environment) ─────────────────────────────
const VERIFICATION_TOKEN = process.env.VERIFICATION_TOKEN;
const ENDPOINT_URL       = process.env.ENDPOINT_URL;
const EBAY_CLIENT_ID     = process.env.EBAY_CLIENT_ID;
const EBAY_CLIENT_SECRET = process.env.EBAY_CLIENT_SECRET;

// ── eBay OAuth token cache ─────────────────────────────────────────────────
let tokenCache = { token: null, expires: 0 };

async function getEbayToken() {
  if (tokenCache.token && Date.now() < tokenCache.expires) {
    return tokenCache.token;
  }
  const credentials = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${credentials}`
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('eBay token error: ' + JSON.stringify(data));
  tokenCache = {
    token: data.access_token,
    expires: Date.now() + (data.expires_in - 60) * 1000
  };
  return tokenCache.token;
}

// ── eBay Browse API Search Proxy ───────────────────────────────────────────
// Called by PalletIQ for each manifest item to get real market prices
// GET /ebay/search?q=item+name&condition=used&limit=15
app.get('/ebay/search', async (req, res) => {
  try {
    const { q, condition = '', limit = 15 } = req.query;
    if (!q) return res.status(400).json({ error: 'Missing q parameter' });

    // Map condition string to eBay Finding API condition filter (use index 1 to avoid collision with SoldItemsOnly at index 0)
    const condLower = condition.toLowerCase();
    let conditionFilter = '';
    if (condLower.includes('new') && !condLower.includes('open')) {
      conditionFilter = '&itemFilter(1).name=Condition&itemFilter(1).value(0)=1000';
    } else if (condLower.includes('open')) {
      conditionFilter = '&itemFilter(1).name=Condition&itemFilter(1).value(0)=1500&itemFilter(1).value(1)=1750';
    } else if (condLower.includes('dam') || condLower.includes('brok') || condLower.includes('part')) {
      conditionFilter = '&itemFilter(1).name=Condition&itemFilter(1).value(0)=7000';
    } else if (condLower.includes('used') || condLower.includes('good') || condLower.includes('fair')) {
      conditionFilter = '&itemFilter(1).name=Condition&itemFilter(1).value(0)=3000&itemFilter(1).value(1)=4000&itemFilter(1).value(2)=5000&itemFilter(1).value(3)=6000';
    }

    // findCompletedItems + SoldItemsOnly=true = only actually sold listings
    const url = `https://svcs.ebay.com/services/search/FindingService/v1` +
      `?OPERATION-NAME=findCompletedItems` +
      `&SERVICE-VERSION=1.0.0` +
      `&SECURITY-APPNAME=${EBAY_CLIENT_ID}` +
      `&RESPONSE-DATA-FORMAT=JSON` +
      `&keywords=${encodeURIComponent(q)}` +
      `&itemFilter(0).name=SoldItemsOnly&itemFilter(0).value=true` +
      conditionFilter +
      `&paginationInput.entriesPerPage=${limit}` +
      `&sortOrder=EndTimeSoonest`;

    console.log(`[eBay] Searching sold: "${q}"`);
    const ebayRes = await fetch(url);
    const data = await ebayRes.json();

    const searchResult = data?.findCompletedItemsResponse?.[0]?.searchResult?.[0];
    const items = searchResult?.item;
    const totalEntries = data?.findCompletedItemsResponse?.[0]?.paginationOutput?.[0]?.totalEntries?.[0];

    console.log(`[eBay] Total entries: ${totalEntries}, Items returned: ${items?.length || 0}`);

    if (!items || items.length === 0) {
      return res.json({ found: false, avg: null, min: null, max: null, count: 0 });
    }

    const prices = items
      .filter(i => i.sellingStatus?.[0]?.currentPrice?.[0]?.__value__)
      .map(i => parseFloat(i.sellingStatus[0].currentPrice[0].__value__))
      .filter(p => p > 0);

    console.log(`[eBay] Prices extracted: ${prices.length}`);

    if (prices.length === 0) {
      return res.json({ found: false, avg: null, min: null, max: null, count: 0 });
    }

    // Remove extreme outliers (top and bottom 10%)
    prices.sort((a, b) => a - b);
    const trim = Math.max(1, Math.floor(prices.length * 0.1));
    const trimmed = prices.slice(trim, prices.length - trim);
    const avg = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;

    return res.json({
      found: true,
      avg:   Math.round(avg * 100) / 100,
      min:   Math.round(prices[0] * 100) / 100,
      max:   Math.round(prices[prices.length - 1] * 100) / 100,
      count: prices.length
    });

  } catch (err) {
    console.error('[eBay Search Error]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── eBay Debug — returns raw Finding API response ─────────────────────────
app.get('/ebay/debug', async (req, res) => {
  const q = req.query.q || 'ipad pro';
  const url = `https://svcs.ebay.com/services/search/FindingService/v1` +
    `?OPERATION-NAME=findCompletedItems` +
    `&SERVICE-VERSION=1.0.0` +
    `&SECURITY-APPNAME=${EBAY_CLIENT_ID}` +
    `&RESPONSE-DATA-FORMAT=JSON` +
    `&keywords=${encodeURIComponent(q)}` +
    `&itemFilter(0).name=SoldItemsOnly&itemFilter(0).value=true` +
    `&paginationInput.entriesPerPage=3`;
  try {
    const r = await fetch(url);
    const text = await r.text();
    res.set('Content-Type', 'application/json');
    res.send(text);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


app.get('/ebay/deletion', (req, res) => {
  const challengeCode = req.query.challenge_code;
  if (!challengeCode) return res.status(400).json({ error: 'Missing challenge_code' });
  const hash = crypto
    .createHash('sha256')
    .update(challengeCode + VERIFICATION_TOKEN + ENDPOINT_URL)
    .digest('hex');
  console.log(`[eBay] Challenge verified`);
  return res.status(200).json({ challengeResponse: hash });
});

// ── eBay Deletion Notification (POST) ──────────────────────────────────────
app.post('/ebay/deletion', (req, res) => {
  console.log('[eBay] Account deletion notification received — no user data stored.');
  return res.status(200).send('OK');
});

// ── Health check ───────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('PalletIQ eBay Webhook + Proxy — running ✓'));

// ── Start ──────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
