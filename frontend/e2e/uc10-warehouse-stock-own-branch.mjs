// UC10（docs/use-cases.md）：正常系・ABACによる絞り込み。yamada-sales
// （branch=tokyo、warehouse-viewer、-allは持たない）がproduct-Aを照会する。
// この商品はtokyo・osaka両支店に在庫がある。UC8のwarehouse-viewer-allと異なり、
// 一般のwarehouse-viewerは常に自分の所属支店しか見えない——osakaの実在庫が
// レスポンスに一切現れてはならない。これはエラーではなく、成功(200)レスポンスの
// 形として表現されるABACである（architecture.md §20）。画面自体を拒否される
// UC9と対比せよ。
// 実行: node e2e/uc10-warehouse-stock-own-branch.mjs
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
