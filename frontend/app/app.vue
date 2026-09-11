<script setup lang="ts">
interface Me {
  loggedIn: boolean;
  username?: string;
  roles?: string[];
}

interface Order {
  id: string;
  customerId: string;
  productId: string;
  quantity: number;
  status: string;
}

interface Employee {
  username: string;
  department: string;
  branch: string;
}

interface WarehouseStock {
  product_id: string;
  branches: Record<string, number>;
}

const { data: me, refresh: refreshMe } = await useFetch<Me>("/api/me");

const orders = ref<Order[]>([]);
const orderError = ref<string | null>(null);
const newOrder = reactive({ customerId: "", productId: "", quantity: 1 });

const employeeUsername = ref("");
const employee = ref<Employee | null>(null);
const employeeError = ref<string | null>(null);

const warehouseProductId = ref("");
const warehouseStock = ref<WarehouseStock | null>(null);
const warehouseError = ref<string | null>(null);

// HTTPステータスコードを業務メッセージへ変換する。
// Spring Securityの既定の403レスポンスボディは空なので data.message が ""
// になりうる——"??"ではなく"||"を使いfalsyな空文字列もフォールバックさせる。
function apiError(error: any, fallback: string): string {
  const status: number = error?.status ?? error?.statusCode ?? error?.data?.statusCode ?? 0;
  if (status === 403 || status === 502) return "この操作を行う権限がありません";
  if (status === 401) return "セッションが切れています。再度ログインしてください";
  return error?.data?.message || error?.statusMessage || fallback;
}

async function loadOrders() {
  orderError.value = null;
  try {
    orders.value = await $fetch<Order[]>("/api/orders");
  } catch (error: any) {
    orderError.value = apiError(error, "注文一覧の取得に失敗しました");
  }
}

const lastOrderResult = ref<string | null>(null);

async function submitOrder() {
  orderError.value = null;
  lastOrderResult.value = null;
  try {
    const created = await $fetch<Order>("/api/orders", { method: "POST", body: newOrder });
    lastOrderResult.value = created.status;
    newOrder.customerId = "";
    newOrder.productId = "";
    newOrder.quantity = 1;
    await loadOrders();
  } catch (error: any) {
    orderError.value = apiError(error, "注文の登録に失敗しました");
  }
}

async function lookupEmployee() {
  employeeError.value = null;
  employee.value = null;
  try {
    employee.value = await $fetch<Employee>(`/api/employees/${employeeUsername.value}`);
  } catch (error: any) {
    employeeError.value = apiError(error, "従業員情報の取得に失敗しました");
  }
}

async function lookupWarehouseStock() {
  warehouseError.value = null;
  warehouseStock.value = null;
  try {
    // リクエストに支店を含めない：「支店Xを見せろ」ではなく「自分に何が見えるか」を
    // 問う設計であり、サーバー側で呼び出し元自身の可視範囲に絞り込まれる
    // （architecture.md §20）。
    warehouseStock.value = await $fetch<WarehouseStock>(`/api/warehouse-stock/${warehouseProductId.value}`);
  } catch (error: any) {
    warehouseError.value = apiError(error, "在庫情報の取得に失敗しました");
  }
}

if (me.value?.loggedIn) {
  await loadOrders();
}
</script>

