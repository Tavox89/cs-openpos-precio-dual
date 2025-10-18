<?php
/**
 * Plugin Name: CS – OpenPOS Precio Dual Dinámico (USD + Bs) via FOX API
 * Description: Muestra precios en USD y Bs en OpenPOS (buscador, addons, carrito y totales) usando FOX API (/currencies). Autodetecta origen local/remoto y mapea VES↔VEF. Incluye barra con tasa y hora.
 * Author: Tavox
 * Version: 1.4.0
 */

if ( ! defined('ABSPATH') ) exit;

/* ====== CONFIG ====== */
if ( ! defined('CS_FX_ORIGIN') )          define('CS_FX_ORIGIN', ''); // '' = autodetectar
if ( ! defined('CS_FX_DEFAULT_REMOTE') )  define('CS_FX_DEFAULT_REMOTE', 'https://clubsamsve.com'); // fallback
if ( ! defined('CS_FX_BASE') )            define('CS_FX_BASE',  '');
if ( ! defined('CS_FX_QUOTE') )           define('CS_FX_QUOTE', 'VES'); // alias BS/VEF/VEB
// símbolo por defecto en Bs con punto final como exige el cliente
if ( ! defined('CS_FX_SYMBOL') )          define('CS_FX_SYMBOL', 'Bs.');
if ( ! defined('CS_FX_DECIMALS') )        define('CS_FX_DECIMALS', 2);
if ( ! defined('CS_FX_TTL') )             define('CS_FX_TTL', 300);
if ( ! defined('CS_FX_DEBUG') )           define('CS_FX_DEBUG', false);
if ( ! defined('CS_FX_BADGE') )           define('CS_FX_BADGE', true);
if ( ! defined('CS_FX_HIDE_TAX') )        define('CS_FX_HIDE_TAX', true); // ocultar Impuestos por defecto (espacio)

if ( ! defined('CS_FX_SEARCH_BS') )       define('CS_FX_SEARCH_BS', true);
if ( ! defined('CS_FX_PAY_CHIPS') )       define('CS_FX_PAY_CHIPS', true);
if ( ! defined('CS_FX_ADDONS_BS') )       define('CS_FX_ADDONS_BS', true);


// Nuevas opciones (defaults)
if ( get_option('csfx_rate_mode') === false )        update_option('csfx_rate_mode', 'api');      // api|fox
if ( get_option('csfx_api_url') === false )          update_option('csfx_api_url', '');           // URL api externa (si modo=api)
if ( get_option('csfx_rate_ttl') === false )         update_option('csfx_rate_ttl', 300);
if ( get_option('csfx_rate_from') === false )        update_option('csfx_rate_from', 'USD');
if ( get_option('csfx_rate_to') === false )          update_option('csfx_rate_to', 'VES');
if ( get_option('csfx_discount_enabled') === false ) update_option('csfx_discount_enabled', 1);
if ( get_option('csfx_discount_percent') === false ) update_option('csfx_discount_percent', 31.0);
if ( get_option('csfx_divisa_methods') === false )   update_option('csfx_divisa_methods', '');
if ( get_option('csfx_asset_version') === false )    update_option('csfx_asset_version', '2.3.4');
if ( get_option('csfx_api_sslverify') === false )    update_option('csfx_api_sslverify', 1);
if ( get_option('csfx_api_fallback_fox') === false ) update_option('csfx_api_fallback_fox', 0);

// ================== ADMIN: MENÚ "Conf Tavox" SIEMPRE VISIBLE ==================
// Creamos SIEMPRE un menú top-level. Además intentamos colgarlo en WooCommerce y (si existe) en OpenPOS.
function csfx_find_openpos_parent_slug() {
  global $menu, $submenu;
  // 1) Buscar por títulos: "POS" / "OpenPOS"
  if (is_array($menu)) {
    foreach ($menu as $m) {
      $title = isset($m[0]) ? wp_strip_all_tags($m[0]) : '';
      $slug  = isset($m[2]) ? (string)$m[2] : '';
      if (!$slug) continue;
      if (stripos($title, 'openpos') !== false || preg_match('/(^|\s)pos(\s|$)/i', $title)) {
        return $slug;
      }
      if (stripos($slug, 'openpos') !== false || stripos($slug, 'pos') !== false || stripos($slug, 'op-') !== false) {
        return $slug;
      }
    }
  }
  // 2) Mirar submenús conocidos (por si el top-level es genérico)
  if (is_array($submenu)) {
    foreach ($submenu as $parent_slug => $items) {
      foreach ((array)$items as $it) {
        $st = isset($it[0]) ? wp_strip_all_tags($it[0]) : '';
        if (preg_match('/(Pedidos|Transacciones|Tiendas|Cajeros|Mesas|OpenPOS)/i', $st)) {
          return $parent_slug;
        }
      }
    }
  }
  return '';
}

add_action('admin_menu', function () {
  // Para evitar sorpresas de capabilities raras, usamos manage_options
  $cap = 'manage_options';
  $title = 'Conf Tavox';
  $slug  = 'csfx-conf';
  $hook = false;
  // A) Menú top-level (siempre visible)
  add_menu_page($title, $title, $cap, $slug, 'csfx_render_admin_page', 'dashicons-admin-generic', 58.7);
  // B) También como submenu en WooCommerce (si existe)
  if (menu_page_url('woocommerce', false)) {
    add_submenu_page('woocommerce', $title, $title, $cap, $slug, 'csfx_render_admin_page');
  }
  // C) Intento opcional de colgarlo en OpenPOS (si logramos detectar el parent)
  $parent = csfx_find_openpos_parent_slug();
  if ($parent) {
    add_submenu_page($parent, $title, $title, $cap, $slug, 'csfx_render_admin_page');

  }
  if (defined('CS_FX_DEBUG') && CS_FX_DEBUG) {
    add_action('admin_notices', function() use ($parent) {
      echo '<div class="notice notice-info"><p><strong>CSFX Debug:</strong> parent slug detectado: <code>'.esc_html($parent ?: 'fallback').'</code></p></div>';
    });
  }
}, 9);

