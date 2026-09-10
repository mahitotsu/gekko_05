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

// initTracer configures an OTLP/HTTP span exporter and registers a global tracer
// provider plus a W3C trace-context propagator, so incoming traceparent headers are
// extracted and outgoing calls carry the trace forward. It returns a shutdown func.
func initTracer(ctx context.Context) (func(context.Context) error, error) {
	// OTEL_EXPORTER_OTLP_ENDPOINT is a base URL (same env var as the other 4
	// services). WithEndpointURL, unlike WithEndpoint, does NOT append /v1/traces
	// automatically (see otlptracehttp's own doc.go) -- append it explicitly.
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

// responseWriter captures the HTTP status code written by the handler.
type responseWriter struct {
	http.ResponseWriter
	status int
}

func (rw *responseWriter) WriteHeader(status int) {
	rw.status = status
	rw.ResponseWriter.WriteHeader(status)
}

// accessLogMiddleware logs one JSON line per request with trace_id and sub.
// Must be placed INSIDE otelhttp so r.Context() carries the active OTel span.
func accessLogMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/health" {
			next.ServeHTTP(w, r)
			return
		}
		start := time.Now()
		rw := &responseWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rw, r)

		span := trace.SpanFromContext(r.Context())
		traceID := "-"
		if span.SpanContext().IsValid() {
			traceID = span.SpanContext().TraceID().String()
		}

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

	// otelsql.Open wraps sql.Open, tracing every database/sql call that takes a
	// context (the DB name shows up as its own node in Tempo's service graph,
	// analogous to how Keycloak's/employee-service's own DB calls already do).
	// DBNamespace is purely a reporting label (independent of the real MySQL db name
	// in dsn above) -- set to match this compose service's own name ("inventory-mysql"),
	// not "inventory_service", so the node doesn't read as a confusing near-twin of
	// this service's own "inventory-service" node in the graph.
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
	// Gated by warehouse-viewer(-all), not inventory-reader/-writer: this passthrough's
	// authorization concern is branch access (Warehouse Service's domain), not
	// aggregate-inventory operations -- see docs/use-cases.md UC8/UC9.
	mux.HandleFunc("GET /warehouse-stock/{branch}/{productId}",
		authMiddleware(keyfunc, keycloakIssuer, []string{"warehouse-viewer", "warehouse-viewer-all"}, handlers.getWarehouseStock))

	log.Println("inventory-service listening on :8082")
	// accessLogMiddleware is placed inside otelhttp so r.Context() carries the active
	// OTel span, enabling trace_id extraction. WithFilter still excludes /health from
	// span creation; accessLogMiddleware also skips /health logging for the same reason.
	otelHandler := otelhttp.NewHandler(accessLogMiddleware(mux), "inventory-service", otelhttp.WithFilter(func(r *http.Request) bool {
		return r.URL.Path != "/health"
	}))
	log.Fatal(http.ListenAndServe(":8082", otelHandler))
}
