# Rollback

- Desactivar Bs en buscador: `define('CS_FX_SEARCH_BS', false);`
- Desactivar Bs en addons: `define('CS_FX_ADDONS_BS', false);`
- Ocultar chips de métodos de pago: `define('CS_FX_PAY_CHIPS', false);`
- Si se desea quitar la conversión por línea, establecer `CS_FX_RATE` en `0` o esconder `.csfx-cart-row` vía CSS.
- Para revertir completamente, remover el filtro `openpos_pos_footer_js` o desactivar el plugin y limpiar `localStorage` (`op_settings`).