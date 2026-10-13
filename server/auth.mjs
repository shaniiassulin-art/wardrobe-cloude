import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "wardrobe_session";
const ONE_YEAR = 365 * 24 * 60 * 60;

export function deriveToken(password, purpose) {
  return createHmac("sha256", password).update(`wardrobe-${purpose}-v1`).digest("hex");
}

export function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  return left.length === right.length && timingSafeEqual(left, right);
}

function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

const jsonResponse = (status, value, headers = {}) => new Response(JSON.stringify(value), {
  status,
  headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers },
});

// Handles /api/import/login and /api/import/session, and rejects every other API
// request that lacks a valid session cookie. Returns null when the request may proceed.
// Without a password (local development) everything is allowed.
export async function authGate(request, password) {
  const { pathname } = new URL(request.url);
  const authenticated = !password || safeEqual(readCookie(request, SESSION_COOKIE), deriveToken(password, "session"));

  if (pathname === "/api/import/session") {
    return authenticated
      ? jsonResponse(200, { authenticated: true, required: Boolean(password) })
      : jsonResponse(401, { authenticated: false, required: true });
  }

  if (pathname === "/api/import/login" && request.method === "POST") {
    if (!password) return jsonResponse(200, { authenticated: true, required: false });
    const input = await request.json().catch(() => ({}));
    if (!safeEqual(input.password, password)) {
      await new Promise((resolve) => setTimeout(resolve, 800));
      return jsonResponse(401, { error: "הסיסמה שגויה." });
    }
    const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
    return jsonResponse(200, { authenticated: true, required: true }, {
      "Set-Cookie": `${SESSION_COOKIE}=${deriveToken(password, "session")}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ONE_YEAR}${secure}`,
    });
  }

  if (pathname === "/api/import/logout" && request.method === "POST") {
    return jsonResponse(200, { authenticated: false }, {
      "Set-Cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    });
  }

  return authenticated ? null : jsonResponse(401, { error: "יש להתחבר מחדש." });
}
