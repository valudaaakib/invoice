require('dotenv').config();
const express = require('express');
const request = require('request-promise-native');
const NodeCache = require('node-cache');
const session = require('express-session');
const opn = require('open');
const app = express();
const axios = require("axios");

const PORT = 5000;

app.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    express.json()(req, res, next);
  } else {
    next();
  }
});

app.use((req, res, next) => {
  console.log("📥 Incoming Request:");
  console.log("  Method:", req.method);
  console.log("  URL:", req.originalUrl);
  console.log("  Query:", req.query);
  console.log("  Headers:", req.headers);
  console.log("  Body:", req.body);
  next(); // Pass to next middleware
});



const refreshTokenStore = {};
const accessTokenCache = new NodeCache({ deleteOnExpire: true });

if (!process.env.CLIENT_ID || !process.env.CLIENT_SECRET) {
    throw new Error('Missing CLIENT_ID or CLIENT_SECRET environment variable.')
}

//===========================================================================//
//  HUBSPOT APP CONFIGURATION
//
//  All the following values must match configuration settings in your app.
//  They will be used to build the OAuth URL, which users visit to begin
//  installing. If they don't match your app's configuration, users will
//  see an error page.

// Replace the following with the values from your app auth config, 
// or set them as environment variables before running.
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

// Scopes for this app will default to `crm.objects.contacts.read`
// To request others, set the SCOPE environment variable instead
let SCOPES = ["crm.objects.contacts.read",
        "crm.objects.contacts.write",
              "crm.objects.invoices.read"
        
        ];
if (process.env.SCOPE) {
    SCOPES = (process.env.SCOPE.split(/ |, ?|%20/)).join(' ');
}

// On successful install, users will be redirected to /oauth-callback
const REDIRECT_URI = `https://invoice-4q9g.onrender.com/oauth-callback`;

//===========================================================================//

// Use a session to keep track of client ID
app.use(session({
  secret: Math.random().toString(36).substring(2),
  resave: false,
  saveUninitialized: true
}));
 
//================================//
//   Running the OAuth 2.0 Flow   //
//================================//

