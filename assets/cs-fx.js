/*!
 * CS – OpenPOS Precio Dual Dinámico (USD + Bs)
 * v1.8.9 – 2025-08-24
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

  // --- Config FX (mezcla BOOT + localStorage) ---
  var FX = (function () {
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
       hideTax: false,
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
    def.rate = Number(def.rate) || 0;
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
      '.csfx-info{margin-top:6px;font-size:11px;opacity:.8;}',
      '.csfx-pay-header-row{display:flex;gap:.8rem;margin-top:2px;}',
      '.csfx-chip--modal{font-size:16px;font-weight:700;padding:.2rem .6rem}',
      // compactar el hueco de impuestos si se decide ocultar
       '.csfx-hide-tax{display:none!important;line-height:0!important;height:0!important;overflow:hidden!important;margin:0!important;padding:0!important;border:0!important;}',
      // badge colapsable para mostrar la tasa y hora
      '.csfx-badge{position:fixed;right:0;bottom:20px;z-index:10000;font-family:inherit;}',
      '.csfx-badge-handle{background:#2f3437;color:#fff;padding:4px 6px;border-radius:4px 4px 0 0;font-size:14px;cursor:pointer;}',
      '.csfx-badge-content{background:#eef1f5;color:#2f3437;padding:4px 6px;border-radius:0 0 4px 4px;display:none;font-size:13px;white-space:nowrap;}',
       '.csfx-badge.open .csfx-badge-content{display:block;}',
      // especificidad para evitar conflictos con CSS del POS
        /* Reglas específicas para el buscador (sin romper layout nativo) */
      '.csfx-chip{font-family:inherit;font-size:16px;font-weight:700;}',
      '.csfx-usd-chip{font-size:16px;font-weight:700;color:#0b5e3c;background:rgba(16,185,129,.10);padding:.2rem .5rem;border-radius:12px;}',
      '.csfx-bs-chip{font-size:16px;font-weight:700;color:#1e3a8a;background:rgba(0,87,183,.10);padding:.2rem .5rem;border-radius:12px;position:absolute;top:50%;transform:translateY(-50%);right:0;}',
      '.mat-autocomplete-panel .mat-option .mat-option-text{position:relative;overflow:visible;padding-right:2rem;}',
      '.mat-dialog-container .mat-radio-button .mat-radio-label-content, .mat-dialog-container .mat-checkbox .mat-checkbox-label{display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%}',
      '.mat-dialog-container .csfx-addon-stack{display:flex;flex-direction:column;align-items:flex-end;gap:2px}',
      // Fila resumen de totales (debajo del Subtotal USD)
      '[data-csfx="summary-bs"]{display:flex;align-items:center;gap:10px;padding:0 .4rem;margin-top:4px;justify-content:flex-start;}'
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

  // --- Decoradores ---
    // bandera para evitar actualizaciones repetidas que generan parpadeo
  var updateApplied = false;

  function decorateSearch() {
      if (!FX.rate || !FX.searchBs || updateApplied) return;
    updateApplied = true;
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
      
      chip.textContent = fmtBs(usd2bs(usdVal));

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
    if (!FX.rate || !FX.addonsBs) return;
    var modals = document.querySelectorAll('.mat-dialog-container');
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
    if (!FX.rate) return;
    var cartRows = document.querySelectorAll('app-cart .mat-list-item');
    var rows = cartRows.length ? cartRows : document.querySelectorAll('.mat-list-item');
    rows.forEach(function (r) {
      if (r.closest('app-pos-order-total, .total-sub')) {
        var leak = r.querySelector(':scope > .csfx-cart-row');
        if (leak) leak.remove();
        return;
      }
      var mark = r.querySelector(':scope > .csfx-cart-row[data-csfx="cart-bs"]');
  var labelText = (r.textContent || '').toLowerCase();
      if (/descuento|discount/.test(labelText)) {
        if (mark) mark.remove();
        return;
      }
      var usd = getLineUSD(r);
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

    var top = row.closest('li, .mat-list-item, tr');
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
  function decorateTotals() {
    if (!FX.rate) return;

    var container = findTotalsContainer();
    if (!container) return;

    // Evitar que el botón verde tape nuestras filas
    if (!container.dataset.csfxPad) {
      container.style.paddingBottom = '64px';
      container.dataset.csfxPad = '1';
    }

    // limpieza: NUNCA permitir filas del carrito en totales
    container.querySelectorAll('.csfx-cart-row').forEach(function (n) { n.remove(); });

    // eliminar previos para idempotencia
    container.querySelectorAll('[data-csfx="total-final"], [data-csfx="total-inline"], [data-csfx="total-usd"], [data-csfx="total-bs"], .csfx-info').forEach(function (n) { n.remove(); });

    var subRow = findTotalsRow(container, /^sub\\s?total/i);
    var discRow = findTotalsRow(container, /descuento|discount/i);
    var taxRow = findTotalsRow(container, /impuesto|tax/i);
    var totRow = findTotalsRow(container, /^total/i);


    var usdS = subRow ? parsePrice(subRow.textContent) : NaN;
    var usdD = discRow ? Math.abs(parsePrice(discRow.textContent)) : 0;
    var usdI = taxRow ? parsePrice(taxRow.textContent) : 0;
    var usdT = totRow ? parsePrice(totRow.textContent) : NaN;
    
    // === Fallbacks robustos ===
    // 1) intenta derivar TOTAL a partir de subtotal/desc/impuesto
    if (isNaN(usdT) && !isNaN(usdS)) usdT = usdS - usdD + usdI;
    // 2) botón verde
    if (isNaN(usdT)) {
      var btnUsd = readCheckoutUSD();
      if (!isNaN(btnUsd)) usdT = btnUsd;
    }
       // 3) intenta derivar SUBTOTAL si no lo conseguimos
    if (isNaN(usdS) && !isNaN(usdT)) usdS = usdT + usdD - usdI;
    if (isNaN(usdS)) {
      var btnUsd2 = readCheckoutUSD();
      if (!isNaN(btnUsd2)) usdS = btnUsd2 + usdD - usdI;
    }
    // Solo removemos la fila de Total nativa si hay descuento global
    var replaceNativeTotal = !!discRow;
        var totA = anchorRow(totRow);
    if (replaceNativeTotal && totA) totA.remove();

    // Ocultar impuestos si la opción está activa
    if (FX.hideTax && taxRow) hideHard(anchorRow(taxRow));

     // Subtotal (Bs.) SIEMPRE visible y con anclaje robusto
    var subA = anchorRow(subRow);
    var fallbackAnchor = subA || anchorRow(discRow) || anchorRow(taxRow) || anchorRow(totRow);
    var summary = container.querySelector('[data-csfx="summary-bs"]');
    if (!summary) {

      summary = document.createElement('div');
      summary.className = 'csfx-total-row';
      summary.dataset.csfx = 'summary-bs';
      summary.innerHTML = '<span>Subtotal (Bs.)</span><span class="csfx-amount" data-csfx="sub-bs"></span>';
      if (fallbackAnchor) fallbackAnchor.insertAdjacentElement('afterend', summary);

      else container.appendChild(summary);
    }
    if (summary) {
      var subSp = summary.querySelector('[data-csfx="sub-bs"]');
      if (subSp) {
        // si el primer intento no trajo USD válido, reintenta con fallbacks ya calculados
        if (isNaN(usdS)) {
       var btnUsd2 = readCheckoutUSD();
          if (!isNaN(btnUsd2)) usdS = btnUsd2 + usdD - usdI;
        }
        if (!isNaN(usdS)) subSp.textContent = fmtBs(usd2bs(usdS));
      }
    }

    // Mostrar Total Final (Bs.) solo si hay descuento global
    if (discRow) {
      var after = anchorRow(discRow);
      var rowFinal = document.createElement('div');
      rowFinal.className = 'csfx-total-row';
      rowFinal.dataset.csfx = 'total-final';
      rowFinal.innerHTML = '<span>Total Final (Bs.)</span><span class="csfx-amount" data-csfx="tot-bs"></span>';
      if (after) after.insertAdjacentElement('afterend', rowFinal);
      var totSp = rowFinal.querySelector('[data-csfx="tot-bs"]');
      // cálculo preferente: SUBTOTAL - DESCUENTO + IMPUESTO
      var usdFinal = !isNaN(usdS) ? (usdS - usdD + usdI) : NaN;
      // fallback al Total nativo y por último al botón verde
      if (isNaN(usdFinal) && !isNaN(usdT)) usdFinal = usdT;

      if (isNaN(usdFinal)) { var b = readCheckoutUSD(); if (!isNaN(b)) usdFinal = b; }
      if (totSp && !isNaN(usdFinal)) {
        totSp.textContent = fmtBs(usd2bs(usdFinal));
      }
    }
    // La información de tasa se muestra exclusivamente en el badge
  }
  function buildInfoText() {
  var t = '<strong>Tasa BCV:</strong> ' + (FX.rate ? FX.rate.toFixed(FX.decimals) : '(sin datos)');
    if (FX.updated) {
      var d = new Date(FX.updated * 1000);
         var hh;
      try {
        hh = d.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', hour12: true });
      } catch (e) {
           hh = d.getHours() + ':' + ('' + d.getMinutes()).padStart(2, '0');
      }
            t += ' · <strong>Actualizado:</strong> ' + hh;
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
        e.stopPropagation();
      });
      document.body.appendChild(badge);
    }
    var contentDiv = badge.querySelector('.csfx-badge-content');
     if (contentDiv) contentDiv.innerHTML = buildInfoText();
  }


  /**
   * Decora el modal de método de pago, añadiendo chips Bs en el encabezado de pagado/total,
   * el campo de importe a pagar y los botones de sugerencia de importes. Se basa en la
   * presencia de role="dialog" o clases de Angular Material.
   */
  function decoratePaymentModal() {
 if (!FX.rate || !FX.payChips) return;
    var modals = document.querySelectorAll('.mat-dialog-container,[role="dialog"]');
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
  var obsTotals = null;
  var obsSearch = null;
  var obsPayment = null;
  var obsEls = { totals: null, search: null, payment: null };

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
  }
  function runAll() {
   ensureObservers();
    resetUpdates();
    decorateSearch();
    decorateAddons();
    decorateCart();
    decorateTotals();
    decoratePaymentModal();
    ensureBadge();
  }

  // --- Refresco de tasa via AJAX ---
  function refreshRate(cb) {
    if (!FX.ajax) { cb && cb(); return; }
    fetch(FX.ajax, { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && typeof j.rate !== 'undefined') {
          FX.rate = Number(j.rate) || 0;
          FX.updated = +j.updated || FX.updated || 0;
          // persistir por si el POS guarda op_settings
          try {
            var s = JSON.parse(localStorage.getItem('op_settings') || '{}');
            if (!s.setting) s.setting = {};
            if (!s.setting.cs_fx) s.setting.cs_fx = {};
            s.setting.cs_fx.rate = FX.rate;
            s.setting.cs_fx.updated = FX.updated;
            localStorage.setItem('op_settings', JSON.stringify(s));
          } catch (e) {}
        }
        // actualizar badge tras refrescar la tasa
        ensureBadge();
        cb && cb();
      })
      .catch(function () { ensureBadge(); cb && cb(); });
  }

  // --- Observer de DOM con throttling ---
 var rootObs = new MutationObserver(function () { schedule(runAll); });
  rootObs.observe(document.documentElement, { childList: true, subtree: true });

  // Exponer runner manual para debug
  window.__CS_FX_RUN = function () { schedule(runAll); };

  // Kickstart
  schedule(runAll);
  setTimeout(function () { schedule(runAll); }, 450);
  setTimeout(function () { refreshRate(function () { schedule(runAll); }); }, 900);
  setInterval(function () { refreshRate(function () { schedule(runAll); }); }, (FX.ttl || 300) * 1000);
})();
