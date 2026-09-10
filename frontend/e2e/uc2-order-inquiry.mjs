// UC2（docs/use-cases.md）：正常系。読み取り専用ユーザー
// （order-reader/inventory-reader、warehouse-viewerは持たない）が受注を照会する。
// Warehouse Serviceの支店別データを一切必要とせずに読み取り経路が完了することを
// 示す。
// 実行: node e2e/uc2-order-inquiry.mjs
import { loginAs, createChecker } from "./helpers.mjs";

const { check, report } = createChecker();
const { browser, page } = await loginAs("suzuki-support");

const loggedInText = await page.textContent("#logged-in");
check("shows logged-in username", loggedInText?.includes("suzuki-support") ?? false);
check("shows order-reader/inventory-reader roles from the BFF session", loggedInText?.includes("order-reader") ?? false);

const orderListVisible = await page.isVisible("#order-list");
check("order list is visible for a read-only (order-reader) user", orderListVisible);

const orderErrorCount = await page.locator("#order-error").count();
check("no error is shown for a plain order inquiry", orderErrorCount === 0);

await browser.close();
report();