function csfx_render_admin_page() {
  if (! current_user_can('manage_woocommerce') && ! current_user_can('manage_options')) return;
  $do_test = isset($_POST['csfx_save_test']);
  if (isset($_POST['csfx_save']) || $do_test) {
    check_admin_referer('csfx_save_opts');
    $mode_post = in_array($_POST['csfx_rate_mode'] ?? 'api', array('api','fox'), true) ? $_POST['csfx_rate_mode'] : 'api';
    update_option('csfx_rate_mode', $mode_post);
    $api_url  = esc_url_raw($_POST['csfx_api_url'] ?? '');
    update_option('csfx_api_url', $api_url);
    $ttl_post = max(0, intval($_POST['csfx_rate_ttl'] ?? 300));
    update_option('csfx_rate_ttl', $ttl_post);
    $from_post = sanitize_text_field($_POST['csfx_rate_from'] ?? 'USD');
    update_option('csfx_rate_from', $from_post);
    $to_post   = sanitize_text_field($_POST['csfx_rate_to'] ?? 'VES');
    update_option('csfx_rate_to', $to_post);
    update_option('csfx_discount_enabled', isset($_POST['csfx_discount_enabled']) ? 1 : 0);
    update_option('csfx_discount_percent', floatval(str_replace(',', '.', $_POST['csfx_discount_percent'] ?? '31')));
    $divisa_raw = isset($_POST['csfx_divisa_methods']) ? wp_unslash((string)$_POST['csfx_divisa_methods']) : '';
    $divisa_list = array();
    foreach (preg_split('/[\r\n,]+/', $divisa_raw) as $token) {
      $token = sanitize_text_field(trim($token));
      if ($token !== '') {
        $divisa_list[] = $token;
      }
    }
    update_option('csfx_divisa_methods', implode("\n", $divisa_list));
    $asset_ver = isset($_POST['csfx_asset_version']) ? sanitize_text_field(wp_unslash((string) $_POST['csfx_asset_version'])) : '';
    if ($asset_ver === '') {
      $asset_ver = '2.3.4';
    }
    update_option('csfx_asset_version', $asset_ver);
    $sslv = isset($_POST['csfx_api_sslverify']) ? 1 : 0;
    update_option('csfx_api_sslverify', $sslv);
    $fbfox = isset($_POST['csfx_api_fallback_fox']) ? 1 : 0;
    update_option('csfx_api_fallback_fox', $fbfox);
    // limpiar cache de tasa
    delete_transient('csfx_rate_cache');
        if ($do_test) {
      $ua   = 'CSFX/2.1 (+'.home_url('/').')';
      $args = array(
        'timeout'  => 10,
        'sslverify'=> $sslv,
        'redirection'=>3,
        'headers' => array('Accept'=>'application/json', 'User-Agent'=>$ua),
        'reject_unsafe_urls' => true,
        'decompress' => true,
      );
      csfx_probe_api($api_url, $args, $to_post);
    }
    echo '<div class="updated notice"><p>Configuración guardada.</p></div>';
  }
  $mode  = get_option('csfx_rate_mode', 'api');
   if ($mode === 'fox' && !class_exists('WOOCS')) {
    add_action('admin_notices', function() {
      $url = admin_url('plugins.php');
      echo '<div class="notice notice-warning"><p>Modo Nativo requiere FOX (WOOCS) activo. <a href="' . esc_url($url) . '">Ir a Plugins</a></p></div>';
    });
  }
  $api   = esc_attr(get_option('csfx_api_url', ''));
  $ttl   = intval(get_option('csfx_rate_ttl', 300));
  $from  = esc_attr(get_option('csfx_rate_from', 'USD'));
  $to    = esc_attr(get_option('csfx_rate_to', 'VES'));
  $d_on  = get_option('csfx_discount_enabled', 1);
  $d_pct = floatval(get_option('csfx_discount_percent', 31.0));
  $sslv  = get_option('csfx_api_sslverify', 1);
  $divisa_text = (string) get_option('csfx_divisa_methods', '');
  $asset_ver = esc_attr(get_option('csfx_asset_version', '2.3.4'));

  $fbfox = get_option('csfx_api_fallback_fox', 0);
  $health = get_option('csfx_last_api_ok');
  if (!$health) $health = get_option('csfx_last_api_err');
  ?>
  <div class="wrap">
    <h1>Configuración · Conf Tavox</h1>
    <form method="post">
      <?php wp_nonce_field('csfx_save_opts'); ?>
      <table class="form-table" role="presentation">
        <tr><th scope="row">Modo de tasa</th>
          <td>
            <label><input type="radio" name="csfx_rate_mode" value="api" <?php checked($mode, 'api'); ?>> API externa</label>&nbsp;&nbsp;
            <label><input type="radio" name="csfx_rate_mode" value="fox" <?php checked($mode, 'fox'); ?>> Nativo (FOX Currency Switcher)</label>
            <p class="description">Elegir de dónde leer la tasa Bs: API propia/externa o desde el plugin FOX instalado en este sitio.</p>
          </td>
        </tr>
        <tr class="csfx-api-row"><th scope="row">API URL (si modo = API)</th>
          <td><input type="url" name="csfx_api_url" class="regular-text" placeholder="https://dominio.tld/currencies" value="<?php echo $api; ?>">
          <p class="description">Debe devolver un JSON con la tasa USD→Bs u objeto que incluya ese valor.</p></td>
        </tr>
        <tr><th scope="row">Par de monedas</th>
          <td>
            <input type="text" name="csfx_rate_from" value="<?php echo $from; ?>" size="6"> →
            <input type="text" name="csfx_rate_to"   value="<?php echo $to;   ?>" size="6">
            <p class="description">Por defecto USD→VES.</p>
          </td>
        </tr>
        <tr><th scope="row">TTL cache (seg)</th>
          <td><input type="number" min="0" name="csfx_rate_ttl" value="<?php echo $ttl; ?>" class="small-text"> <span class="description">0 = sin cache</span></td>
        </tr>
              <tr class="csfx-api-row"><th scope="row">Verificar SSL</th>
          <td><label><input type="checkbox" name="csfx_api_sslverify" <?php checked($sslv, 1); ?>> Habilitar verificación SSL (recomendado)</label></td>
        </tr>
        <tr class="csfx-api-row"><th scope="row">Fallback a FOX si API falla</th>
          <td><label><input type="checkbox" name="csfx_api_fallback_fox" <?php checked($fbfox, 1); ?>> Permitir usar FOX si la API no responde</label></td>
        </tr>
        <tr><th scope="row">Descuento por pago en USD</th>
          <td>
            <label><input type="checkbox" name="csfx_discount_enabled" <?php checked($d_on, 1); ?>> Activar</label>
            &nbsp;&nbsp;<input type="number" step="0.01" min="0" max="100" name="csfx_discount_percent" value="<?php echo esc_attr($d_pct); ?>" class="small-text"> %
            <p class="description">Por defecto 31%. Si está desactivado, los endpoints devolverán 0.</p>
          </td>
        </tr>
        <tr><th scope="row">Versión de assets</th>
          <td>
            <input type="text" name="csfx_asset_version" value="<?php echo $asset_ver; ?>" class="regular-text" pattern="[\w\.\-]+" />
            <p class="description">Se usa para versionar el JS principal y controlar la caché. Ingresa un valor como 2.3.0; escribe “auto” si prefieres usar el filemtime del archivo.</p>
          </td>
        </tr>
        <tr><th scope="row">Métodos de pago en divisas</th>
          <td>
            <textarea name="csfx_divisa_methods" rows="3" class="large-text code" placeholder="cash_usd&#10;zelle&#10;binance"><?php echo esc_textarea($divisa_text); ?></textarea>
            <p class="description">IDs o nombres de métodos de pago OpenPOS que se consideran divisas. Uno por línea o separados por comas.</p>
          </td>
        </tr>
      </table>
      <?php submit_button('Guardar cambios', 'primary', 'csfx_save'); ?>
            <h2 class="csfx-api-row">Health / Probar API ahora</h2>
      <table class="form-table csfx-api-row" role="presentation">
        <tr><th scope="row">Status</th><td><?php echo $health ? esc_html($health['status']) : 'n/d'; ?></td></tr>
        <tr><th scope="row">HTTP / wp_error</th><td><?php echo isset($health['http_code']) ? intval($health['http_code']) : esc_html($health['wp_error'] ?? ''); ?></td></tr>
        <tr><th scope="row">URL</th><td><code><?php echo esc_html($health['upstream_url'] ?? ''); ?></code></td></tr>
        <tr><th scope="row">Rate</th><td><?php echo isset($health['rate']) ? esc_html($health['rate']) : ''; ?></td></tr>
        <tr><th scope="row">Mode</th><td><code><?php echo esc_html($health['mode'] ?? '-'); ?></code></td></tr>
        <tr><th scope="row">Source</th><td><code><?php echo esc_html($health['source'] ?? '-'); ?></code></td></tr>
        <tr><th scope="row">When</th><td><?php echo esc_html($health['when'] ?? ''); ?></td></tr>
      </table>
      <?php submit_button('Guardar y Probar', 'secondary', 'csfx_save_test'); ?>
    </form>
    <hr>
    <h2>Mini-API (REST)</h2>
    <p>Usos rápidos para otros plugins, sitios o scripts:</p>
    <pre><code># Descuento
GET <?php echo esc_url( home_url( '/wp-json/csfx/v1/discount' ) ); ?>
# Respuesta: {"active":true,"percent":31.0,"updated":"2025-08-24T10:25:00-04:00"}

# Tasa
GET <?php echo esc_url( home_url( '/wp-json/csfx/v1/rate' ) ); ?>
# Respuesta: {"mode":"<?php echo esc_html($mode); ?>","rate":141.88,"from":"<?php echo esc_html($from); ?>","to":"<?php echo esc_html($to); ?>","ttl":<?php echo $ttl; ?>,"updated":"..."}
</code></pre>
  </div>
  <style>.csfx-api-row{<?php echo $mode==='api' ? '' : 'display:none;'; ?>}</style>
    <script>
  (function(){
    const radios = document.querySelectorAll('input[name="csfx_rate_mode"]');
    const rows = document.querySelectorAll('.csfx-api-row');
    function update(){

      const val = document.querySelector('input[name="csfx_rate_mode"]:checked')?.value;
           rows.forEach(r => { r.style.display = (val==='api') ? '' : 'none'; });
    }
    radios.forEach(r => r.addEventListener('change', update));
    update();
  })();
  </script>
  <?php
}

