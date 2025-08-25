<?php
/**
 * Plugin Name: CS – OpenPOS Precio Dual Dinámico (USD + Bs) via FOX API
 * Description: Muestra precios en USD y Bs en OpenPOS (buscador, addons, carrito y totales) usando FOX API (/currencies). Autodetecta origen local/remoto y mapea VES↔VEF. Incluye barra con tasa y hora.
 * Author: Tavox
 * Version: 2.0.1



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

// ================== ADMIN: SUBMENU "Conf Tavox" ==================
// Detecta dinámicamente el slug del menú de OpenPOS y cuelga "Conf Tavox" allí (fallback WooCommerce -> top-level)
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
  $cap = current_user_can('manage_woocommerce') ? 'manage_woocommerce' : 'manage_options';
  $title = 'Conf Tavox';
  $slug  = 'csfx-conf';
  $hook = false;
  // 1) Intentar OpenPOS real
  $parent = csfx_find_openpos_parent_slug();
  if ($parent) {
    $hook = add_submenu_page($parent, $title, $title, $cap, $slug, 'csfx_render_admin_page');

  }
  // 2) Fallback WooCommerce
  if (! $hook && menu_page_url('woocommerce', false)) {
    $hook = add_submenu_page('woocommerce', $title, $title, $cap, $slug, 'csfx_render_admin_page');
  }
  // 3) Fallback top-level
  if (! $hook) {
    add_menu_page($title, $title, $cap, $slug, 'csfx_render_admin_page', 'dashicons-admin-generic', 58.7);
  }
  if (defined('CS_FX_DEBUG') && CS_FX_DEBUG) {
    add_action('admin_notices', function() use ($parent) {
      echo '<div class="notice notice-info"><p><strong>CSFX Debug:</strong> parent slug detectado: <code>'.esc_html($parent ?: 'fallback').'</code></p></div>';
    });
  }
}, 99);

function csfx_render_admin_page() {
  if (! current_user_can('manage_woocommerce') && ! current_user_can('manage_options')) return;
  if (isset($_POST['csfx_save'])) {
    check_admin_referer('csfx_save_opts');
    update_option('csfx_rate_mode',        in_array($_POST['csfx_rate_mode'] ?? 'api', array('api','fox'), true) ? $_POST['csfx_rate_mode'] : 'api');
    update_option('csfx_api_url',          esc_url_raw($_POST['csfx_api_url'] ?? ''));
    update_option('csfx_rate_ttl',         max(0, intval($_POST['csfx_rate_ttl'] ?? 300)));
    update_option('csfx_rate_from',        sanitize_text_field($_POST['csfx_rate_from'] ?? 'USD'));
    update_option('csfx_rate_to',          sanitize_text_field($_POST['csfx_rate_to'] ?? 'VES'));
    update_option('csfx_discount_enabled', isset($_POST['csfx_discount_enabled']) ? 1 : 0);
    update_option('csfx_discount_percent', floatval(str_replace(',', '.', $_POST['csfx_discount_percent'] ?? '31')));
    // limpiar cache de tasa
    delete_transient('csfx_rate_cache');
    echo '<div class="updated notice"><p>Configuración guardada.</p></div>';
  }
  $mode  = get_option('csfx_rate_mode', 'api');
  $api   = esc_attr(get_option('csfx_api_url', ''));
  $ttl   = intval(get_option('csfx_rate_ttl', 300));
  $from  = esc_attr(get_option('csfx_rate_from', 'USD'));
  $to    = esc_attr(get_option('csfx_rate_to', 'VES'));
  $d_on  = get_option('csfx_discount_enabled', 1);
  $d_pct = floatval(get_option('csfx_discount_percent', 31.0));
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
        <tr><th scope="row">Descuento por pago en USD</th>
          <td>
            <label><input type="checkbox" name="csfx_discount_enabled" <?php checked($d_on, 1); ?>> Activar</label>
            &nbsp;&nbsp;<input type="number" step="0.01" min="0" max="100" name="csfx_discount_percent" value="<?php echo esc_attr($d_pct); ?>" class="small-text"> %
            <p class="description">Por defecto 31%. Si está desactivado, los endpoints devolverán 0.</p>
          </td>
        </tr>
      </table>
      <?php submit_button('Guardar cambios', 'primary', 'csfx_save'); ?>
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
  <?php
}

// ================== HELPERS: Rate & Discount ==================
function csfx_get_discount(){
  $active = (bool) get_option('csfx_discount_enabled', 1);
  $pct    = $active ? floatval(get_option('csfx_discount_percent', 31.0)) : 0.0;
  $out    = array('active'=>$active, 'percent'=>$pct);
  return apply_filters('csfx_discount', $out);
}

function csfx_get_rate(){
  $mode = get_option('csfx_rate_mode', 'api');
  $from = strtoupper(get_option('csfx_rate_from', 'USD'));
  $to   = strtoupper(get_option('csfx_rate_to', 'VES'));
  $ttl  = intval(get_option('csfx_rate_ttl', 300));
  $rate = 0.0; $updated = '';

  if ($mode === 'api') {
    $cache = get_transient('csfx_rate_cache');
    if (is_array($cache) && isset($cache['rate'])) {
      return apply_filters('csfx_rate', $cache);
    }
    $url = trim(get_option('csfx_api_url', ''));
    if ($url) {
      $res = wp_remote_get($url, array('timeout'=>6));
      if (! is_wp_error($res) && wp_remote_retrieve_response_code($res) === 200) {
        $body = json_decode(wp_remote_retrieve_body($res), true);
        // heurística: buscar campos comunes
        $rate = 0.0;
        if (isset($body['rate']))               $rate = floatval($body['rate']);
        elseif (isset($body['USD_VES']))        $rate = floatval($body['USD_VES']);
        elseif (isset($body['ves']) )           $rate = floatval($body['ves']);
        elseif (isset($body['currencies'][$to]['rate'])) $rate = floatval($body['currencies'][$to]['rate']);
        $updated = current_time('c');
        $data = array('mode'=>'api','rate'=>$rate,'from'=>$from,'to'=>$to,'ttl'=>$ttl,'updated'=>$updated,'source'=>'api');
        if ($ttl>0) set_transient('csfx_rate_cache', $data, $ttl);
        return apply_filters('csfx_rate', $data);
      }
    }
  }

  // modo FOX (nativo)
  if (class_exists('WOOCS')) {
    global $WOOCS;
    $currs = is_object($WOOCS) && method_exists($WOOCS, 'get_currencies') ? $WOOCS->get_currencies() : array();
    // Asumir que 'rate' es respecto a la moneda base de WooCommerce
    $base = get_option('woocommerce_currency', 'USD');
    $r_from = ($from===$base) ? 1.0 : floatval($currs[$from]['rate'] ?? 0);
    $r_to   = ($to===$base)   ? 1.0 : floatval($currs[$to]['rate'] ?? 0);
    if ($r_from>0 && $r_to>0) {
      $rate = $r_to / $r_from;
      $updated = current_time('c');
      $data = array('mode'=>'fox','rate'=>$rate,'from'=>$from,'to'=>$to,'ttl'=>0,'updated'=>$updated,'source'=>'fox');
      return apply_filters('csfx_rate', $data);
    }
  }

  // Fallback final
  return apply_filters('csfx_rate', array('mode'=>$mode,'rate'=>0.0,'from'=>$from,'to'=>$to,'ttl'=>$ttl,'updated'=>current_time('c'),'source'=>$mode));
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
      return rest_ensure_response(csfx_get_rate());
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
        'style'      => [
            'bsColor'       => '#0057b7',
            'discountColor' => '#28a745',
            'usdColor'      => '#000000',
        ],
    ];
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
    $ver = '1.9.8';


    if ( file_exists( $asset_path ) ) {
        $ver .= '.' . filemtime( $asset_path );
    }
    $asset = plugins_url('assets/cs-fx.js', __FILE__);
    // JS principal
    wp_register_script('cs-fx', $asset, [], $ver, true);
        wp_script_add_data('cs-fx', 'defer', true);
    // JS principal dependiente de compat
    wp_register_script('cs-fx', $asset, ['cs-openpos-compat'], $ver, true);
    wp_script_add_data('cs-fx', 'defer', true);
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
        'style'     => [
            'bsColor'       => '#0057b7',
            'discountColor' => '#28a745',
            'usdColor'      => '#000000',
        ],
    ];
    wp_add_inline_script('cs-fx', 'window.__CS_FX_BOOT = '. wp_json_encode($boot, JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE) .';', 'before');

    // al final del POS añádeme
    $handles[] = 'cs-openpos-compat';
    $handles[] = 'cs-fx';
    return $handles;
}, 50);
