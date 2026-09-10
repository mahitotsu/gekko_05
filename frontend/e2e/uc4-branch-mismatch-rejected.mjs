// UC4 (docs/use-cases.md): 異常系・支店不一致. yamada-sales (branch=tokyo) orders
// product-C, whose real stock (50 units, non-zero -- see inventory-service/db/init.sql
// and warehouse-service/db/seed.sh) lives at the osaka branch. Warehouse Service's ABAC
// check denies the reservation, but Inventory Service deliberately collapses that
// denial into the same "not reserved" outcome as genuine insufficient stock (see
// inventory-service/handlers.go), so the order is still created (201) with
// status=REJECTED rather than surfacing as an HTTP error -- unlike UC3.
// Run: node e2e/uc4-branch-mismatch-rejected.mjs
import { loginAs, createChecker } from "./helpers.mjs";

const { check, report } = createChecker();
const { browser, page } = await loginAs("yamada-sales");

const customerId = `cust-e2e-uc4-${Date.now()}`;
await page.fill('#order-form input[name="customerId"]', customerId);
await page.fill('#order-form input[name="productId"]', "product-C");
await page.fill('#order-form input[name="quantity"]', "1");
await page.click('#order-form button[type="submit"]');

await page.waitForFunction(() => document.querySelector("#order-result")?.textContent?.trim(), { timeout: 10000 });
const orderResult = await page.textContent("#order-result");
check(
  "order for a product stocked at a mismatched branch comes back REJECTED, not an HTTP error",
  orderResult?.includes("REJECTED") ?? false,
  orderResult ?? "",
);

await page.waitForFunction(
  (id) => document.querySelector("#order-list")?.textContent?.includes(id),
  customerId,
  { timeout: 10000 },
).catch(() => {});
const orderList = await page.textContent("#order-list");
check("REJECTED order still appears in the order list", orderList?.includes(customerId) ?? false, orderList ?? "");

await browser.close();
report();
