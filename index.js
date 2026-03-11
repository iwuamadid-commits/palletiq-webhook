const express = require('express');
const crypto  = require('crypto');
const app     = express();

app.use(express.json());

// ── Config ────────────────────────────────────────────────────────────────────
// Set these as Environment Variables in Render (never hard-code secrets)
const VERIFICATION_TOKEN = process.env.VERIFICATION_TOKEN; // you'll create this below
const ENDPOINT_URL       = process.env.ENDPOINT_URL;       // your Render URL + /ebay/deletion

// ── eBay Challenge Verification (GET) ─────────────────────────────────────────
// eBay hits this once to confirm you own the endpoint before activating it.
app.get('/ebay/deletion', (req, res) => {
  const challengeCode = req.query.challenge_code;

  if (!challengeCode) {
    return res.status(400).json({ error: 'Missing challenge_code' });
  }

  // eBay requires: SHA-256(challengeCode + verificationToken + endpointUrl)
  const hash = crypto
    .createHash('sha256')
    .update(challengeCode + VERIFICATION_TOKEN + ENDPOINT_URL)
    .digest('hex');

  console.log(`[eBay] Challenge verified: ${challengeCode}`);
  return res.status(200).json({ challengeResponse: hash });
});

// ── eBay Deletion Notification (POST) ─────────────────────────────────────────
// eBay sends this when a user requests account deletion.
// PalletIQ stores no user data, so we just acknowledge and log it.
app.post('/ebay/deletion', (req, res) => {
  console.log('[eBay] Account deletion notification received:', JSON.stringify(req.body));
  // Nothing to delete — PalletIQ doesn't store eBay user data.
  return res.status(200).send('OK');
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.send('PalletIQ eBay Webhook — running'));

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Webhook listening on port ${PORT}`));
