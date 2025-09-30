=== CS – OpenPOS Precio Dual Dinámico (USD + Bs) via FOX API ===
Contributors: tavox
Tags: openpos, point of sale, woocommerce, currency, venezuela
Requires at least: 5.8
Tested up to: 6.5
Stable tag: 1.4.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

== Description ==

Complementa OpenPOS con precios duales Bs/USD basados en FOX Currency Switcher. El plugin toma la tasa vigente, la cachea y expone endpoints REST/AJAX pensados para puntos de venta con respuesta rápida.

== Installation ==

1. Sube la carpeta `cs-openpos-precio-dual` a `/wp-content/plugins/`.
2. Activa el plugin desde el menú "Plugins" de WordPress.
3. Configura la sección "Conf Tavox" para definir el origen de la tasa.

== Changelog ==

= 1.4.0 =
* perf: cache-first, stale fallback, timeouts 3s, AJAX handler para POS
