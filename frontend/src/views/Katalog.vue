<script setup>
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { api } from "../api.js";

const router = useRouter();
const products = ref([]);
const selectedOperator = ref(null);
const selectedGroup = ref(null);
const search = ref("");

function rupiah(n) {
  return "Rp" + Number(n || 0).toLocaleString("id-ID");
}

// Tingkat 1: operator/tipe — dicocokkan dari product_group ("produk" OkeConnect)
// atau category kalau product_group kosong (data lama sebelum kolom ini ada).
// Urutan penting: yang lebih spesifik dicek duluan.
const OPERATOR_RULES = [
  { key: "telkomsel", label: "Telkomsel", match: /telkomsel|\btsel\b/i, icon: "phone", color: "#1F6F54" },
  { key: "indosat", label: "Indosat", match: /indosat|\bisat\b/i, icon: "phone", color: "#2E7D5B" },
  { key: "xl", label: "XL", match: /\bxl\b/i, icon: "phone", color: "#3B6E91" },
  { key: "axis", label: "Axis", match: /axis/i, icon: "phone", color: "#6B4FA0" },
  { key: "tri", label: "Tri", match: /\btri\b|\bthree\b/i, icon: "phone", color: "#A8412A" },
  { key: "smartfren", label: "Smartfren", match: /smart(fren)?/i, icon: "phone", color: "#8A5A2A" },
  { key: "byu", label: "By.U", match: /by\s?u\b/i, icon: "phone", color: "#2C6E8A" },
  { key: "pln", label: "Token PLN", match: /\bpln\b|listrik/i, icon: "bolt", color: "#B9822C" },
  { key: "pdam", label: "Air PDAM", match: /pdam|\bair\b/i, icon: "drop", color: "#2C6E8A" },
  { key: "bpjs", label: "BPJS", match: /bpjs/i, icon: "receipt", color: "#8A5A2A" },
  { key: "ewallet", label: "e-Wallet", match: /dompet|wallet|ovo|gopay|dana|shopeepay/i, icon: "wallet", color: "#6B4FA0" },
  { key: "game", label: "Voucher Game", match: /game|voucher/i, icon: "game", color: "#A8412A" },
];

function operatorFor(p) {
  const text = `${p.product_group || ""} ${p.category || ""} ${p.name || ""}`;
  const rule = OPERATOR_RULES.find((r) => r.match.test(text));
  return rule || { key: "lainnya", label: "Lainnya", icon: "tag", color: "#6b6152" };
}

const operators = computed(() => {
  const map = new Map();
  for (const p of products.value) {
    if (!p.code) continue; // cuma produk PPOB, bukan barang warung
    const op = operatorFor(p);
    if (!map.has(op.key)) map.set(op.key, { ...op, items: [] });
    map.get(op.key).items.push(p);
  }
  return [...map.values()].map((o) => ({ ...o, count: o.items.length })).sort((a, b) => b.count - a.count);
});

// Tingkat 2: dalam satu operator, kelompokkan lagi per product_group
// (mis. dalam "Telkomsel": "Telkomsel", "Masa Aktif Telkomsel", "Data Bulanan
// Telkomsel", "Tsel Data Mini Harian", dst — pas seperti daftar harga aslinya).
const groupsInOperator = computed(() => {
  if (!selectedOperator.value) return [];
  const op = operators.value.find((o) => o.key === selectedOperator.value);
  if (!op) return [];
  const map = new Map();
  for (const p of op.items) {
    const g = p.product_group || p.category || "Lainnya";
    if (!map.has(g)) map.set(g, []);
    map.get(g).push(p);
  }
  return [...map.entries()].map(([name, items]) => ({ name, items, count: items.length })).sort((a, b) => a.name.localeCompare(b.name));
});

const productsInGroup = computed(() => {
  if (!selectedGroup.value) return [];
  const grp = groupsInOperator.value.find((g) => g.name === selectedGroup.value);
  if (!grp) return [];
  const q = search.value.toLowerCase();
  return grp.items.filter((p) => !q || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q));
});

function openOperator(op) {
  selectedOperator.value = op.key;
  selectedGroup.value = null;
}
function openGroup(g) {
  selectedGroup.value = g.name;
  search.value = "";
}
function backToOperators() {
  selectedOperator.value = null;
  selectedGroup.value = null;
}
function backToGroups() {
  selectedGroup.value = null;
}

