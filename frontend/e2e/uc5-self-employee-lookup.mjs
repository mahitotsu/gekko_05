// UC5 (docs/use-cases.md): 正常系. Any logged-in user can look up their own employee
// info directly from Employee Service, no delegation chain involved.
// Run: node e2e/uc5-self-employee-lookup.mjs
import { loginAs, createChecker } from "./helpers.mjs";

const { check, report } = createChecker();
const { browser, page } = await loginAs("yamada-sales");

await page.fill('#employee-form input[name="username"]', "yamada-sales");
await page.click('#employee-form button[type="submit"]');
await page.waitForSelector("#employee-result", { timeout: 10000 });
const employeeResult = await page.textContent("#employee-result");
check("self employee lookup succeeds via Employee Service", employeeResult?.includes("tokyo") ?? false, employeeResult ?? "");

await browser.close();
report();
