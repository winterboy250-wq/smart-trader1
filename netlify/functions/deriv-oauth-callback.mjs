import { randomBytes, createCipheriv, createHash } from "node:crypto";
import { MongoClient } from "mongodb";

const COOKIE = "st_oauth_session";
const DB = process.env.MONGODB_DB_NAME || "smart_trader";
let clientPromise;

function dbClient() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not configured");
  if (!clientPromise) {
    const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000, maxPoolSize: 5 });
    clientPromise = client.connect().catch((e) => { clientPromise = undefined; throw e; });
  }
  return clientPromise;
}
function reply(statusCode, body, headers = {}) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers }, body: JSON.stringify(body) };
}
function cookieValue(header) {
  for (const item of (header || "").split(";")) {
    const i = item.indexOf("=");
    if (i >= 0 && item.slice(0, i).trim() === COOKIE) return item.slice(i + 1).trim();
  }
  return null;
}
function encryptToken(token) {
  const key = createHash("sha256").update(process.env.SESSION_SECRET).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return { ciphertext: encrypted.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" }, { Allow: "POST" });
  let input;
  try { input = JSON.parse(event.body || "{}"); } catch { return reply(400, { error: "Invalid request" }); }
  if (typeof input.code !== "string" || input.code.length < 1 || input.code.length > 2048 ||
      typeof input.state !== "string" || !/^[A-Za-z0-9_-]{30,100}$/.test(input.state)) {
    return reply(400, { error: "Missing or invalid OAuth code/state" });
  }
  const sessionId = cookieValue(event.headers?.cookie || event.headers?.Cookie);
  if (!sessionId || !process.env.SESSION_SECRET) return reply(401, { error: "OAuth session expired. Please connect Deriv again." });

  try {
    const client = await dbClient();
    const database = client.db(DB);
    const sessions = database.collection("oauth_sessions");
    const session = await sessions.findOne({ _id: sessionId, state: input.state, expiresAt: { $gt: new Date() } });
    if (!session) return reply(401, { error: "OAuth state did not match this browser session. Please reconnect." });

    const authBase = process.env.NEXT_PUBLIC_DERIV_ENV === "preview" || process.env.NEXT_PUBLIC_DERIV_ENV === "staging"
      ? "https://staging-auth.deriv.com/oauth2" : "https://auth.deriv.com/oauth2";
    const tokenResponse = await fetch(`${authBase}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code: input.code, client_id: session.clientId,
        redirect_uri: session.redirectUri, code_verifier: session.verifier,
      }).toString(),
    });
    if (!tokenResponse.ok) {
      await sessions.deleteOne({ _id: sessionId });
      return reply(502, { error: `Deriv token exchange failed (${tokenResponse.status}). Please reconnect.` });
    }
    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token) return reply(502, { error: "Deriv did not return an access token." });

    const apiBase = process.env.NEXT_PUBLIC_DERIV_ENV === "preview" || process.env.NEXT_PUBLIC_DERIV_ENV === "staging"
      ? "https://staging-api.derivws.com/trading/v1/options" : "https://api.derivws.com/trading/v1/options";
    const accountsResponse = await fetch(`${apiBase}/accounts`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, "Deriv-App-ID": session.clientId },
    });
    if (!accountsResponse.ok) return reply(502, { error: `Deriv account verification failed (${accountsResponse.status}).` });
    const accountsData = await accountsResponse.json();
    const accounts = Array.isArray(accountsData.data) ? accountsData.data : [];
    if (!accounts.length) return reply(403, { error: "Deriv authorization succeeded but no trading accounts were returned." });

    const sessionRecord = {
      _id: sessionId,
      token: encryptToken(tokenData.access_token),
      refreshToken: tokenData.refresh_token ? encryptToken(tokenData.refresh_token) : null,
      tokenExpiresAt: new Date(Date.now() + Number(tokenData.expires_in || 3600) * 1000),
      scope: tokenData.scope || "",
      accounts: accounts.map(({ account_id, account_type, currency, balance, group, status }) => ({
        account_id, account_type, currency, balance, group, status,
      })),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    };
    await database.collection("deriv_sessions").replaceOne({ _id: sessionId }, sessionRecord, { upsert: true });
    await sessions.deleteOne({ _id: sessionId });

    return reply(200, { authenticated: true, accounts: sessionRecord.accounts }, {
      "Set-Cookie": `${COOKIE}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
    });
  } catch (error) {
    return reply(503, { error: "Secure Deriv callback could not complete. Check backend configuration and MongoDB access." });
  }
};
