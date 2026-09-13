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
misalnya "Saldo OkeConnect". Sertakan `provider: "okeconnect"` (atau `"digiflazz"`
kalau sudah ikut langkah di bawah) supaya saldo yang dipotong saat order cocok
dengan provider produknya.

## 4a. (Opsional) Tambah Digiflazz sebagai provider kedua, berdampingan dengan OkeConnect

Digiflazz dipakai lewat jalur **Jabber**, BUKAN REST API — karena REST API
Digiflazz mewajibkan whitelist IP statis yang tidak tersedia di Cloudflare
Worker, sedangkan Jabber tidak mensyaratkan itu sama sekali.

1. Daftar sebagai Buyer di Digiflazz, lalu di member area Anda buat/lihat
   **akun Jabber** Anda sendiri (JID + password) dan **PIN transaksi**.
2. Tambahkan (add contact) ID Jabber "jabber center" Digiflazz sesuai yang
   tertera di halaman Pengaturan Koneksi Jabber akun Anda (tidak ada satu
   alamat baku untuk semua buyer — WAJIB dicek di akun Anda sendiri).
3. Isi secrets berikut:
   ```
   wrangler secret put DIGIFLAZZ_JABBER_PIN
   ```
   Lalu isi `DIGIFLAZZ_JABBER_TARGET` di `wrangler.toml` (`[vars]`) dengan ID
   Jabber center Digiflazz dari langkah 2, lalu `wrangler deploy`.

   **Kalau akun Jabber Anda (JID di langkah 1) sudah dipakai/"berteman" dengan
   H2H beberapa provider sekaligus** (satu akun Jabber pribadi terhubung ke
   OkeConnect DAN Digiflazz, bukan 2 akun terpisah) — cukup segitu saja,
   TIDAK perlu isi `DIGIFLAZZ_JABBER_JID`/`DIGIFLAZZ_JABBER_PASSWORD`, karena
   otomatis dipakaikan `JABBER_JID`/`JABBER_PASSWORD` yang sama dengan
   OkeConnect. PIN tetap wajib diisi terpisah (`DIGIFLAZZ_JABBER_PIN`) karena
   itu kode rahasia dari Digiflazz sendiri, bukan bagian dari login Jabber.

   Kalau sebaliknya Anda pakai 2 akun Jabber yang benar-benar berbeda untuk
   tiap provider, isi juga:
   ```
   wrangler secret put DIGIFLAZZ_JABBER_JID
   wrangler secret put DIGIFLAZZ_JABBER_PASSWORD
   ```
4. Jalankan migrasi `migrasi-fitur-digiflazz.sql` sekali ke database yang
   sudah berjalan (kalau database baru, `schema.sql` sudah termasuk semua ini).
5. Tambahkan produk Digiflazz manual lewat halaman **Produk** (atau
   `POST /api/products`), isi `provider: "digiflazz"` dan `code` = kode SKU
   Digiflazz Anda (`buyer_sku_code`). **Belum ada sinkronisasi harga otomatis**
   untuk Digiflazz (beda dari OkeConnect yang sudah ada tombol "Sinkron Harga
   PPOB") — format balasan perintah cek-harga Jabber Digiflazz (`H.`) belum
   dipastikan cukup terstruktur untuk di-parse otomatis, jadi untuk sekarang
   harga & kode produk Digiflazz diinput manual dan diperbarui sendiri.
6. **Prabayar & pascabayar SUDAH keduanya didukung**, tapi mekanismenya beda:
   - Prabayar (pulsa/paket data/token): satu kali order lewat `/api/ppob/order`,
     command `KODE.NOMOR.PIN R#TRXID`.
   - Pascabayar (listrik/PDAM/dll): WAJIB 2 langkah — panggil `/api/ppob/cek`
     dulu (command `cek.KODE.NOMOR.PIN`, tidak potong saldo) untuk lihat
     nominal tagihan & nama pelanggan, baru `/api/ppob/order` (command
     `bayar.KODE.NOMOR.PIN`) di **HARI YANG SAMA** untuk benar-benar membayar
     — syarat ini dari Digiflazz sendiri, bukan batasan project ini.
   - Khusus produk Samsat, isi `target` dengan format
     `KodePembayaran,NomorIdentitas` (dipisah koma) sesuai dokumentasi mereka.
   - **Order pascabayar Digiflazz TIDAK bisa di-cek-ulang otomatis** (tombol
     "Cek Ulang Status" akan menolak) karena command `bayar.` tidak punya trx
     id sama sekali — mengirim ulang begitu saja beresiko dobel-bayar. Kalau
     balasannya sempat terputus/error, cek status pembayarannya langsung ke
     CS atau member area Digiflazz, jangan andalkan tombol cek ulang.
7. Uji dengan transaksi kecil dulu sebelum dipakai produksi — semua format
   pesan Jabber Digiflazz di atas diambil dari dokumentasi resmi tapi belum
   pernah diuji langsung ke server mereka dari project ini.

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
- **Digiflazz (kalau dipakai)**: format pesan Jabber (prabayar & pascabayar,
  lihat bagian 4a poin 6) diambil dari dokumentasi resmi tapi belum pernah
  diuji ke server Digiflazz asli — wajib dites dengan transaksi kecil dulu,
  terutama alur "Cek Tagihan → Bayar Tagihan" pascabayar. Cek-ulang-status
  otomatis SENGAJA tidak didukung untuk order pascabayar Digiflazz (resiko
  dobel-bayar, lihat poin 6). Sinkronisasi harga otomatis juga belum ada
  untuk Digiflazz — produk diinput manual lewat halaman Produk.
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
