# Research on Dual Prices for OpenPOS

## Selector map
- **Search autocomplete**: `.mat-autocomplete-panel .mat-option` contains option; price element `.variation-price`; fallback `.mat-option-text`.
- **Cart line item**: `.mat-list-item` each row; unit price `.variation-price`; line total `.total-value`; quantity from text prefix or `data-qty`/input.
- **Totals area**: `app-pos-order-total` with rows `.mat-list-item[data-total-type]`; generic fallback search in elements containing "total" or "summary"; rows labelled by text for subtotal/total/discount/tax.
- **Payment modal**: dialogs `.mat-dialog-container,[role="dialog"]`; header with pattern `pagado/total`; inputs for amounts and suggestion buttons.

## Price sources
- **Unit USD**: parsed from `.variation-price` or last decimal number.
- **Line total USD**: `.total-value` preferred; fallback `unit × qty + addons`.
- **Totals**: values extracted from labelled rows (subtotal, total, discount) and converted.
- **Payment header**: parsed `pagado / total` to derive Paid and Remaining.

## FX logic
- Direction forced to USD→VES; aliases VES/VEF/VEB/BS normalised server‑side.
- Formatting with `Intl.NumberFormat('es-VE')`; symbol `Bs.`; USD symbol from WooCommerce.

## Risks & mitigations
- **Markup changes**: selectors have fallbacks and dataset markers `data-csfx-*` to avoid duplicate injections.
- **i18n labels**: regex matches for `impuesto|iva|tax` and `desc|discount`.
- **Performance**: single `MutationObserver` with `requestAnimationFrame` throttling (<2ms typical).
- **Locales**: `parsePrice` normalises comma/point decimals and ignores existing Bs amounts.
