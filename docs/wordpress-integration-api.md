# WordPress / FloCafe Integration API

This API is the localhost-only boundary used by FloCafe Bridge. WordPress never accesses the FloCafe SQLite database directly.

## Security

- Bind/access is restricted to loopback requests.
- Every request requires the `x-flocafe-integration-key` header.
- Configure `FLOCAFE_INTEGRATION_API_KEY` in the FloCafe process environment.
- The integration actor can be pinned with `FLOCAFE_INTEGRATION_USER_ID`; otherwise an active owner/manager is selected for attribution.
- The Bridge remains the only component expected to call this API.

## Catalog

Base URL: `http://127.0.0.1:3001/api/integration`

- `GET /health`
- `GET /store`
- `POST /store`
- `GET /catalog`
- `GET /catalog/snapshot`
- `GET /catalog/changes?after_revision=N`

Catalog revisions are monotonic. A snapshot is the recovery mechanism if the Bridge detects a revision gap.

Products expose immutable FloCafe IDs, current authoritative prices, category IDs, image URLs, and availability. The API never maps products by name.

## Online orders

- `POST /orders/quote` validates product existence, active state, quantity rules, and current availability and returns current line prices. It deliberately does not claim a final total; FloCafe calculates the final authoritative total during order creation.
- `POST /orders` accepts only `type=online`, `online_platform=wordpress`, and a required `external_order_id`.
- `GET /orders/:id`
- `GET /orders/changes?after_revision=N`
- `POST /orders/:id/cancel`

Order creation is delegated to FloCafe's existing canonical order route so tax, inventory, recipe, addon, audit, KDS, and idempotency business logic remains centralized.

The database enforces uniqueness of `(online_platform, external_order_id)`. A retry with an already-created WordPress external ID returns the existing order instead of creating a duplicate.

## Store state

`online_ordering_enabled` is the master feature toggle and `online_ordering_open` is the current operational open/closed state. When ordering is closed, catalog reads continue but online order creation returns HTTP 409.

## Bridge responsibilities

The Bridge should:

1. Bootstrap from `/catalog/snapshot`.
2. Poll `/catalog/changes` and periodically reconcile with a snapshot.
3. Push WordPress orders to `POST /orders` with the Woo order ID as the immutable external ID.
4. Retry transient failures using its persistent outbox.
5. Poll `/orders/changes` and update WordPress only for meaningful online-order status changes.
6. Never write directly to FloCafe SQLite.


## Reliability invariants

- `external_order_id` is required, max 100 characters, and is unique per `online_platform` in FloCafe.
- Integration order creation reuses the canonical order business logic so pricing, tax, inventory, recipe, KDS and audit behavior remain centralized.
- The Integration API resolves or creates a FloCafe customer from WordPress contact/address data; Woo customer numeric IDs are never treated as FloCafe customer IDs.
- `GET /orders/changes` includes `external_order_id` so Bridge status reconciliation survives restart without relying only on an in-memory mapping.
- Full catalog snapshots are the recovery path after revision gaps.
