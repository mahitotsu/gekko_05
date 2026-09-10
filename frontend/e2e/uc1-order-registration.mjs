// UC1 (docs/use-cases.md): 正常系. An order-writer/inventory-writer/warehouse-viewer
// persona orders a product actually stocked at their own branch, driving the real
// 3-hop delegation chain (Order -> Inventory -> Warehouse -> Employee) to CONFIRMED.
// Run: node e2e/uc1-order-registration.mjs
import { loginAs, createChecker } from "./helpers.mjs";

const { check, report } = createChecker();
const { browser, page } = await loginAs("yamada-sales");

const loggedInText = await page.textContent("#logged-in");
check("shows logged-in username", loggedInText?.includes("yamada-sales") ?? false);
check("shows roles from the BFF session", loggedInText?.includes("order-writer") ?? false);

const customerId = `cust-e2e-uc1-${Date.now()}`;
await page.fill('#order-form input[name="customerId"]', customerId);
await page.fill('#order-form input[name="productId"]', "product-A");
await page.fill('#order-form input[name="quantity"]', "3");
await page.click('#order-form button[type="submit"]');
await page.waitForFunction(() => document.querySelector("#order-result")?.textContent?.trim(), { timeout: 10000 });
const orderResult = await page.textContent("#order-result");
check("order confirmed via real Inventory/Warehouse call", orderResult?.includes("CONFIRMED") ?? false, orderResult ?? "");

await page.waitForFunction(
  (id) => document.querySelector("#order-list")?.textContent?.includes(id),
  customerId,
  { timeout: 10000 },
).catch(() => {});
const orderList = await page.textContent("#order-list");
check("new order appears in the list", orderList?.includes(customerId) ?? false, orderList ?? "");

await browser.close();
report();