// ================== HELPERS: Rate & Discount ==================
function csfx_get_discount(){
  $active = (bool) get_option('csfx_discount_enabled', 1);
  $pct    = $active ? floatval(get_option('csfx_discount_percent', 31.0)) : 0.0;
  $out    = array('active'=>$active, 'percent'=>$pct);
  return apply_filters('csfx_discount', $out);
}

function csfx_get_divisa_methods(){
  $raw = get_option('csfx_divisa_methods', '');
  if (!is_string($raw)) $raw = '';
  $parts = preg_split('/[\r\n,]+/', $raw);
  $out = array();
  if (is_array($parts)) {
    foreach ($parts as $part) {
      $part = trim(wp_strip_all_tags((string)$part));
      if ($part !== '') $out[] = $part;
    }
  }
  return $out;
}

// csfx: inicio descuento dual (backend)
function csfx_extract_request_meta_pairs($prefix = 'csfx_'){
  $out = array();
  foreach ($_REQUEST as $key => $value) { // phpcs:ignore WordPress.Security.NonceVerification
    if (!is_string($key) || strpos($key, $prefix) !== 0) continue;
    $out[$key] = is_array($value) ? reset($value) : $value;
  }
  foreach (array('meta_data','meta','order_meta','order_meta_data') as $group_key) {
    if (empty($_REQUEST[ $group_key ]) || !is_array($_REQUEST[ $group_key ])) continue; // phpcs:ignore WordPress.Security.NonceVerification
    foreach ((array) $_REQUEST[ $group_key ] as $item) { // phpcs:ignore WordPress.Security.NonceVerification
      if (!is_array($item)) continue;
      $name = '';
      if (isset($item['key'])) {
        $name = $item['key'];
      } elseif (isset($item['name'])) {
        $name = $item['name'];
      } elseif (isset($item['code'])) {
        $name = $item['code'];
      }
      if (!is_string($name) || strpos($name, $prefix) !== 0) continue;
      $out[$name] = isset($item['value']) ? $item['value'] : (isset($item['val']) ? $item['val'] : '');
    }
  }
  return $out;
}

