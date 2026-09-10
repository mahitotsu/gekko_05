// UC6（docs/use-cases.md）：正常系。tanaka-hr（hr-viewer）がEmployee Serviceから
// 直接、他の社員の情報を照会する。
// 実行: node e2e/uc6-hr-employee-lookup.mjs
import { loginAs, createChecker } from "./helpers.mjs";

const { check, report } = createChecker();
const { browser, page } = await loginAs("tanaka-hr");

await page.fill('#employee-form input[name="username"]', "yamada-sales");
await page.click('#employee-form button[type="submit"]');
await page.waitForSelector("#employee-result", { timeout: 10000 });
const employeeResult = await page.textContent("#employee-result");
check(
  "hr-viewer can look up another employee's info",
  Boolean(employeeResult?.includes("yamada-sales")) && Boolean(employeeResult?.includes("tokyo")),
  employeeResult ?? "",
);

await browser.close();
report();
