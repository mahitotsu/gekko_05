// UC7 (docs/use-cases.md): 異常系・権限不足. yamada-sales (no hr-viewer) attempts to
// look up another employee's info and is denied by Employee Service -- the same
// "front-door RBAC" denial shape as UC3, surfacing as an HTTP error to the BFF.
// Run: node e2e/uc7-employee-lookup-denied.mjs
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
