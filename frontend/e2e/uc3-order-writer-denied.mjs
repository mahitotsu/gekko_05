// UC3 (docs/use-cases.md): 異常系・権限不足. A user without order-writer (only
// order-reader/inventory-reader) attempts to register an order. Order Service's
// @PreAuthorize denies the request at the entry point -- unlike UC4's branch-mismatch
// denial, this surfaces as an HTTP error, and no order row is ever created.
// Run: node e2e/uc3-order-writer-denied.mjs
import { loginAs, createChecker } from "./helpers.mjs";

const { check, report } = createChecker();
const { browser, page } = await loginAs("suzuki-support");

const customerId = `cust-e2e-uc3-${Date.now()}`;
await page.fill('#order-form input[name="customerId"]', customerId);
await page.fill('#order-form input[name="productId"]', "product-A");
await page.fill('#order-form input[name="quantity"]', "1");
await page.click('#order-form button[type="submit"]');

await page.waitForSelector("#order-error", { timeout: 10000 });
const orderError = await page.textContent("#order-error");
check("order registration denied for a user without order-writer", (orderError?.length ?? 0) > 0, orderError ?? "");

await Promise.all([
  page.waitForResponse((res) => res.url().includes("/api/orders") && res.request().method() === "GET"),
  page.getByRole("button", { name: "再読込" }).click(),
]);
await page.waitForTimeout(200);
const orderList = await page.textContent("#order-list");
check("denied order never appears in the list", !(orderList?.includes(customerId) ?? true), orderList ?? "");

await browser.close();
report();
