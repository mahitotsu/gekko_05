package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/XSAM/otelsql"
	_ "github.com/go-sql-driver/mysql"

	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.26.0"
	"go.opentelemetry.io/otel/trace"
)

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// initTracerはOTLP/HTTPのスパンエクスポーターを構成し、グローバルなtracer providerと
// W3C trace-contextのpropagatorを登録する。これにより受信したtraceparentヘッダーが
// 抽出され、発信呼び出しにもトレースが引き継がれる。シャットダウン用の関数を返す。
func initTracer(ctx context.Context) (func(context.Context) error, error) {
	// OTEL_EXPORTER_OTLP_ENDPOINTはベースURL（他の4サービスと共通の環境変数名）。
	// WithEndpointURLはWithEndpointと異なり/v1/tracesを自動付与しない
	// （otlptracehttp自身のdoc.go参照）ため、明示的に付与する。
	endpoint := getenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318")
	serviceName := getenv("OTEL_SERVICE_NAME", "inventory-service")

	exporter, err := otlptracehttp.New(ctx, otlptracehttp.WithEndpointURL(strings.TrimRight(endpoint, "/")+"/v1/traces"))
	if err != nil {
		return nil, err
	}

	res := resource.NewWithAttributes(
		semconv.SchemaURL,
		semconv.ServiceName(serviceName),
	)

	tp := sdktrace.NewTracerProvider(
		sdktrace.WithSpanProcessor(sdktrace.NewBatchSpanProcessor(exporter)),
		sdktrace.WithResource(res),
	)
	otel.SetTracerProvider(tp)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	return tp.Shutdown, nil
}

// traceIDFromContextはctxから現在有効なOTelスパンのtrace idを取り出す。無ければ"-"を
// 返す。accessLogMiddlewareとauthMiddlewareのauthz_denyログの両方で共有し、同じ
// リクエストに対する両ログ行が同じtrace_idを持つようにする。
func traceIDFromContext(ctx context.Context) string {
	span := trace.SpanFromContext(ctx)
	if span.SpanContext().IsValid() {
		return span.SpanContext().TraceID().String()
	}
	return "-"
}

// responseWriterはハンドラが書き込んだHTTPステータスコードを記録する。
type responseWriter struct {
	http.ResponseWriter
	status int
}

func (rw *responseWriter) WriteHeader(status int) {
	rw.status = status
	rw.ResponseWriter.WriteHeader(status)
}

// accessLogMiddlewareはリクエストごとにtrace_idとsubを含むJSON1行をログ出力する。
// r.Context()が有効なOTelスパンを持つよう、otelhttpの内側に配置する必要がある。
func accessLogMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		rw := &responseWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rw, r)

		traceID := traceIDFromContext(r.Context())

		entry := struct {
			Type       string `json:"type"`
			Method     string `json:"method"`
			Path       string `json:"path"`
			Status     int    `json:"status"`
			DurationMs int64  `json:"duration_ms"`
			Sub        string `json:"sub"`
			Jti        string `json:"jti"`
			TraceID    string `json:"trace_id"`
		}{
			Type:       "access_log",
			Method:     r.Method,
			Path:       r.URL.Path,
			Status:     rw.status,
			DurationMs: time.Since(start).Milliseconds(),
			Sub:        r.Header.Get("X-Subject"),
			Jti:        r.Header.Get("X-Jti"),
			TraceID:    traceID,
		}
		line, _ := json.Marshal(entry)
		os.Stdout.Write(append(line, '\n'))
	})
}

func main() {
	shutdown, err := initTracer(context.Background())
	if err != nil {
		log.Fatalf("initializing tracer: %v", err)
	}
	defer shutdown(context.Background())

	keycloakInternalURL := getenv("KEYCLOAK_INTERNAL_URL", "http://localhost:8080/realms/kikan-system")
	keycloakIssuer := getenv("KEYCLOAK_ISSUER", "http://localhost:8080/realms/kikan-system")
	clientID := getenv("INVENTORY_SERVICE_CLIENT_ID", "inventory-service")
	clientSecret := getenv("INVENTORY_SERVICE_CLIENT_SECRET", "inventory-service-secret")
	dsn := getenv("MYSQL_DSN", "inventory_service:inventory_service@tcp(localhost:3306)/inventory_service")
	warehouseBaseURL := getenv("WAREHOUSE_SERVICE_BASE_URL", "http://localhost:8083")

	// otelsql.Openはsql.Openをラップし、contextを受け取るdatabase/sql呼び出しをすべて
	// トレースする（DB名はTempoのservice graph上で独自のノードとして表示される。
	// Keycloak/employee-service自身のDB呼び出しが既にそうなっているのと同じ扱い）。
	// DBNamespaceは純粋な表示用ラベルで（上のdsnにある実際のMySQL DB名とは独立）、
	// "inventory_service"ではなくこのcomposeサービス自身の名前("inventory-mysql")に
	// 合わせている。こうしないと、graph上でこのサービス自身の"inventory-service"
	// ノードと紛らわしい"双子"に見えてしまう。
	db, err := otelsql.Open("mysql", dsn, otelsql.WithAttributes(
		semconv.DBSystemMySQL,
		semconv.DBNamespace("inventory-mysql"),
	))
	if err != nil {
		log.Fatalf("opening database: %v", err)
	}
	defer db.Close()

	keyCache, err := newJWKSCache(keycloakInternalURL + "/protocol/openid-connect/certs")
	if err != nil {
		log.Fatalf("fetching JWKS: %v", err)
	}
	keyfunc := keyCache.keyfunc

	tokenExchange := NewTokenExchangeClient(keycloakInternalURL, clientID, clientSecret)
	handlers := &InventoryHandlers{db: db, tokenExchange: tokenExchange, warehouseBaseURL: warehouseBaseURL}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})
	mux.HandleFunc("GET /inventory/{id}",
		authMiddleware(keyfunc, keycloakIssuer, []string{"inventory-reader", "inventory-writer"}, handlers.getProduct))
	mux.HandleFunc("POST /inventory/{id}/reserve",
		authMiddleware(keyfunc, keycloakIssuer, []string{"inventory-writer"}, handlers.reserve))
	// requiredRolesはnil（inventory-reader/-writerではなく、意図的にwarehouse-viewer/
	// -allでもない）：支店アクセスはWarehouse Service単独の領域である（services.md：
	// 「組織的に独立した拠点システム」。Inventory Serviceは支店レベルのアクセス制御を
	// 明示的に行わない「集計・ルーティング層」に過ぎない）。パスに{branch}も持たない
	// ——「この商品について自分に何が見えるか」を問うのであって「支店Xを見せろ」では
	// ない。docs/use-cases.md UC8/UC9とarchitecture.md §20を参照。
	mux.HandleFunc("GET /warehouse-stock/{productId}",
		authMiddleware(keyfunc, keycloakIssuer, nil, handlers.getWarehouseStock))

	log.Println("inventory-service listening on :8082")
	// accessLogMiddlewareはotelhttpの内側に配置し、r.Context()が有効なOTelスパンを
	// 持つようにしてtrace_idを抽出できるようにする。WithFilterは引き続き/healthを
	// スパン生成から除外しており、同じ理由でaccessLogMiddleware側も/healthのログを
	// スキップする。
	otelHandler := otelhttp.NewHandler(accessLogMiddleware(mux), "inventory-service", otelhttp.WithFilter(func(r *http.Request) bool {
		return r.URL.Path != "/health"
	}))
	log.Fatal(http.ListenAndServe(":8082", otelHandler))
}
