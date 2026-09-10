// UC9 (docs/use-cases.md): 異常系・権限不足. suzuki-support (no warehouse-viewer or
// warehouse-viewer-all at all) attempts the logistics all-branch inquiry screen and is
// denied at Order Service's own RBAC gate -- the same front-door denial shape as UC3/UC7
// -- before the Inventory/Warehouse Service delegation chain ever starts.
// Run: node e2e/uc9-warehouse-stock-denied.mjs
import { loginAs, createChecker } from "./helpers.mjs";

const { check, report } = createChecker();
const { browser, page } = await loginAs("suzuki-support");

await page.fill('#warehouse-form input[name="branch"]', "tokyo");
await page.fill('#warehouse-form input[name="productId"]', "product-A");
await page.click('#warehouse-form button[type="submit"]');

await page.waitForSelector("#warehouse-error", { timeout: 10000 });
const warehouseError = await page.textContent("#warehouse-error");
check(
  "warehouse stock lookup denied for a user without warehouse-viewer(-all)",
  (warehouseError?.length ?? 0) > 0,
  warehouseError ?? "",
);

await browser.close();
report();
