/*!
 * CS – OpenPOS Precio Dual Dinámico (USD + Bs)
 * v2.1.0 – 2025-08-24
 * Muestra Bs en buscador, addons, carrito y totales del POS.
 * Seguro para Angular: idempotente, con throttling y sin mutar contenedores base.
 */
/**
 * Script principal del conversor USD→Bs para OpenPOS.
 *
 * Este archivo se ejecuta siempre que el POS se cargue en el navegador.
 * A diferencia de versiones anteriores, no abandona si no existe un
 * <app-root> inmediatamente. En su lugar, registra observadores que
 * reaccionan cuando Angular crea la interfaz. Esto permite decorar
 * correctamente los componentes incluso si se cargan de forma
 * asíncrona o después del login.
 */
(function () {
  'use strict';

    // Compatibilidad con distintas versiones de OpenPOS
  var OPCompat = window.OpenPOSCompat || {};

  // --- Config FX (mezcla BOOT + localStorage) ---
  var FX = window.CSFX = (function () {
    var def = {
      enabled: true,
      base: 'USD',
      quote: 'VES',
         symbolUSD: '$',
      symbolVES: 'Bs.',
      symbol: 'Bs.',
      rate: 0,
      decimals: 2,
      updated: 0,
      ttl: 300,
      ajax: '',
      badge: true,
      hideTax: true,
      searchBs: true,
      payChips: true,
       addonsBs: true,
      debug: false,
           style: {
        bsColor: '#0057b7',
        vipSearch: true,
        vipSearchBg: 'rgba(0,87,183,.10)',
        vipSearchBorder: 'rgba(0,87,183,.28)',
        vipSearchText: '#1e3a8a',
        vipSearchShadow: '0 1px 0 rgba(255,255,255,.4) inset, 0 1px 4px rgba(0,0,0,.12)'
      }
    };
    // Datos inyectados por PHP antes de tener sesión
    if (window.__CS_FX_BOOT && typeof window.__CS_FX_BOOT === 'object') {
       var boot = window.__CS_FX_BOOT;
      if (boot.style && typeof boot.style === 'object') {
        Object.assign(def.style, boot.style);
      }
      Object.keys(boot).forEach(function (k) {
        if (k !== 'style' && boot[k] != null) def[k] = boot[k];
      });
    }
    // Datos persistidos por el POS una vez logueado
    try {
      var s = JSON.parse(localStorage.getItem('op_settings') || '{}');
      var fx = (s.setting && s.setting.cs_fx) || {};
      Object.keys(fx).forEach(function (k) {
             if (fx[k] != null) {
          if (k === 'style' && typeof fx[k] === 'object') {
            Object.assign(def.style, fx[k]);
          } else {
            def[k] = fx[k];
          }
        }
      });
    } catch (e) {}
    def.rate = 0;
    def.updated = 0;
    def.decimals = Number(def.decimals) || 2;

    // AJAX: si no viene, lo armamos desde action_url global del POS
    if (!def.ajax && typeof window !== 'undefined' && window.action_url) {
      var a = window.action_url;
      def.ajax = a + (a.indexOf('?') > -1 ? '&' : '?') + 'action=cs_fx_rate';
    }
      if (!def.symbol && def.symbolVES) def.symbol = def.symbolVES;
    window.__CS_FX = def; // legado
    window.csfx = def; // para debug externo
    return def;
  })();
  FX.hideTax = true;
  // Estado inicial para el descuento; se rellenará tras consultar la mini‑API
  // No dependemos de storage para el descuento global
  FX.disc = { active: false, percent: 0 };
  // si vienen opciones desde PHP, las respetamos; si no, default true
  if (window.CSFX_OPTS && typeof window.CSFX_OPTS.hideTax !== 'undefined') FX.hideTax = !!window.CSFX_OPTS.hideTax;

  function decodeSymbol(sym, fallback) {
    if (!sym) return fallback || '';
    if (typeof sym !== 'string') return sym;
    if (sym.indexOf('&') === -1) return sym;
    return sym
      .replace(/&amp;/gi, '&')
      .replace(/&#(\d+);/g, function (_, code) {
        var n = parseInt(code, 10);
        return isFinite(n) ? String.fromCharCode(n) : _;
      })
      .replace(/&(#x[0-9a-f]+);/gi, function (_, hex) {
        var n = parseInt(hex.slice(2), 16);
        return isFinite(n) ? String.fromCharCode(n) : _;
      })
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, '\'')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>');
  }

  FX.symbolUSD = decodeSymbol(FX.symbolUSD, '$');
  FX.symbol = decodeSymbol(FX.symbol, 'Bs.');
  FX.symbolVES = decodeSymbol(FX.symbolVES, 'Bs.');

  var FX_STATE_STORAGE_KEY = 'csfx_state_v1';
  var fxOfflineState = (function(){
    try {
      var raw = localStorage.getItem(FX_STATE_STORAGE_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (_err) {
      return {};
    }
  })();

  function persistFxOfflineState(partial){
    if (!partial || typeof partial !== 'object') return;
    fxOfflineState = fxOfflineState && typeof fxOfflineState === 'object' ? fxOfflineState : {};
    Object.keys(partial).forEach(function(k){
      fxOfflineState[k] = partial[k];
    });
    try {
      localStorage.setItem(FX_STATE_STORAGE_KEY, JSON.stringify(fxOfflineState));
    } catch (_err) { /* storage lleno/offline */ }
  }

  function hydrateFxRateFromOffline(){
    if (!fxOfflineState || typeof fxOfflineState !== 'object') return;
    var rate = Number(fxOfflineState.rate || 0);
    if (rate > 0 && (!FX.rate || FX.rate <= 0)) {
      FX.rate = rate;
      if (fxOfflineState.updated) FX.updated = fxOfflineState.updated;
    }
  }

  function hydrateFxDiscountFromOffline(){
    if (!fxOfflineState || typeof fxOfflineState !== 'object' || !fxOfflineState.disc) return;
    var storedDisc = fxOfflineState.disc;
    var raw = (typeof storedDisc.percent !== 'undefined') ? storedDisc.percent : storedDisc.percentDecimal;
    var pct = Number(raw || 0);
    if (!isFinite(pct) || pct <= 0) return;
    var normalized = pct > 1 ? pct : pct * 100;
    if (!FX.disc || typeof FX.disc !== 'object') {
      FX.disc = {
        active: !!storedDisc.active,
        percent: normalized
      };
      return;
    }
    if (!FX.disc.percent || FX.disc.percent <= 0) {
      FX.disc.percent = normalized;
    }
    if (typeof FX.disc.active === 'undefined') {
      FX.disc.active = !!storedDisc.active;
    }
  }

  hydrateFxRateFromOffline();
  hydrateFxDiscountFromOffline();

    function csfxClearLegacyStores(){
    try { localStorage.removeItem('YU_BCV_RATE'); } catch(_){ }
    try { localStorage.removeItem('CSFX_RATE'); } catch(_){ }
    try { if (window.YuPrecio) delete window.YuPrecio; } catch(_){ }
  }

  csfxClearLegacyStores();

  // --- Utilidades ---
  function round(n, d) {
    d = (typeof d === 'number') ? d : FX.decimals;
    var p = Math.pow(10, d);
    return Math.round((+n + Number.EPSILON) * p) / p;
  }
  function parsePrice(s) {
    /**
     * Extrae un precio con decimales de una cadena. Se ignoran los
     * identificadores numéricos sin decimales (IDs, SKUs) y los valores
     * precedidos por el texto "Bs". Sólo se consideran números que
     * contienen un separador decimal (punto o coma).
     * @param {string} s
     * @returns {number}
     */
    if (!s) return NaN;
    var text = '' + s;
    // descarta si aparece "Bs" cerca del número
    if (/bs\s*[\d.,]/i.test(text)) return NaN;
    // normaliza separadores de miles y decimales
    var t = text.replace(/[^0-9,\.\-]/g, '');
    // convierte coma decimal a punto decimal
    t = t.replace(/,(\d{1,2})(?=\D|$)/, '.$1');
    // sólo números con decimales (punto o coma)
    var m = t.match(/-?\d+[\.,]\d{1,2}/);
    if (!m) return NaN;
    return parseFloat(m[0].replace(/,/g, '.'));
  }
  function fmtBs(n) {
    try {
       return (FX.symbol || 'Bs.') + ' ' + Number(n).toLocaleString('es-VE', {
        minimumFractionDigits: FX.decimals,
        maximumFractionDigits: FX.decimals
      });
    } catch (e) {
     return (FX.symbol || 'Bs.') + ' ' + round(n, FX.decimals);
    }
  }
  function usd2bs(u) {
    return round((Number(u) || 0) * (FX.rate || 0), FX.decimals);
  }
  function fmtUsd(n) {
    try {
      return (FX.symbolUSD || '$') + ' ' + Number(n).toLocaleString('en-US', {
        minimumFractionDigits: FX.decimals,
        maximumFractionDigits: FX.decimals
      });
    } catch (e) {
      return (FX.symbolUSD || '$') + ' ' + round(n, FX.decimals);
    }
  }
  // --- CSS mínimo/limpio ---
  (function addCss() {
    var id = 'csfx-css';
    if (document.getElementById(id)) return;
    var css = [
      '.csfx-chip{display:inline-block;margin-left:.5rem;padding:.15rem .45rem;border-radius:12px;font-size:11px;line-height:1;background:#eef1f5;color:#2f3437;white-space:nowrap;vertical-align:middle;}',
      '.csfx-chip--under{margin:0;display:block;font-size:12px;font-weight:600}',
          '.csfx-chip--inline{margin-left:.5rem;font-size:13px;font-weight:700}',
        /* Base común para chips estilo "pill" */
        '.csfx-chip-pill{display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;line-height:1;padding:.1rem .45rem;border-radius:12px;vertical-align:middle;white-space:nowrap;}',
      '.csfx-addon-stack{display:flex;flex-direction:column;align-items:flex-end;gap:2px;line-height:1}',
      '.csfx-chip--addon{font-size:12px;font-weight:600}',
      '.csfx-row{display:flex;justify-content:space-between;font-size:12px;opacity:.95;margin-top:2px;}',
      '.csfx-row .csfx-amount{font-weight:600;}',
      // fila del carrito: sólo muestra el importe en Bs, alineado a la derecha
           '.csfx-cart-row{display:block;margin-top:2px;font-size:13px;font-weight:600;text-align:right;padding-right:.6rem;width:100%;}',
          // filas de totales en Bs (Subtotal)
        '.csfx-total-row{display:flex;justify-content:space-between;font-size:14px;font-weight:700;margin-top:8px;padding:0 .4rem;}',
      '.csfx-total-row span{font-weight:700;font-size:14px;}',
      '.csfx-total-row .csfx-amount{color:#1e3a8a;font-weight:700;font-size:14px;}',
      '.csfx-total-row[data-csfx="total-final"]{display:grid;grid-template-columns:auto 1fr;column-gap:8px;row-gap:2px;align-items:center;}',
      '.csfx-total-row[data-csfx="total-final"] .csfx-amount{text-align:right;}',
            '.csfx-sub-bs-inline{display:block;text-align:right;font-weight:700;color:#0d6efd;line-height:1.1;margin-top:2px;font-size:12px;}',

      '.csfx-info{margin-top:6px;font-size:11px;opacity:.8;}',
      '.csfx-pay-header-row{display:flex;gap:.8rem;margin-top:2px;}',
      '.csfx-chip--modal{font-size:16px;font-weight:700;padding:.2rem .6rem}',
      '.csfx-dual-box{margin-top:12px;padding:10px;border:1px solid rgba(15,23,42,.12);border-radius:8px;background:#f8fafc;max-width:280px;}',
      '.csfx-dual-box h4{margin:0 0 6px;font-size:14px;font-weight:700;color:#1f2937;}',
      '.csfx-dual-grid{display:grid;grid-template-columns:auto auto;column-gap:8px;row-gap:4px;font-size:12px;}',
      '.csfx-dual-grid strong{color:#111827;}',
      '.csfx-dual-input{margin-top:8px;display:flex;flex-direction:column;gap:4px;font-size:12px;}',
      '.csfx-dual-input input{padding:6px 8px;border:1px solid #d1d5db;border-radius:4px;font-size:14px;font-weight:600;color:#111827;}',
      '.csfx-dual-input input:focus{outline:2px solid rgba(14,116,144,.25);border-color:#0ea5e9;}',
      '.csfx-dual-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;}',
      '.csfx-chip-pill{background:rgba(15,23,42,.08);color:#0f172a;}',
      '.csfx-chip-pill--ok{background:rgba(16,185,129,.16);color:#065f46;}',
      '.csfx-chip-pill--warn{background:rgba(249,115,22,.16);color:#9a3412;}',
      '.csfx-chip-pill--alert{background:rgba(239,68,68,.16);color:#991b1b;}',
      '.csfx-dual-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:10px;}',
      '.csfx-dual-status{margin-top:8px;font-size:12px;color:#1f2937;}',
      '.csfx-dual-status--info{color:#0f766e;}',
      '.csfx-dual-status--warn{color:#9a3412;}',
      '.csfx-dual-status--error{color:#991b1b;}',
      '.csfx-dual-status--ok{color:#065f46;font-weight:700;}',
      '.csfx-dual-note{margin-top:6px;font-size:11px;color:#4b5563;line-height:1.4;}',
      '.csfx-badge-info{margin-bottom:6px;font-size:12px;line-height:1.4;}',
      '.csfx-dual-note strong{font-weight:700;}',
      // compactar el hueco de impuestos si se decide ocultar
       '.csfx-hide-tax{display:none!important;line-height:0!important;height:0!important;overflow:hidden!important;margin:0!important;padding:0!important;border:0!important;}',
      // badge colapsable para mostrar la tasa y hora
        '.csfx-badge{position:fixed;right:12px;bottom:96px;z-index:10000;font-family:inherit;}', /* bottom se recalcula por JS */
      '.csfx-badge-handle{background:#2f3437;color:#fff;padding:6px 8px;border-radius:4px 4px 0 0;font-size:16px;cursor:pointer;}',
      '.csfx-badge-content{background:#eef1f5;color:#2f3437;padding:6px 8px;border-radius:0 0 4px 4px;display:none;font-size:14px;white-space:nowrap;}',
       '.csfx-badge.open .csfx-badge-content{display:block;}',
      // especificidad para evitar conflictos con CSS del POS
        /* Reglas específicas para el buscador (sin romper layout nativo) */
      '.csfx-chip{font-family:inherit;font-size:16px;font-weight:700;}',
      '.csfx-usd-chip{font-size:16px;font-weight:700;color:#0b5e3c;background:rgba(16,185,129,.10);padding:.2rem .5rem;border-radius:12px;}',
      '.csfx-bs-chip{font-size:16px;font-weight:700;color:#1e3a8a;background:rgba(0,87,183,.10);padding:.2rem .5rem;border-radius:12px;position:absolute;top:50%;transform:translateY(-50%);right:0;}',
      '.mat-autocomplete-panel .mat-option .mat-option-text{position:relative;overflow:visible;padding-right:2rem;}',
      '.mat-dialog-container .mat-radio-button .mat-radio-label-content, .mat-dialog-container .mat-checkbox .mat-checkbox-label{display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%}',
      '.mat-dialog-container .csfx-addon-stack{display:flex;flex-direction:column;align-items:flex-end;gap:2px}',
      /* Chip USD con descuento (se inserta dentro del chip Bs en buscador) */
      '.csfx-usd-disc-inside{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:12px;font-weight:700;font-size:12px;line-height:1.4;background:#e9ecf5;color:#1e2a44;white-space:nowrap;vertical-align:middle;}'

    ].join('');
    var el = document.createElement('style');
    el.id = id;
    el.textContent = css;
    document.head.appendChild(el);
  })();

  // --- Throttling seguro para Angular ---
  var scheduled = false;
  function schedule(fn) {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () {
      scheduled = false;
      try { fn(); } catch (e) { /* silencioso */ }
    });
  }

  // --- Helpers DOM ---
  function findPriceElement(root) {
    if (!root) return null;
    // targets típicos
    var e = root.querySelector('.md-chip,.mat-chip,.chip,.price,[class*="price"],[class*="amount"]');
    if (e && !isNaN(parsePrice(e.textContent))) return e;
    // fallback: último número con 2 decimales a la derecha
    var cand = Array.prototype.filter.call(root.querySelectorAll('span,div,strong,b,i,em'), function (n) {
      var t = (n.textContent || '').trim();
      return /-?\d+[.,]\d{2}\s*$/.test(t) && !n.classList.contains('csfx-chip') && !/\(Bs\)/i.test(t);
    });
    if (cand.length) {
      cand.sort(function (a, b) {
        return b.getBoundingClientRect().right - a.getBoundingClientRect().right;
      });
      return cand[0];
    }
    return null;
  }
  function hideHard(el) {
    if (!el) return;
    el.classList.add('csfx-hide-tax');
    el.style.display = 'none';
    el.style.lineHeight = '0';
    el.style.height = '0';
    el.style.overflow = 'hidden';
    el.style.margin = '0';
    el.style.padding = '0';
    el.style.border = '0';
  }
  // ----- Lectura robusta de valores en USD desde una fila de totales -----
  function pickValueElement(row) {
    if (!row) return null;
    // 1) patrones típicos de OpenPOS / Angular Material
    var el = row.querySelector('.total-value, [class*="total-value"], [class*="value"]');
    if (el) return el;
    // 2) tablas: última celda
    el = row.querySelector('td:last-child');
    if (el) return el;
    // 3) mat-list: la segunda columna dentro de .mat-list-text
    var listText = row.querySelector('.mat-list-text');
    if (listText) {
      // suele tener 2 hijos: título y valor; intentamos el último
      var kids = Array.from(listText.children).filter(Boolean);
      if (kids.length) return kids[kids.length - 1];
    }
    // 4) último hijo directo con texto
    var children = Array.from(row.children).filter(Boolean);
    for (var i = children.length - 1; i >= 0; i--) {
      if ((children[i].textContent || '').trim()) {
        return children[i];
      }
    }
    return row;
  }
  function readUsdFromRow(row) {
    if (!row) return NaN;
    var valEl = pickValueElement(row);
   if (!valEl) return NaN;
    // Evitar contaminación por nuestros hijos inline (data-csfx)
    var txt;
    if (valEl.querySelector && valEl.querySelector('[data-csfx]')) {
      var clone = valEl.cloneNode(true);
      Array.prototype.slice.call(clone.querySelectorAll('[data-csfx]')).forEach(function (n) { n.remove(); });
      txt = clone.textContent || '';
    } else {
      txt = valEl.textContent || '';
    }    return parsePrice(txt);
  }
  // --- Decoradores ---
    // bandera para evitar actualizaciones repetidas que generan parpadeo
  var updateApplied = false;

  function decorateSearch() {
    if (!FX.rate) {
      document.querySelectorAll('[data-csfx="bs-search"], .csfx-search-bs').forEach(function(n){ n.remove(); });
      return;
    }
    if (!FX.searchBs || updateApplied) return;    updateApplied = true;
    var items = document.querySelectorAll('.mat-autocomplete-panel .mat-option');
    items.forEach(function (it) {
     var textRoot = it.querySelector('.mat-option-text') || it;
      // Limpieza de versiones previas que usaban csfx-price-stack
      var oldStack = textRoot.querySelector('.csfx-price-stack');
      if (oldStack) {
        while (oldStack.firstChild) {
          oldStack.parentNode.insertBefore(oldStack.firstChild, oldStack);
        }
        oldStack.remove();
      }
      var priceEl = textRoot.querySelector('.product-price, .variation-price, [class*="price"]');
      if (!priceEl) priceEl = findPriceElement(textRoot);
    if (!priceEl) return; // sin USD confiable, no insertes Bs
      if (!priceEl.classList.contains('csfx-usd-chip')) {
   priceEl.classList.add('csfx-chip', 'csfx-usd-chip');
      }
      var usdVal = parsePrice(priceEl.textContent);
      if (isNaN(usdVal) || usdVal <= 0) return;

     const anchor = priceEl.closest('.mat-option-text') || priceEl.parentNode;
      if (!anchor) return;
    

      let chip = anchor.querySelector('[data-csfx="bs-search"]');
      if (!chip) {
        chip = document.createElement('span');
 
        chip.dataset.csfx = 'bs-search';
        anchor.appendChild(chip);
      }
         chip.className = 'csfx-chip csfx-bs-chip' + (FX.style && FX.style.vipSearch ? ' vip' : '');
      if (FX.style && FX.style.vipSearch) {
        chip.style.background = FX.style.vipSearchBg || '';
        chip.style.borderColor = FX.style.vipSearchBorder || '';
        chip.style.color = FX.style.vipSearchText || '';
        chip.style.boxShadow = FX.style.vipSearchShadow || '';
      }
      
      // Calcular monto en Bs y armar contenido del chip. Si existe un
      // descuento activo, se muestra el valor en USD con descuento al lado
      // dentro del mismo chip para no alterar el layout del buscador.
      var bsText = fmtBs(usd2bs(usdVal));
      // Reiniciar contenido del chip
      chip.innerHTML = '';
      chip.appendChild(document.createTextNode(bsText));
      if (FX.disc && FX.disc.active && FX.disc.percent > 0) {
        var usdDisc = usdVal * (1 - FX.disc.percent / 100);
        var discSpan = document.createElement('span');
        discSpan.className = 'csfx-usd-disc-inside';
        discSpan.title = 'USD con descuento (' + FX.disc.percent + '%)';
        discSpan.textContent = (new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(usdDisc)) + '$';
        chip.appendChild(discSpan);
      }

      // tipografía simétrica (copiar del USD, sin tocar USD)
      const cs = getComputedStyle(priceEl);
      chip.style.fontFamily = cs.fontFamily || 'inherit';
      chip.style.fontSize = cs.fontSize;
      chip.style.fontWeight = cs.fontWeight;
      chip.style.letterSpacing = cs.letterSpacing;
      chip.style.fontFeatureSettings = cs.fontFeatureSettings || 'normal';
      chip.style.fontVariantNumeric = 'tabular-nums lining-nums';

      let lh = cs.lineHeight;
      if (!lh || lh === 'normal') lh = `${Math.round(parseFloat(cs.fontSize) || 12)}px`;
      chip.style.lineHeight = lh;
      chip.style.borderRadius = cs.borderRadius || '12px';


    });
  }

    function resetUpdates() {
    updateApplied = false;
  }

  function decorateAddons() {
    if (!FX.rate || !FX.addonsBs) {
      document.querySelectorAll('[data-csfx="addon-bs"]').forEach(function(n){ n.remove(); });
      document.querySelectorAll('[data-csfx="addon-stack"]').forEach(function(stack){
        var child = Array.prototype.find.call(stack.childNodes, function(n){ return n.nodeType === 1 && !n.dataset.csfx; });
        if (child) stack.replaceWith(child); else stack.remove();
      });
      return;
    }    var modals = document.querySelectorAll('.mat-dialog-container');
    modals.forEach(function (modal) {
      var opts = modal.querySelectorAll('mat-radio-button, mat-checkbox, .mat-option, li');
      opts.forEach(function (opt) {
        var content = opt.querySelector('.mat-radio-label-content') || opt.querySelector('.mat-checkbox-label') || opt.querySelector('label') || opt;
        var stack = content.querySelector('[data-csfx="addon-stack"]');
        if (stack && stack.parentNode !== content) content.appendChild(stack);
        var priceEl;
        if (stack) {
          priceEl = Array.prototype.find.call(stack.childNodes, function (n) {
            return n.nodeType === 1 && !n.dataset.csfx;
          });
        } else {
        priceEl = content.querySelector('.price, [class*="amount"]');
          if (!priceEl) priceEl = findPriceElement(content);
          if (!priceEl) return;
          stack = document.createElement('span');
          stack.className = 'csfx-addon-stack';
          stack.dataset.csfx = 'addon-stack';
          priceEl.parentNode.insertBefore(stack, priceEl);
          stack.appendChild(priceEl);
               content.appendChild(stack);
        }
        var usdVal = parsePrice(priceEl.textContent);
        if (isNaN(usdVal) || usdVal <= 0) return;
        var chip = stack.querySelector('[data-csfx="addon-bs"]');
        if (!chip) {
     chip = Array.prototype.find.call(content.childNodes, function (n) {
            if (n.nodeType !== 1) return false;
            if (stack.contains(n)) return false;
            var tx = (n.textContent || '').trim();
          return /^(Bs|VES|VEF)\s*[\d\.,]+$/i.test(tx);
          });
          if (chip) {
            stack.appendChild(chip);
          } else {
            chip = document.createElement('span');
            stack.appendChild(chip);
          }
          chip.className = 'csfx-chip csfx-chip--under csfx-chip--addon';
          chip.dataset.csfx = 'addon-bs';
        }
         chip.textContent = fmtBs(usd2bs(usdVal));
      });
    });
  
  }

  function getLineUSD(row) {
    if (!row) return NaN;
    var candidates = [];
    var bsVisible = NaN;
    Array.prototype.slice.call(row.querySelectorAll('span,div,strong,b')).forEach(function (n) {
      if (n.closest('.csfx-cart-row')) return;
      if ((n.classList && Array.prototype.some.call(n.classList, function (c) { return c.indexOf('csfx-') === 0; })) || n.dataset && n.dataset.csfx) return;
      var tx = (n.textContent || '').trim();
     if (/^(Bs|VES|VEF)\s*[\d\.,]+$/i.test(tx) && isNaN(bsVisible)) bsVisible = parsePrice(tx);
    });
    function pushCandidate(val, prio) {
      if (isNaN(val) || val <= 0) return;
            var bsVal = usd2bs(val);
      if (bsVal < 1 || bsVal > 1e6) return;
      if (!isNaN(bsVisible)) {
             var diff = Math.abs(bsVal - bsVisible) / bsVisible;
        if (diff > 0.25) return;
      }
      candidates.push({ usd: val, prio: prio });
    }
    var totalEl = row.querySelector('.total-value');
    if (totalEl) pushCandidate(parsePrice(totalEl.textContent), 1);
    if (candidates.length === 0) {
      var nodes = Array.prototype.filter.call(row.querySelectorAll('span,div,strong,b'), function (n) {
        if (n.closest('.csfx-cart-row')) return false;
        if ((n.classList && Array.prototype.some.call(n.classList, function (c) { return c.indexOf('csfx-') === 0; })) || n.dataset && n.dataset.csfx) return false;
        if (n.querySelector('svg')) return false;
        var t = (n.textContent || '').trim();
        if (/bs|ves|vef/i.test(t)) return false;
     if (/^[+-]/.test(t)) return false;
        return /\d+[.,]\d{1,2}$/.test(t);
      });
      if (nodes.length) {
        nodes.sort(function (a, b) { return b.getBoundingClientRect().right - a.getBoundingClientRect().right; });
        pushCandidate(parsePrice(nodes[0].textContent), 2);
      }
    }
    if (candidates.length === 0) {
      var clone = row.cloneNode(true);
      Array.prototype.slice.call(clone.querySelectorAll('.csfx-cart-row,[class^="csfx-"],[data-csfx]')).forEach(function (x) { x.remove(); });
      var text = clone.textContent || '';
      var qty = 1;
      var qm = text.match(/^\s*(\d+)\s*[x×]/i);
      if (qm) {
        qty = parseInt(qm[1], 10);
      } else {
     var dq = row.getAttribute('data-qty');
        if (dq && !isNaN(parseInt(dq, 10))) qty = parseInt(dq, 10);
      var inp = row.querySelector('input[type="number"]');
        if (inp && !isNaN(parseInt(inp.value, 10))) qty = parseInt(inp.value, 10);
      }
      var unitUSD = NaN;
      var unitEl = row.querySelector('.variation-price, .product-price, [class*="price"]');
      if (unitEl) {
        var txu = (unitEl.textContent || '').trim();
        if (!/bs|ves|vef/i.test(txu)) unitUSD = parsePrice(txu);
      }
    if (isNaN(unitUSD)) {
        var rx = /-?\d+[\.,]\d{1,2}/g, m;
        while ((m = rx.exec(text)) !== null) {
          var seg = text.slice(Math.max(0, m.index - 4), m.index + m[0].length + 3).toLowerCase();
         if (/bs|ves|vef/.test(seg)) continue;
        var before = text[m.index - 1];
        if (before === '+' || before === '-') continue;
        unitUSD = parsePrice(m[0]);
          if (!isNaN(unitUSD)) break;
        }
      }
         var addonUSD = 0;
      var rxAdd = /\+\s*(\d+[\.,]\d{1,2})/g, ma;
      while ((ma = rxAdd.exec(text)) !== null) {
        var seg2 = text.slice(Math.max(0, ma.index - 4), ma.index + ma[0].length + 3).toLowerCase();
        if (/bs|ves|vef/.test(seg2)) continue;
        var v = parsePrice(ma[1]);
        if (!isNaN(v)) addonUSD += v;
      }
      if (!isNaN(unitUSD)) pushCandidate(unitUSD * qty + addonUSD, 3);
    }
    if (!candidates.length) return NaN;
    candidates.sort(function (a, b) { return a.prio - b.prio; });
     return candidates[0].usd;
  }

  function decorateCart() {
    if (!FX.rate) {
      var c = findTotalsContainer();
      if (c) c.querySelectorAll('.csfx-total-row, .csfx-cart-row, [data-csfx]').forEach(function(n){ n.remove(); });
      return;
    }    var cartRows = document.querySelectorAll('app-cart .mat-list-item');
    var rows = cartRows.length ? cartRows : document.querySelectorAll('.mat-list-item');
    rows.forEach(function (r) {
      if (r.closest('app-pos-order-total, .total-sub')) {
        var leak = r.querySelector(':scope > .csfx-cart-row');
        if (leak) leak.remove();
        return;
      }
      var mark = r.querySelector(':scope > .csfx-cart-row[data-csfx="cart-bs"]');
      // Saltar únicamente la FILA de descuento global, no las líneas de producto con texto “de Descuento”
      if (r.classList && r.classList.contains('cart-discount')) {
        if (mark) mark.remove();
        return;
      }
      var usd = getLineUSD(r);
           var discounts = OPCompat.normalizeItemDiscounts ? OPCompat.normalizeItemDiscounts(r.dataset || {}) : [];
      if (discounts.length) {
        r.dataset.csfxDiscounts = discounts.join(',');
      }
      if (isNaN(usd)) {
        if (mark) mark.remove();
        return;
      }
     var bs = usd2bs(usd);
      if (!mark) {
           mark = document.createElement('span');
        mark.className = 'csfx-cart-row mat-line';
        mark.dataset.csfx = 'cart-bs';
        var sp = document.createElement('span');
        sp.className = 'csfx-amount';
     
        mark.appendChild(sp);
        r.appendChild(mark);

      }
        var sp2 = mark.querySelector('.csfx-amount');
      if (sp2) sp2.textContent = fmtBs(bs);
    });
        positionBadge();

  }

  function findTotalsContainer() {
    // footer/totales (suele vivir al final del panel derecho)
    // Intenta localizar el contenedor de totales. Abarcamos varios casos: componentes
    // Angular específicos, clases con "total" o "summary" y variantes de OpenPOS.
    return document.querySelector('app-pos-order-total, app-pos-order-summary, app-pos-summary, .total-sub, .op-total, .order-total, [class*="totals"], [class*="summary"], [class*="checkout-footer"], .openpos-summary');
  }
  function findTotalsRow(container, rx) {
    if (!container) return null;
    // incluir Angular Material y filas de tabla
    var rows = Array.prototype.slice.call(container.querySelectorAll('div,li,tr,mat-list-item,mat-row'));

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
       // Ignora cualquier fila/nodo inyectado por nosotros
      if (
        (row.dataset && row.dataset.csfx) ||
        (row.classList && (row.classList.contains('csfx-total-row') || row.classList.contains('csfx-cart-row'))) ||
        (row.closest && (row.closest('[data-csfx]') || row.closest('.csfx-total-row')))
      ) {
        continue;
      }
      // Preferir el elemento de título si existe
      var labelEl = row.querySelector('.total-title, [class*="total-title"], [class*="title"]');
      var label = labelEl || row.querySelector('span,div,b,strong,td') || row;
      var t = (label.textContent || '').trim().toLowerCase();
      if (!t) continue;
      if (rx.test(t)) return row;
    }
    return null;
  }
   // --- Helpers de anclaje y fallback ---
  function anchorRow(row) {
    if (!row) return null;

    var top = row.closest('li, .mat-list-item, tr, mat-list-item, mat-row');
    return top || row;
  }
  function readCheckoutUSD() {
    var btn = document.querySelector(
      '.op-cart-footer .btn.btn-success, .op-cart-footer .op-button-checkout,' +
      ' .op-footer button.btn-success, .op-footer .op-checkout'
    );
      if (!btn) return NaN;
      return parsePrice(btn.textContent);
    }
  // === Anclaje al checkout ===
  var ANCHOR_BTN_SELECTORS = [
    '.op-cart-footer .btn.btn-success',
    '.op-cart-footer .op-button-checkout',
    '.op-footer button.btn-success',
    '.op-footer .op-checkout',
    '.bottom-cart-total-container button',
    '.bottom-cart-total-container .btn-success',
    '.bottom-cart-total-container [role="button"]',
    'button[class*="success"]'
  ];
  var FOOTER_SELECTORS = [
    '.bottom-cart-total-container',
    '.op-cart-footer',
    '.op-footer',
    'footer[class*="cart"]'
  ];

  function pickVisibleRects(selectors){
    var nodes = Array.prototype.slice.call(document.querySelectorAll(selectors.join(', ')));
    return nodes.map(function(n){
      try{
        var cs = window.getComputedStyle(n);
        if (!cs || cs.display==='none' || cs.visibility==='hidden') return null;
        var r = n.getBoundingClientRect();
         if (r.width<=0 || r.height<=0) return null;
        return {n:n, r:r};
      }catch(_){ return null; }
    }).filter(Boolean);
   }

  function getCheckoutAnchorRect(){
    var btns = pickVisibleRects(ANCHOR_BTN_SELECTORS);
    var footers = pickVisibleRects(FOOTER_SELECTORS);
    var candidates = btns.concat(footers);
    if (!candidates.length) return null;
    candidates.sort(function(a,b){ return b.r.top - a.r.top; });
    return candidates[0].r;
  }

  function getCheckoutAreaHeight(){
    var areas = pickVisibleRects(FOOTER_SELECTORS);
    if (!areas.length) return 0;
    areas.sort(function(a,b){ return b.r.top - a.r.top; });
    return Math.round(areas[0].r.height);
  }

  // registrar scroll en contenedores típicos del layout (además de window)
  function attachScrollListeners(cb){
    var containers = document.querySelectorAll([
      'body','html',
      '.mat-sidenav-content','.mat-drawer-content','.mat-mdc-sidenav-content','.mat-mdc-drawer-content',
      '.pos-content','.op-container','.cdk-virtual-scroll-viewport'
    ].join(','));
    containers.forEach(function(c){
      try { c.addEventListener('scroll', cb, { passive:true }); } catch(_){ }
    });
  }

  // --- Posicionar badge pegado al botón (o footer) ---
  function positionBadge() {
    var badge = document.querySelector('.csfx-badge');
    if (!badge) return;
    var bottom = 96; // fallback
   try{
      var r = getCheckoutAnchorRect();
      var h = getCheckoutAreaHeight();
      var gap = r ? Math.max(0, Math.round(window.innerHeight - r.top)) : 0;
      bottom = Math.max(12, Math.max(gap, h) + 12);
    }catch(_){ }
    if (badge.style.bottom !== (bottom + 'px')) {
      badge.style.bottom = bottom + 'px';
    }
  }
  // exposed para reusar tras renders
  window.__csfx_positionBadge = positionBadge;
  // enganchar el posicionamiento del badge a eventos relevantes
  function initBadgePositioning() {
    positionBadge();
    window.addEventListener('load', positionBadge, { passive: true });
    window.addEventListener('resize', positionBadge, { passive: true });
    // reposicionar al desplazarse y cambio de orientación
    window.addEventListener('scroll', positionBadge, { passive: true });
    window.addEventListener('orientationchange', positionBadge, { passive: true });
        // scroll en contenedores internos (Angular/Material)
    attachScrollListeners(positionBadge);
    // observar cambios de DOM que puedan mover el botón
    var mo = new MutationObserver(function(){ positionBadge(); });
    mo.observe(document.body, { subtree:true, childList:true, attributes:true });
    // respaldo defensivo
    setInterval(positionBadge, 2000);
  }
  
  function decorateTotals() {



    var container = findTotalsContainer();
   // 1) Ocultar impuestos SIEMPRE si la opción está activa, aunque no haya tasa
    if (FX.hideTax && container) {
      var tax0 = findTotalsRow(container, /impuesto|tax/i);
      if (tax0) hideHard(anchorRow(tax0));
    }
    if (!FX.rate) {
      if (container) container.querySelectorAll('.csfx-total-row,[data-csfx]').forEach(function (n) { n.remove(); });
      return;
    }
    if (!container) return;
    if (!container.dataset.csfxPad) { container.style.paddingBottom = '64px'; container.dataset.csfxPad = '1'; }

    // 2) Con tasa válida, pintar Subtotal (Bs.) inline + Total Final (Bs.)

    container.querySelectorAll('.csfx-cart-row, .csfx-total-row[data-csfx="total-final"]').forEach(function (n) { n.remove(); });
    var subRow = findTotalsRow(container, /(^|\s)subtotal(\s|$)/i);

    var discRow = findTotalsRow(container, /descuento|discount/i);
    var taxRow = findTotalsRow(container, /impuesto|tax/i);
    var totRow = findTotalsRow(container, /^total(?!.*\(bs\))/i);


    var usdS = readUsdFromRow(subRow);
    var usdD = Math.abs(readUsdFromRow(discRow)) || 0;
    var usdI = readUsdFromRow(taxRow);
    var usdT = readUsdFromRow(totRow);

    
    if (isNaN(usdT) && !isNaN(usdS)) usdT = usdS - usdD + (isNaN(usdI) ? 0 : usdI);
    if (isNaN(usdT)) {
      var btnUsd = readCheckoutUSD();
      if (!isNaN(btnUsd)) usdT = btnUsd;
    }
  
    if (isNaN(usdS) && !isNaN(usdT)) usdS = usdT + usdD - (isNaN(usdI) ? 0 : usdI);
    if (isNaN(usdS)) {
      var btnUsd2 = readCheckoutUSD();
      if (!isNaN(btnUsd2)) usdS = btnUsd2 + usdD - usdI;
    }
   


    var legacy = container.querySelector('[data-csfx="summary-bs"]');
    if (legacy) legacy.remove();
    var subValEl = pickValueElement(subRow);
    if (subValEl) {
      var inline = subValEl.querySelector('[data-csfx="sub-bs-inline"]');
      if (!inline) {
        inline = document.createElement('div');
        inline.dataset.csfx = 'sub-bs-inline';
        inline.className = 'csfx-sub-bs-inline';
        subValEl.appendChild(inline);
      }
      if (!isNaN(usdS)) inline.textContent = fmtBs(usd2bs(usdS));
    }



    if (discRow) {
  
      var totA = anchorRow(totRow);
      if (totA) totA.remove();
      var after = anchorRow(discRow);
      var rowFinal = document.createElement('div');
      rowFinal.className = 'csfx-total-row';
      rowFinal.dataset.csfx = 'total-final';
      rowFinal.innerHTML = '<span>Total Final (Bs.)</span><span class="csfx-amount" data-csfx="tot-bs"></span>';
      if (after) after.insertAdjacentElement('afterend', rowFinal);
      var totSp = rowFinal.querySelector('[data-csfx="tot-bs"]');
 
      var usdFinal = !isNaN(usdS) ? (usdS - usdD + (isNaN(usdI) ? 0 : usdI)) : NaN;
      if (isNaN(usdFinal) && !isNaN(usdT)) usdFinal = usdT;

      if (isNaN(usdFinal)) {
        var b = readCheckoutUSD();
        if (!isNaN(b)) usdFinal = b;
      }
             if (totSp && !isNaN(usdFinal)) totSp.textContent = fmtBs(usd2bs(usdFinal));

    }
    if (!isNaN(usdS)) window.__CSFX_SUBTOTAL_USD = usdS;
    if (!isNaN(usdT)) window.__CSFX_TOTAL_USD = usdT;
    if (!isNaN(usdS) && isNaN(usdT)) window.__CSFX_TOTAL_USD = usdS - usdD + (isNaN(usdI) ? 0 : usdI);
    if (typeof window.__CSFX_TOTAL_USD === 'undefined' && !isNaN(readCheckoutUSD())) {
      window.__CSFX_TOTAL_USD = readCheckoutUSD();
    }
    positionBadge();

  }
  // --- Conversor de timestamps a Date robusto ---
  function parseUpdated(u){
    if (!u) return null;
    if (typeof u === 'number') {
      // epoch en segundos → milisegundos; si ya viene en ms, no multiplicar
      return new Date(u < 1e12 ? u * 1000 : u);
    }
    if (typeof u === 'string') {
      var d1 = new Date(u);
      if (!isNaN(d1.getTime())) return d1;
      var n = parseFloat(u);
      if (!isNaN(n)) return new Date(n < 1e12 ? n * 1000 : n);
    }
    return null;
  }

  function buildInfoText() {
    var t = '<strong>Tasa BCV:</strong> ' + (FX.rate ? FX.rate.toFixed(FX.decimals) : '(sin datos)');
    var d = parseUpdated(FX.updated);
    if (d) {
      var hh;
      try {
        hh = d.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', hour12: true });
      } catch (e) {
        hh = d.getHours() + ':' + ('' + d.getMinutes()).padStart(2, '0');
      }
      t += ' · <strong>Actualizado:</strong> ' + hh;
    }
    if (FX.disc && FX.disc.active && FX.disc.percent > 0) {
      t += ' · <strong>Desc:</strong> ' + FX.disc.percent + '%';
    }
    return t;
  }

  /**
   * Crea o actualiza la insignia (badge) colapsable que muestra la tasa y hora.
   * Si FX.badge es false, elimina cualquier badge existente.
   */
  function ensureBadge() {
    if (!FX.badge) {
      var old = document.querySelector('.csfx-badge');
      if (old) old.remove();
      return;
    }
    var badge = document.querySelector('.csfx-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'csfx-badge';
      var handle = document.createElement('div');
      handle.className = 'csfx-badge-handle';
      // texto del asa: puede ser un símbolo o abreviatura
      handle.textContent = '⚖';
      var content = document.createElement('div');
      content.className = 'csfx-badge-content';
      badge.appendChild(handle);
      badge.appendChild(content);
      handle.addEventListener('click', function (e) {
        badge.classList.toggle('open');
        if (badge.classList.contains('open')) {
          csfxRenderBadgeContent(badge);
        }
        e.stopPropagation();
      });
      document.body.appendChild(badge);
    }
    csfxRenderBadgeContent(badge);
  }


  /**
   * Decora el modal de método de pago, añadiendo chips Bs en el encabezado de pagado/total,
   * el campo de importe a pagar y los botones de sugerencia de importes. Se basa en la
   * presencia de role="dialog" o clases de Angular Material.
   */

  // csfx: inicio descuento dual
  function csfxDiscountDecimal() {
    var pct = Number(FX && FX.disc && FX.disc.percent ? FX.disc.percent : 0);
    if (!isFinite(pct)) pct = 0;
    if (pct > 1) pct = pct / 100;
    if (pct < 0) pct = 0;
    if (pct >= 0.995) pct = 0.995;
    return pct;
  }

  function csfxToNumber(val) {
    if (val === null || val === undefined || val === '') return NaN;
    if (typeof val === 'number') return val;
    if (typeof val === 'string') {
      var parsed = parsePrice(val);
      if (!isNaN(parsed)) return parsed;
      var sanitized = parseFloat(val.replace(/[^0-9\-\.,]/g, '').replace(/,/g, '.'));
      return isNaN(sanitized) ? NaN : sanitized;
    }
    if (typeof val === 'object' && val) {
      if (typeof val.value !== 'undefined') return csfxToNumber(val.value);
    }
    return NaN;
  }

  function csfxNormalizeCartCandidate(candidate) {
    if (!candidate) return null;
    if (typeof candidate === 'string') {
      try {
        var parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object') return csfxNormalizeCartCandidate(parsed);
      } catch (_err) {}
      return null;
    }
    if (typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    if (candidate.cart && typeof candidate.cart === 'object') return candidate.cart;
    if (candidate.cart_data && typeof candidate.cart_data === 'object') return candidate.cart_data;
    if (candidate.data && typeof candidate.data === 'object') return candidate.data;
    return candidate;
  }

  function csfxLocateCartDetailed() {
    var debug = { tried: [] };
    var svcRef = null;
    function attempt(value, source, serviceOverride) {
      var normalized = csfxNormalizeCartCandidate(value);
      debug.tried.push({
        source: source,
        hit: !!normalized,
        type: value == null ? String(value) : typeof value
      });
      if (normalized) {
        return {
          cart: normalized,
          source: source,
          debug: debug,
          cartService: serviceOverride || svcRef || null
        };
      }
      return null;
    }

    var svc = csfxGetCartService(debug);
    svcRef = svc;
    if (svc && typeof svc === 'object') {
      var svcCandidates = [];
      try {
        if (typeof svc.getCurrentCart === 'function') {
          var current = svc.getCurrentCart();
          if (current && typeof current.then === 'function') {
            debug.tried.push({ source: 'cartService.getCurrentCart()', hit: false, async: true });
          } else {
            svcCandidates.push({ value: current, source: 'cartService.getCurrentCart()' });
          }
        }
      } catch (errCurrent) {
        debug.tried.push({ source: 'cartService.getCurrentCart()', error: String(errCurrent) });
      }
      try {
        if (typeof svc.getCart === 'function') {
          var legacy = svc.getCart();
          if (legacy && typeof legacy.then === 'function') {
            debug.tried.push({ source: 'cartService.getCart()', hit: false, async: true });
          } else {
            svcCandidates.push({ value: legacy, source: 'cartService.getCart()' });
          }
        }
      } catch (errLegacy) {
        debug.tried.push({ source: 'cartService.getCart()', error: String(errLegacy) });
      }
      svcCandidates.push({ value: svc.cart, source: 'cartService.cart' });
      svcCandidates.push({ value: svc._cart, source: 'cartService._cart' });
      svcCandidates.push({ value: svc.cart_data, source: 'cartService.cart_data' });
      svcCandidates.push({ value: svc.cartData, source: 'cartService.cartData' });
      for (var c = 0; c < svcCandidates.length; c++) {
        var candidate = svcCandidates[c];
        if (!candidate) continue;
        var value = candidate.value;
        var source = candidate.source;
        var normalized = csfxNormalizeCartCandidate(value);
        debug.tried.push({
          source: source,
          hit: !!normalized,
          type: value == null ? String(value) : typeof value
        });
        if (normalized) {
          return {
            cart: normalized,
            source: source,
            debug: debug,
            cartService: svc
          };
        }
      }
    }

    var globalCandidates = [
      { value: window.OpenPOSApp && window.OpenPOSApp.cart, source: 'OpenPOSApp.cart', service: window.OpenPOSApp && window.OpenPOSApp.cartService },
      { value: window.OpenPOSApp && window.OpenPOSApp.activeCart, source: 'OpenPOSApp.activeCart', service: window.OpenPOSApp && window.OpenPOSApp.cartService },
      {
        value: window.OpenPOSApp && window.OpenPOSApp.cartService && window.OpenPOSApp.cartService.cart,
        source: 'OpenPOSApp.cartService.cart',
        service: window.OpenPOSApp && window.OpenPOSApp.cartService
      },
      { value: window.pos_cart && (window.pos_cart.cart || window.pos_cart), source: 'window.pos_cart', service: window.pos_cart && window.pos_cart.cartService },
      { value: window.posApp && (window.posApp.cart || (window.posApp.cartService && window.posApp.cartService.cart)), source: 'window.posApp', service: window.posApp && window.posApp.cartService },
      { value: window.POSApp && (window.POSApp.cart || (window.POSApp.cartService && window.POSApp.cartService.cart)), source: 'window.POSApp', service: window.POSApp && window.POSApp.cartService },
      { value: window.OPCart, source: 'window.OPCart' },
      { value: window.OPENPOS_CART, source: 'window.OPENPOS_CART' }
    ];
    for (var i = 0; i < globalCandidates.length; i++) {
      var gc = globalCandidates[i];
      var gcHit = attempt(gc.value, gc.source, gc.service);
      if (gcHit) return gcHit;
    }

    var storageKeys = ['op_cart', 'op_cache_cart', 'op_local_cart', '_op_cart_data', 'op_cart_data', 'op_cart_v8', 'op_v5_cart', 'op_cart_backup', 'op_cart_latest', 'op_cart_store'];
    for (var j = 0; j < storageKeys.length; j++) {
      try {
        var raw = localStorage.getItem(storageKeys[j]);
        if (!raw) {
          debug.tried.push({ source: 'localStorage.' + storageKeys[j], hit: false, empty: true });
          continue;
        }
        var parsed = JSON.parse(raw);
        var storageHit = attempt(parsed, 'localStorage.' + storageKeys[j]);
        if (storageHit) return storageHit;
      } catch (err) {
        debug.tried.push({ source: 'localStorage.' + storageKeys[j], error: String(err) });
      }
    }

    return { cart: null, source: null, debug: debug, cartService: svcRef };
  }

  function csfxLocateCart() {
    return csfxLocateCartDetailed().cart;
  }

  function csfxExtractMetaMap(cart) {
    var meta = {};
    function ingest(list) {
      if (!list || typeof list.forEach !== 'function') return;
      list.forEach(function (item) {
        if (!item) return;
        var key = item.key || item.name || item.code;
        if (!key) return;
        var value = typeof item.value !== 'undefined' ? item.value : (typeof item.val !== 'undefined' ? item.val : null);
        meta[key] = value;
      });
    }
    if (cart) {
      ingest(cart.meta_data);
      ingest(cart.metaData);
      ['csfx_usd_paid', 'csfx_discount_pct', 'csfx_discount_value', 'csfx_discount_note', 'csfx_base_total'].forEach(function (k) {
        if (typeof cart[k] !== 'undefined') meta[k] = cart[k];
      });
    }
    return meta;
  }

  function csfxGetCartSnapshot(context) {
    context = context || {};
    var located = csfxLocateCartDetailed();
    var cart = located.cart;
    var cartSource = located.source;
    var cartService = located.cartService;
    var cartDebug = located.debug && typeof located.debug === 'object' ? located.debug : {};

    if (cart && OPCompat && typeof OPCompat.normalizeCart === 'function') {
      try {
        cart = OPCompat.normalizeCart(cart);
        located.cart = cart;
      } catch (errNorm) {
        cartDebug.compatNormalizeError = (errNorm && errNorm.message) || true;
      }
    }

    var compatTotals = null;
    if (cart && OPCompat && typeof OPCompat.readTotals === 'function') {
      try {
        compatTotals = OPCompat.readTotals(cart) || null;
      } catch (errTotals) {
        cartDebug.compatTotalsError = (errTotals && errTotals.message) || true;
        compatTotals = null;
      }
    }
    cartDebug.compatTotals = compatTotals;
    cartDebug.cartSource = cartSource;
    cartDebug.totalsSource = compatTotals ? 'compat' : 'legacy';

    var meta = csfxExtractMetaMap(cart);

    var subtotalCandidates = [];
    var discountCandidates = [];
    var taxCandidates = [];
    var totalCandidates = [];

    if (compatTotals && typeof compatTotals === 'object') {
      subtotalCandidates.push(compatTotals.baseSubtotal, compatTotals.subtotal);
      discountCandidates.push(compatTotals.discount);
      taxCandidates.push(compatTotals.tax);
      totalCandidates.push(compatTotals.grand, compatTotals.total);
    }

    if (cart) {
      subtotalCandidates.push(cart.base_subtotal, cart.subtotal, cart.totals && cart.totals.base_subtotal, cart.totals && cart.totals.subtotal);
      discountCandidates.push(
        cart.final_discount_amount,
        cart.discount_final_amount,
        cart.discount_amount,
        cart.discount
      );
      taxCandidates.push(
        cart.totals && cart.totals.tax,
        cart.totals && cart.totals.tax_amount,
        cart.tax_amount,
        cart.total_tax
      );
      totalCandidates.push(
        cart.base_grand_total,
        cart.baseGrandTotal,
        cart.grand_total,
        cart.grandTotal,
        cart.total_due,
        cart.totalDue,
        cart.total
      );
    }

    if (typeof context.totalUSD !== 'undefined') {
      totalCandidates.push(context.totalUSD);
    }

    function pickCandidate(values, allowNegative) {
      for (var i = 0; i < values.length; i++) {
        var candidate = csfxToNumber(values[i]);
        if (isNaN(candidate)) continue;
        if (!allowNegative && candidate < 0) continue;
        return candidate;
      }
      return NaN;
    }

    var total = pickCandidate(totalCandidates, false);
    if (isNaN(total) && typeof window.__CSFX_TOTAL_USD !== 'undefined') {
      var gTotal = csfxToNumber(window.__CSFX_TOTAL_USD);
      if (!isNaN(gTotal)) total = gTotal;
    }

    var discountAmount = pickCandidate(discountCandidates, true);
    if (isNaN(discountAmount)) {
      discountAmount = 0;
    } else {
      discountAmount = Math.abs(discountAmount);
    }
    var discountValueMeta = csfxToNumber(meta.csfx_discount_value);
    if (!isNaN(discountValueMeta) && discountValueMeta > 0) {
      discountAmount = round(Math.abs(discountValueMeta), FX.decimals);
    }

    var baseTotal = pickCandidate([
      compatTotals && compatTotals.subtotal,
      compatTotals && compatTotals.baseSubtotal,
      meta && meta.csfx_base_total,
      cart && cart.base_subtotal,
      cart && cart.subtotal,
      cart && cart.totals && cart.totals.base_subtotal
    ], false);

    if (isNaN(baseTotal) || baseTotal <= 0) {
      var metaBase = csfxToNumber(meta.csfx_base_total);
      if (!isNaN(metaBase) && metaBase > 0) {
        baseTotal = metaBase;
      }
    }

    if ((isNaN(baseTotal) || baseTotal <= 0) && !isNaN(total)) {
      var taxAmount = pickCandidate(taxCandidates, true);
      var taxCalc = isNaN(taxAmount) ? 0 : taxAmount;
      baseTotal = total + discountAmount - taxCalc;
    }

    if ((isNaN(baseTotal) || baseTotal <= 0) && typeof window.__CSFX_SUBTOTAL_USD !== 'undefined') {
      var gBase = csfxToNumber(window.__CSFX_SUBTOTAL_USD);
      if (!isNaN(gBase) && gBase > 0) baseTotal = gBase;
    }
    if ((isNaN(baseTotal) || baseTotal <= 0) && !isNaN(total)) {
      baseTotal = total;
    }

    var usdPaid = csfxToNumber(meta.csfx_usd_paid);
    var discountPctMeta = meta.csfx_discount_pct != null ? Number(meta.csfx_discount_pct) : null;
    var applied = Math.abs(discountAmount) > 0.0001;

    return {
      cart: cart,
      cartService: cartService,
      cartSource: cartSource,
      cartDebug: cartDebug,
      meta: meta,
      totalUSD: isNaN(total) ? NaN : total,
      baseTotalUSD: isNaN(baseTotal) ? NaN : baseTotal,
      discountAmount: discountAmount,
      usdPaid: isNaN(usdPaid) ? 0 : usdPaid,
      discountPct: discountPctMeta,
      applied: applied
    };
  }

  function csfxComputeDual(baseTotal, usdNet, pct) {
    pct = pct || 0;
    if (!isFinite(baseTotal) || baseTotal <= 0) {
      return {
        netRequested: usdNet,
        netEffective: 0,
        grossCovered: 0,
        discount: 0,
        remainderUsd: 0,
        remainderBs: 0,
        trimmed: false,
        finalTotal: 0
      };
    }
    if (!isFinite(usdNet) || usdNet < 0) usdNet = 0;
    if (pct < 0) pct = 0;
    if (pct >= 0.995) pct = 0.995;
    var maxNet = baseTotal * (1 - pct);
    if (!isFinite(maxNet) || maxNet < 0) maxNet = 0;
    var effectiveNet = usdNet;
    if (effectiveNet > maxNet) effectiveNet = maxNet;
    var grossCovered = pct >= 0.999 ? effectiveNet : (effectiveNet === 0 ? 0 : effectiveNet / (1 - pct));
    if (!isFinite(grossCovered)) grossCovered = 0;
    if (grossCovered > baseTotal) grossCovered = baseTotal;
    var discount = grossCovered - effectiveNet;
    if (!isFinite(discount) || discount < 0) discount = 0;
    var remainderUsd = baseTotal - grossCovered;
    if (!isFinite(remainderUsd) || remainderUsd < 0) remainderUsd = 0;
    var finalTotal = baseTotal - discount;
    if (!isFinite(finalTotal) || finalTotal < 0) finalTotal = 0;
    return {
      netRequested: usdNet,
      netEffective: effectiveNet,
      grossCovered: grossCovered,
      discount: discount,
      remainderUsd: remainderUsd,
      remainderBs: usd2bs(remainderUsd),
      trimmed: usdNet > effectiveNet + 0.009,
      finalTotal: finalTotal
    };
  }

  function csfxSanitizeMetaList(list) {
    if (!list || typeof list.filter !== 'function') return [];
    return list.filter(function (item) {
      if (!item) return false;
      var key = item.key || item.name || item.code;
      return key ? key.indexOf('csfx_') !== 0 : true;
    });
  }

  var csfxCachedCartService = null;

  function csfxLooksLikeCartService(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (obj === window || obj === document) return false;
    var hasStoreName = obj.storeName === 'cart';
    var fnCount = 0;
    ['saveCart', 'updateTotals', 'clearCart', 'getCurrentCart'].forEach(function (fn) {
      if (typeof obj[fn] === 'function') fnCount++;
    });
    return hasStoreName || fnCount >= 2;
  }

  function csfxFindCartServiceViaNg(debugSvc) {
    var selectors = ['app-root', 'pos-root', 'openpos-root', '[ng-version]'];
    var roots = [];
    selectors.forEach(function (sel) {
      var node = document.querySelector(sel);
      if (node && roots.indexOf(node) === -1) roots.push(node);
    });
    document.querySelectorAll('[ng-version]').forEach(function (node) {
      if (roots.indexOf(node) === -1) roots.push(node);
    });

    if (typeof window !== 'undefined' && window.ng && typeof window.ng.getInjector === 'function') {
      for (var s = 0; s < roots.length; s++) {
        var rootEl = roots[s];
        if (!rootEl) continue;
        try {
          var injector = window.ng.getInjector(rootEl);
          if (!injector) continue;
          var svc = null;
          if (typeof injector.get === 'function') {
            try { svc = injector.get('CartService'); } catch (_errToken) {}
            if (!svc && typeof window.CartService !== 'undefined') {
              try { svc = injector.get(window.CartService); } catch (_errClass) {}
            }
          }
          if (svc && csfxLooksLikeCartService(svc)) {
            if (debugSvc) {
              debugSvc.ngHit = {
                via: 'ng.getInjector',
                node: rootEl.tagName,
                className: svc.constructor && svc.constructor.name
              };
            }
            return svc;
          }
        } catch (_errInjector) {}
      }
    }

    var visited = new Set();
    var queue = [];
    roots.forEach(function (node) {
      if (node && node.__ngContext__) {
        queue.push({ ctx: node.__ngContext__, node: node });
      }
    });
    if (queue.length === 0) {
      document.querySelectorAll('*').forEach(function (node) {
        if (node && node.__ngContext__ && !visited.has(node.__ngContext__)) {
          queue.push({ ctx: node.__ngContext__, node: node });
        }
      });
    } else {
      document.querySelectorAll('*').forEach(function (node) {
        if (node && node.__ngContext__ && !visited.has(node.__ngContext__)) {
          queue.push({ ctx: node.__ngContext__, node: node });
        }
      });
    }
    var iterations = 0;
    while (queue.length && iterations < 1200) {
      iterations++;
      var entry = queue.shift();
      var ctx = entry && entry.ctx;
      if (!ctx || visited.has(ctx)) continue;
      visited.add(ctx);
      for (var i = 0; i < ctx.length; i++) {
        var slot = ctx[i];
        if (!slot || typeof slot !== 'object') continue;
        if (typeof Node !== 'undefined' && slot instanceof Node) continue;
        if (csfxLooksLikeCartService(slot)) {
          if (debugSvc) {
            debugSvc.ngHit = {
              via: 'context',
              node: entry.node && entry.node.tagName,
              ctxIndex: i,
              className: slot.constructor && slot.constructor.name
            };
          }
          return slot;
        }
        if (slot.cartService && csfxLooksLikeCartService(slot.cartService)) {
          if (debugSvc) {
            debugSvc.ngHit = {
              via: 'component.cartService',
              node: entry.node && entry.node.tagName,
              ctxIndex: i,
              className: slot.constructor && slot.constructor.name
            };
          }
          return slot.cartService;
        }
        if (slot.__ngContext__ && !visited.has(slot.__ngContext__)) {
          queue.push({ ctx: slot.__ngContext__, node: entry.node });
        }
      }
      var tail = ctx[ctx.length - 1];
      if (Array.isArray(tail) && !visited.has(tail)) {
        queue.push({ ctx: tail, node: entry.node });
      }
      if (ctx.length > 8 && Array.isArray(ctx[8]) && !visited.has(ctx[8])) {
        queue.push({ ctx: ctx[8], node: entry.node });
      }
    }
    if (debugSvc) {
      debugSvc.ngScan = {
        visited: visited.size,
        iterations: iterations,
        queueLength: queue.length
      };
    }
    return null;
  }

  function csfxGetCartService(debug) {
    var svcDebug = debug.cartService = { attempts: [] };
    function record(source, svc, ok) {
      svcDebug.attempts.push({
        source: source,
        ok: !!ok,
        type: svc == null ? String(svc) : typeof svc
      });
    }
    function consider(svc, source) {
      if (!svc) {
        record(source, svc, false);
        return null;
      }
      if (csfxLooksLikeCartService(svc)) {
        csfxCachedCartService = svc;
        try { if (typeof window !== 'undefined') window.__CSFX_CART_SERVICE__ = svc; } catch (_err) {}
        record(source, svc, true);
        return svc;
      }
      record(source, svc, false);
      return null;
    }

    if (csfxCachedCartService && csfxLooksLikeCartService(csfxCachedCartService)) {
      record('cache', csfxCachedCartService, true);
      return csfxCachedCartService;
    }

    try {
      if (typeof window !== 'undefined' && window.__CSFX_CART_SERVICE__) {
        var cached = consider(window.__CSFX_CART_SERVICE__, 'window.__CSFX_CART_SERVICE__');
        if (cached) return cached;
      }
    } catch (_err2) {}

    var globalNames = [
      'OpenPOSApp', 'OpenposApp', 'openposApp', 'OpenPOSAPP',
      'POSApp', 'posApp', 'posapp', 'POSAPP', 'pos_app',
      'OPApp', 'openposapp', 'openposAppService', 'OpenPosApp',
      'posAppService', 'OpenPOSAppService', 'OpenPosAppService'
    ];
    for (var g = 0; g < globalNames.length; g++) {
      var name = globalNames[g];
      var host = null;
      try { host = typeof window !== 'undefined' ? window[name] : null; } catch (_errHost) { host = null; }
      if (!host) continue;
      var svcHost = consider(host, 'window.' + name);
      if (svcHost) return svcHost;
      if (typeof host.cartService !== 'undefined') {
        var svcChild = consider(host.cartService, 'window.' + name + '.cartService');
        if (svcChild) return svcChild;
      }
    }

    try {
      if (typeof window !== 'undefined' && window.global && typeof window.global === 'object') {
        var globalSvc = consider(window.global.cartService, 'global.cartService');
        if (globalSvc) return globalSvc;
      }
    } catch (_err3) {}

    var viaNg = csfxFindCartServiceViaNg(svcDebug);
    if (viaNg) {
      return consider(viaNg, 'ngContext');
    }
    return null;
  }

  function csfxDualLog(stage, detail) {
    var payload = detail && typeof detail === 'object' ? Object.assign({}, detail) : {};
    payload.stage = stage;
    payload.time = new Date().toISOString();
    try {
      if (window.console) {
        var label = '[csfx][dual] ' + stage;
        if (typeof console.groupCollapsed === 'function') {
          console.groupCollapsed(label);
          if (payload) console.log(payload);
          console.groupEnd();
        } else if (typeof console.info === 'function') {
          console.info(label, payload);
        } else if (typeof console.log === 'function') {
          console.log(label, payload);
        }
      }
    } catch (_err) {}
    try {
      document.dispatchEvent(new CustomEvent('csfx:dual-debug', {
        detail: payload
      }));
    } catch (_err2) {}
  }

  function csfxUpsertMeta(list, key, value) {
    if (!key) return Array.isArray(list) ? list : [];
    var arr = Array.isArray(list) ? list : [];
    var found = false;
    for (var i = 0; i < arr.length; i++) {
      var item = arr[i];
      if (!item) continue;
      var itemKey = item.key || item.name || item.code;
      if (itemKey === key) {
        arr[i] = Object.assign({}, item, { key: key, value: value });
        found = true;
        break;
      }
    }
    if (!found) arr.push({ key: key, value: value });
    return arr;
  }

  // csfx: aplica descuento manual nativo OpenPOS sobre el cart
  function csfxApplyManualCartDiscount(cart, discountValue, svcCandidate) {
    var d = round(Math.max(0, Number(discountValue) || 0), FX.decimals);
    if (!isFinite(d) || d <= 0) return { ok: false };

    cart = cart && typeof cart === 'object' ? cart : {};
    var via = 'fallback';
    var svc = svcCandidate && typeof svcCandidate === 'object' ? svcCandidate : null;
    var nativeError = null;

    if (!svc) {
      try {
        var svcDebugTmp = { cartService: { attempts: [] } };
        svc = csfxGetCartService(svcDebugTmp);
        if (svc && typeof window !== 'undefined') {
          window.__CSFX_CART_SERVICE__ = svc;
        }
      } catch (_svcErr) {
        svc = null;
      }
    }

    if (svc && typeof svc.setDiscount === 'function' && typeof svc._initCartTotal === 'function') {
      try {
        svc.setDiscount(d, 'fixed');
        var activeCart = null;
        if (typeof svc.getCurrentCart === 'function') {
          activeCart = svc.getCurrentCart();
        } else if (svc.cart) {
          activeCart = svc.cart;
        }
        if (activeCart && typeof activeCart === 'object') {
          cart = activeCart;
        }
        if (cart) {
          cart.discount_source = '';
          cart.discountSource = '';
        }
        svc._initCartTotal();
        if (typeof svc.updateTotals === 'function') svc.updateTotals();
        if (typeof svc.saveCart === 'function') svc.saveCart();
        via = 'native';
      } catch (errNative) {
        nativeError = errNative;
        via = 'native-error';
      }
    }

    if (via !== 'native' && OPCompat && typeof OPCompat.applyManualCartDiscount === 'function') {
      try {
        OPCompat.applyManualCartDiscount(cart, d, 'csfx');
        via = via === 'native-error' ? 'compat-after-native-error' : 'compat';
      } catch (_errCompat) {
        via = via === 'native-error' ? 'compat-failed-native-error' : via;
      }
    }

    if (via !== 'native' && via !== 'compat' && via !== 'compat-after-native-error') {
      if (!cart.totals || typeof cart.totals !== 'object') cart.totals = {};
      var codeAmt = round(Math.max(0, Number(cart.discount_code_amount || 0)), FX.decimals);
      var itemsAmt = round(Math.max(0, Number(cart.final_items_discount_amount || 0)), FX.decimals);
      var combined = round(codeAmt + itemsAmt + d, FX.decimals);
      cart.discount_source = 'csfx';
      cart.discount_type = 'fixed';
      cart.discount_amount = d;
      cart.discount_final_amount = d;
      cart.discount_tax_amount = 0;
      cart.discount_excl_tax = d;
      cart.cart_discount_amount = d;
      cart.discount_code_amount = codeAmt;
      cart.final_items_discount_amount = itemsAmt;
      cart.final_discount_amount = combined;
      cart.final_discount_amount_incl_tax = cart.final_discount_amount;
      cart.add_discount = true;
      cart.discountSource = cart.discount_source;
      cart.discountType = cart.discount_type;
      cart.discountAmount = cart.discount_amount;
      cart.discountFinalAmount = cart.discount_final_amount;
      cart.discountTaxAmount = cart.discount_tax_amount;
      cart.discountExclTax = cart.discount_excl_tax;
      cart.cartDiscountAmount = cart.cart_discount_amount;
      cart.discountCodeAmount = cart.discount_code_amount;
      cart.finalItemsDiscountAmount = cart.final_items_discount_amount;
      cart.finalDiscountAmount = cart.final_discount_amount;
      cart.finalDiscountAmountInclTax = cart.final_discount_amount_incl_tax;
      cart.addDiscount = true;
      cart.totals.discount = combined;
      cart.totals.discountAmount = combined;
      cart.totals.final_discount_amount = combined;
      cart.totals.finalDiscountAmount = combined;
      via = (via === 'compat-failed-native-error') ? 'fallback-after-errors' : 'fallback';
    }

    if (OPCompat && typeof OPCompat.normalizeCart === 'function') {
      try { OPCompat.normalizeCart(cart); } catch (_errNorm) {}
    }

    if (typeof fmtUsd === 'function') {
      var discAmt = Number(cart.discount_amount || d);
      var finalAmt = Number(cart.final_discount_amount || discAmt);
      cart.discount_amount_currency_formatted = fmtUsd(discAmt);
      cart.discount_final_amount_currency_formatted = fmtUsd(discAmt);
      cart.final_discount_amount_currency_formatted = fmtUsd(finalAmt);
    }

    return { ok: true, amount: d, via: via, cart: cart, service: svc || null, nativeError: nativeError };
  }

  function csfxPersistCart(cart) {
    var snapshot = {
      discount_amount: cart.discount_amount,
      final_discount_amount: cart.final_discount_amount,
      final_discount_amount_incl_tax: cart.final_discount_amount_incl_tax,
      grand_total: cart.grand_total,
      base_grand_total: cart.base_grand_total,
      total: cart.total,
      total_due: cart.total_due,
      meta_data: cart.meta_data,
      csfx_usd_paid: cart.csfx_usd_paid,
      csfx_discount_pct: cart.csfx_discount_pct,
      csfx_discount_value: cart.csfx_discount_value,
      csfx_base_total: cart.csfx_base_total
    };
    var keys = ['op_cart', 'op_cache_cart', 'op_local_cart'];
    for (var k = 0; k < keys.length; k++) {
      try {
        var raw = localStorage.getItem(keys[k]);
        if (!raw) continue;
        var stored = JSON.parse(raw);
        if (!stored || typeof stored !== 'object') continue;
        Object.keys(snapshot).forEach(function (prop) {
          if (typeof snapshot[prop] !== 'undefined') stored[prop] = snapshot[prop];
        });
        localStorage.setItem(keys[k], JSON.stringify(stored));
      } catch (_err) {}
    }
    persistFxOfflineState({
      rate: FX.rate,
      updated: FX.updated,
      disc: FX.disc
    });
  }

  function csfxApplyDualDiscount(snapshot, calc) {
    var cart = snapshot.cart;
    if (!cart) {
      csfxDualLog('apply:no-cart', {
        cartSource: snapshot.cartSource,
        cartDebug: snapshot.cartDebug
      });
      return false;
    }
    var baseTotal = round(snapshot.baseTotalUSD, FX.decimals);
    if (!baseTotal || !isFinite(baseTotal)) {
      csfxDualLog('apply:no-base-total', {
        baseTotal: snapshot.baseTotalUSD,
        totalUSD: snapshot.totalUSD,
        discountAmount: snapshot.discountAmount
      });
      return false;
    }
    csfxDualLog('apply:start', {
      baseTotal: baseTotal,
      calc: calc,
      snapshotTotal: snapshot.totalUSD,
      existingDiscount: cart.discount_amount,
      existingFinalDiscount: cart.final_discount_amount,
      hasService: !!snapshot.cartService,
      cartSource: snapshot.cartSource
    });
    var manualRes = csfxApplyManualCartDiscount(cart, calc && calc.discount, snapshot.cartService);
    if (!manualRes.ok) {
      csfxDualLog('apply:manual-failed', {
        requestedDiscount: calc && calc.discount,
        cartDiscountAmount: cart && cart.discount_amount
      });
      return false;
    }
    if (manualRes.cart && typeof manualRes.cart === 'object') {
      cart = manualRes.cart;
    }
    var discountValue = manualRes.amount;
    if (snapshot.cartDebug && typeof snapshot.cartDebug === 'object') {
      snapshot.cartDebug.manualVia = manualRes.via;
    }
    csfxDualLog('apply:manual', {
      manual: {
        via: manualRes.via,
        nativeError: manualRes.nativeError ? (manualRes.nativeError.message || String(manualRes.nativeError)) : null
      },
      cartDiscountAmount: cart.discount_amount,
      cartFinalDiscountAmount: cart.final_discount_amount,
      manualVia: manualRes.via
    });
    if (OPCompat && typeof OPCompat.normalizeCart === 'function') {
      try { OPCompat.normalizeCart(cart); } catch (_errNormAfterManual) {}
    }
    var metaListBase = cart.meta_data || cart.metaData;
    var metaList = csfxSanitizeMetaList(metaListBase && metaListBase.slice ? metaListBase.slice() : metaListBase);
    var usdPaidRounded = round(calc.netEffective, FX.decimals);
    var pctStored = Number(FX && FX.disc && FX.disc.percent ? FX.disc.percent : 0);
    var pctDisplay = pctStored;
    if (pctDisplay > 0 && pctDisplay < 1) pctDisplay = pctDisplay * 100;
    var pctRounded = round(pctDisplay, 2);
    var note = 'Descuento dual del ' + pctRounded.toFixed(2) + '% aplicado sobre ' + fmtUsd(calc.grossCovered) + ', cliente pagó ' + fmtUsd(calc.netEffective) + ' en divisas.';
    metaList = csfxUpsertMeta(metaList, 'csfx_usd_paid', usdPaidRounded);
    metaList = csfxUpsertMeta(metaList, 'csfx_discount_pct', pctStored);
    metaList = csfxUpsertMeta(metaList, 'csfx_discount_value', discountValue);
    metaList = csfxUpsertMeta(metaList, 'csfx_base_total', baseTotal);
    metaList = csfxUpsertMeta(metaList, 'csfx_discount_note', note);
    cart.meta_data = metaList;
    cart.metaData = metaList;
    cart.csfx_usd_paid = usdPaidRounded;
    cart.csfx_discount_pct = pctStored;
    cart.csfx_discount_value = discountValue;
    cart.csfx_base_total = baseTotal;
    cart.csfx_discount_note = note;
    csfxDualLog('apply:meta', {
      discountValue: discountValue,
      pctStored: pctStored,
      meta: metaList,
      cartSummary: {
        discount_amount: cart.discount_amount,
        final_discount_amount: cart.final_discount_amount,
        grand_total: cart.grand_total,
        total: cart.total,
        total_due: cart.total_due,
        add_discount: cart.add_discount
      }
    });
    // csfx: sincroniza con el servicio de OpenPOS para refrescar UI y modo offline
    try {
      var svc = manualRes.service || snapshot.cartService;
      if ((!svc || typeof svc !== 'object') && typeof csfxCachedCartService !== 'undefined' && csfxCachedCartService) {
        svc = csfxCachedCartService;
      }
      if ((!svc || typeof svc !== 'object') && window.OpenPOSApp && OpenPOSApp.cartService) {
        svc = OpenPOSApp.cartService;
      }
      if (svc && typeof window !== 'undefined') {
        try { window.__CSFX_CART_SERVICE__ = svc; } catch (_errExposeSvc) {}
      }
      if (svc && typeof svc === 'object') {
        var usedNative = manualRes.via === 'native';
        var nativeError = manualRes.nativeError ? (manualRes.nativeError.message || String(manualRes.nativeError)) : null;
        if (!usedNative && typeof svc.setCart === 'function') {
          try { svc.setCart(cart); } catch (_errSet) {}
        }
        if (svc.cart) {
          svc.cart.meta_data = metaList;
          svc.cart.metaData = metaList;
          svc.cart.csfx_usd_paid = usdPaidRounded;
          svc.cart.csfx_discount_pct = pctStored;
          svc.cart.csfx_discount_value = discountValue;
          svc.cart.csfx_base_total = baseTotal;
          svc.cart.csfx_discount_note = note;
          svc.cart.final_discount_amount_incl_tax = cart.final_discount_amount_incl_tax;
          svc.cart.finalDiscountAmountInclTax = cart.final_discount_amount_incl_tax;
          if (usedNative) {
            svc.cart.discount_source = '';
            svc.cart.discountSource = '';
          }
        }
        if (!usedNative && typeof svc._initCartTotal === 'function') {
          try { svc._initCartTotal(); } catch (_errInitFinal) {}
        }
        if (typeof svc.updateTotals === 'function') svc.updateTotals();
        if (typeof svc.saveCart === 'function') svc.saveCart();
        csfxDualLog('apply:service', {
          usedNative: usedNative,
          nativeError: nativeError ? (nativeError.message || true) : null,
          hasSetCart: typeof svc.setCart === 'function',
          hasUpdateTotals: typeof svc.updateTotals === 'function',
          hasSaveCart: typeof svc.saveCart === 'function',
          serviceDetected: !!svc,
          cartSource: snapshot.cartSource,
          manualVia: manualRes.via
        });
      }
    } catch (_err) {}
    csfxPersistCart(cart);
    csfxDualLog('apply:finished', {
      discountValue: discountValue,
      finalDiscountAmount: cart.final_discount_amount,
      finalDiscountAmountInclTax: cart.final_discount_amount_incl_tax
    });
    try {
      document.dispatchEvent(new CustomEvent('csfx:dual-discount-applied', {
        detail: {
          usdNet: calc.netEffective,
          discount: discountValue,
          pct: Number(FX.disc.percent),
          remainderUsd: calc.remainderUsd
        }
      }));
      document.dispatchEvent(new CustomEvent('csfx:cart-updated'));
    } catch (_err) {}
    return true;
  }

  function csfxRenderBadgeContent(badge) {
    if (!badge) return;
    var contentDiv = badge.querySelector('.csfx-badge-content');
    if (!contentDiv) return;
    var infoRow = contentDiv.querySelector('.csfx-badge-info');
    if (!infoRow) {
      infoRow = document.createElement('div');
      infoRow.className = 'csfx-badge-info';
      contentDiv.appendChild(infoRow);
    }
    infoRow.innerHTML = buildInfoText();
    var panel = contentDiv.querySelector('[data-csfx="dual-panel"]');
    var justCreated = false;
    if (!panel) {
      panel = csfxRenderDualPanel(contentDiv);
      justCreated = !!panel;
    } else {
      csfxUpdateDualPanel(panel);
    }
    if (justCreated && panel) {
      setTimeout(function(){
        var firstInput = panel.querySelector('input[data-csfx="usd-net"]');
        if (firstInput) {
          try {
            firstInput.focus();
            firstInput.select();
          } catch (_err) {}
        }
      }, 80);
    }
  }

  function csfxRenderDualPanel(container) {
    if (!container) return null;
    var existingPanel = container.querySelector('[data-csfx="dual-panel"]');
    if (existingPanel) {
      csfxUpdateDualPanel(existingPanel);
      return existingPanel;
    }
    container.querySelectorAll('[data-csfx="dual-panel"]').forEach(function (node) {
      if (node && node.parentNode) node.parentNode.removeChild(node);
    });
    container.querySelectorAll('.csfx-dual-note').forEach(function (node) {
      if (node && node.parentNode) node.parentNode.removeChild(node);
    });
    var pct = csfxDiscountDecimal();
    if (!FX.disc || !FX.disc.active || !pct) {
      var note = document.createElement('div');
      note.className = 'csfx-dual-note';
      note.textContent = 'Descuento inactivo. Configura un porcentaje en Conf Tavox.';
      container.appendChild(note);
      return null;
    }
    var panel = document.createElement('div');
    panel.className = 'csfx-dual-box';
    panel.dataset.csfx = 'dual-panel';
    container.appendChild(panel);

    var title = document.createElement('h4');
    title.textContent = 'Descuento precio dual';
    panel.appendChild(title);

    var grid = document.createElement('div');
    grid.className = 'csfx-dual-grid';
    grid.innerHTML = ''
      + '<span>Total sin descuento</span><strong data-csfx="total-base">—</strong>'
      + '<span>Total con descuento</span><strong data-csfx="total-full">—</strong>';
    panel.appendChild(grid);

    var inputWrap = document.createElement('div');
    inputWrap.className = 'csfx-dual-input';
    var label = document.createElement('span');
    label.textContent = 'Pago en divisas (USD neto)';
    var input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = '0.01';
    input.placeholder = '0.00';
    input.dataset.csfx = 'usd-net';
    inputWrap.appendChild(label);
    inputWrap.appendChild(input);
    panel.appendChild(inputWrap);
    input.value = '';
    input.autocomplete = 'off';
    input.inputMode = 'decimal';
    input.pattern = '[0-9]*[.,]?[0-9]*';
    input.disabled = false;
    input.removeAttribute('disabled');
    input.readOnly = false;
    input.removeAttribute('readonly');
    input.tabIndex = 0;
    ['keydown','keypress','keyup','wheel','focus','blur','mousedown','mouseup','click','touchstart'].forEach(function(evt){
      input.addEventListener(evt, function(e){ e.stopPropagation(); }, true);
      input.addEventListener(evt, function(e){ e.stopPropagation(); });
    });

    var chipsWrap = document.createElement('div');
    chipsWrap.className = 'csfx-dual-chips';
    [
      { key: 'gross', label: 'Parte bruta' },
      { key: 'discount', label: 'Descuento' },
      { key: 'remaining-usd', label: 'Resta USD' },
      { key: 'remaining-bs', label: 'Resta Bs.' }
    ].forEach(function (info) {
      var chip = document.createElement('span');
      chip.className = 'csfx-chip csfx-chip-pill';
      chip.dataset.csfxChip = info.key;
      chip.textContent = info.label + ': —';
      chipsWrap.appendChild(chip);
    });
    panel.appendChild(chipsWrap);

    var actions = document.createElement('div');
    actions.className = 'csfx-dual-actions';
    var confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'btn btn-primary btn-sm';
    confirm.dataset.csfx = 'confirm';
    confirm.textContent = 'Confirmar descuento';
    actions.appendChild(confirm);
    panel.appendChild(actions);

    var status = document.createElement('div');
    status.className = 'csfx-dual-status';
    status.dataset.csfx = 'status';
    panel.appendChild(status);

    input.addEventListener('input', function (ev) {
      if (this.value && typeof this.value === 'string' && this.value.indexOf(',') > -1) {
        var pos = this.selectionStart;
        this.value = this.value.replace(',', '.');
        if (typeof pos === 'number') {
          this.setSelectionRange(pos, pos);
        }
      }
      ev.stopPropagation();
      panel.dataset.csfxDirty = '1';
      input.dataset.csfxTouched = '1';
      csfxUpdateDualPanel(panel);
    });
    confirm.addEventListener('click', function () { csfxHandleDualConfirm(panel); });

    csfxUpdateDualPanel(panel);
    return panel;
  }

  function csfxResetDualChips(panel) {
    panel.querySelectorAll('[data-csfx-chip]').forEach(function (chip) {
      var label = chip.textContent.split(':')[0];
      chip.textContent = label + ': —';
      chip.classList.remove('csfx-chip-pill--ok', 'csfx-chip-pill--warn', 'csfx-chip-pill--alert');
    });
  }

  function csfxUpdateDualPanel(panel) {
    if (!panel) return;
    var pct = csfxDiscountDecimal();
    var snapshot = csfxGetCartSnapshot({ totalUSD: readCheckoutUSD() });
    var baseTotal = snapshot.baseTotalUSD;
    panel.dataset.csfxPct = pct ? String(pct) : '';
    panel.dataset.csfxBase = isFinite(baseTotal) ? String(baseTotal) : '';
    panel.dataset.csfxTotal = isFinite(snapshot.totalUSD) ? String(snapshot.totalUSD) : '';

    var baseEl = panel.querySelector('[data-csfx="total-base"]');
    var fullEl = panel.querySelector('[data-csfx="total-full"]');
    if (baseEl) baseEl.textContent = isFinite(baseTotal) ? fmtUsd(baseTotal) : '—';
    if (fullEl) fullEl.textContent = (isFinite(baseTotal) && pct)
      ? fmtUsd(baseTotal * (1 - pct))
      : '—';

    var input = panel.querySelector('input[data-csfx="usd-net"]');
    var status = panel.querySelector('[data-csfx="status"]');
    if (input && !panel.dataset.csfxDirty) {
      if (snapshot.usdPaid) {
        input.value = round(snapshot.usdPaid, FX.decimals).toFixed(FX.decimals);
      } else if (!input.dataset.csfxTouched) {
        input.value = '';
      }
    }

    if (!isFinite(baseTotal) || baseTotal <= 0) {
      if (status) {
        status.textContent = 'Sin total disponible para calcular descuento.';
        status.className = 'csfx-dual-status csfx-dual-status--warn';
      }
      csfxResetDualChips(panel);
    return;
    }

    var rawValue = input ? String(input.value || '').replace(',', '.') : '0';
    var usdNet = parseFloat(rawValue);
    if (!isFinite(usdNet) || usdNet <= 0) {
      csfxResetDualChips(panel);
      if (status) {
        status.textContent = 'Introduce el pago neto en divisas para estimar.';
        status.className = 'csfx-dual-status';
      }
      return;
    }

    var calc = csfxComputeDual(baseTotal, usdNet, pct);
    panel.dataset.csfxCalcNet = calc.netEffective || '';
    panel.dataset.csfxCalcDiscount = calc.discount || '';
    panel.dataset.csfxCalcGross = calc.grossCovered || '';
    panel.dataset.csfxCalcRemainder = calc.remainderUsd || '';

    var chipsText = {
      'gross': 'Parte bruta: ' + fmtUsd(calc.grossCovered),
      'discount': 'Descuento: ' + fmtUsd(calc.discount),
      'remaining-usd': 'Resta USD: ' + fmtUsd(calc.remainderUsd),
      'remaining-bs': 'Resta Bs: ' + fmtBs(calc.remainderBs)
    };

    panel.querySelectorAll('[data-csfx-chip]').forEach(function (chip) {
      var key = chip.dataset.csfxChip;
      if (chipsText[key]) chip.textContent = chipsText[key];
      chip.classList.remove('csfx-chip-pill--ok', 'csfx-chip-pill--warn', 'csfx-chip-pill--alert');
      if (key === 'discount' && calc.discount > 0.009) {
        chip.classList.add('csfx-chip-pill--ok');
      }
      if ((key === 'remaining-usd' || key === 'remaining-bs') && calc.remainderUsd > 0.009) {
        chip.classList.add('csfx-chip-pill--warn');
      }
    });

    if (status) {
      if (calc.discount > 0.009) {
        status.textContent = 'Descuento estimado: ' + fmtUsd(calc.discount);
        status.className = 'csfx-dual-status csfx-dual-status--info';
      } else {
        status.textContent = 'Con este monto no se genera descuento.';
        status.className = 'csfx-dual-status csfx-dual-status--warn';
      }
    }
    return panel;
  }

  function csfxHandleDualConfirm(panel) {
    if (!panel) return;
    var input = panel.querySelector('input[data-csfx="usd-net"]');
    var status = panel.querySelector('[data-csfx="status"]');
    if (!input) return;
    var usdNet = parseFloat(String(input.value || '').replace(',', '.'));
    if (!isFinite(usdNet) || usdNet <= 0) {
      csfxDualLog('confirm:invalid-input', { rawValue: input.value });
      if (status) {
        status.textContent = 'Ingresa un monto válido.';
        status.className = 'csfx-dual-status csfx-dual-status--error';
      }
      return;
    }
    var pct = csfxDiscountDecimal();
    var snapshot = csfxGetCartSnapshot({ totalUSD: readCheckoutUSD() });
    var baseTotal = snapshot.baseTotalUSD;
    if (!isFinite(baseTotal) || baseTotal <= 0) {
      csfxDualLog('confirm:no-base-total', { snapshot: snapshot, usdNet: usdNet });
      if (status) {
        status.textContent = 'No hay total disponible para aplicar el descuento.';
        status.className = 'csfx-dual-status csfx-dual-status--error';
      }
      return;
    }
    var calc = csfxComputeDual(baseTotal, usdNet, pct);
    csfxDualLog('confirm:calc', {
      baseTotal: baseTotal,
      usdNet: usdNet,
      pct: pct,
      cartFound: !!snapshot.cart,
      cartSource: snapshot.cartSource,
      hasService: !!snapshot.cartService,
      cartDebug: snapshot.cartDebug,
      calc: calc
    });
    if (!calc || calc.discount <= 0) {
      csfxDualLog('confirm:no-discount', { calc: calc });
      if (status) {
        status.textContent = 'Con este monto no se genera descuento.';
        status.className = 'csfx-dual-status csfx-dual-status--warn';
      }
      return;
    }
    var success = csfxApplyDualDiscount(snapshot, calc);
    csfxDualLog('confirm:apply-result', {
      success: success,
      discount: calc.discount,
      cartFound: !!snapshot.cart,
      remainderUsd: calc.remainderUsd,
      manualVia: snapshot.cartDebug && snapshot.cartDebug.manualVia ? snapshot.cartDebug.manualVia : null
    });
    if (status) {
      status.classList.remove('csfx-dual-status--warn', 'csfx-dual-status--info', 'csfx-dual-status--error', 'csfx-dual-status--ok');
      if (success) {
        status.textContent = 'Descuento aplicado: ' + fmtUsd(calc.discount);
        status.classList.add('csfx-dual-status', 'csfx-dual-status--ok');
      } else {
        status.textContent = 'No se pudo aplicar el descuento.';
        status.classList.add('csfx-dual-status', 'csfx-dual-status--error');
      }
    }
    if (success) {
      panel.dataset.csfxDirty = '';
      input.dataset.csfxTouched = '';
      csfxRenderBadgeContent(document.querySelector('.csfx-badge'));
      schedule(decorateCart);
      schedule(decorateTotals);
      schedule(decoratePaymentModal);
      schedule(decorateBill);
      var badge = document.querySelector('.csfx-badge');
      if (badge && badge.classList && badge.classList.contains('open')) {
        badge.classList.remove('open');
      }
    }
  }
  // csfx: fin descuento dual

  function decoratePaymentModal() {
   if (!FX.rate || !FX.payChips) {
      document.querySelectorAll('.csfx-pay-header-row,[data-csfxpay],.mat-dialog-container .csfx-chip').forEach(function(n){ n.remove(); });
      return;
    }    var modals = document.querySelectorAll('.mat-dialog-container,[role="dialog"]');
    modals.forEach(function (modal) {
      var headerFound = false;
      // buscar encabezado "pagado/total" dentro del modal
      var headers = modal.querySelectorAll('h1,h2,h3,h4,div,span,p,strong,b');
      for (var idx = 0; idx < headers.length; idx++) {
        var el = headers[idx];
        var txt = (el.textContent || '').trim();
        var mm = txt.match(/([0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,][0-9]{1,2}))\s*\/\s*([0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,][0-9]{1,2}))/);
        if (!mm) continue;
        var u1 = parsePrice(mm[1]);
        var u2 = parsePrice(mm[2]);
        if (isNaN(u1) || isNaN(u2)) continue;
        var chipRow = el.nextElementSibling;
        if (!(chipRow && chipRow.classList && chipRow.classList.contains('csfx-pay-header-row'))) {
          chipRow = document.createElement('div');
          chipRow.className = 'csfx-pay-header-row';
        
          el.insertAdjacentElement('afterend', chipRow);
        }
        var diff = (u2 - u1);
        var vals = [u1, u2];
          var labels = ['Pagado', 'Faltante'];
        for (var k = 0; k < vals.length; k++) {
          var child = chipRow.children[k];
          var bsVal = vals[k];
          // para el segundo valor, mostrar la resta (total - pagado) en lugar del total
          if (k === 1) {
            bsVal = diff;
          }
          var bs = usd2bs(bsVal);
          if (!child) {
            child = document.createElement('span');
          
            chipRow.appendChild(child);
          }
     child.className = 'csfx-chip csfx-chip--modal';
          child.dataset.csfxPay = labels[k].toLowerCase();
          child.textContent = labels[k] + ': ' + fmtBs(bs);
        }
        // marca este encabezado como decorado para idempotencia, pero siempre actualiza
        el.dataset.csfxPayHeader = '1';
        headerFound = true;
        break;
      }
      // si no hay encabezado, no procesamos esta caja
      if (!headerFound) return;
      // Importe a pagar: busca inputs y actualiza chips
      var inputs = modal.querySelectorAll('input');
      inputs.forEach(function (inp) {
        var value = inp.value || '';
        var usdVal = parsePrice(value);
        if (isNaN(usdVal) || usdVal === 0) {
          // si el campo está vacío, elimina chip asociado
          var cch = inp.nextElementSibling;
          if (cch && cch.classList && cch.classList.contains('csfx-chip')) {
            cch.textContent = '';
          }
          return;
        }
        var chip = inp.nextElementSibling && inp.nextElementSibling.classList && inp.nextElementSibling.classList.contains('csfx-chip') ? inp.nextElementSibling : null;
        if (!chip) {
          chip = document.createElement('span');
          chip.className = 'csfx-chip';
          chip.style.marginLeft = '.5rem';
          inp.after(chip);
        }
        chip.textContent = fmtBs(usd2bs(usdVal));
      });
      // Botones de sugerencia dentro del modal
      var buttons = modal.querySelectorAll('button');
      buttons.forEach(function (btn) {
        var txtb = (btn.textContent || '').trim();
        var nb = txtb.match(/([0-9]{1,3}(?:[.,][0-9]{3})*(?:[.,][0-9]{1,2}))/);
        if (!nb) return;
        var usdBtn = parsePrice(nb[1]);
        if (isNaN(usdBtn) || usdBtn === 0) {
          var c2 = btn.querySelector('.csfx-chip');
          if (c2) c2.textContent = '';
          return;
        }
        var chip2 = btn.querySelector('.csfx-chip');
        if (!chip2) {
          chip2 = document.createElement('span');
          chip2.className = 'csfx-chip';
          chip2.style.marginLeft = '.4rem';
          btn.appendChild(chip2);
        }
        chip2.textContent = fmtBs(usd2bs(usdBtn));
      });
    });
  }
    function decorateBill() {
   if (!FX.rate) {
      document.querySelectorAll('.csfx-bill-bs').forEach(function(n){ n.remove(); });
      return;
    }    var cont = document.getElementById('bill-products') || document.getElementById('bill_products') || document.querySelector('.bill-products');
    if (!cont) return;
    var rows = cont.querySelectorAll('tr[id^="item-"], tr');
    rows.forEach(function (r) {
      var priceCell = r.querySelector('td:last-child');
      if (!priceCell) return;
      var usd = parsePrice(priceCell.textContent);
      if (isNaN(usd)) return;
      var mark = priceCell.querySelector('.csfx-bill-bs');
      if (!mark) {
        mark = document.createElement('div');
        mark.className = 'csfx-bill-bs';
        mark.style.fontSize = '11px';
        mark.style.color = FX.style.bsColor || '#0057b7';
        priceCell.appendChild(mark);
      }
      mark.textContent = fmtBs(usd2bs(usd));
    });
  }
  var obsTotals = null;
  var obsSearch = null;
  var obsPayment = null;
  var obsBill = null;
  var obsEls = { totals: null, search: null, payment: null, bill: null };

  function ensureObservers() {
    var cont = findTotalsContainer();
    if (cont) {
      if (!obsTotals || obsEls.totals !== cont) {
        if (obsTotals) obsTotals.disconnect();
        obsTotals = new MutationObserver(function () { schedule(decorateTotals); });
         obsTotals.observe(cont, { childList: true, subtree: true });
        obsEls.totals = cont;
      }
    } else if (obsTotals) {
      obsTotals.disconnect();
      obsTotals = null;
      obsEls.totals = null;
    }

    var panel = document.querySelector('.mat-autocomplete-panel');
    if (panel) {
      if (!obsSearch || obsEls.search !== panel) {
        if (obsSearch) obsSearch.disconnect();
 obsSearch = new MutationObserver(function () { resetUpdates(); schedule(decorateSearch); });
        obsSearch.observe(panel, { childList: true, subtree: true });
        obsEls.search = panel;
      }
    } else if (obsSearch) {
      obsSearch.disconnect();
      obsSearch = null;
      obsEls.search = null;
    }

    var modal = document.querySelector('.mat-dialog-container');
    if (modal) {
      if (!obsPayment || obsEls.payment !== modal) {
        if (obsPayment) obsPayment.disconnect();
        obsPayment = new MutationObserver(function () {
          schedule(decoratePaymentModal);
          schedule(decorateAddons);
        });
        obsPayment.observe(modal, { childList: true, subtree: true });
        obsEls.payment = modal;
      }
    } else if (obsPayment) {
      obsPayment.disconnect();
      obsPayment = null;
      obsEls.payment = null;
    }
    
    var bill = document.getElementById('bill-products') || document.getElementById('bill_products') || document.querySelector('.bill-products');
    if (bill) {
      if (!obsBill || obsEls.bill !== bill) {
        if (obsBill) obsBill.disconnect();
        obsBill = new MutationObserver(function () { schedule(decorateBill); });
        obsBill.observe(bill, { childList: true, subtree: true });
        obsEls.bill = bill;
      }
    } else if (obsBill) {
      obsBill.disconnect();
      obsBill = null;
      obsEls.bill = null;
    }
  }
  function runAll() {
   ensureObservers();
    resetUpdates();
    decorateSearch();
    decorateAddons();
    decorateCart();
    decorateTotals();
    decoratePaymentModal();
      decorateBill();
    ensureBadge();
  }

  // --- Refresco de tasa via AJAX ---
  function refreshRate(cb) {
    var url = (window.CSFX_RATE_ENDPOINT || '/wp-json/csfx/v1/rate') + '?ts=' + Date.now();
    fetch(url, { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        // Si la respuesta es válida y tiene una tasa > 0, actualizamos; de lo contrario mantenemos la última tasa conocida.
        if (j && Number(j.rate) > 0) {
          FX.rate = Number(j.rate);
          FX.mode = j.mode || '';
          FX.updated = j.updated || '';
          persistFxOfflineState({ rate: FX.rate, updated: FX.updated });
        }
        if (!FX.rate || FX.rate <= 0) hydrateFxRateFromOffline();
        ensureBadge();
        cb && cb();
      })
      .catch(function () {
        // En caso de error de red, no reiniciamos la tasa: conservamos la existente.
        hydrateFxRateFromOffline();
        ensureBadge();
        cb && cb();
      });
  }

  // --- Refresco del descuento mediante API ---
  function refreshDiscount(cb){
    var url = (window.CSFX_DISCOUNT_ENDPOINT || '/wp-json/csfx/v1/discount') + '?ts=' + Date.now();
    fetch(url, { cache: 'no-store', credentials: 'same-origin' })
      .then(function(r){ return r.ok ? r.json() : null; })
      .then(function(j){
        FX.disc = {
          active: !!(j && j.active && Number(j.percent) > 0),
          percent: Number(j && j.percent || 0)
        };
        persistFxOfflineState({ disc: FX.disc });
        ensureBadge();
        cb && cb();
      })
      .catch(function(){
        hydrateFxDiscountFromOffline();
        ensureBadge();
        cb && cb();
      });
  }

    // Inicializar posicionamiento del badge y carga de tasa al cargar el DOM
  document.addEventListener('DOMContentLoaded', function(){
    try {
      if (typeof initBadgePositioning === 'function') initBadgePositioning();
      csfxClearLegacyStores();
     refreshRate(function(){
        try {
          var badge = document.querySelector('.csfx-badge-content');
          if (badge && !FX.rate) badge.innerHTML = '<strong>Tasa BCV:</strong> (sin datos)';
        } catch(e){}
        // Tras refrescar la tasa, refrescamos el descuento y luego ejecutamos decoradores
        refreshDiscount(function(){ runAll(); });
        // Fallback: si después de la primera carga aún no hay tasa, intenta otra carga
        setTimeout(function(){
          if (!FX.rate) {
            refreshRate(function(){
              refreshDiscount(function(){ schedule(runAll); });
            });
          }
        }, 10000);
      });    } catch(e){}
  });

  // --- Observer de DOM con throttling ---
 var rootObs = new MutationObserver(function () { schedule(runAll); });
  rootObs.observe(document.documentElement, { childList: true, subtree: true });

  // Exponer runner manual para debug
  window.__CS_FX_RUN = function () { schedule(runAll); };

  // Kickstart

  setInterval(function () { refreshRate(function () { schedule(runAll); }); }, (FX.ttl || 300) * 1000);

  // Intervalo para refrescar el descuento periódicamente (p.ej. cada 60 segundos)
  setInterval(function(){
    refreshDiscount(function(){
      // Actualizamos solo el buscador y el badge para evitar recargar todo
      schedule(decorateSearch);
      ensureBadge();
    });
  }, 60 * 1000);
})();
