// UC8 (docs/use-cases.md): 正常系. sato-logistics (branch=osaka, warehouse-viewer-all)
// looks up product-A, which is stocked at both tokyo and osaka (warehouse-service/db/seed.sh).
// The request carries no branch -- it asks "what can I see", and warehouse-viewer-all
// bypasses the ABAC branch match, so both branches (not just their own, osaka) come back
// in one response, proving the bypass (a plain warehouse-viewer would only ever see their
// own branch, per UC1/UC4).
// Run: node e2e/uc8-warehouse-stock-lookup.mjs
import { loginAs, createChecker } from "./helpers.mjs";

const { check, report } = createChecker();
const { browser, page } = await loginAs("sato-logistics");

await page.fill('#warehouse-form input[name="productId"]', "product-A");
await page.click('#warehouse-form button[type="submit"]');

await page.waitForFunction(() => document.querySelector("#warehouse-result")?.textContent?.trim(), { timeout: 10000 });
const warehouseResult = await page.textContent("#warehouse-result");
check(
  "warehouse-viewer-all sees both branches stocking product-A, not just their own",
  Boolean(warehouseResult?.includes("tokyo")) &&
    Boolean(warehouseResult?.includes("osaka")) &&
    Boolean(warehouseResult?.includes("product-A")),
  warehouseResult ?? "",
);

await browser.close();
report();
