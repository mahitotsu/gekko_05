package com.example.orderservice;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

@Component
public class AccessLogInterceptor implements HandlerInterceptor {

    private static final Logger log = LoggerFactory.getLogger("access");
    private static final String ATTR_START = "al.start";

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        request.setAttribute(ATTR_START, System.currentTimeMillis());
        return true;
    }

    @Override
    public void afterCompletion(HttpServletRequest request, HttpServletResponse response,
                                Object handler, Exception ex) {
        Object startAttr = request.getAttribute(ATTR_START);
        if (startAttr == null) return;
        long duration = System.currentTimeMillis() - (Long) startAttr;

        String sub = "-";
        String jti = "-";
        Authentication auth = SecurityContextHolder.getContext().getAuthentication();
        if (auth instanceof JwtAuthenticationToken token) {
            sub = token.getToken().getSubject();
            jti = token.getToken().getId() != null ? token.getToken().getId() : "-";
        }

        // traceId is in MDC as "traceId" (micrometer naming). Explicitly add "trace_id"
        // to match the snake_case naming used by inventory/warehouse/frontend services,
        // enabling consistent LogQL queries across all services.
        String traceId = MDC.get("traceId");
        log.atInfo()
            .addKeyValue("type", "access_log")
            .addKeyValue("method", request.getMethod())
            .addKeyValue("path", request.getRequestURI())
            .addKeyValue("status", response.getStatus())
            .addKeyValue("duration_ms", duration)
            .addKeyValue("sub", sub)
            .addKeyValue("jti", jti)
            .addKeyValue("trace_id", traceId != null ? traceId : "-")
            .log("");
    }
}