<template>
  <div class="app-shell">
    <header class="app-header">
      <span class="app-title">基幹システム — トークン交換サンプル</span>
      <div v-if="me?.loggedIn" class="user-info">
        <span class="user-badge">{{ me.username }}</span>
        <span class="role-list">{{ me.roles?.join(", ") || "no roles" }}</span>
        <a href="/api/logout" class="btn btn-outline">ログアウト</a>
      </div>
    </header>

    <main class="app-main">
      <section v-if="!me?.loggedIn" class="card login-card">
        <p>このシステムを利用するにはログインが必要です。</p>
        <a id="login" href="/api/login" class="btn btn-primary">ログイン</a>
      </section>

      <template v-else id="logged-in">
        <!-- 注文登録 -->
        <section class="card">
          <h2 class="card-title">注文登録</h2>
          <form id="order-form" class="form-grid" @submit.prevent="submitOrder">
            <label for="customerId">顧客 ID</label>
            <input id="customerId" v-model="newOrder.customerId" name="customerId" placeholder="例: C001" required />

            <label for="productId">商品 ID</label>
            <input id="productId" v-model="newOrder.productId" name="productId" placeholder="例: P001" required />

            <label for="quantity">数量</label>
            <input id="quantity" v-model.number="newOrder.quantity" name="quantity" type="number" min="1" required />

            <div class="form-action">
              <button type="submit" class="btn btn-primary">注文する</button>
            </div>
          </form>
          <div v-if="lastOrderResult" id="order-result" class="alert alert-success">
            注文を登録しました（ステータス: {{ lastOrderResult }}）
          </div>
          <div v-if="orderError" id="order-error" class="alert alert-error">{{ orderError }}</div>
        </section>

        <!-- 注文一覧 -->
        <section class="card">
          <div class="card-title-row">
            <h2 class="card-title">注文一覧</h2>
            <button class="btn btn-outline btn-sm" @click="loadOrders">再読込</button>
          </div>
          <div v-if="orders.length === 0" class="empty-state">注文データがありません</div>
          <table v-else id="order-list" class="data-table">
            <thead>
              <tr>
                <th>顧客 ID</th>
                <th>商品 ID</th>
                <th>数量</th>
                <th>ステータス</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="order in orders" :key="order.id">
                <td>{{ order.customerId }}</td>
                <td>{{ order.productId }}</td>
                <td class="num">{{ order.quantity }}</td>
                <td><span class="status-badge">{{ order.status }}</span></td>
              </tr>
            </tbody>
          </table>
        </section>

        <!-- 従業員照会 -->
        <section class="card">
          <h2 class="card-title">従業員照会</h2>
          <form id="employee-form" class="form-inline" @submit.prevent="lookupEmployee">
            <label for="empUsername">ユーザー名</label>
            <input id="empUsername" v-model="employeeUsername" name="username" placeholder="例: alice" required />
            <button type="submit" class="btn btn-primary">照会</button>
          </form>
          <dl v-if="employee" id="employee-result" class="result-dl">
            <dt>ユーザー名</dt><dd>{{ employee.username }}</dd>
            <dt>部門</dt><dd>{{ employee.department }}</dd>
            <dt>支店</dt><dd>{{ employee.branch }}</dd>
          </dl>
          <div v-if="employeeError" id="employee-error" class="alert alert-error">{{ employeeError }}</div>
        </section>

        <!-- 支店別在庫照会 -->
        <section class="card">
          <h2 class="card-title">支店別在庫照会（物流管理）</h2>
          <form id="warehouse-form" class="form-inline" @submit.prevent="lookupWarehouseStock">
            <label for="whProductId">商品 ID</label>
            <input id="whProductId" v-model="warehouseProductId" name="productId" placeholder="例: P001" required />
            <button type="submit" class="btn btn-primary">照会</button>
          </form>
          <template v-if="warehouseStock" id="warehouse-result">
            <p class="result-label">商品: {{ warehouseStock.product_id }}</p>
            <div v-if="Object.keys(warehouseStock.branches).length === 0" class="empty-state">
              参照可能な支店はありません
            </div>
            <table v-else class="data-table">
              <thead>
                <tr><th>支店</th><th>在庫数</th></tr>
              </thead>
              <tbody>
                <tr v-for="(quantity, branch) in warehouseStock.branches" :key="branch">
                  <td>{{ branch }}</td>
                  <td class="num">{{ quantity }}</td>
                </tr>
              </tbody>
            </table>
          </template>
          <div v-if="warehouseError" id="warehouse-error" class="alert alert-error">{{ warehouseError }}</div>
        </section>
      </template>
    </main>
  </div>
</template>

<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

:root {
  --color-bg: #f4f5f7;
  --color-surface: #ffffff;
  --color-border: #d9dde5;
  --color-text: #1a1d23;
  --color-text-muted: #5a6270;
  --color-primary: #2563eb;
  --color-primary-hover: #1d4ed8;
  --color-success-bg: #ecfdf5;
  --color-success-border: #6ee7b7;
  --color-success-text: #065f46;
  --color-error-bg: #fef2f2;
  --color-error-border: #fca5a5;
  --color-error-text: #991b1b;
  --radius: 6px;
  --shadow: 0 1px 3px rgba(0,0,0,.08), 0 1px 2px rgba(0,0,0,.06);
}

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Meiryo", sans-serif;
  font-size: 14px;
  color: var(--color-text);
  background: var(--color-bg);
  line-height: 1.6;
}

