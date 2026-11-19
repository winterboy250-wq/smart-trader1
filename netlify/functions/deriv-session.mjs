import { MongoClient } from "mongodb";

const COOKIE_NAME = "st_oauth_session";
const DB_NAME = process.env.MONGODB_DB_NAME || "smart_trader";
let cachedClientPromise;

function response(statusCode, body, headers = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}

async function getMongoClient() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is not configured");
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

function cookieValue(header, name) {
  for (const item of (header || "").split(";")) {
    const index = item.indexOf("=");
    if (index < 0) continue;
    if (item.slice(0, index).trim() === name) {
      return item.slice(index + 1).trim();
    }
  }
  return null;
}

export const handler = async (event) => {
  const method = event.httpMethod;

  if (method === "POST") {
    let payload;
    try {
      payload = JSON.parse(event.body || "{}");
    } catch {
      return response(400, { ok: false, error: "Invalid JSON body" });
    }

    if (payload.action !== "logout") {
      return response(400, { ok: false, error: "Unsupported action" });
    }

    return response(
      200,
      { ok: true, authenticated: false },
      {
        "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      }
    );
  }

  if (method !== "GET") {
    return response(405, { ok: false, error: "Method not allowed" }, { Allow: "GET, POST" });
  }

  const sessionCookie = cookieValue(event.headers?.cookie || event.headers?.Cookie, COOKIE_NAME);

  try {
    const client = await getMongoClient();
    await client.db(DB_NAME).command({ ping: 1 });

    // Readiness only: no OAuth token is accepted from the browser and no
    // authenticated Deriv session is created by this endpoint yet.
    return response(200, {
      ok: true,
      database: "connected",
      sessionSecretConfigured: Boolean(process.env.SESSION_SECRET),
      authenticated: false,
      sessionCookiePresent: Boolean(sessionCookie),
      derivConnected: false,
    });
  } catch {
    return response(503, {
      ok: false,
      database: "unavailable",
      sessionSecretConfigured: Boolean(process.env.SESSION_SECRET),
      authenticated: false,
      error: "Backend database is not ready. Check Netlify environment variables and MongoDB network access.",
    });
  }
};
