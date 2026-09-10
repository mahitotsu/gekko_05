// UC9 (docs/use-cases.md): 異常系・権限不足. suzuki-support (no warehouse-viewer or
// warehouse-viewer-all at all) attempts the logistics all-branch inquiry screen. Order
// Service and Inventory Service hold no authority over branch access (architecture.md
// §20) and relay unconditionally; the denial happens deep in the chain, at Warehouse
// Service's own RBAC gate, then propagates back as a transparent HTTP error (unlike
// UC3's front-door denial, which never starts the delegation chain at all).
// Run: node e2e/uc9-warehouse-stock-denied.mjs
import { loginAs, createChecker } from "./helpers.mjs";

const { check, report } = createChecker();
const { browser, page } = await loginAs("suzuki-support");

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
