# ADR-0014: isolated single-host connected deployment

- Status: accepted for deployment preparation under the 2026-09-11 implementation request
- Date: 2026-09-11

The public Sites static host cannot execute the existing native media worker.
Rather than duplicate Rust rules in a second JavaScript backend, deploy the
existing web/BFF, Rust API, dispatcher and worker with PostgreSQL, Redis and S3
storage on one authorized host for an initial portfolio release.

`docker-compose.production.yml` overlays the established service contracts but
uses separate production volumes/network, no fixed local container names, no
published database/API/Redis ports and test mode disabled in browser and server.
Only web and storage bind loopback for an existing HTTPS proxy. Generated
secrets are exclusive-create, not updates to initialized database passwords.

This changes deployment topology, not the canonical data model, authorization,
worker delivery, render contract or migration policy. Moving to managed services
later uses the existing environment/provider boundaries. No existing local or
other project's data is moved or removed. Production publishing remains pending
an authorized host and verification on its actual HTTPS origins.
