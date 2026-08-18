// Zero-dependency Google service-account auth: signs a JWT with node:crypto
// and exchanges it for an OAuth2 access token. Avoids pulling in
// google-auth-library / googleapis just for this one flow.

import { createSign } from "node:crypto";
import { fetchWithTimeout } from "./fetchWithTimeout.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

let cachedToken = null; // { accessToken, expiresAt }

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function signJWT(email, privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claim = {
    iss: email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claim))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer
    .sign(privateKey)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${signingInput}.${signature}`;
}

/**
 * Returns a valid access token, fetching/caching a fresh one as needed.
 * Reads GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY from process.env.
 * Returns null if credentials aren't configured.
 */
export async function getAccessToken() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let key = process.env.GOOGLE_PRIVATE_KEY;
  if (!email || !key) return null;

  // .env files commonly store the key with literal "\n" sequences.
  key = key.replace(/\\n/g, "\n");

  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.accessToken;
  }

  const jwt = signJWT(email, key);
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt,
  });

  const res = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google token exchange failed (${res.status}): ${text}`);
  }

  const json = await res.json();
  cachedToken = {
    accessToken: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
  return cachedToken.accessToken;
}
