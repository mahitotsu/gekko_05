CREATE TABLE products (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    aggregate_stock INT NOT NULL,
    -- Which single branch's Warehouse Service actually holds/reserves this product's
    -- stock. A real product-warehouse mapping could span multiple branches; this demo
    -- keeps it to one so the reservation call has an unambiguous target.
    primary_branch VARCHAR(64) NOT NULL
);

INSERT INTO products (id, name, aggregate_stock, primary_branch) VALUES
    ('product-A', 'Product A', 150, 'tokyo'),
    ('product-B', 'Product B', 0, 'osaka');
