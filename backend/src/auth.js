// Autentikasi ringan tanpa dependensi eksternal (pakai Web Crypto bawaan Workers).
// Password di-hash dengan PBKDF2 (bukan plaintext). Sesi berupa token yang
// ditandatangani HMAC-SHA256 (bukan disimpan di server), berisi employeeId,
// role, dan waktu kedaluwarsa — mirip pola token di Worker "buku-kas" Anda.

function toBase64Url(bytes) {
  let str = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    key,
    256
  );
  return `${toBase64Url(salt)}.${toBase64Url(bits)}`;
}

export async function verifyPassword(password, stored) {
  const [saltB64, hashB64] = stored.split(".");
  const salt = fromBase64Url(saltB64);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    key,
    256
  );
  return toBase64Url(bits) === hashB64;
}

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return toBase64Url(sig);
}

export async function createToken(env, payload, ttlSeconds = 60 * 60 * 12) {
  const body = { ...payload, exp: Date.now() + ttlSeconds * 1000 };
  const payloadB64 = toBase64Url(new TextEncoder().encode(JSON.stringify(body)));
  const sig = await hmac(env.AUTH_SECRET, payloadB64);
  return `${payloadB64}.${sig}`;
}

export async function verifyToken(env, token) {
  if (!token) return null;
  const [payloadB64, sig] = token.split(".");
  if (!payloadB64 || !sig) return null;
  const expectedSig = await hmac(env.AUTH_SECRET, payloadB64);
  if (expectedSig !== sig) return null;
  const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadB64)));
  if (payload.exp < Date.now()) return null;
  return payload;
}

/** Middleware Hono: wajib login. Tempel c.set("employee", payload) kalau valid. */
export async function requireAuth(c, next) {
  const authHeader = c.req.header("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const payload = await verifyToken(c.env, token);
  if (!payload) return c.json({ ok: false, error: "Belum login / sesi kedaluwarsa" }, 401);
  c.set("employee", payload);
  await next();
}

/** Middleware Hono: wajib role admin (pasang setelah requireAuth). */
export async function requireAdmin(c, next) {
  const employee = c.get("employee");
  if (!employee || employee.role !== "admin") {
    return c.json({ ok: false, error: "Khusus admin" }, 403);
  }
  await next();
}
