import { reactive } from "vue";

// Sengaja pakai sessionStorage (bukan localStorage): sesi login otomatis hilang
// begitu tab/browser ditutup, jadi kasir wajib login lagi tiap buka browser baru.
const savedToken = sessionStorage.getItem("kasir_token");
const savedEmployee = sessionStorage.getItem("kasir_employee");

export const auth = reactive({
  token: savedToken || null,
  employee: savedEmployee ? JSON.parse(savedEmployee) : null,
});

export function login(token, employee) {
  auth.token = token;
  auth.employee = employee;
  sessionStorage.setItem("kasir_token", token);
  sessionStorage.setItem("kasir_employee", JSON.stringify(employee));
}

export function logout() {
  auth.token = null;
  auth.employee = null;
  sessionStorage.removeItem("kasir_token");
  sessionStorage.removeItem("kasir_employee");
}

export function isAdmin() {
  return auth.employee?.role === "admin";
}
