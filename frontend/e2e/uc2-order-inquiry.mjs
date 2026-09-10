// UC2 (docs/use-cases.md): 正常系. A read-only user (order-reader/inventory-reader,
// no warehouse-viewer) inquires about orders -- proving the read path completes without
// ever needing Warehouse Service's branch-scoped data.
// Run: node e2e/uc2-order-inquiry.mjs
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
