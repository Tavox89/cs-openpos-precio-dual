# Rollback

- Desactivar desde `wp-config.php` definiendo:
  - `define('CS_FX_HIDE_TAX', false);`
  - `define('CS_FX_BADGE', false);`
  - `define('CS_FX_DEBUG', false);`
- Para quitar totalmente el script, remover el filtro `openpos_pos_footer_js` o borrar el plugin.
- Los datos `cs_fx` quedan en `op_settings`; limpiar localStorage si es necesario.