function csfx_parse_decimal($value){
  if ($value === null || $value === '') return null;
  if (is_array($value)) $value = reset($value);
  $value = str_replace(',', '.', (string) $value);
  $value = preg_replace('/[^0-9\.\-]/', '', $value);
  if ($value === '' || !is_numeric($value)) return null;
  return (float) $value;
}

function csfx_collect_dual_discount_request(){
  $pairs = csfx_extract_request_meta_pairs('csfx_');
  if (empty($pairs)) return null;
  $meta_out = array();
  foreach ($pairs as $key => $value) {
    $meta_out[$key] = is_scalar($value) ? wc_clean((string) $value) : '';
  }
  $usd_paid = isset($meta_out['csfx_usd_paid']) ? csfx_parse_decimal($meta_out['csfx_usd_paid']) : null;
  $pct_raw = isset($meta_out['csfx_discount_pct']) ? csfx_parse_decimal($meta_out['csfx_discount_pct']) : null;
  $disc_val = isset($meta_out['csfx_discount_value']) ? csfx_parse_decimal($meta_out['csfx_discount_value']) : null;
  $base_total = isset($meta_out['csfx_base_total']) ? csfx_parse_decimal($meta_out['csfx_base_total']) : null;

  if ($usd_paid !== null) {
    $meta_out['csfx_usd_paid'] = wc_format_decimal($usd_paid, 4);
  } else {
    unset($meta_out['csfx_usd_paid']);
  }
  $pct_display = null;
  $pct_decimal = null;
  if ($pct_raw !== null) {
    $pct_display = $pct_raw;
    if ($pct_display > 1) {
      $pct_decimal = $pct_display / 100;
    } else {
      $pct_decimal = $pct_display;
      $pct_display = $pct_decimal * 100;
    }
    $meta_out['csfx_discount_pct'] = wc_format_decimal($pct_display, 4);
  } else {
    unset($meta_out['csfx_discount_pct']);
  }
  if ($disc_val !== null) {
    $meta_out['csfx_discount_value'] = wc_format_decimal($disc_val, 4);
  } else {
    unset($meta_out['csfx_discount_value']);
  }
  if ($base_total !== null) {
    $meta_out['csfx_base_total'] = wc_format_decimal($base_total, 4);
  } else {
    unset($meta_out['csfx_base_total']);
  }

  $note = '';
  if ($usd_paid !== null && $disc_val !== null && $pct_display !== null) {
    $gross = $usd_paid + $disc_val;
    $note = sprintf(
      'Descuento de precio dual: %s %% sobre %s USD, cliente pagó %s USD en divisas.',
      wc_format_decimal($pct_display, 2),
      wc_format_decimal($gross, 2),
      wc_format_decimal($usd_paid, 2)
    );
  }

  $warning = '';
  if ($usd_paid !== null && $pct_decimal !== null && $disc_val !== null && $pct_decimal > 0 && $pct_decimal < 1) {
    $expected = ($usd_paid / (1 - $pct_decimal)) - $usd_paid;
    if (abs($expected - $disc_val) > 0.5) {
      $warning = sprintf(
        'CSFX dual discount mismatch: expected %.4f vs received %.4f (pct %.4f, paid %.4f)',
        $expected,
        $disc_val,
        $pct_display,
        $usd_paid
      );
    }
  }

  return array(
    'meta' => $meta_out,
    'note' => $note,
    'warning' => $warning
  );
}

function csfx_checkout_store_dual_discount_meta( $order, $data = null ){
  if ( ! is_a( $order, 'WC_Order' ) ) {
    return;
  }
  $collected = csfx_collect_dual_discount_request();
  if ( ! $collected ) {
    return;
  }
  foreach ( $collected['meta'] as $key => $value ) {
    $order->update_meta_data( $key, $value );
  }
  if ( ! empty( $collected['note'] ) ) {
    $order->add_order_note( $collected['note'], false, true );
  }
  if ( ! empty( $collected['warning'] ) ) {
    $logger = function_exists( 'wc_get_logger' ) ? wc_get_logger() : null;
    if ( $logger ) {
      $logger->warning(
        $collected['warning'],
        array(
          'source'   => 'csfx-dual-discount',
          'order_id' => $order->get_id(),
        )
      );
    }
  }
}
add_action( 'woocommerce_checkout_create_order', 'csfx_checkout_store_dual_discount_meta', 21, 2 );
// csfx: fin descuento dual (backend)

function csfx_is_self_url($url){
  $host = wp_parse_url(home_url('/'), PHP_URL_HOST);
  $u    = wp_parse_url($url, PHP_URL_HOST);
  return $host && $u && strtolower($host) === strtolower($u);
}

