// UC4（docs/use-cases.md）：異常系・支店不一致。yamada-sales（branch=tokyo）が
// product-Cを注文するが、この商品の実在庫（50個、非ゼロ——
// inventory-service/db/init.sqlとwarehouse-service/db/seed.sh参照）はosaka支店に
// ある。Warehouse ServiceのABACチェックが引当てを拒否するが、Inventory Serviceは
// 意図的にその拒否を実際の在庫不足と同じ「引当てできなかった」という結果に
// 潰す（inventory-service/handlers.go参照）。そのため、UC3と異なりHTTPエラーには
// ならず、status=REJECTEDとして受注自体は作成される（201）。
// 実行: node e2e/uc4-branch-mismatch-rejected.mjs
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
