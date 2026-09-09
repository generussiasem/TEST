// Validasi initData yang dikirim oleh Telegram Mini App, sesuai algoritma resmi:
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//
// secret_key = HMAC_SHA256(key="WebAppData", data=botToken)
// hash_valid = HMAC_SHA256(key=secret_key, data=dataCheckString) (hex) === hash yang dikirim

async function hmacSha256(keyBytes, messageBytes) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, messageBytes);
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function verifyTelegramInitData(botToken, initDataStr, maxAgeSeconds = 86400) {
  if (!initDataStr) return null;
  const params = new URLSearchParams(initDataStr);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const encoder = new TextEncoder();
  const secretKey = await hmacSha256(encoder.encode("WebAppData"), encoder.encode(botToken));
  const computedHash = toHex(await hmacSha256(secretKey, encoder.encode(dataCheckString)));

  if (computedHash !== hash) return null;

  const authDate = Number(params.get("auth_date") || 0);
  if (maxAgeSeconds && Date.now() / 1000 - authDate > maxAgeSeconds) return null; // initData kedaluwarsa

  const user = params.get("user") ? JSON.parse(params.get("user")) : null;
  return { user, authDate };
}

/** Middleware Hono untuk /miniapp/*: baca header X-Telegram-Init-Data, verifikasi, set c.set("tgUser"). */
export async function requireTelegramInitData(c, next) {
  const initData = c.req.header("x-telegram-init-data");
  const result = await verifyTelegramInitData(c.env.TELEGRAM_BOT_TOKEN, initData);
  if (!result) return c.json({ ok: false, error: "Data Telegram tidak valid, buka lagi lewat bot." }, 401);
  c.set("tgUser", result.user);
  await next();
}
