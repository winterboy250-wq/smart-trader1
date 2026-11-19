import { randomBytes, createHash } from "node:crypto";
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
function b64url(value) { return Buffer.from(value).toString("base64url"); }

export const handler = async (event) => {
  if (event.httpMethod !== "POST") return reply(405, { error: "Method not allowed" }, { Allow: "POST" });
  let input;
  try { input = JSON.parse(event.body || "{}"); } catch { return reply(400, { error: "Invalid request" }); }

  const clientId = process.env.DERIV_CLIENT_ID || process.env.NEXT_PUBLIC_DERIV_APP_ID;
  const redirectUri = input.redirectUri;
  const origin = event.headers?.origin;
  const allowedOrigin = event.headers?.host ? `https://${event.headers.host}` : "";
  if (!clientId || !process.env.SESSION_SECRET || !process.env.MONGODB_URI) {
    return reply(503, { error: "OAuth backend is not configured. Check DERIV_CLIENT_ID, SESSION_SECRET and MONGODB_URI." });
  }
  if (typeof redirectUri !== "string" || !origin || origin !== allowedOrigin || !redirectUri.startsWith(origin + "/") && redirectUri !== origin) {
    return reply(400, { error: "Invalid OAuth redirect origin" });
  }

  const sessionId = b64url(randomBytes(32));
  const state = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(32));
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const environment = process.env.NEXT_PUBLIC_DERIV_ENV === "preview" || process.env.NEXT_PUBLIC_DERIV_ENV === "staging" ? "staging-" : "";
  const authBase = `https://${environment}auth.deriv.com/oauth2/auth`;
  const params = new URLSearchParams({
    response_type: "code", client_id: clientId, redirect_uri: redirectUri,
    scope: input.scopes || "trade", state, code_challenge: challenge, code_challenge_method: "S256",
  });
  const attributionKeys = ["t", "affiliate_token", "sidi", "ca", "utm_source", "utm_medium", "utm_campaign"];
  for (const key of attributionKeys) {
    if (typeof input[key] === "string" && input[key].length < 500) params.set(key, input[key]);
  }
  if (input.prompt === "registration") params.set("prompt", "registration");

  try {
    const client = await dbClient();
    const sessions = client.db(DB).collection("oauth_sessions");
    await sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await sessions.insertOne({
      _id: sessionId, state, verifier, clientId, redirectUri,
      createdAt: new Date(), expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    return reply(200, { authorizationUrl: `${authBase}?${params.toString()}` }, {
      "Set-Cookie": `${COOKIE}=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    });
  } catch {
    return reply(503, { error: "Could not create a secure OAuth session. Check MongoDB access." });
  }
};