// Step 1
// Build the authorization URL to redirect a user
// to when they choose to install the app
const authUrl =
  'https://app.hubspot.com/oauth/authorize' +
  `?client_id=${encodeURIComponent(CLIENT_ID)}` + // app's client ID
  `&scope=${encodeURIComponent(SCOPES)}` + // scopes being requested by the app
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`; // where to send the user after the consent page

// Redirect the user from the installation page to
// the authorization URL
app.get('/install', (req, res) => {
  console.log('');
  console.log('=== Initiating OAuth 2.0 flow with HubSpot ===');
  console.log('');
  console.log("===> Step 1: Redirecting user to your app's OAuth URL");
  res.redirect(authUrl);
  console.log('===> Step 2: User is being prompted for consent by HubSpot');
});

// Step 2
// The user is prompted to give the app access to the requested
// resources. This is all done by HubSpot, so no work is necessary
// on the app's end

// Step 3
// Receive the authorization code from the OAuth 2.0 Server,
// and process it based on the query parameters that are passed

app.get('/oauth-callback', async (req, res) => {
  console.log('===> Step 3: Handling the request sent by the server');

  // Received a user authorization code, so now combine that with the other
  // required values and exchange both for an access token and a refresh token
  if (req.query.code) {
    console.log('       > Received an authorization token');

    const authCodeProof = {
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code: req.query.code
    };

    // Step 4
    // Exchange the authorization code for an access token and refresh token
    console.log('===> Step 4: Exchanging authorization code for an access token and refresh token');
    const token = await exchangeForTokens(req.sessionID, authCodeProof);
    if (token.message) {
      return res.redirect(`/error?msg=${token.message}`);
    }

    // Once the tokens have been retrieved, use them to make a query
    // to the HubSpot API
    res.redirect(`/`);
  }
});

//==========================================//
//   Exchanging Proof for an Access Token   //
//==========================================//

const exchangeForTokens = async (userId, exchangeProof) => {
  try {
    const responseBody = await request.post('https://api.hubapi.com/oauth/v1/token', {
      form: exchangeProof
    });
    const tokens = JSON.parse(responseBody);
    refreshTokenStore[userId] = tokens.refresh_token;
    accessTokenCache.set(userId, tokens.access_token, Math.round(tokens.expires_in * 0.75));
    console.log('> Received an access token and refresh token');
    return tokens.access_token;
  } catch (e) {
    console.error('❌ Error exchanging token:', e.message, e.response?.body);
    return null; // return null instead of trying to parse invalid JSON
  }
};


const refreshAccessToken = async (userId) => {
  const refreshTokenProof = {
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    redirect_uri: REDIRECT_URI,
    refresh_token: refreshTokenStore[userId]
  };
  return await exchangeForTokens(userId, refreshTokenProof);
};

const getAccessToken = async (userId) => {
  // If the access token has expired, retrieve
  // a new one using the refresh token
  if (!accessTokenCache.get(userId)) {
    console.log('Refreshing expired access token');
    await refreshAccessToken(userId);
  }
  return accessTokenCache.get(userId);
};

const isAuthorized = (userId) => {
  return refreshTokenStore[userId] ? true : false;
};

//====================================================//
//   Using an Access Token to Query the HubSpot API   //
//====================================================//

const getContact = async (accessToken) => {
  console.log('');
  console.log('=== Retrieving a contact from HubSpot using the access token ===');
  try {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    };
    console.log('===> Replace the following request.get() to test other API calls');
    console.log('===> request.get(\'https://api.hubapi.com/contacts/v1/lists/all/contacts/all?count=1\')');
    const result = await request.get('https://api.hubapi.com/contacts/v1/lists/all/contacts/all?count=1', {
      headers: headers
    });

    return JSON.parse(result).contacts[0];
  } catch (e) {
    console.error('  > Unable to retrieve contact');
    return JSON.parse(e.response.body);
  }
};

//========================================//
//   Displaying information to the user   //
//========================================//

const displayContactName = (res, contact) => {
  if (contact.status === 'error') {
    res.write(`<p>Unable to retrieve contact! Error Message: ${contact.message}</p>`);
    return;
  }
  const { firstname, lastname } = contact.properties;
  res.write(`<p>Contact name: ${firstname.value} ${lastname.value}</p>`);
};

app.get('/', async (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.write(`<h2>HubSpot OAuth 2.0 Quickstart App</h2>`);
  if (isAuthorized(req.sessionID)) {
    const accessToken = await getAccessToken(req.sessionID);
    const contact = await getContact(accessToken);
    res.write(`<h4>Access token: ${accessToken}</h4>`);
    displayContactName(res, contact);
  } else {
    res.write(`<a href="/install"><h3>Install the app</h3></a>`);
  }
  res.end();
});

app.get('/error', (req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.write(`<h4>Error: ${req.query.msg}</h4>`);
  res.end();
});


app.get("/api/hubspot/cards/invoices", async (req, res) => {
  console.log("🚀 Starting to fetch invoices...");

  try {
    // Use query parameter or default for testing
    const contactId = req.query.contactId || req.query.objectId || 276295868135;
    console.log("📌 Contact ID:", contactId);

    if (!contactId) {
      console.warn("⚠️ No contact ID provided");
      return res.json({ results: [] });
    }

    // Get access token
    const token = await getAccessToken(req.sessionID);
    if (!token) {
      console.warn("⚠️ No access token available");
      return res.status(401).json({ results: [] });
    }
    console.log("🔑 Access Token retrieved successfully");

    // 1️⃣ Fetch associated invoices
    const assocUrl = `https://api.hubapi.com/crm/v4/objects/contacts/${contactId}/associations/invoices?limit=100`;
    console.log("🔗 Assoc API URL:", assocUrl);

    let assocResp;
    try {
      assocResp = await axios.get(assocUrl, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 5000,
      });
    } catch (e) {
      console.error("❌ Error calling Assoc API:", e.response?.data || e.message);
      return res.status(500).json({ results: [], error: e.message });
    }
   console.log("✅ Assoc API Response:", assocResp);
    console.log("✅ Assoc API Response:", assocResp.data);

    const invoiceIds = (assocResp.data.results || []).map((r) => r.toObjectId);
    console.log("📄 Invoice IDs:", invoiceIds);

    if (!invoiceIds.length) {
      console.info("ℹ️ No invoices associated with this contact");
      return res.json({ results: [] });
    }

    // 2️⃣ Batch fetch invoice details
    const batchUrl = "https://api.hubapi.com/crm/v3/objects/invoices/batch/read";
    console.log("➡️ Batch API URL:", batchUrl);

    let batchResp;
    try {
      batchResp = await axios.post(
        batchUrl,
        {
          inputs: invoiceIds.map((id) => ({ id })),
          properties: [
            "hs_invoice_number",
            "hs_invoice_status",
            "hs_invoice_total_amount",
            "hs_due_date",
          ],
        },
        {
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          timeout: 5000,
        }
      );
    } catch (e) {
      console.error("❌ Error calling Batch API:", e.response?.data || e.message);
      return res.status(500).json({ results: [], error: e.message });
    }

    console.log("✅ Batch API Response:", batchResp.data);

    const results = (batchResp.data.results || []).map((inv) => {
      const p = inv.properties || {};
      return {
        objectId: inv.id,
        title: p.hs_invoice_number || `Invoice ${inv.id}`,
        properties: {
          amount: p.hs_invoice_total_amount || "",
          status: p.hs_invoice_status || "",
          due_date: p.hs_due_date || "",
        },
      };
    });

    console.log("📦 Final Results:", results.json());

    return res.json({ results });
  } catch (err) {
    console.error("❌ Unexpected error fetching invoices:", err.message);
    return res.status(500).json({ results: [], error: err.message });
  }
});


app.listen(PORT, () => console.log(`=== Starting your app on http://localhost:${PORT} ===`));
