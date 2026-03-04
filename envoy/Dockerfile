FROM envoyproxy/envoy:v1.31-latest

# Copy our Envoy configuration into the standard config location.
# Envoy reads this file at startup via the --config-path flag below.
COPY envoy.yaml /etc/envoy/envoy.yaml

# 10000 — buyer proxy port (HTTP/HTTPS CONNECT requests from buyers)
# 9901  — Envoy admin port (stats, health, config dump)
EXPOSE 10000 9901

# Use --service-cluster and --service-node for better observability in stats.
# --log-level info reduces noise while keeping useful startup/error messages.
CMD ["/usr/local/bin/envoy", \
     "--config-path", "/etc/envoy/envoy.yaml", \
     "--service-cluster", "roxy-gateway", \
     "--service-node", "roxy-gateway-0", \
     "--log-level", "info"]
