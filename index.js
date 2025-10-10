require('dotenv').config();
const express = require('express');
const request = require('request-promise-native');
const axios = require('axios');
const NodeCache = require('node-cache');
const session = require('express-session');
const app = express();

const PORT = 5000;

// Token storage (GLOBAL)
const refreshTokenStore = {};
const accessTokenCache = new NodeCache({ deleteOnExpire: true });

// Middleware
app.use(express.json());

// Logging middleware
app.use((req, res, next) => {
  console.log(`📥 ${req.method} ${req.originalUrl}`);
  next();
});

// Session (still used for OAuth redirect, not token storage)
app.use(session({
  secret: Math.random().toString(36).substring(2),
  resave: false,
  saveUninitialized: true,
}));

// HubSpot OAuth config
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const REDIRECT_URI = `https://invoice-4q9g.onrender.com/oauth-callback`;

let SCOPES = [
  "crm.objects.contacts.read",
  "crm.objects.contacts.write",
  "crm.objects.invoices.read"
];

if (process.env.SCOPE) {
  SCOPES = process.env.SCOPE.split(/ |, ?|%20/);
}

// OAuth URL
const authUrl = `https://app.hubspot.com/oauth/authorize?client_id=${encodeURIComponent(CLIENT_ID)}&scope=${encodeURIComponent(SCOPES.join(" "))}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

// OAuth Install
app.get('/install', (req, res) => {
  console.log('🔑 Redirecting to HubSpot OAuth...');
  res.redirect(authUrl);
});

// OAuth Callback
app.get('/oauth-callback', async (req, res) => {
  if (req.query.code) {
    console.log('✅ Received authorization code, exchanging for token...');
    const authCodeProof = {
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code: req.query.code
    };
    const token = await exchangeForTokens("global", authCodeProof);
    if (!token) return res.redirect('/error?msg=Token exchange failed.');
    return res.redirect('/');
  } else {
    res.redirect('/error?msg=Missing code');
  }
});

// Token exchange function
const exchangeForTokens = async (key, data) => {
  try {
    const responseBody = await request.post('https://api.hubapi.com/oauth/v1/token', {
      form: data
    });
    const tokens = JSON.parse(responseBody);
    refreshTokenStore[key] = tokens.refresh_token;
    accessTokenCache.set(key, tokens.access_token, Math.round(tokens.expires_in * 0.75));
    console.log('🔐 Tokens stored.');
    return tokens.access_token;
  } catch (e) {
    console.error('❌ Token exchange error:', e.message, e.response?.body);
    return null;
  }
};

const refreshAccessToken = async (key) => {
  const refreshToken = refreshTokenStore[key];
  if (!refreshToken) return null;

  const proof = {
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    refresh_token: refreshToken
  };
  return await exchangeForTokens(key, proof);
};

const getAccessToken = async () => {
  const key = "global";
  if (!accessTokenCache.get(key)) {
    console.log("🔁 Access token expired. Refreshing...");
    await refreshAccessToken(key);
  }
  return accessTokenCache.get(key);
};

// Root route
app.get('/', async (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.write(`<h2>HubSpot OAuth App</h2>`);
  const token = await getAccessToken();
  if (!token) {
    res.write(`<a href="/install"><h3>Install the app</h3></a>`);
  } else {
    res.write(`<p>✅ App installed. You can now fetch invoices from the card.</p>`);
  }
  res.end();
});

// Error page
app.get('/error', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.write(`<h4>Error: ${req.query.msg}</h4>`);
  res.end();
});

// Cards API
app.get("/api/hubspot/cards/invoices", async (req, res) => {
  try {
    const contactId = req.query.contactId || 276295868135;
    if (!contactId) return res.json({ results: [] });

    const token = await getAccessToken();
    if (!token) return res.status(401).json({ results: [] });

    const assocUrl = `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/invoices?limit=100`;
    const assocResp = await axios.get(assocUrl, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const invoiceIds = (assocResp.data.results || []).map(r => r.toObjectId);
    if (!invoiceIds.length) return res.json({ results: [] });

    const batchUrl = `https://api.hubapi.com/crm/v3/objects/invoices/batch/read`;
    const batchResp = await axios.post(batchUrl, {
      inputs: invoiceIds.map(id => ({ id })),
      properties: [
        "hs_invoice_number",
        "hs_invoice_status",
        "hs_invoice_total_amount",
        "hs_due_date"
      ]
    }, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    });

    const results = (batchResp.data.results || []).map(inv => {
      const p = inv.properties || {};
      return {
        objectId: inv.id,
        title: p.hs_invoice_number || `Invoice ${inv.id}`,
        properties: {
          amount: p.hs_invoice_total_amount || "",
          status: p.hs_invoice_status || "",
          due_date: p.hs_due_date || ""
        }
      };
    });

    res.json({ results });
  } catch (err) {
    console.error("❌ Unexpected error:", err.message);
    res.status(500).json({ results: [], error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 App running at http://localhost:${PORT}`);
});
