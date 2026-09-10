// MongoDBの公式イメージは、初回起動時（データディレクトリが空の場合）に
// /docker-entrypoint-initdb.d/にある.jsファイルを自動実行する。postgres/mysqlの
// initスクリプトと同じ仕組みであり、Redisと違ってここでは専用Dockerfileが不要。
// DB名はこのcomposeサービス自身の名前に合わせている——main.pyのMongoClient
// 呼び出しを参照。
db = db.getSiblingDB("employee-mongo");

db.employees.insertMany([
  { username: "yamada-sales", department: "sales", branch: "tokyo" },
  { username: "suzuki-support", department: "customer-support", branch: "tokyo" },
  { username: "sato-logistics", department: "logistics", branch: "osaka" },
  { username: "tanaka-hr", department: "hr", branch: null },
]);
