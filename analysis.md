# Research on Dual Prices for OpenPOS

## Selector map
### Totales
- Nativo `app-pos-order-total` con filas `.mat-list-item[data-total-type]`.
- Fallback en cualquier contenedor con `total|summary|checkout-footer|openpos-summary` y filas `div/li/tr`.
### Buscador (autocomplete)
- Panel `.mat-autocomplete-panel` → opciones `.mat-option`.
- Precio USD dentro `.product-price`, `.variation-price` o último span decimal de `.mat-option-text`.
### Modal de pago
- Overlay `.mat-dialog-container`.
- Encabezado `Pagado/Total` seguido por `.csfx-pay-header-row`.
- Inputs y botones dentro del mismo modal.
## Failures & fixes
- **Impuestos visibles**: selector anterior fallaba con cambios de markup. Ahora se detecta `data-total-type="tax"` o labels `/(impuesto|iva|tax)/`, ocultando el contenedor completo con `csfx-hide-tax`.
- **Buscador desbordado**: el chip Bs ocupaba todo el ancho. Se creó `.csfx-price-stack` que apila USD arriba y Bs debajo, alineado a la derecha.
- **Chips de pago pequeños**: poco legibles. Se añadió variante `.csfx-chip--modal` (16 px, bold) y mayor `gap` en `.csfx-pay-header-row`.

## Notes
- Observers dedicados en totales, buscador y modal evitan fugas y reprocesan sólo cuando cambia cada vista.
- `data-csfx-*` preserva idempotencia y permite rollback granular.
