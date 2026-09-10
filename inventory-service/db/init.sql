CREATE TABLE products (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    aggregate_stock INT NOT NULL,
    -- この商品の実在庫を実際に保有・引当てするWarehouse Service側の単一支店。
    -- 実際の商品-倉庫マッピングは複数支店にまたがりうるが、本サンプルでは1つに
    -- 絞ることで引当て呼び出しの対象を一意にしている。
    primary_branch VARCHAR(64) NOT NULL
);

INSERT INTO products (id, name, aggregate_stock, primary_branch) VALUES
    ('product-A', 'Product A', 150, 'tokyo'),
    ('product-B', 'Product B', 0, 'osaka'),
    -- テストユーザー本人の所属支店以外に実在庫（非ゼロ）を置く。これにより
    -- ABACの支店不一致による拒否（UC4）を在庫不足と区別できる：tokyo所属の
    -- ユーザーとしてこれを注文すると、Warehouse Serviceの支店チェックには
    -- 実際に在庫がある状態でぶつかることになり、棚が空だからではない。
    ('product-C', 'Product C', 50, 'osaka');