function csfx_probe_api($url, $args = array(), $to = 'VES'){
  $out  = array('upstream_url'=>$url);
  $when = current_time('mysql');
  if (! $url) {
    $out['status'] = 'error';
    $out['error']  = 'missing_api_url';
    update_option('csfx_last_api_err', $out + array('when'=>$when), false);
    return $out;
  }
  if (csfx_is_self_url($url)) {
    $out['status'] = 'error';
    $out['error']  = 'self_url';
    update_option('csfx_last_api_err', $out + array('when'=>$when), false);
    return $out;
  }
  $args = wp_parse_args($args, array('reject_unsafe_urls'=>true, 'decompress'=>true));
  $res = wp_remote_get($url, $args);
  if (is_wp_error($res)) {
    $out['status']   = 'error';
    $out['error']    = 'wp_error';
    $out['wp_error'] = $res->get_error_message();
    update_option('csfx_last_api_err', $out + array('when'=>$when), false);
    return $out;
  }
  $code = wp_remote_retrieve_response_code($res);
  $out['http_code'] = intval($code);
  if (intval($code) !== 200) {
    $out['status'] = 'error';
    $out['error']  = 'http_error';
    update_option('csfx_last_api_err', $out + array('when'=>$when), false);
    return $out;
  }
  $body = wp_remote_retrieve_body($res);
  $json = json_decode($body, true);
  $rate = 0.0;
  if (is_array($json)) {
    if (isset($json['rate']))               $rate = floatval($json['rate']);
    elseif (isset($json['USD_VES']))        $rate = floatval($json['USD_VES']);
    elseif (isset($json['ves']))            $rate = floatval($json['ves']);
    elseif (isset($json['currencies'][$to]['rate'])) $rate = floatval($json['currencies'][$to]['rate']);
  } elseif (is_numeric($json)) {
    $rate = floatval($json);
  } elseif (is_numeric(trim($body))) {
    $rate = floatval(trim($body));
  }
  $out['status'] = 'ok';
  $out['rate']   = $rate;
  update_option('csfx_last_api_ok', $out + array('when'=>$when), false);
  delete_option('csfx_last_api_err');
  return $out;
}
function csfx_get_rate(){
  $mode = get_option('csfx_rate_mode', 'api');
  $from = strtoupper(get_option('csfx_rate_from', 'USD'));
  $to   = strtoupper(get_option('csfx_rate_to', 'VES'));
  $ttl  = intval(get_option('csfx_rate_ttl', 300));
  $sslv = !! get_option('csfx_api_sslverify', 1);
  $fbfx = !! get_option('csfx_api_fallback_fox', 0);
  $ua   = 'CSFX/2.1 (+'.home_url('/').')';
  // POS-friendly: respuestas rápidas y sin múltiples redirecciones
  $args = array('timeout'=>3, 'sslverify'=>$sslv, 'redirection'=>1, 'headers'=>array('Accept'=>'application/json', 'User-Agent'=>$ua), 'reject_unsafe_urls'=>true, 'decompress'=>true);

  if ($mode === 'api') {
    $cache = get_transient('csfx_rate_cache');
    if (is_array($cache) && isset($cache['rate'])) {
      return apply_filters('csfx_rate', $cache);
    }
    $url   = trim(get_option('csfx_api_url', ''));
    $probe = csfx_probe_api($url, $args, $to);
    if (($probe['status'] ?? '') === 'ok') {
      $rate    = (float)($probe['rate'] ?? 0);
      $updated = current_time('c');
      $data = array('mode'=>'api','rate'=>$rate,'from'=>$from,'to'=>$to,'ttl'=>$ttl,'updated'=>$updated,'source'=>'api','upstream_url'=>$url,'http_code'=>$probe['http_code'] ?? 200);
      if ($ttl>0) set_transient('csfx_rate_cache', $data, $ttl);
      // Persistimos el último valor válido para servirlo como stale si la API falla
      update_option('csfx_last_good_rate', $data, false);
      return apply_filters('csfx_rate', $data);
    }
    // Falla la API: intentar servir último valor bueno si es reciente (<=24h)
    $stale = get_option('csfx_last_good_rate');
    if (is_array($stale) && isset($stale['rate'])) {
      $updated_ts = null;
      if (isset($stale['updated'])) {
        if (is_numeric($stale['updated'])) {
          $updated_ts = intval($stale['updated']);
        } else {
          $parsed = strtotime((string)$stale['updated']);
          if ($parsed !== false) {
            $updated_ts = intval($parsed);
          }
        }
      }
      if ($updated_ts === null) {
        $updated_ts = 0;
      }
      if (abs(time() - $updated_ts) <= DAY_IN_SECONDS) {
        $stale['_stale'] = true;
        return apply_filters('csfx_rate', $stale);
      }
    }
    $data = array('mode'=>'api','rate'=>0.0,'from'=>$from,'to'=>$to,'ttl'=>$ttl,'updated'=>current_time('c'),'source'=>'api','error'=>$probe['error'] ?? 'unknown','upstream_url'=>$url);
    if (isset($probe['http_code'])) $data['http_code'] = $probe['http_code'];
    if (isset($probe['wp_error']))  $data['wp_error']  = $probe['wp_error'];
    if ($fbfx && class_exists('WOOCS')) {
      $fox = csfx_get_rate_from_fox($from,$to);
      $fox['error'] = $probe['error'] ?? 'unknown';
      $fox['upstream_url'] = $url;
      if (isset($probe['http_code'])) $fox['http_code'] = $probe['http_code'];
      if (isset($probe['wp_error'])) $fox['wp_error'] = $probe['wp_error'];
      return apply_filters('csfx_rate', $fox);
    }

    return apply_filters('csfx_rate', $data);
  }

  if (class_exists('WOOCS')) return apply_filters('csfx_rate', csfx_get_rate_from_fox($from,$to));



  return apply_filters('csfx_rate', array('mode'=>$mode,'rate'=>0.0,'from'=>$from,'to'=>$to,'ttl'=>$ttl,'updated'=>current_time('c'),'source'=>$mode));
}
function csfx_get_rate_from_fox($from,$to){
  global $WOOCS;
  $rate = 0.0; $updated = current_time('c');
  $currs = is_object($WOOCS) && method_exists($WOOCS, 'get_currencies') ? $WOOCS->get_currencies() : array();
  $base = get_option('woocommerce_currency', 'USD');
  $r_from = ($from===$base) ? 1.0 : floatval($currs[$from]['rate'] ?? 0);
  $r_to   = ($to===$base)   ? 1.0 : floatval($currs[$to]['rate'] ?? 0);
  if ($r_from > 0 && $r_to > 0) {
    // Si ambas tasas existen, usa la relación directa.
    $rate = $r_to / $r_from;
  } else {
    /*
     * Fallback avanzado: cuando alguna de las monedas no está registrada en el objeto
     * $WOOCS (p. ej. VES o VEF según la versión del plugin), intentamos calcular
     * la tasa consultando los endpoints públicos del propio plugin FOX. Primero
     * intentamos obtener todas las monedas con sus tasas mediante
     * /fox-rate/v1/currencies y calculamos la relación. Si eso falla o no
     * contiene las monedas deseadas, recurrimos a /fox-rate/v1/convert, pero
     * sustituyendo VES↔VEF según exista.
     */
    // Construimos la URL del listado de monedas.
    $curr_url = home_url( '/wp-json/fox-rate/v1/currencies' );
    $resp_c   = wp_remote_get( $curr_url, array( 'timeout' => 3, 'sslverify' => true, 'redirection' => 0 ) );
    $computed = false;
    if ( ! is_wp_error( $resp_c ) && wp_remote_retrieve_response_code( $resp_c ) == 200 ) {
      $body_c = json_decode( wp_remote_retrieve_body( $resp_c ), true );
      if ( is_array( $body_c ) ) {
        // Determinar alias: si el código no existe pero su alternativo sí, usarlo.
        $from_x = isset( $body_c[ $from ] ) ? $from : ( ( $from === 'VES' && isset( $body_c['VEF'] ) ) ? 'VEF' : ( ( $from === 'VEF' && isset( $body_c['VES'] ) ) ? 'VES' : $from ) );
        $to_x   = isset( $body_c[ $to ] )   ? $to   : ( ( $to   === 'VES' && isset( $body_c['VEF'] ) ) ? 'VEF' : ( ( $to   === 'VEF' && isset( $body_c['VES'] ) ) ? 'VES' : $to ) );
        // Recuperamos las tasas de cada moneda. La tasa está definida frente al
        // currency base, que es la moneda definida en WooCommerce.
        $base = get_option( 'woocommerce_currency', 'USD' );
        $r_from2 = ( $from_x === $base ) ? 1.0 : floatval( $body_c[ $from_x ]['rate'] ?? 0 );
        $r_to2   = ( $to_x   === $base ) ? 1.0 : floatval( $body_c[ $to_x ]['rate'] ?? 0 );
        if ( $r_from2 > 0 && $r_to2 > 0 ) {
          $rate = $r_to2 / $r_from2;
          $computed = true;
        }
      }
    }
    if ( ! $computed ) {
      // Si no logramos calcular la tasa, probamos con el endpoint de conversión.
      $amount = 1;
      // Aplica alias para VES/VEF en caso de que una de las divisas no exista.
      $from_alias = $from;
      $to_alias   = $to;
      if ( $from_alias === 'VES' || $from_alias === 'VEF' ) {
        // Cambiar a la existente en el listado de monedas si disponible.
        $alt_from   = $from_alias === 'VES' ? 'VEF' : 'VES';
        // Sólo reemplazamos si la moneda alterna existe en $currs (si lo tenemos) o
        // en los datos remotos (si la petición anterior falló no tendremos
        // $body_c disponible). Es un fallback best-effort.
        if ( isset( $currs[ $alt_from ] ) || ( isset( $body_c ) && isset( $body_c[ $alt_from ] ) ) ) {
          $from_alias = $alt_from;
        }
      }
      if ( $to_alias === 'VES' || $to_alias === 'VEF' ) {
        $alt_to   = $to_alias === 'VES' ? 'VEF' : 'VES';
        if ( isset( $currs[ $alt_to ] ) || ( isset( $body_c ) && isset( $body_c[ $alt_to ] ) ) ) {
          $to_alias = $alt_to;
        }
      }
      $url = home_url( sprintf( '/wp-json/fox-rate/v1/convert?amount=%s&from=%s&to=%s', $amount, urlencode( $from_alias ), urlencode( $to_alias ) ) );
      $resp = wp_remote_get( $url, array( 'timeout' => 3, 'sslverify' => true, 'redirection' => 0 ) );
      if ( ! is_wp_error( $resp ) && wp_remote_retrieve_response_code( $resp ) == 200 ) {
        $body = json_decode( wp_remote_retrieve_body( $resp ), true );
        if ( is_array( $body ) && isset( $body['converted'] ) && floatval( $body['converted'] ) > 0 ) {
          $rate = floatval( $body['converted'] );
        }
      }
    }
  }
  return array('mode'=>'fox','rate'=>$rate,'from'=>$from,'to'=>$to,'ttl'=>0,'updated'=>$updated,'source'=>'fox');
}

