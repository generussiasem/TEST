# Kasir + Bot Telegram PPOB (Jabber, tanpa VPS)

Semua jalan di Cloudflare Worker + D1 — tidak ada server yang perlu Anda nyalakan sendiri.

## 1. Buat resource Cloudflare

```
npm install
wrangler d1 create kasir-ppob-db
```

Salin `database_id` yang muncul ke `wrangler.toml`, lalu:

```
npm run db:init
```

## 2. Buat bot Telegram

1. Chat `@BotFather` di Telegram → `/newbot` → catat **token**.
2. Set webhook (ganti `<TOKEN>`, `<SECRET>`, `<WORKER_URL>`):

```
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<WORKER_URL>/telegram/webhook&secret_token=<SECRET>"
```

`<SECRET>` bebas Anda tentukan sendiri (string acak), nanti dipakai juga di secret `TELEGRAM_SECRET`.

## 3. Isi secrets

```
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_SECRET
wrangler secret put JABBER_JID        # akun Jabber yang Anda daftarkan sendiri (bukan akun OrderKuota)
wrangler secret put JABBER_PASSWORD   # password akun Jabber tersebut
wrangler secret put JABBER_PIN        # PIN transaksi PPOB Anda
wrangler secret put AUTH_SECRET       # string acak panjang, buat tanda-tangan sesi login karyawan
wrangler secret put PRICE_LIST_URL    # link JSON harga dari CS OkeConnect (opsional, buat /cari)
```

## 3b. Buat akun admin pertama

Setelah deploy (langkah 5), jalankan sekali saja:
```
curl -X POST https://<WORKER_URL>/api/setup \
  -H "Content-Type: application/json" \
  -d '{"name":"Nama Anda","username":"admin","password":"passwordkuat"}'
```
Endpoint ini otomatis terkunci setelah ada 1 karyawan — untuk tambah karyawan/kasir
berikutnya, login dulu lalu pakai `POST /api/employees` (khusus admin).

Login dashboard:
```
curl -X POST https://<WORKER_URL>/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"passwordkuat"}'
```
Hasilnya berisi `token` — dipakai di header `Authorization: Bearer <token>` untuk semua
panggilan `/api/*` lainnya (berlaku 12 jam).

## 4b. Sinkronkan daftar harga (supaya bisa /cari kode produk)

```
wrangler secret put PRICE_LIST_URL
```
Isi dengan link JSON harga dari CS OkeConnect Anda, contoh:
`https://okeconnect.com/harga/json?id=905ccd028329b0a`

Setelah deploy (langkah 5), jalankan sekali (dan ulangi tiap harga berubah):
```
curl -X POST https://<WORKER_URL>/api/products/sync
```
Lalu di bot Telegram bisa pakai `/cari telkomsel 5000` untuk cari kode produk.
Kalau hasil sync kosong/aneh, cek dulu struktur JSON aslinya (`curl <PRICE_LIST_URL>`)
dan sesuaikan pemetaan field di `src/index.js` (fungsi `/api/products/sync`).

## 4. Tambah akun saldo distributor

Lewat endpoint `/api/wallets` (POST), buat baris dengan `type = "distributor_ppob"`,
misalnya "Saldo OkeConnect".

## 5. Deploy

```
npm run deploy
```

## 6. Deploy dashboard web (Cloudflare Pages)

Frontend-nya satu file HTML di folder `web/index.html` — tidak perlu proses build.

1. Buka `web/index.html`, cari baris:
   ```js
   const API_BASE = "https://kasir-ppob.WORKER-ANDA.workers.dev";
   ```
   Ganti dengan URL Worker hasil deploy Anda (langkah 8 di atas).
2. Buka dashboard Cloudflare → **Workers & Pages** → **Create** → **Pages** → **Upload assets**.
3. Upload folder `web` (atau drag file `index.html`-nya).
4. Setelah selesai, Anda dapat URL seperti `https://kasir-ppob-web.pages.dev` — buka di HP, login pakai akun admin yang dibuat di langkah 3b.

Halaman ini sudah termasuk: kasir dengan scan barcode kamera, keranjang & cetak/share struk,
form beli PPOB, riwayat transaksi, laporan laba rugi & arus kas, hutang-piutang dengan tombol
share tagihan, serta pengaturan toko & karyawan (khusus admin).

## 7. Pasang Telegram Mini App (untuk pelanggan)

1. Upload `web/miniapp.html` ke Cloudflare Pages yang sama (satu situs bisa berisi
   beberapa halaman) — pastikan sudah ganti `API_BASE` di dalamnya juga.
   URL-nya jadi seperti `https://kasir-ppob-web.pages.dev/miniapp.html`.
2. Chat **@BotFather** → `/mybots` → pilih bot Anda → **Bot Settings** → **Menu Button**
   → **Configure Menu Button** → tempel URL Mini App tadi, beri label misal "🛒 Order".
3. Selesai — pelanggan tinggal buka chat bot Anda, tekan tombol menu di pojok kiri
   bawah, muncul halaman cari & beli produk tanpa perlu ketik perintah.

Otentikasinya otomatis — Mini App memverifikasi `initData` dari Telegram di sisi
server (`src/telegram-miniapp-auth.js`), jadi tidak perlu form login terpisah untuk
pelanggan.

## Yang masih perlu Anda sesuaikan

- **Format perintah "cek status"** di `checkPendingOrders` (src/index.js) masih placeholder
  (`CEK.R#{ID}`) — konfirmasi ke CS OkeConnect format yang benar, karena screenshot Anda
  hanya menunjukkan format order, bukan format cek status.
- **Daftar kode produk & harga** — sebaiknya diambil dari link JSON harga yang diberikan CS
  (`okeconnect.com/harga/json?id=...`) dan disimpan ke tabel `products`, supaya `/beli`
  bisa validasi kode & hitung laba otomatis (modal vs harga jual).
- **Parser XMPP di `src/jabber.js`** memakai pendekatan regex sederhana, bukan parser XML
  penuh — sudah mencakup alur STARTTLS + SASL PLAIN standar, tapi tetap uji langsung ke
  `gojabber.com` sebelum dipakai produksi, karena setiap server XMPP bisa punya sedikit
  perbedaan perilaku.
- **Mini App** memakai desain terpisah dari dashboard admin (`web/miniapp.html`) supaya
  ringan dan cepat dibuka pelanggan — kalau mau tampilannya disamakan gaya dengan
  dashboard utama, tinggal sesuaikan CSS-nya.
