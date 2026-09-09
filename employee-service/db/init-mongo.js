// MongoDB's official image runs any .js file found in /docker-entrypoint-initdb.d/
// automatically on first startup (when the data directory is empty), the same
// mechanism as postgres/mysql's init scripts -- no custom Dockerfile needed here,
// unlike Redis.
db = db.getSiblingDB("employee_service");

db.employees.insertMany([
  { username: "yamada-sales", department: "sales", branch: "tokyo" },
  { username: "suzuki-support", department: "customer-support", branch: "tokyo" },
  { username: "sato-logistics", department: "logistics", branch: "osaka" },
  { username: "tanaka-hr", department: "hr", branch: null },
]);
