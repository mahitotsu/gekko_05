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

async function loadOrders() {
  orderError.value = null;
  try {
    orders.value = await $fetch<Order[]>("/api/orders");
  } catch (error: any) {
    // "??"ではなく"||"を使う：Spring Securityの既定の403レスポンスボディは空で、
    // data.message === ""として流れてくる——"??"だとこの「値はあるがfalsyな」空
    // 文字列をそのまま通してしまい、エラーが静かに隠れてしまう
    // （v-if="orderError"も""をfalsyとして扱うため）。
    orderError.value = error?.data?.message || error?.statusMessage || "Failed to load orders";
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
    orderError.value = error?.data?.message || error?.statusMessage || "Failed to create order";
  }
}

async function lookupEmployee() {
  employeeError.value = null;
  employee.value = null;
  try {
    employee.value = await $fetch<Employee>(`/api/employees/${employeeUsername.value}`);
  } catch (error: any) {
    employeeError.value = error?.data?.message || error?.statusMessage || "Failed to look up employee";
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
    warehouseError.value = error?.data?.message || error?.statusMessage || "Failed to look up warehouse stock";
  }
}

if (me.value?.loggedIn) {
  await loadOrders();
}
</script>

<template>
  <main style="max-width: 640px; margin: 2rem auto; font-family: sans-serif;">
    <h1>基幹システム トークン交換サンプル</h1>

    <section v-if="!me?.loggedIn">
      <a id="login" href="/api/login">ログイン</a>
    </section>

    <section v-else id="logged-in">
      <p>
        ログイン中: <strong>{{ me.username }}</strong>
        （roles: {{ me.roles?.join(", ") || "none" }}）
        &mdash;
        <a href="/api/logout">ログアウト</a>
      </p>

      <h2>注文</h2>
      <form id="order-form" @submit.prevent="submitOrder">
        <input v-model="newOrder.customerId" name="customerId" placeholder="customerId" required />
        <input v-model="newOrder.productId" name="productId" placeholder="productId" required />
        <input v-model.number="newOrder.quantity" name="quantity" type="number" min="1" required />
        <button type="submit">注文する</button>
      </form>
      <p id="order-result">{{ lastOrderResult }}</p>
      <p v-if="orderError" id="order-error" style="color: red;">{{ orderError }}</p>

      <h3>注文一覧 <button @click="loadOrders">再読込</button></h3>
      <ul id="order-list">
        <li v-for="order in orders" :key="order.id">
          {{ order.customerId }} / {{ order.productId }} x{{ order.quantity }} &mdash; {{ order.status }}
        </li>
      </ul>

      <h2>従業員照会</h2>
      <form id="employee-form" @submit.prevent="lookupEmployee">
        <input v-model="employeeUsername" name="username" placeholder="username" required />
        <button type="submit">照会</button>
      </form>
      <p id="employee-result" v-if="employee">
        {{ employee.username }} &mdash; {{ employee.department }} / {{ employee.branch }}
      </p>
      <p v-if="employeeError" id="employee-error" style="color: red;">{{ employeeError }}</p>

      <h2>支店別在庫照会（物流管理）</h2>
      <form id="warehouse-form" @submit.prevent="lookupWarehouseStock">
        <input v-model="warehouseProductId" name="productId" placeholder="productId" required />
        <button type="submit">照会</button>
      </form>
      <p id="warehouse-result" v-if="warehouseStock">
        {{ warehouseStock.product_id }} &mdash;
        <span v-if="Object.keys(warehouseStock.branches).length === 0">見える支店はありません</span>
        <span v-for="(quantity, branch) in warehouseStock.branches" :key="branch">{{ branch }}: {{ quantity }}　</span>
      </p>
      <p v-if="warehouseError" id="warehouse-error" style="color: red;">{{ warehouseError }}</p>
    </section>
  </main>
</template>
