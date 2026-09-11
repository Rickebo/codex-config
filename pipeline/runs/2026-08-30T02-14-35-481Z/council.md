# Council decision

Architecture, security, and quality perspectives agree that `observability-config` already owns the sole fixed ServiceMonitor and that alert resources must remain deferred until a real plan-only target is observed.

The approved implementation slice is `codicarium/access-controller#92`: add two fixed, label-free metrics sampled from existing state—last successful reconciliation timestamp and current leadership—plus deterministic tests and documentation. No deployment, provider write, health semantic, ServiceMonitor, PrometheusRule, or live-system change is in scope.
