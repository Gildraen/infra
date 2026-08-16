# infra

Shared local infrastructure for all Gildraen services.

This repository runs the common Traefik entrypoint used to route local microservices by hostname.

## Goal

- Provide one shared reverse proxy for local development.
- Route every service through Traefik, instead of direct per-service ports.
- Keep service onboarding simple via Docker labels + shared network.

## What It Runs

- `traefik:v3`
- Docker provider enabled
- EntryPoint on port `80`
- Dashboard on `traefik.localhost` (and `localhost:8080`)

## Prerequisites

- Docker engine available from the devcontainer (DooD)
- `task` installed

## Quick Start

```sh
task up
task ps
task network
```

Dashboard:

- http://traefik.localhost
- http://localhost:8080

## Service Integration Contract

A service must:

1. Join the external network `traefik-net`
2. Expose Traefik labels
3. Declare the internal service port for load-balancing

Example:

```yaml
services:
  my-service:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.my-service.rule=Host(`my-service.localhost`)"
      - "traefik.http.services.my-service.loadbalancer.server.port=3100"
    networks:
      - traefik-net

networks:
  traefik-net:
    name: traefik-net
    external: true
```

## Operations

```sh
task up       # start
task down     # stop
task ps       # status
task logs     # follow logs
task network  # list connected containers
```

## Related Repositories

- `Gildraen/local-llm`: local LLM API service routed via Traefik
- `Gildraen/Niki`: product-level behavior and tests
- `Gildraen/dx`: shared dev experience baseline
