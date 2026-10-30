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
A check that fails for a reason other than an unknown token (server unreachable, server error) says "Could not check the
invitation" with fixed text and offers Try again; only an unknown token is reported as an invalid link. After an account is
created but two-step verification is not finished, the used-up form gives way to a notice with a sign-in button.

## Boundary assets per program

Assets stay in one tenant-wide inventory. A program can declare which of them lie inside its authorization boundary
(`program_assets`, one row per tenant, program and asset; an asset may belong to several programs):

* `GET /api/v1/tenants/:tenantId/programs/:id/assets` returns `{ programId, declared, assetIds, summary }`. A program that has
  declared no asset (`declared: false`) uses the **whole inventory**, so existing tenants see no change; its `summary` is then the
  summary of the inventory.
* `PATCH` on the same path takes `{ add?: string[], remove?: string[] }` (deltas) and is for TENANT_OWNER and MSP_ADMIN. An id that is
  not in the tenant's inventory is `400 unknown_assets`, a malformed body `400 invalid_asset_ids`, an archived program `409 program_archived`.
* `GET /api/v1/tenants/:tenantId/programs/asset-memberships` lists the declared ids of every program, archived ones included.
  The Programs page uses it to show an archived program's declared assets read-only (count and host names, on screen only).
* Each change is recorded in the program history as `assets_changed` (counts and asset ids, never a host name or address).
* Deleting an asset or a program removes its membership. New assets are not added to any program automatically, and the
  vulnerability-management pipeline (snapshots, findings, POA&M items) still reads the whole inventory.
