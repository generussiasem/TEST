// ---------------------------------------------------------------------------
// SYNC PRODUK PPOB DARI OKECONNECT
// ---------------------------------------------------------------------------
// Endpoint:
// POST /api/products/sync
//
// Secret yang diperlukan:
// PRICE_LIST_URL
//
// Contoh:
// https://okeconnect.com/harga/json?id=XXXXXXXX
//
// Fungsi:
// 1. Validasi PRICE_LIST_URL
// 2. Request ke API daftar harga
// 3. Validasi HTTP status
// 4. Validasi JSON
// 5. Mendeteksi beberapa format response umum
// 6. Mapping kode/nama/kategori/harga
// 7. Mengabaikan produk nonaktif
// 8. UPSERT ke D1 products
// 9. Mengembalikan informasi error yang jelas
// ---------------------------------------------------------------------------

app.post("/api/products/sync", async (c) => {
  const startedAt = Date.now();

  try {
    // ---------------------------------------------------------
    // 1. Pastikan binding D1 tersedia
    // ---------------------------------------------------------
    if (!c.env.DB) {
      return c.json(
        {
          ok: false,
          error: "Binding D1 'DB' tidak tersedia di Worker",
        },
        500
      );
    }

    // ---------------------------------------------------------
    // 2. Pastikan PRICE_LIST_URL tersedia
    // ---------------------------------------------------------
    const priceListUrl = String(c.env.PRICE_LIST_URL || "").trim();

    if (!priceListUrl) {
      return c.json(
        {
          ok: false,
          error: "Secret PRICE_LIST_URL belum dikonfigurasi",
        },
        500
      );
    }

    // ---------------------------------------------------------
    // 3. Validasi URL
    // ---------------------------------------------------------
    let parsedUrl;

    try {
      parsedUrl = new URL(priceListUrl);
    } catch {
      return c.json(
        {
          ok: false,
          error: "PRICE_LIST_URL bukan URL yang valid",
        },
        500
      );
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      return c.json(
        {
          ok: false,
          error: "PRICE_LIST_URL harus menggunakan HTTP atau HTTPS",
        },
        500
      );
    }

    // ---------------------------------------------------------
    // 4. Ambil daftar harga dari OkeConnect
    // ---------------------------------------------------------
    let res;

    try {
      res = await fetch(parsedUrl.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "PPOB-Worker/1.0",
        },
      });
    } catch (err) {
      console.error("PRICE_LIST fetch error:", err);

      return c.json(
        {
          ok: false,
          error: "Gagal menghubungi server daftar harga OkeConnect",
          detail: err instanceof Error ? err.message : String(err),
        },
        502
      );
    }

    // ---------------------------------------------------------
    // 5. Jangan langsung res.json()
    //    Cek HTTP status terlebih dahulu
    // ---------------------------------------------------------
    const contentType = res.headers.get("content-type") || "";

    const rawText = await res.text();

    if (!res.ok) {
      console.error(
        "PRICE_LIST HTTP error:",
        res.status,
        rawText.slice(0, 500)
      );

      return c.json(
        {
          ok: false,
          error: `Server daftar harga mengembalikan HTTP ${res.status}`,
          http_status: res.status,
          content_type: contentType,
          response_preview: rawText.slice(0, 300),
        },
        502
      );
    }

    // ---------------------------------------------------------
    // 6. Parse JSON dengan aman
    // ---------------------------------------------------------
    let data;

    try {
      data = JSON.parse(rawText);
    } catch (err) {
      console.error("PRICE_LIST invalid JSON:", rawText.slice(0, 500));

      return c.json(
        {
          ok: false,
          error: "Response PRICE_LIST_URL bukan JSON yang valid",
          content_type: contentType,
          response_preview: rawText.slice(0, 300),
        },
        502
      );
    }

    // ---------------------------------------------------------
    // 7. Deteksi beberapa bentuk response API
    // ---------------------------------------------------------
    let list = [];

    if (Array.isArray(data)) {
      list = data;
    } else if (Array.isArray(data.data)) {
      list = data.data;
    } else if (Array.isArray(data.result)) {
      list = data.result;
    } else if (Array.isArray(data.products)) {
      list = data.products;
    } else if (Array.isArray(data.harga)) {
      list = data.harga;
    }

    if (!list.length) {
      console.error(
        "PRICE_LIST response tidak berisi array produk:",
        JSON.stringify(data).slice(0, 1000)
      );

      return c.json(
        {
          ok: false,
          error: "Data daftar harga tidak ditemukan atau format JSON tidak sesuai",
          detected_type: Array.isArray(data) ? "array" : typeof data,
          keys:
            data && typeof data === "object"
              ? Object.keys(data).slice(0, 30)
              : [],
          response_preview: JSON.stringify(data).slice(0, 500),
        },
        422
      );
    }

    // ---------------------------------------------------------
    // 8. MARKUP
    // ---------------------------------------------------------
    const MARKUP = 500;

    let synced = 0;
    let skipped = 0;
    let failed = 0;

    const errors = [];

    // ---------------------------------------------------------
    // 9. Proses produk
    // ---------------------------------------------------------
    for (const item of list) {
      try {
        if (!item || typeof item !== "object") {
          skipped++;
          continue;
        }

        // Kode produk
        const code = String(
          item.kode ??
            item.code ??
            item.product_code ??
            item.kode_produk ??
            item.productCode ??
            ""
        ).trim();

        // Nama/keterangan produk
        const name = String(
          item.keterangan ??
            item.produk ??
            item.nama ??
            item.name ??
            item.description ??
            item.deskripsi ??
            ""
        ).trim();

        // Kategori
        const categoryValue =
          item.kategori ??
          item.category ??
          item.kategori_produk ??
          null;

        const category =
          categoryValue === null || categoryValue === undefined
            ? null
            : String(categoryValue).trim() || null;

        // Harga modal
        const rawCost =
          item.harga ??
          item.price ??
          item.harga_modal ??
          item.cost ??
          item.cost_price ??
          0;

        // Bersihkan format harga seperti:
        // "10.500"
        // "Rp 10.500"
        // "10500"
        const normalizedCost = String(rawCost)
          .replace(/[^\d-]/g, "")
          .trim();

        const cost = Number(normalizedCost || 0);

        // Status produk
        const status = String(item.status ?? "")
          .trim()
          .toLowerCase();

        // Produk tidak aktif
        if (
          status === "0" ||
          status === "false" ||
          status === "nonaktif" ||
          status === "inactive"
        ) {
          skipped++;
          continue;
        }

        // Data wajib
        if (!code || !name) {
          skipped++;
          continue;
        }

        // Harga harus valid
        if (!Number.isFinite(cost) || cost < 0) {
          skipped++;
          continue;
        }

        const sell = cost + MARKUP;

        // -----------------------------------------------------
        // UPSERT
        // -----------------------------------------------------
        await c.env.DB.prepare(
          `
          INSERT INTO products
            (code, name, category, cost_price, sell_price)
          VALUES
            (?, ?, ?, ?, ?)
          ON CONFLICT(code) DO UPDATE SET
            name = excluded.name,
            category = excluded.category,
            cost_price = excluded.cost_price,
            sell_price = excluded.sell_price
          `
        )
          .bind(code, name, category, cost, sell)
          .run();

        synced++;
      } catch (err) {
        failed++;

        const message =
          err instanceof Error ? err.message : String(err);

        errors.push({
          index: list.indexOf(item),
          error: message,
        });

        console.error("Gagal menyimpan produk:", message);
      }
    }

    // ---------------------------------------------------------
    // 10. Response
    // ---------------------------------------------------------
    return c.json({
      ok: true,
      message: "Sinkronisasi produk selesai",

      source: {
        url_configured: true,
        http_status: res.status,
        content_type: contentType,
      },

      total_from_source: list.length,
      synced,
      skipped,
      failed,

      markup: MARKUP,

      duration_ms: Date.now() - startedAt,

      errors: errors.slice(0, 20),
    });
  } catch (err) {
    // ---------------------------------------------------------
    // 11. Tangkap SEMUA error yang sebelumnya menjadi HTTP 500
    // ---------------------------------------------------------
    console.error("PRODUCT SYNC FATAL ERROR:", err);

    return c.json(
      {
        ok: false,
        error: "Gagal melakukan sinkronisasi produk",
        detail: err instanceof Error ? err.message : String(err),
        duration_ms: Date.now() - startedAt,
      },
      500
    );
  }
});
