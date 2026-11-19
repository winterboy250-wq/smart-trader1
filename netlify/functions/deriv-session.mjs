import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { MongoClient } from "mongodb";

const COOKIE_NAME = "st_oauth_session";
const DB_NAME = process.env.MONGODB_DB_NAME || "smart_trader";
let cachedClientPromise;

function response(statusCode, body, headers = {}) {
  return { statusCode, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", ...headers }, body: JSON.stringify(body) };
}
async function getMongoClient() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not configured");
  if (!cachedClientPromise) {
    const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000, maxPoolSize: 5 });
    cachedClientPromise = client.connect().catch((error) => { cachedClientPromise = undefined; throw error; });
  }
  return cachedClientPromise;
}
function cookieValue(header) {
  for (const item of (header || "").split(";")) {
    const index = item.indexOf("=");
    if (index >= 0 && item.slice(0, index).trim() === COOKIE_NAME) return item.slice(index + 1).trim();
  }
  return null;
}
function decryptToken(encrypted) {
  const key = createHash("sha256").update(process.env.SESSION_SECRET).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, "base64")), decipher.final()]).toString("utf8");
}
function encryptToken(token) {
  const key = createHash("sha256").update(process.env.SESSION_SECRET).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return { ciphertext: encrypted.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}
async function getUsableAccessToken(database, session) {
  if (session.tokenExpiresAt && session.tokenExpiresAt.getTime() > Date.now() + 60000) {
    return decryptToken(session.token);
  }
  if (!session.refreshToken) throw new Error("Deriv session expired. Reconnect Deriv.");
  const refreshToken = decryptToken(session.refreshToken);
  const authBase = process.env.NEXT_PUBLIC_DERIV_ENV === "preview" || process.env.NEXT_PUBLIC_DERIV_ENV === "staging"
    ? "https://staging-auth.deriv.com/oauth2" : "https://auth.deriv.com/oauth2";
  const refreshResponse = await fetch(`${authBase}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: process.env.DERIV_CLIENT_ID || process.env.NEXT_PUBLIC_DERIV_APP_ID || "",
    }).toString(),
  });
  if (!refreshResponse.ok) throw new Error("Deriv token refresh failed. Reconnect Deriv.");
  const refreshed = await refreshResponse.json();
  if (!refreshed.access_token) throw new Error("Deriv did not return a refreshed access token.");
  const update = {
    token: encryptToken(refreshed.access_token),
    tokenExpiresAt: new Date(Date.now() + Number(refreshed.expires_in || 3600) * 1000),
  };
  if (refreshed.refresh_token) update.refreshToken = encryptToken(refreshed.refresh_token);
  await database.collection("deriv_sessions").updateOne({ _id: session._id }, { $set: update });
  return refreshed.access_token;
}
export const handler = async (event) => {
  if (event.httpMethod === "POST") {
    const requestOrigin = event.headers?.origin;
    const requestHost = event.headers?.host;
    if (!requestOrigin || !requestHost || requestOrigin !== `https://${requestHost}`) {
      return response(403, { ok: false, error: "Cross-origin session request rejected." });
    }
  }
  const sessionId = cookieValue(event.headers?.cookie || event.headers?.Cookie);
  if (!sessionId) return response(401, { ok: false, authenticated: false, error: "No secure Deriv session. Connect Deriv first." });
  if (!process.env.SESSION_SECRET) return response(503, { ok: false, error: "SESSION_SECRET is not configured." });

  try {
    const client = await getMongoClient();
    const database = client.db(DB_NAME);
    const sessions = database.collection("deriv_sessions");
    if (event.httpMethod === "POST") {
      let payload;
      try { payload = JSON.parse(event.body || "{}"); } catch { return response(400, { ok: false, error: "Invalid JSON body" }); }
      if (payload.action === "logout") {
        await sessions.deleteOne({ _id: sessionId });
        return response(200, { ok: true, authenticated: false }, { "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
      }
    }

    const session = await sessions.findOne({ _id: sessionId, expiresAt: { $gt: new Date() } });
    if (!session) return response(401, { ok: false, authenticated: false, error: "Deriv session expired. Please reconnect." });

    if (event.httpMethod === "GET") {
      return response(200, { ok: true, database: "connected", authenticated: true, accounts: session.accounts || [] });
    }
    if (event.httpMethod !== "POST") return response(405, { ok: false, error: "Method not allowed" }, { Allow: "GET, POST" });

    let payload;
    try { payload = JSON.parse(event.body || "{}"); } catch { return response(400, { ok: false, error: "Invalid JSON body" }); }

    if (payload.action === "logout") {
      await sessions.deleteOne({ _id: sessionId });
      return response(200, { ok: true, authenticated: false }, { "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
    }

    if (payload.action === "otp") {
      const accountId = String(payload.accountId || "");
      if (!session.accounts?.some((account) => account.account_id === accountId)) {
        return response(403, { ok: false, error: "That account is not part of this Deriv session." });
      }
      const accessToken = await getUsableAccessToken(database, session);
      const apiBase = process.env.NEXT_PUBLIC_DERIV_ENV === "preview" || process.env.NEXT_PUBLIC_DERIV_ENV === "staging"
        ? "https://staging-api.derivws.com/trading/v1/options" : "https://api.derivws.com/trading/v1/options";
      const otpResponse = await fetch(`${apiBase}/accounts/${encodeURIComponent(accountId)}/otp`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Deriv-App-ID": process.env.DERIV_CLIENT_ID || process.env.NEXT_PUBLIC_DERIV_APP_ID || "" },
      });
      if (!otpResponse.ok) return response(502, { ok: false, error: `Deriv WebSocket authorization failed (${otpResponse.status}).` });
      const otp = await otpResponse.json();
      if (!otp?.data?.url) return response(502, { ok: false, error: "Deriv did not return a WebSocket URL." });
      return response(200, { ok: true, websocketUrl: otp.data.url });
    }
    return response(400, { ok: false, error: "Unsupported action" });
  } catch {
    return response(503, { ok: false, error: "Secure session service unavailable. Check MongoDB and server configuration." });
  }
};
