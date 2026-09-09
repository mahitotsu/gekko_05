// Real-browser end-to-end check of the BFF-driven Authorization Code + PKCE login
// flow and the full Order -> Inventory -> Warehouse -> Employee delegation chain,
// driven through the actual frontend UI via edge-proxy. Requires the full
// docker-compose stack to be up and healthy. Login/token handling all happens
// server-side in the Nuxt BFF now -- the browser never sees an access token.
//
// Run: node e2e/login-and-order.mjs
import { chromium } from "playwright";

const BASE_URL = "http://localhost:3000";
let failures = 0;

function check(label, condition, detail = "") {
  if (condition) {
    console.log(`PASS: ${label}`);
  } else {
    console.log(`FAIL: ${label} ${detail}`);
    failures++;
  }
}

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (err) => console.log("[pageerror]", err.message));

await page.goto(BASE_URL);
await page.waitForSelector("#login");

await page.click("#login");
await page.waitForURL(/\/realms\//, { timeout: 10000 });
check("redirected to Keycloak (via edge-proxy) with PKCE", page.url().includes("code_challenge_method=S256"));
check("Keycloak reached under the same origin", page.url().startsWith(BASE_URL));

await page.fill("#username", "yamada-sales");
await page.fill("#password", "password");
await page.click("#kc-login");

await page.waitForSelector("#logged-in", { timeout: 10000 });
const loggedInText = await page.textContent("#logged-in");
check("shows logged-in username", loggedInText?.includes("yamada-sales") ?? false);
check("shows roles from the BFF session", loggedInText?.includes("order-writer") ?? false);

const customerId = `cust-e2e-${Date.now()}`;
await page.fill('#order-form input[name="customerId"]', customerId);
await page.fill('#order-form input[name="productId"]', "product-A");
await page.fill('#order-form input[name="quantity"]', "3");
await page.click('#order-form button[type="submit"]');
await page.waitForFunction(() => document.querySelector("#order-result")?.textContent?.trim(), { timeout: 10000 });
const orderResult = await page.textContent("#order-result");
check("order confirmed via real Inventory/Warehouse call", orderResult?.includes("CONFIRMED") ?? false, orderResult ?? "");

await page.waitForFunction(
  (id) => document.querySelector("#order-list")?.textContent?.includes(id),
  customerId,
  { timeout: 10000 },
).catch(() => {});
const orderList = await page.textContent("#order-list");
check("new order appears in the list", orderList?.includes(customerId) ?? false, orderList ?? "");

await page.fill('#employee-form input[name="username"]', "yamada-sales");
await page.click('#employee-form button[type="submit"]');
await page.waitForSelector("#employee-result", { timeout: 10000 });
const employeeResult = await page.textContent("#employee-result");
check("self employee lookup succeeds via Employee Service", employeeResult?.includes("tokyo") ?? false, employeeResult ?? "");

await browser.close();

console.log(`\n=== ${failures === 0 ? "ALL PASSED" : `${failures} FAILED`} ===`);
process.exit(failures === 0 ? 0 : 1);
