// Shared Playwright helpers for the per-use-case e2e scripts (frontend/e2e/uc*.mjs).
// Each script is self-contained (own browser instance, own process.exit) so it can be
// run individually or via `npm run e2e`, mirroring the one-file-per-concern style of
// keycloak/tests/permission-matrix.sh rather than pulling in a shared test-runner
// framework. Login/token handling all happens server-side in the Nuxt BFF -- the
// browser never sees an access token.
import { chromium } from "playwright";

export const BASE_URL = "http://localhost:3000";

export function createChecker() {
  let failures = 0;
  function check(label, condition, detail = "") {
    if (condition) {
      console.log(`PASS: ${label}`);
    } else {
      console.log(`FAIL: ${label} ${detail}`);
      failures++;
    }
  }
  function report() {
    console.log(`\n=== ${failures === 0 ? "ALL PASSED" : `${failures} FAILED`} ===`);
    process.exit(failures === 0 ? 0 : 1);
  }
  return { check, report };
}

// Launches a browser and logs in as the given user via the real Authorization Code +
// PKCE flow, driven through edge-proxy exactly as a real user's browser would. Returns
// { browser, page } once the BFF session is confirmed logged-in -- caller owns
// browser.close().
export async function loginAs(username, password = "password") {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on("pageerror", (err) => console.log("[pageerror]", err.message));

  await page.goto(BASE_URL);
  await page.waitForSelector("#login");
  await page.click("#login");
  await page.waitForURL(/\/realms\//, { timeout: 10000 });

  await page.fill("#username", username);
  await page.fill("#password", password);
  await page.click("#kc-login");

  await page.waitForSelector("#logged-in", { timeout: 10000 });
  return { browser, page };
}
