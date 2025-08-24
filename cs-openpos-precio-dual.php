<?php
/**
 * Plugin Name: CS – OpenPOS Precio Dual Dinámico (USD + Bs) via FOX API
 * Description: Muestra precios en USD y Bs en OpenPOS (buscador, addons, carrito y totales) usando FOX API (/currencies). Autodetecta origen local/remoto y mapea VES↔VEF. Incluye barra con tasa y hora.
 * Author: Tavox
 * Version: 1.8.9
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
    // versionado basado en filemtime para busting de cache
    $asset_path = plugin_dir_path(__FILE__) . 'assets/cs-fx.js';
    $ver = '1.8.9'; // bump para busting de caché tras refactor de totales

    if ( file_exists( $asset_path ) ) {
        $ver .= '.' . filemtime( $asset_path );
    }
    $asset = plugins_url('assets/cs-fx.js', __FILE__);
    // JS principal
    wp_register_script('cs-fx', $asset, [], $ver, true);
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
    $handles[] = 'cs-fx';
    return $handles;
}, 50);
