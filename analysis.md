# Analysis

## Selectores finales
- **Buscador**: `.mat-autocomplete-panel .mat-option` → precio dentro de `.product-price`, `.variation-price` o último número con decimales.
- **Carrito**: filas `.mat-list-item`; inserta `div.csfx-cart-row[data-csfx="cart-bs"]` al final de cada fila.
- **Totales**: contenedor `app-pos-order-total` o fallback de `findTotalsContainer()`; fila extra `div[data-csfx="subtotal"]` tras "Subtotal" y chip `[data-csfx="total-inline"]` dentro de "Total".
- **Extras (modal)**: en `.mat-dialog-container` las opciones `mat-radio-button`, `mat-checkbox`, `.mat-option` o `li` usan `span.csfx-addon-stack`.

## Diseño de `getLineUSD`
1. Busca `.total-value` como total USD de la línea.
2. Si falla, toma el nodo de precio alineado a la derecha (último número con 2 decimales) excluyendo textos con Bs/VES/VEF o elementos `.csfx-*`.
3. Último recurso: calcula `unitUSD × qty + Σ(addonUSD)` parseando números sin prefijo `Bs` y con `+` para addons.

## Por qué evita tomar el Bs como USD
- Se descartan nodos `.csfx-*` y cualquier número cercano a "Bs", "VES" o "VEF".
- Si existe un Bs visible en la fila, se rechazan candidatos cuyo `usd × rate` difiera más de 40 % del Bs observado.

## Guardas anti‑explosión y sanidad
- Si `usd × rate > 10^7` se busca otro candidato menor; si no hay, no se muestra Bs.
- El parseo ignora valores precedidos por `+` al estimar el precio unitario para no mezclar addons.
- Toda mutación es idempotente mediante `data-csfx` y no altera contenedores base.
