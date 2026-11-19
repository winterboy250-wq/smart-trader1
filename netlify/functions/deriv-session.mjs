import { MongoClient } from "mongodb";

const COOKIE_NAME = "st_oauth_session";
const DB_NAME = process.env.MONGODB_DB_NAME || "smart_trader";

let cachedClientPromise;

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

function getMongoClient() {
  if (!process.env.MONGODB_URI) {
    throw new Error("MONGODB_URI is not configured");
  }

  if (!cachedClientPromise) {
    const client = new MongoClient(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
      maxPoolSize: 5,
    });
    cachedClientPromise = client.connect().catch((error) => {
      cachedClientPromise = undefined;
      throw error;
    });
  }

  return cachedClientPromise;
}

function readCookie(cookieHeader, name) {
  const cookies = (cookieHeader || "").split(";");
  for (const part of cookies) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }
  return null;
}

export default async (request) => {
  const method = request.httpMethod || request.method;
  if (method !== "GET" && method !== "POST") {
    return json(405, { ok: false, error: "Method not allowed" }, { Allow: "GET, POST" });
  }

  if (method === "POST") {
    let payload = {};
    try {
      payload = JSON.parse(request.body || "{}");
    } catch {
      return json(400, { ok: false, error: "Invalid JSON body" });
    }

    if (payload.action !== "logout") {
      return json(400, { ok: false, error: "Unsupported action" });
    }

    return json(
      200,
      { ok: true, authenticated: false },
      {
        "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      }
    );
  }

  const sessionCookie = readCookie(
    request.headers?.cookie || request.headers?.Cookie,
    COOKIE_NAME
  );

  try {
    const client = await getMongoClient();
    await client.db(DB_NAME).command({ ping: 1 });

    // This initial endpoint deliberately does not accept access tokens from the
    // browser. OAuth callback/session creation is added in the next backend step.
    return json(200, {
      ok: true,
      database: "connected",
      sessionConfigured: Boolean(process.env.SESSION_SECRET),
      authenticated: false,
      sessionPresent: Boolean(sessionCookie),
      derivConnected: false,
    });
  } catch {
    return json(503, {
      ok: false,
      database: "unavailable",
      sessionConfigured: Boolean(process.env.SESSION_SECRET),
      authenticated: false,
      error: "Backend database is not ready. Check Netlify environment variables and MongoDB network access.",
    });
  }
};