function orderProduct(p) {
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
        <p>Pilih operator/tipe → pilih grup produk → pilih produk</p>
      </div>
    </div>

    <!-- Tingkat 1: operator/tipe -->
    <div v-if="!selectedOperator" class="grid cols-4">
      <div
        v-for="op in operators"
        :key="op.key"
        class="card"
        style="text-align: center; cursor: pointer; padding: 18px 8px"
        @click="openOperator(op)"
      >
        <div
          style="width: 52px; height: 52px; border-radius: 14px; margin: 0 auto 10px; display: flex; align-items: center; justify-content: center"
          :style="{ background: op.color + '22' }"
        >
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none" :stroke="op.color" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path v-if="op.icon === 'phone'" d="M17 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2Z" /><path v-if="op.icon === 'phone'" d="M11 18h2" />
            <path v-if="op.icon === 'bolt'" d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z" />
            <path v-if="op.icon === 'receipt'" d="M4 3h16v18l-3-2-3 2-3-2-3 2-3-2-1 2V3Z" /><path v-if="op.icon === 'receipt'" d="M8 8h8M8 12h8M8 16h4" />
            <path v-if="op.icon === 'drop'" d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z" />
            <rect v-if="op.icon === 'wallet'" x="3" y="6" width="18" height="13" rx="2" /><path v-if="op.icon === 'wallet'" d="M16 12h2M3 10h18" />
            <rect v-if="op.icon === 'game'" x="3" y="8" width="18" height="9" rx="4" /><circle v-if="op.icon === 'game'" cx="16" cy="11" r="0.8" fill="op.color" /><circle v-if="op.icon === 'game'" cx="18" cy="13" r="0.8" fill="op.color" />
            <path v-if="op.icon === 'tag'" d="m2 12 9.5-9.5a2 2 0 0 1 2.8 0L21 9.2a2 2 0 0 1 0 2.8L11.5 22 2 12Z" />
          </svg>
        </div>
        <div style="font-size: 13.5px; font-weight: 500">{{ op.label }}</div>
        <div class="muted" style="font-size: 11.5px">{{ op.count }} produk</div>
      </div>
      <div v-if="!operators.length" class="muted" style="grid-column: 1 / -1">
        Belum ada produk PPOB — sinkron dulu lewat halaman Produk.
      </div>
    </div>

    <!-- Tingkat 2: grup produk dalam satu operator -->
    <div v-else-if="!selectedGroup">
      <button class="btn ghost" style="margin-bottom: 16px" @click="backToOperators">← Kembali ke operator</button>
      <h3 style="margin-bottom: 12px">{{ operators.find((o) => o.key === selectedOperator)?.label }}</h3>
      <div class="grid cols-3">
        <div v-for="g in groupsInOperator" :key="g.name" class="card" style="cursor: pointer" @click="openGroup(g)">
          <div style="font-size: 14px; font-weight: 500">{{ g.name }}</div>
          <div class="muted" style="font-size: 12px">{{ g.count }} produk</div>
        </div>
      </div>
    </div>

    <!-- Tingkat 3: daftar produk dalam satu grup -->
    <div v-else>
      <button class="btn ghost" style="margin-bottom: 16px" @click="backToGroups">← Kembali ke grup produk</button>
      <div class="card">
        <div class="page-head" style="margin-bottom: 12px">
          <h3>{{ selectedGroup }}</h3>
          <input v-model="search" placeholder="Cari dalam grup ini…" style="max-width: 240px" />
        </div>
        <table>
          <tbody>
            <tr v-for="p in productsInGroup" :key="p.id">
              <td>
                {{ p.name }}
                <div class="muted num" style="font-size: 12px">#{{ p.code }}</div>
              </td>
              <td class="num" style="text-align: right">{{ rupiah(p.sell_price) }}</td>
              <td style="width: 90px"><button class="btn ghost" style="padding: 4px 10px" @click="orderProduct(p)">Order</button></td>
            </tr>
            <tr v-if="!productsInGroup.length">
              <td colspan="3" class="muted">Tidak ada produk cocok.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
