// UC8 (docs/use-cases.md): 正常系. sato-logistics (branch=osaka, warehouse-viewer-all)
// looks up tokyo's real stock for product-A -- a branch other than their own, proving
// warehouse-viewer-all's ABAC bypass (a plain warehouse-viewer could only reach their
// own branch, per UC1/UC4).
// Run: node e2e/uc8-warehouse-stock-lookup.mjs
import { loginAs, createChecker } from "./helpers.mjs";

const { check, report } = createChecker();
const { browser, page } = await loginAs("sato-logistics");

await page.fill('#warehouse-form input[name="branch"]', "tokyo");
await page.fill('#warehouse-form input[name="productId"]', "product-A");
await page.click('#warehouse-form button[type="submit"]');

await page.waitForFunction(() => document.querySelector("#warehouse-result")?.textContent?.trim(), { timeout: 10000 });
const warehouseResult = await page.textContent("#warehouse-result");
check(
  "warehouse-viewer-all can look up a branch other than their own",
  Boolean(warehouseResult?.includes("tokyo")) && Boolean(warehouseResult?.includes("product-A")),
  warehouseResult ?? "",
);

await browser.close();
report();