// === AJAX ultra-rápido para OpenPOS (cache-first, sin bloquear) ===
if (!function_exists('csfx_ajax_rate')) {
  add_action('wp_ajax_cs_fx_rate',        'csfx_ajax_rate');
  add_action('wp_ajax_nopriv_cs_fx_rate', 'csfx_ajax_rate');
  function csfx_ajax_rate(){
    $cache = get_transient('csfx_rate_cache');
    $data  = (is_array($cache) && isset($cache['rate'])) ? $cache : csfx_get_rate();
    wp_send_json($data);
  }
}

// ================== REST API ==================
add_action('rest_api_init', function () {
  register_rest_route('csfx/v1', '/discount', array(
    'methods' => 'GET',
    'permission_callback' => '__return_true',
    'callback' => function () {
      $d = csfx_get_discount();
      $d['updated'] = current_time('c');
      return rest_ensure_response($d);
    },
  ));
  register_rest_route('csfx/v1', '/rate', array(
    'methods' => 'GET',
    'permission_callback' => '__return_true',
    'callback' => function () {
      $data = csfx_get_rate();
      // Normaliza el campo "updated" a epoch (segundos) si no es numérico. Esto
      // evita que el front reciba cadenas ISO y reduzca las posibilidades de
      // mostrar "Invalid Date".
      if (!empty($data['updated']) && !is_numeric($data['updated'])) {
        $ts = strtotime($data['updated']);
        if ($ts) {
          // strtotime devuelve segundos; asignamos tal cual
          $data['updated'] = $ts;
        }
      }
      $debug = isset($_GET['debug']) || (defined('CS_FX_DEBUG') && CS_FX_DEBUG);
      if ($debug) {
        $data['_debug'] = true;
      } else {
        unset($data['upstream_url'], $data['wp_error'], $data['http_code']);
      }
      return rest_ensure_response($data);
    },
  ));
  register_rest_route('csfx/v1', '/config', array(
    'methods' => 'GET',
    'permission_callback' => '__return_true',
    'callback' => function () {
      return rest_ensure_response(array(
        'mode'   => get_option('csfx_rate_mode','api'),
        'api'    => get_option('csfx_api_url',''),
        'ttl'    => intval(get_option('csfx_rate_ttl',300)),
        'from'   => get_option('csfx_rate_from','USD'),
        'to'     => get_option('csfx_rate_to','VES'),
        'discount'=> csfx_get_discount(),
        'divisa_methods' => csfx_get_divisa_methods(),
      ));
    },
  ));
});
/* ====== Helpers ====== */
function cs_fx_site_origin(){ return rtrim( site_url(), '/' ); }
function cs_fx_sanitize_origin($o){
    $o = trim((string)$o);
    if ($o === '') return '';
    if (stripos($o, 'http') !== 0) $o = 'https://' . $o;
    return rtrim($o, '/');
}
function cs_fx_candidate_origins(){
    $candidates = [];
    $opt = get_option('cs_fx_origin', '');
    if ($opt)        $candidates[] = cs_fx_sanitize_origin($opt);
    if (CS_FX_ORIGIN)$candidates[] = cs_fx_sanitize_origin(CS_FX_ORIGIN);
    $candidates[]    = cs_fx_site_origin(); // local primero
    $candidates[]    = cs_fx_sanitize_origin(CS_FX_DEFAULT_REMOTE);
    $uniq = [];
    foreach ($candidates as $o) if ($o && !in_array($o, $uniq, true)) $uniq[] = $o;
    return $uniq;
}
function cs_fx_status_url($origin){ return rtrim($origin,'/') . '/wp-json/fox-rate/v1/status'; }
function cs_fx_currencies_url($origin){ return rtrim($origin,'/') . '/wp-json/fox-rate/v1/currencies'; }

