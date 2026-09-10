// ユースケースごとのe2eスクリプト（frontend/e2e/uc*.mjs）が共有するPlaywright
// ヘルパー。各スクリプトは自己完結（自前のブラウザインスタンス・自前のprocess.exit）
// しており、個別実行でも`npm run e2e`経由でも動く。共有のテストランナー
// フレームワークを持ち込むのではなく、keycloak/tests/permission-matrix.shと同じ
// 「関心事ごとに1ファイル」というスタイルに倣っている。ログイン・トークンの
// 取り扱いはすべてNuxt BFFのサーバーサイドで完結し、ブラウザがアクセストークンを
// 目にすることは一切ない。
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

// ブラウザを起動し、実際のAuthorization Code + PKCEフローで指定ユーザーとして
// ログインする。実際のユーザーのブラウザと全く同じくedge-proxy経由で駆動する。
// BFFセッションがログイン済みと確認できた時点で{ browser, page }を返す——
// browser.close()の呼び出しは呼び出し元の責務。
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
