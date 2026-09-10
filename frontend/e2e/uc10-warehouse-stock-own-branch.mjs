// UC10 (docs/use-cases.md): 正常系・ABACによる絞り込み. yamada-sales (branch=tokyo,
// warehouse-viewer, no -all) looks up product-A, which is stocked at both tokyo and
// osaka. Unlike UC8's warehouse-viewer-all, a plain warehouse-viewer only ever sees
// their own branch -- osaka's real stock must not appear in the response at all. This
// is ABAC expressed as the shape of a successful (200) response, not an error
// (architecture.md §20); contrast with UC9, which is denied the screen entirely.
// Run: node e2e/uc10-warehouse-stock-own-branch.mjs
import { loginAs, createChecker } from "./helpers.mjs";

const { check, report } = createChecker();
const { browser, page } = await loginAs("yamada-sales");

await page.fill('#warehouse-form input[name="productId"]', "product-A");
await page.click('#warehouse-form button[type="submit"]');

await page.waitForFunction(() => document.querySelector("#warehouse-result")?.textContent?.trim(), { timeout: 10000 });
const warehouseResult = await page.textContent("#warehouse-result");
check(
  "plain warehouse-viewer sees only their own branch (tokyo), never osaka's real stock",
  Boolean(warehouseResult?.includes("tokyo")) && !warehouseResult?.includes("osaka"),
  warehouseResult ?? "",
);

await browser.close();
report();