/* ヘッダー */
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0 1.5rem;
  height: 52px;
  background: var(--color-surface);
  border-bottom: 1px solid var(--color-border);
  position: sticky;
  top: 0;
  z-index: 10;
}
.app-title { font-size: 15px; font-weight: 600; }
.user-info { display: flex; align-items: center; gap: .75rem; font-size: 13px; }
.user-badge { font-weight: 600; }
.role-list { color: var(--color-text-muted); }

/* メイン */
.app-main {
  max-width: 760px;
  margin: 1.5rem auto;
  padding: 0 1rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

/* カード */
.card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 1.25rem 1.5rem;
}
.login-card { text-align: center; padding: 2.5rem; }
.login-card p { margin-bottom: 1.25rem; color: var(--color-text-muted); }
.card-title { font-size: 15px; font-weight: 600; margin-bottom: 1rem; }
.card-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1rem;
}
.card-title-row .card-title { margin-bottom: 0; }

/* フォーム — グリッド（ラベル+入力を2列） */
.form-grid {
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: .6rem .75rem;
  align-items: center;
}
.form-action { grid-column: 2; padding-top: .25rem; }

/* フォーム — インライン（横並び） */
.form-inline {
  display: flex;
  align-items: center;
  gap: .5rem;
  flex-wrap: wrap;
}
.form-inline label { font-weight: 500; white-space: nowrap; }

/* 共通入力 */
input[type="text"],
input[type="number"],
input:not([type]) {
  width: 100%;
  padding: .45rem .65rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  font-size: 14px;
  font-family: inherit;
  color: var(--color-text);
  background: #fff;
  outline: none;
  transition: border-color .15s;
}
input:focus { border-color: var(--color-primary); }
.form-inline input { flex: 1; min-width: 160px; }

/* ボタン */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: .45rem 1rem;
  border-radius: var(--radius);
  font-size: 14px;
  font-family: inherit;
  font-weight: 500;
  cursor: pointer;
  text-decoration: none;
  border: 1px solid transparent;
  white-space: nowrap;
  transition: background .15s, border-color .15s;
}
.btn-primary { background: var(--color-primary); color: #fff; }
.btn-primary:hover { background: var(--color-primary-hover); }
.btn-outline {
  background: transparent;
  border-color: var(--color-border);
  color: var(--color-text);
}
.btn-outline:hover { background: var(--color-bg); }
.btn-sm { padding: .3rem .75rem; font-size: 13px; }

/* アラート */
.alert {
  margin-top: .875rem;
  padding: .6rem .875rem;
  border-radius: var(--radius);
  border: 1px solid;
  font-size: 13px;
}
.alert-success {
  background: var(--color-success-bg);
  border-color: var(--color-success-border);
  color: var(--color-success-text);
}
.alert-error {
  background: var(--color-error-bg);
  border-color: var(--color-error-border);
  color: var(--color-error-text);
}

/* テーブル */
.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.data-table th, .data-table td {
  padding: .5rem .75rem;
  text-align: left;
  border-bottom: 1px solid var(--color-border);
}
.data-table th { font-weight: 600; color: var(--color-text-muted); background: var(--color-bg); }
.data-table tbody tr:last-child td { border-bottom: none; }
.data-table tbody tr:hover td { background: #f8f9fb; }
.num { text-align: right; }

/* ステータスバッジ */
.status-badge {
  display: inline-block;
  padding: .15rem .55rem;
  border-radius: 999px;
  background: #e0f2fe;
  color: #075985;
  font-size: 12px;
  font-weight: 500;
}

/* 定義リスト（照会結果） */
.result-dl {
  display: grid;
  grid-template-columns: 100px 1fr;
  gap: .35rem .75rem;
  margin-top: .875rem;
  font-size: 13px;
}
.result-dl dt { color: var(--color-text-muted); font-weight: 500; }
.result-dl dd { color: var(--color-text); }

.result-label { margin-top: .875rem; margin-bottom: .5rem; font-weight: 500; font-size: 13px; }

.empty-state {
  padding: 1.25rem;
  text-align: center;
  color: var(--color-text-muted);
  font-size: 13px;
}
</style>