function cs_fx_pick_key(array $arr, $want){
    $want = strtoupper(trim((string)$want));
    $aliases = [$want];
    if ($want === 'VES') $aliases = ['VES','VEF','VEB','BS'];
    if ($want === 'USD') $aliases = ['USD','US$','$'];
    foreach ($aliases as $k) if (isset($arr[$k])) return $k;
    return null;
}

/** Selecciona y cachea el mejor origen disponible (1 día). */
function cs_fx_select_origin(){
    $cached = get_transient('cs_fx_origin_selected');
    if ($cached) return $cached;
    foreach (cs_fx_candidate_origins() as $origin){
        $url = cs_fx_status_url($origin);
        $res = wp_remote_get($url, ['timeout'=>6]);
        if ( ! is_wp_error($res) && wp_remote_retrieve_response_code($res) === 200 ){
            $j = json_decode(wp_remote_retrieve_body($res), true);
            if ( is_array($j) && (!empty($j['status']) || !empty($j['message'])) ){
                set_transient('cs_fx_origin_selected', $origin, DAY_IN_SECONDS);
                if ( CS_FX_DEBUG ) error_log('[CS-FX] origin selected: '.$origin);
                return $origin;
            }
        }
    }
    $fallback = cs_fx_sanitize_origin(CS_FX_DEFAULT_REMOTE);
    set_transient('cs_fx_origin_selected', $fallback, HOUR_IN_SECONDS);
    if ( CS_FX_DEBUG ) error_log('[CS-FX] origin fallback: '.$fallback);
    return $fallback;
}

/** Moneda base (WooCommerce por defecto) */
function cs_fx_base_currency(){
    if ( CS_FX_BASE ) return strtoupper(CS_FX_BASE);
    $wc = get_option('woocommerce_currency');
    return $wc ? strtoupper($wc) : 'USD';
}

/** Pide la tasa remota */
function cs_fx_get_rate_remote(){
    $origin = cs_fx_select_origin();
    $url    = cs_fx_currencies_url($origin);
    $res    = wp_remote_get($url, ['timeout'=>10]);

    if ( is_wp_error($res) || wp_remote_retrieve_response_code($res) !== 200 ){
        if ( CS_FX_DEBUG ) error_log('[CS-FX] currencies request failed: '.$origin);
        return ['rate'=>0.0, 'source'=>'fail', 'origin'=>$origin];
    }
    $data = json_decode(wp_remote_retrieve_body($res), true);
    if ( ! is_array($data) ){
        if ( CS_FX_DEBUG ) error_log('[CS-FX] currencies invalid payload: '.$origin);
        return ['rate'=>0.0, 'source'=>'fail', 'origin'=>$origin];
    }

    $baseKey  = cs_fx_pick_key($data, cs_fx_base_currency());
    $quoteKey = cs_fx_pick_key($data, CS_FX_QUOTE);
    if ( ! $baseKey || ! $quoteKey ){
        if ( CS_FX_DEBUG ) error_log('[CS-FX] keys not found base='.cs_fx_base_currency().' quote='.CS_FX_QUOTE.' origin='.$origin);
        return ['rate'=>0.0, 'source'=>'fail', 'origin'=>$origin];
    }

    $rb = isset($data[$baseKey]['rate'])  ? (float)$data[$baseKey]['rate']  : 0.0;
    $rq = isset($data[$quoteKey]['rate']) ? (float)$data[$quoteKey]['rate'] : 0.0;

    $rate = 0.0;
    if ( $rq > 0 ) $rate = ($rb > 0) ? ($rq / $rb) : $rq;

    return ['rate'=>$rate, 'source'=>'currencies', 'origin'=>$origin];
}

function cs_fx_get_rate(){
    $cached = get_transient('cs_fx_rate');
    if ( $cached && is_array($cached) && isset($cached['rate']) ) return $cached;

    $remote = cs_fx_get_rate_remote();
    $rate   = max(0.0, (float)$remote['rate']);
       // normaliza orientación para asegurar USD→VES
    $base  = cs_fx_base_currency();
    $quote = strtoupper(CS_FX_QUOTE);
    if ( $base === 'VES' && $quote === 'USD' && $rate > 0 ) {
        $rate = 1 / $rate;
    }
    $out = [
        'rate'    => $rate,
        'updated' => time(),
        'source'  => $remote['source'],
        'origin'  => $remote['origin'],
    ];

    if ($rate > 0){
        set_transient('cs_fx_rate', $out, CS_FX_TTL);
        update_option('cs_fx_last', $out, false);
    } else {
        $last = get_option('cs_fx_last', []);
        if ( isset($last['rate']) ){
            $out = $last + ['source'=>'last'];
        }
    }
    return $out;
}

/* ====== AJAX para refrescar ====== */
add_action('wp_ajax_cs_fx_rate',        function(){ wp_send_json( cs_fx_get_rate() ); });
add_action('wp_ajax_nopriv_cs_fx_rate', function(){ wp_send_json( cs_fx_get_rate() ); });

