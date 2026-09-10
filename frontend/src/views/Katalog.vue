<script setup>
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api.js";

const router = useRouter();
const products = ref([]);
const selectedCategory = ref(null);
const search = ref("");

function rupiah(n) {
  return "Rp" + Number(n || 0).toLocaleString("id-ID");
}

// Kata kunci -> ikon (SVG sederhana bikinan sendiri, bukan tiruan ikon aplikasi
// lain) & warna tile, supaya kategori dari OkeConnect (yang penamaannya beda-
// beda) tetap kelihatan rapi dikelompokkan.
const ICON_RULES = [
  { match: /pulsa/i, icon: "phone", color: "#1F6F54" },
  { match: /kuota|data/i, icon: "wifi", color: "#2E7D5B" },
  { match: /token pln|listrik|pln/i, icon: "bolt", color: "#B9822C" },
  { match: /tagihan|bpjs|telkom|internet/i, icon: "receipt", color: "#8A5A2A" },
  { match: /air|pdam/i, icon: "drop", color: "#2C6E8A" },
  { match: /dompet|e-wallet|ewallet|ovo|gopay|dana|shopeepay/i, icon: "wallet", color: "#6B4FA0" },
  { match: /voucher|game|top up game/i, icon: "game", color: "#A8412A" },
  { match: /sms|telp/i, icon: "chat", color: "#3B6E91" },
];

function iconFor(category) {
  const rule = ICON_RULES.find((r) => r.match.test(category || ""));
  return rule || { icon: "tag", color: "#6b6152" };
}

const categories = computed(() => {
  const map = new Map();
  for (const p of products.value) {
    if (!p.code) continue; // cuma produk PPOB (punya kode), bukan barang warung
    const cat = p.category || "Lainnya";
    if (!map.has(cat)) map.set(cat, []);
    map.get(cat).push(p);
  }
  return [...map.entries()]
    .map(([name, items]) => ({ name, items, count: items.length, ...iconFor(name) }))
    .sort((a, b) => b.count - a.count);
});

const productsInCategory = computed(() => {
  if (!selectedCategory.value) return [];
  const cat = categories.value.find((c) => c.name === selectedCategory.value);
  if (!cat) return [];
  const q = search.value.toLowerCase();
  return cat.items.filter((p) => !q || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q));
});

function openCategory(cat) {
  selectedCategory.value = cat.name;
  search.value = "";
}

function orderProduct(p) {
  // Produk tagihan pascabayar (kode Cek/Bayar) lebih aman lewat alur Cek dulu.
  if (p.category === "TAGIHAN" || p.category === "AIR PDAM") {
    router.push({ path: "/tagihan", query: { code: p.code } });
  } else {
    router.push({ path: "/ppob", query: { code: p.code } });
  }
}

async function load() {
  products.value = await api.get("/api/products");
}

onMounted(load);
</script>

<template>
  <div>
    <div class="page-head">
      <div>
        <h1>Katalog PPOB</h1>
        <p>Pilih kategori untuk lihat daftar produk, atau langsung cari di halaman Pulsa &amp; PPOB</p>
      </div>
    </div>

    <div v-if="!selectedCategory" class="grid cols-4">
      <div
        v-for="cat in categories"
        :key="cat.name"
        class="card"
        style="text-align: center; cursor: pointer; padding: 18px 8px"
        @click="openCategory(cat)"
      >
        <div
          style="width: 52px; height: 52px; border-radius: 14px; margin: 0 auto 10px; display: flex; align-items: center; justify-content: center"
          :style="{ background: cat.color + '22' }"
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" :stroke="cat.color" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path v-if="cat.icon === 'phone'" d="M17 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2Z" /><path v-if="cat.icon === 'phone'" d="M11 18h2" />
            <path v-if="cat.icon === 'wifi'" d="M5 12a10 10 0 0 1 14 0" /><path v-if="cat.icon === 'wifi'" d="M8.5 15.5a5 5 0 0 1 7 0" /><circle v-if="cat.icon === 'wifi'" cx="12" cy="19" r="1" fill="cat.color" />
            <path v-if="cat.icon === 'bolt'" d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />
            <path v-if="cat.icon === 'receipt'" d="M4 3h16v18l-3-2-3 2-3-2-3 2-3-2-1 2V3Z" /><path v-if="cat.icon === 'receipt'" d="M8 8h8M8 12h8M8 16h4" />
            <path v-if="cat.icon === 'drop'" d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z" />
            <rect v-if="cat.icon === 'wallet'" x="3" y="6" width="18" height="13" rx="2" /><path v-if="cat.icon === 'wallet'" d="M16 12h2M3 10h18" />
            <rect v-if="cat.icon === 'game'" x="3" y="8" width="18" height="9" rx="4" /><path v-if="cat.icon === 'game'" d="M8 11v3M6.5 12.5h3" /><circle v-if="cat.icon === 'game'" cx="16" cy="11" r="0.8" fill="cat.color" /><circle v-if="cat.icon === 'game'" cx="18" cy="13" r="0.8" fill="cat.color" />
            <path v-if="cat.icon === 'chat'" d="M21 11.5a8.4 8.4 0 0 1-8.9 8.4 8.6 8.6 0 0 1-3.6-.8L3 20l1-4.5A8.4 8.4 0 1 1 21 11.5Z" />
            <path v-if="cat.icon === 'tag'" d="m2 12 9.5-9.5a2 2 0 0 1 2.8 0L21 9.2a2 2 0 0 1 0 2.8L11.5 22 2 12Z" /><circle v-if="cat.icon === 'tag'" cx="8.5" cy="8.5" r="1.2" fill="cat.color" />
          </svg>
        </div>
        <div style="font-size: 13.5px; font-weight: 500">{{ cat.name }}</div>
        <div class="muted" style="font-size: 11.5px">{{ cat.count }} produk</div>
      </div>
      <div v-if="!categories.length" class="muted" style="grid-column: 1 / -1">
        Belum ada produk PPOB — sinkron dulu lewat halaman Produk.
      </div>
    </div>

    <div v-else>
      <button class="btn ghost" style="margin-bottom: 16px" @click="selectedCategory = null">← Kembali ke kategori</button>
      <div class="card">
        <div class="page-head" style="margin-bottom: 12px">
          <h3>{{ selectedCategory }}</h3>
          <input v-model="search" placeholder="Cari dalam kategori ini…" style="max-width: 240px" />
        </div>
        <table>
          <tbody>
            <tr v-for="p in productsInCategory" :key="p.id">
              <td>
                {{ p.name }}
                <div class="muted num" style="font-size: 12px">#{{ p.code }}</div>
              </td>
              <td class="num" style="text-align: right">{{ rupiah(p.sell_price) }}</td>
              <td style="width: 90px"><button class="btn ghost" style="padding: 4px 10px" @click="orderProduct(p)">Order</button></td>
            </tr>
            <tr v-if="!productsInCategory.length">
              <td colspan="3" class="muted">Tidak ada produk cocok.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
