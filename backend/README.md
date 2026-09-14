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
misalnya "Saldo OkeConnect". Sertakan `provider: "okeconnect"` supaya saldo yang
dipotong saat order cocok dengan provider produknya.

## 4c. Bot Telegram admin/kasir — kelola Hutang & konfirmasi harga PPOB lewat tombol

Berbeda dari bot jualan PPOB publik di atas (`/beli`, `/cari`, dst — siapa
saja boleh pakai), fitur ini KHUSUS untuk karyawan yang sudah login di
dashboard web, dipakai lewat menu tombol (bukan command teks) gaya bot
Telegram pada umumnya.

1. Jalankan migrasi `migrasi-fitur-bot-admin.sql` sekali ke database yang
   sudah berjalan (instalasi baru cukup pakai `schema.sql` yang sudah
   termasuk perubahan ini).
2. Di halaman **Karyawan**, klik "Hubungkan Bot Telegram" pada baris
   karyawan yang mau dihubungkan → muncul kode 6 digit (berlaku 10 menit).
3. Karyawan tsb buka bot Telegram Anda, kirim `/hubung KODE` → chat itu
   otomatis tertaut ke akunnya (`employees.telegram_id`).
4. Kirim `/menu` (atau `/start`) ke bot → muncul menu tombol:
   - **📋 Cek Hutang Pelanggan** — daftar pelanggan yang masih punya
     hutang, tap salah satu untuk lihat riwayat & tombol "💵 Catat
     Pembayaran" (bot lalu minta kirim nominal, dicatat persis seperti
     mengisi form Cicilan di halaman Hutang Piutang web).
   - **🧾 Konfirmasi Order PPOB** — daftar order PPOB yang sudah *sukses*
     dari provider tapi harga jualnya belum dikonfirmasi/dicatat. Tap satu
     → bisa "✅ Pakai harga default" atau "✏️ Ubah Harga" (kirim nominal
     baru) sebelum benar-benar dicatat sebagai transaksi & saldo
     distributor terpotong — ini jalur yang SAMA PERSIS dengan tombol
     "Konfirmasi" di halaman PPOB/Tagihan pada web (satu fungsi backend
     yang sama, `finalizePpobOrder`), jadi harga yang dikonfirmasi lewat
     bot langsung sinkron ke laporan web.
   - **💳 Saldo Distributor** — saldo semua akun `distributor_ppob`.
5. Untuk memutuskan koneksi (mis. karyawan resign atau ganti HP), klik
   "Putuskan" di halaman Karyawan — atau admin bisa hubungkan ulang dengan
   kode baru kapan saja.

**Catatan**: fitur "bagikan" (struk belanja, struk PPOB, tagihan hutang)
sengaja dibuat sebagai tombol biasa di halaman web (📤 *Bagikan via
WhatsApp*, sudah ada di Kasir/PPOB/Tagihan, dan sekarang juga di halaman
Kontak untuk tagihan hutang) — BUKAN dikirim otomatis dari bot, supaya
kasir yang menentukan kapan & ke nomor mana pesannya dikirim.

## 4d. Mini App Kasir di Telegram (catat/bayar hutang & transaksi PPOB dari HP)

Selain menu tombol chat biasa (poin 4c), ada juga **Telegram Mini App** —
halaman kecil bergaya app (bukan cuma pesan tombol) yang muncul di dalam
Telegram, isinya form catat hutang, bayar hutang, dan order PPOB (cari
produk, isi nomor tujuan, pilih Tunai/Utang, sampai konfirmasi harga jual).
Semua aksinya lewat fungsi backend yang SAMA dengan dashboard web (`ppob.js`),
jadi begitu dicatat lewat mini app langsung muncul juga di laporan web —
tidak ada data yang terpisah.

1. Isi secret `MINIAPP_URL` — alamat halaman mini app-nya, yaitu Worker Anda
   sendiri ditambah `/miniapp`:
   ```
   wrangler secret put MINIAPP_URL
   ```
   Isi dengan, misalnya: `https://<WORKER_URL>/miniapp` (satu Worker yang sama
   dengan `/api/*`, tidak perlu domain/hosting terpisah).
2. Deploy ulang (`npm run deploy`).
3. Karyawan yang SUDAH terhubung lewat `/hubung KODE` (lihat poin 4c) kirim
   `/menu` ke bot → sekarang ada tombol tambahan **"🧮 Buka Mini App Kasir"**
   di paling atas — tap untuk membuka.
4. Kalau tombolnya tidak mau terbuka / Telegram menolak, biasanya karena
   domain belum didaftarkan ke bot: buka `@BotFather` → pilih bot Anda →
   **Bot Settings → Menu Button** atau `/setdomain`, isi dengan domain Worker
   Anda (tanpa `https://` dan tanpa path, mis. `test.psudiningsih.workers.dev`).

**Catatan**: mini app ini otomatis menolak dibuka lewat browser biasa (bukan
dari dalam Telegram) — itu bukan bug, memang disengaja karena autentikasinya
memverifikasi data resmi dari Telegram (`initData`), bukan username/password.

## 5. Deploy

```
npm run deploy
```

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
- Frontend kasir (Vue) belum disertakan di scaffold ini — endpoint `/api/*` sudah siap
  dikonsumsi kalau Anda mau lanjutkan frontend seperti "Kasir Warung" sebelumnya.
- **Harga jual produk PPOB tidak lagi diberi markup otomatis** — sinkron harga
  OkeConnect sekarang cuma mengisi `sell_price = cost_price` (untung Rp0) untuk
  produk yang BARU pertama kali muncul, dan tidak lagi menimpa `sell_price`
  produk yang sudah ada tiap kali sinkron (supaya harga yang sudah Anda atur
  manual di halaman Produk tidak ketiban ulang). Atur margin Anda sendiri per
  produk di halaman Produk.
- **Bot admin/kasir (menu Hutang & Konfirmasi PPOB)** memakai `editMessageText`
  Telegram supaya 1 pesan berubah-ubah isinya saat navigasi menu — kalau pesan
  itu sudah terlalu lama (Telegram membatasi edit pesan yang sangat lama,
  umumnya 48 jam) atau sudah dihapus manual oleh user, tombolnya akan gagal;
  minta karyawan kirim `/menu` ulang untuk dapat pesan baru. Alur "menunggu
  input" (nominal pembayaran/harga) di `bot_sessions` otomatis kedaluwarsa
  setelah 5 menit tanpa balasan (`SESSION_TIMEOUT_MINUTES` di `bot-admin.js`)
  — kalau karyawan telat balas, bot akan minta kirim `/menu` lagi daripada
  salah mengartikan pesan berikutnya sebagai nominal.
