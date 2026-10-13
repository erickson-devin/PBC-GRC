# Assessment programs and platform administrators

An installation of Event Horizon: Singularity hosts any number of **tenants** (enclaves). Each tenant is provisioned for an
**assessment program**: a *primary framework* plus any *additional frameworks* enabled for it. Examples:

| Tenant | Program |
|---|---|
| A supplier handling FCI | CMMC Level 1 (the default) |
| A prime handling CUI | CMMC Level 2 |
| A separate engagement | NIST SP 800-53 Rev. 5 (optionally + CMMC Level 2) |

There is no billing and no license tier: what distinguishes tenants is the assessment workflow they are set up for.

## Who decides: platform administrators

Only **platform administrators** can set a tenant's program, when provisioning it and later. A tenant owner can manage their
own people and settings but cannot widen their tenant's scope. Anyone else who creates a tenant (the first-run wizard) gets
the default program, CMMC Level 1, whatever the request says.

The first platform administrator is created by the first-time setup wizard (see docs/ON_PREM_DATABASE.md). More can be named in the
server setting `PLATFORM_ADMIN_EMAILS` (comma-separated, case-insensitive), matched against the verified identity of the
signed-in user; setting it before the first start also replaces the wizard:

```
PLATFORM_ADMIN_EMAILS=ciso@example.mil,ops@example.mil
```

With docker compose, put it in the `.env` file next to `docker-compose.yml` and restart the app container.
**Unset means nobody is an administrator**: the administration console is hidden and every tenant gets the default program.
The web app learns who is an administrator from the server (`GET /api/v1/me`), never from the browser.

Platform administrators must also be members of a tenant to edit it (they own every tenant they provision).

## What the server enforces

A tenant is only served the frameworks of its program. For a tenant that does not have a framework enabled:

* `GET /api/v1/controls?framework_id=...` answers `403` (`framework_not_enabled`); with no framework asked for, the tenant's
  **primary** framework is served;
* `PUT /api/v1/controls/:id` and evidence upload for a control that belongs only to other frameworks answer `403`.

CMMC Level 2 includes the 17 Level 1 practices, so a Level 2 tenant can score those too. Changing a program takes effect on
the next request. Frameworks are never mixed across tenants: each tenant's data is isolated by row-level security as before.

## The invitation

The invitation page shows the program the server holds for the tenant, so the invited owner sees exactly what was provisioned.
