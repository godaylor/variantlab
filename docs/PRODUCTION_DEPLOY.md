# Connected deployment

The current Sites publication runs browser-local editing. It cannot execute the
native Rust/FFmpeg worker or host this application's PostgreSQL control plane.
The connected application is a separate deployment of the same web shell and
Rust services, not a simulation or a replacement landing page.

## One-server installation

Use an authorized Linux host with Docker Compose 2.24.4 or newer, DNS names for
the application and media, and an existing HTTPS reverse proxy. Budget at least
4 CPU / 8 GiB RAM for a first small installation; this is a provisioning starting
point, not a measured capacity claim. The worker remains bounded to 2 CPU / 2 GiB.

1. Check out the release commit into its own directory. Generate credentials:

   ```sh
   node script/configure-production.mjs https://studio.example.com https://media.example.com
   ```

   This creates an ignored `.env.production` with unique random credentials and
   refuses to overwrite it. Keep it private and backed up. Never use the local
   `variantlab.env.example` as production secrets.

2. Verify that loopback ports 32280 and 32282 are free. If occupied, choose free
   ports in 32200–32299 in `.env.production` and update this application's proxy
   targets. Do not stop another application's processes or containers.

3. Validate and start **only this profile**:

   ```sh
   docker compose --env-file .env.production -f docker-compose.variantlab.yml -f docker-compose.production.yml -p variantlab-production config --quiet
   docker compose --env-file .env.production -f docker-compose.variantlab.yml -f docker-compose.production.yml -p variantlab-production up -d --build --wait
   ```

   The profile uses separate `variantlab-production-*` volumes and network.
   PostgreSQL, Redis and the Rust API have no host ports. Web and media bind only
   to loopback. Migrations run before the API starts. Test identity is disabled
   in both the browser build and BFF, regardless of a local test setting.

4. Add the two hosts from `infra/variantlab/Caddyfile.production.example` to the
   authorized host's HTTPS proxy. Preserve its existing configuration. Public
   storage URLs must exactly match the media origin used to sign downloads.

5. On the public HTTPS application: register a test account, import a licensed
   WebM, create versions, explicitly upload, render, download and reopen on a
   second browser. Confirm a different account cannot access the campaign.
   Check CSP, HSTS, secure cookies and storage URL expiration at these public
   origins. Local test receipts do not establish that this deployment works.

## Updates and recovery

Before updating an existing installation, take a PostgreSQL dump and a consistent
copy of the object-storage volume, and verify restoration in an isolated
environment. Keep the previous image digest and secrets. Do not run `down -v`,
prune, overwrite credentials for initialized volumes, or reuse local volumes.
Schema rollback requires the verified backup; older code must not be assumed to
understand a newer schema. Keep source/license/SBOM receipts with each release.

An initial single-host deployment has no automatic cross-host failover. Arrange
off-host backups, disk/worker monitoring and retention before accepting valuable
user media. Registration currently uses email/password; email verification and
password-reset delivery are not wired to a production mail provider.

## External handoff

Required external action: provide access to the authorized deployment host with
the two DNS names pointed at it. No such host credential is configured in this
repository. Until its public scenario is verified, connected production remains
unreleased even when local tests pass.
