# local-llm — Guide agent de developpement

Infrastructure locale partagee — point d'entree Traefik pour les services locaux.

## Ce que ce repo fait

Lance un Traefik partage sur le daemon Docker hote.
Tous les services qui rejoignent le reseau `traefik-net` sont routables via `<nom>.localhost`.

## Demarrage

```sh
task up         # lance Traefik
task ps         # verifie que c'est up
task network    # liste les services connectes
```

Dashboard Traefik: http://traefik.localhost ou http://localhost:8080

## Connecter un service

Dans le `docker-compose.yml` du service:

```yaml
services:
  mon-service:
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.mon-service.rule=Host(`mon-service.localhost`)"
      - "traefik.http.services.mon-service.loadbalancer.server.port=<port interne>"
    networks:
      - traefik-net

networks:
  traefik-net:
    name: traefik-net
    external: true
```

## Regles de contribution

- Git et workflow : `.agents/rules/git.md`
