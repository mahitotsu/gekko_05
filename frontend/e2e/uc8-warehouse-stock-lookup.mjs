// UC8（docs/use-cases.md）：正常系。sato-logistics（branch=osaka、
// warehouse-viewer-all）がproduct-Aを照会する。この商品はtokyo・osaka両支店に
// 在庫がある（warehouse-service/db/seed.sh）。リクエストに支店は含まれない——
// 「自分に何が見えるか」を問う形であり、warehouse-viewer-allはABACの支店一致
// 判定をバイパスするため、自分の所属支店（osaka）だけでなく両支店が1つの
// レスポンスに返ってくる。このバイパスが効いていることの証明になる
// （一般のwarehouse-viewerは、UC1/UC4の通り常に自分の所属支店しか見えない）。
// 実行: node e2e/uc8-warehouse-stock-lookup.mjs
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
