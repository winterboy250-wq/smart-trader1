import { createDecipheriv, createHash } from "node:crypto";
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
export const handler = async (event) => {
  const sessionId = cookieValue(event.headers?.cookie || event.headers?.Cookie);
  if (!sessionId) return response(401, { ok: false, authenticated: false, error: "No secure Deriv session. Connect Deriv first." });
  if (!process.env.SESSION_SECRET) return response(503, { ok: false, error: "SESSION_SECRET is not configured." });

  try {
    const client = await getMongoClient();
    const database = client.db(DB_NAME);
    const sessions = database.collection("deriv_sessions");
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
      const accessToken = decryptToken(session.token);
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
