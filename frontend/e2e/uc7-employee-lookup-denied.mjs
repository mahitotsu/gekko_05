// UC7（docs/use-cases.md）：異常系・権限不足。yamada-sales（hr-viewerを持たない）が
// 他の社員の情報照会を試み、Employee Serviceに拒否される——UC3と同じ「入口での
// RBAC」拒否の形であり、BFFへHTTPエラーとして表面化する。
// 実行: node e2e/uc7-employee-lookup-denied.mjs
import { loginAs, createChecker } from "./helpers.mjs";

const { check, report } = createChecker();
const { browser, page } = await loginAs("yamada-sales");

await page.fill('#employee-form input[name="username"]', "suzuki-support");
await page.click('#employee-form button[type="submit"]');
await page.waitForSelector("#employee-error", { timeout: 10000 });
const employeeError = await page.textContent("#employee-error");
check("looking up another employee without hr-viewer is denied", (employeeError?.length ?? 0) > 0, employeeError ?? "");

await browser.close();
report();
