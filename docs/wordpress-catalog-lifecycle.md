# WordPress catalog lifecycle

The native WordPress Bridge sends a full catalog snapshot from FloCafe.

- FloCafe is_active is exposed as explicit active and available fields.
- A product becoming inactive changes WordPress/ACF available to false; website visibility is independent of that lifecycle flag.
- A product deleted in FloCafe is omitted from the full snapshot, allowing CafeFlo Connect to permanently delete the mapped WooCommerce product.
- Stable FloCafe product IDs remain the mapping identity.

Uncategorized is not a FloCafe catalog category; the WordPress side is responsible for removing WooCommerce's default product category when a synced product has no FloCafe category.