/* ====== Inyectar settings al POS (después de login) ====== */
add_filter('op_get_login_cashdrawer_data', function($session){
    $fx = cs_fx_get_rate();
    $session['setting']['cs_fx'] = [
        'enabled'    => true,
        'base'       => cs_fx_base_currency(),
        'quote'      => strtoupper(CS_FX_QUOTE),
        'symbolUSD'  => get_woocommerce_currency_symbol( cs_fx_base_currency() ),
        'symbolVES'  => CS_FX_SYMBOL,
          'symbol'     => CS_FX_SYMBOL,
        'rate'       => (float)$fx['rate'],
        'updated'    => (int)$fx['updated'],
        'decimals'   => (int)CS_FX_DECIMALS,
        'ttl'        => (int)CS_FX_TTL,
        'ajax'       => admin_url('admin-ajax.php?action=cs_fx_rate'),
        'source'     => $fx['source'],
        'origin'     => $fx['origin'],
        'badge'      => (bool)CS_FX_BADGE,
        'hideTax'    => (bool)CS_FX_HIDE_TAX,
        'searchBs'   => (bool)CS_FX_SEARCH_BS,
        'payChips'   => (bool)CS_FX_PAY_CHIPS,
               'addonsBs'   => (bool)CS_FX_ADDONS_BS,
        'debug'      => (bool)CS_FX_DEBUG,
        'divisaMethods' => csfx_get_divisa_methods(),
        'style'      => [
            'bsColor'       => '#0057b7',
            'discountColor' => '#28a745',
            'usdColor'      => '#000000',
        ],
    ];
    $session['setting']['pos_disable_cart_discount'] = 'no';
    $session['setting']['pos_disable_item_discount'] = 'no';
    return $session;
}, 50);

/* ====== Encolar scripts sólo en la página del POS ====== */
add_filter('openpos_pos_footer_js', function($handles){
        // archivo de compatibilidad con cambios de la API 7.3.x
    $compat_path = plugin_dir_path(__FILE__) . 'assets/js/compat/openpos-compat.js';
    $compat_ver  = '1.0.0';
    if ( file_exists( $compat_path ) ) {
        $compat_ver .= '.' . filemtime( $compat_path );
    }
    $compat_asset = plugins_url('assets/js/compat/openpos-compat.js', __FILE__);
    wp_register_script('cs-openpos-compat', $compat_asset, [], $compat_ver, true);
    wp_script_add_data('cs-openpos-compat', 'defer', true);
    // versionado basado en filemtime para busting de cache
    $asset_path = plugin_dir_path(__FILE__) . 'assets/cs-fx.js';
    $ver = '1.0.0';
    if (file_exists($asset_path)) {
        $ver = (string) filemtime($asset_path);
    }
    $asset = plugins_url('assets/cs-fx.js', __FILE__);
    // JS principal dependiente de compat
    wp_register_script('cs-fx', $asset, ['cs-openpos-compat'], $ver, true);
    wp_script_add_data('cs-fx', 'defer', true);
    $inline_js = "(function(){var css='.cart-discount button{opacity:0!important;pointer-events:none!important;position:relative!important;width:0!important;height:0!important;}';var style=document.createElement('style');style.textContent=css;document.head.appendChild(style);var hide=function(){var btn=document.querySelector('.cart-discount button');if(btn){btn.style.opacity='0';btn.style.pointerEvents='none';btn.style.position='relative';btn.style.width='0';btn.style.height='0';btn.setAttribute('aria-hidden','true');}};document.addEventListener('DOMContentLoaded',hide);document.addEventListener('csfx:cart-updated',hide);})();";
    wp_add_inline_script('cs-openpos-compat', $inline_js);
    // Boot inline para tener rate incluso en pantalla de login
    $fx = cs_fx_get_rate();
    $boot = [
        'enabled'   => true,
        'base'      => cs_fx_base_currency(),
        'quote'     => strtoupper(CS_FX_QUOTE),
        'symbolUSD' => get_woocommerce_currency_symbol( cs_fx_base_currency() ),
        'symbolVES' => CS_FX_SYMBOL,
           'symbol'    => CS_FX_SYMBOL,
        'rate'      => (float)$fx['rate'],
        'updated'   => (int)$fx['updated'],
        'decimals'  => (int)CS_FX_DECIMALS,
        'ttl'       => (int)CS_FX_TTL,
        'ajax'      => admin_url('admin-ajax.php?action=cs_fx_rate'),
        'source'    => $fx['source'],
        'origin'    => $fx['origin'],
        'badge'     => (bool)CS_FX_BADGE,
        'hideTax'   => (bool)CS_FX_HIDE_TAX,
        'searchBs'  => (bool)CS_FX_SEARCH_BS,
        'payChips'  => (bool)CS_FX_PAY_CHIPS,
             'addonsBs'  => (bool)CS_FX_ADDONS_BS,
        'debug'     => (bool)CS_FX_DEBUG,
        'divisaMethods' => csfx_get_divisa_methods(),
        'style'     => [
            'bsColor'       => '#0057b7',
            'discountColor' => '#28a745',
            'usdColor'      => '#000000',
        ],
    ];
    wp_add_inline_script('cs-fx', 'window.__CS_FX_BOOT = '. wp_json_encode($boot, JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE) .';', 'before');
    add_action('wp_footer', function(){
      // Inyectar los endpoints utilizados por el front. Se define siempre un
      // endpoint de tasa y un endpoint de descuento para permitir refrescos
      // independientes. También exportamos opciones como hideTax.
      $hide_tax = defined('CS_FX_HIDE_TAX') ? (bool) CS_FX_HIDE_TAX : true;
      $rate_url = esc_js( rest_url('csfx/v1/rate') );
      $disc_url = esc_js( rest_url('csfx/v1/discount') );
      $opts = array(
        'hideTax' => $hide_tax,
        'divisaMethods' => csfx_get_divisa_methods(),
      );
      echo "<script>\n";
      echo "  window.CSFX_RATE_ENDPOINT = '" . $rate_url . "';\n";
      echo "  window.CSFX_DISCOUNT_ENDPOINT = '" . $disc_url . "';\n";
      echo "  window.CSFX_OPTS = " . wp_json_encode($opts, JSON_UNESCAPED_UNICODE) . ";\n";
      echo "</script>";
    }, 99);

    // al final del POS añádeme
    $handles[] = 'cs-openpos-compat';
    $handles[] = 'cs-fx';
    return $handles;
}, 50);
