// UC9（docs/use-cases.md）：異常系・権限不足。suzuki-support
// （warehouse-viewer・warehouse-viewer-allのどちらも一切持たない）が物流部門向け
// 全支店照会画面を試みる。Order Service・Inventory Serviceは支店アクセスに関する
// 権限を一切持たず（architecture.md §20）無条件に中継する。拒否はチェーンの奥深く、
// Warehouse Service自身のRBACゲートで発生し、透過的なHTTPエラーとして戻ってくる
// （委任チェーン自体が始まらないUC3の入口での拒否とは異なる）。
// 実行: node e2e/uc9-warehouse-stock-denied.mjs
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
