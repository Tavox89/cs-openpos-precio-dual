/*!
 * CS – OpenPOS Precio Dual Dinámico (USD + Bs)
* v1.8.0 – 2025-08-09
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
  hideTax: true,
    searchBs: true,
      payChips: true,
      debug: false,
      style: {}
    };
    // Datos inyectados por PHP antes de tener sesión
    if (window.__CS_FX_BOOT && typeof window.__CS_FX_BOOT === 'object') {
      Object.assign(def, window.__CS_FX_BOOT);
    }
    // Datos persistidos por el POS una vez logueado
    try {
      var s = JSON.parse(localStorage.getItem('op_settings') || '{}');
      var fx = (s.setting && s.setting.cs_fx) || {};
      Object.keys(fx).forEach(function (k) {
        if (fx[k] != null) def[k] = fx[k];
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

  // --- CSS mínimo/limpio ---
  (function addCss() {
    var id = 'csfx-css';
    if (document.getElementById(id)) return;
    var css = [
      '.csfx-chip{display:inline-block;margin-left:.5rem;padding:.15rem .45rem;border-radius:12px;font-size:11px;line-height:1;background:#eef1f5;color:#2f3437;white-space:nowrap;vertical-align:middle;}',
      // variante para chips bajo el precio en listas (buscador)
        '.csfx-price-stack{display:flex;flex-direction:column;align-items:flex-end;gap:2px;line-height:1}',
      '.csfx-chip--under{margin:0;display:block;font-size:12px;font-weight:600}',
      '.csfx-row{display:flex;justify-content:space-between;font-size:12px;opacity:.95;margin-top:2px;}',
      '.csfx-row .csfx-amount{font-weight:600;}',
      // fila del carrito: sólo muestra el importe en Bs, alineado a la derecha
      '.csfx-cart-row{display:block;margin-top:2px;font-size:13px;font-weight:600;text-align:right;padding-right:.4rem;}',
      // filas de totales en Bs (Subtotal y Total)
      '.csfx-total-row{display:flex;justify-content:space-between;font-size:13px;font-weight:600;margin-top:4px;padding:0 .4rem;}',
            '.csfx-total-row.csfx-total-subtotal .csfx-amount,.csfx-total-row.csfx-total-total .csfx-amount{color:'+ (FX.style.bsColor || '#0057b7') +';}',
      '.csfx-total-row.csfx-total-desc-total .csfx-amount{color:'+ (FX.style.discountColor || '#28a745') +';}',
      '.csfx-info{margin-top:6px;font-size:11px;opacity:.8;}',
      '.csfx-pay-header-row{display:flex;gap:.8rem;margin-top:2px;}',
      '.csfx-chip--modal{font-size:16px;font-weight:700;padding:.2rem .6rem}',
      // compactar el hueco de impuestos si se decide ocultar
        '.csfx-hide-tax{display:none!important;line-height:0!important;height:0!important;overflow:hidden!important;margin:0!important;padding:0!important;border:0!important;}',
      // badge colapsable para mostrar la tasa y hora
      '.csfx-badge{position:fixed;right:0;bottom:20px;z-index:10000;font-family:inherit;}',
      '.csfx-badge-handle{background:#2f3437;color:#fff;padding:4px 6px;border-radius:4px 4px 0 0;font-size:14px;cursor:pointer;}',
      '.csfx-badge-content{background:#eef1f5;color:#2f3437;padding:4px 6px;border-radius:0 0 4px 4px;display:none;font-size:13px;white-space:nowrap;}',
      '.csfx-badge.open .csfx-badge-content{display:block;}'
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
  function decorateSearch() {
    if (!FX.rate || !FX.searchBs) return;
    var items = document.querySelectorAll('.mat-autocomplete-panel .mat-option');
    items.forEach(function (it) {
   var prev = it.querySelector('[data-csfx="bs-option"]');
      if (prev) prev.remove();
      var stack = it.querySelector('.csfx-price-stack');
      var priceEl;
      if (stack) {
        priceEl = Array.prototype.find.call(stack.childNodes, function (n) {
          return n.nodeType === 1 && !n.classList.contains('csfx-chip');
        });
      }
      if (!priceEl) {
        priceEl = it.querySelector('.product-price, .variation-price, [class*="price"]');
        if (!priceEl) {
          var textRoot = it.querySelector('.mat-option-text') || it;
          priceEl = findPriceElement(textRoot);
        }
                if (!priceEl) return;
        stack = document.createElement('span');
        stack.className = 'csfx-price-stack';
        stack.dataset.csfx = 'stack';
        priceEl.after(stack);
        stack.appendChild(priceEl);
      }
            var usdVal = parsePrice(priceEl.textContent);
      if (isNaN(usdVal) || usdVal <= 0) return;

      var chip = document.createElement('span');
      chip.className = 'csfx-chip csfx-chip--under';
      chip.dataset.csfx = 'bs-option';
        chip.textContent = fmtBs(usd2bs(usdVal));
      stack.appendChild(chip);
    });
  }

  function decorateAddons() {
    // Este decorador se ha deshabilitado para no renderizar chips en el modal de opciones.
    // También elimina cualquier chip existente dentro de la ventana de addons.
    var modals = document.querySelectorAll('.mat-dialog-container');
    modals.forEach(function (modal) {
      // elimina chips Bs previos
      var chips = modal.querySelectorAll('.csfx-chip');
      chips.forEach(function (c) { c.remove(); });
      // oculta cualquier nodo cuyo contenido sea únicamente un precio en Bs (Bs X.XXX,XX)
      var spans = modal.querySelectorAll('span,div');
      spans.forEach(function (el) {
        var tx = (el.textContent || '').trim();
        if (/^Bs\s*[\d\.,]+$/.test(tx)) {
          el.style.display = 'none';
        }
      });
    });
    return;
  }

  function decorateCart() {
    if (!FX.rate) return;
    // Cada producto en el carrito se representa como .mat-list-item; busca su precio y añade fila Bs
    var rows = document.querySelectorAll('.mat-list-item');
    rows.forEach(function (r) {
      // Ignora el texto de la fila Bs que haya sido insertado previamente para evitar crecimiento exponencial
      var clone = r.cloneNode(true);
      var extraRow = clone.querySelector('.csfx-cart-row');
      if (extraRow) extraRow.remove();
      var text = (clone.textContent || '').trim();
      // obtener qty
      var qty = 1;
      var qm = text.match(/^\s*(\d+)\s*[x×]/i);
      if (qm) {
        qty = parseInt(qm[1], 10);
      } else {
        // fallback: busca data-qty o inputs
        var dq = r.getAttribute('data-qty');
        if (dq && !isNaN(parseInt(dq, 10))) qty = parseInt(dq, 10);
        var inp = r.querySelector('input[type="number"]');
        if (inp && !isNaN(parseInt(inp.value, 10))) qty = parseInt(inp.value, 10);
      }
      // Intenta obtener el valor total de la línea desde .total-value (ya incluye qty y addons)
      var totalUSD = NaN;
      var totalEl = r.querySelector('.total-value');
      if (totalEl) {
        totalUSD = parsePrice(totalEl.textContent);
      }
      if (isNaN(totalUSD)) {
        // fallback: calcula total a partir del precio unitario y qty
        var baseUSD = NaN;
        var priceEl = r.querySelector('.variation-price');
        if (priceEl) {
          baseUSD = parsePrice(priceEl.textContent);
        }
        if (isNaN(baseUSD)) {
          // último número con decimales en la línea, no precedido por Bs, como unidad (cuando no hay .variation-price)
          var matches = [];
          var rx2 = /(\d[\d.,]*)(\$?)/g;
          var m;
          while ((m = rx2.exec(text)) !== null) {
            var idx2 = m.index;
            var before2 = text.slice(Math.max(0, idx2 - 3), idx2).toLowerCase();
            if (before2.includes('bs')) continue;
            var val2 = parsePrice(m[0]);
            if (!isNaN(val2) && val2 > 0) matches.push(val2);
          }
          if (matches.length) {
            var finalLine = matches[matches.length - 1];
            baseUSD = finalLine / qty;
          }
        }
        if (!isNaN(baseUSD) && baseUSD > 0) {
          // sumar addons de toda la línea (no multiplicar por qty)
          var addonUSD = 0;
          var addMatches = text.match(/\+\s*(\d+[\d.,]*)/g);
          if (addMatches) {
            addMatches.forEach(function (a) {
              var num = a.replace(/[^0-9,\.]/g, '');
              var p = parsePrice(num);
              if (!isNaN(p)) addonUSD += p;
            });
          }
          totalUSD = baseUSD * qty + addonUSD;
        }
      }
      if (isNaN(totalUSD) || totalUSD <= 0) {
        // no hay base, borra fila
        var ex = r.querySelector(':scope > .csfx-cart-row');
        if (ex) ex.remove();
        return;
      }
      var bs = usd2bs(totalUSD);
      var mark = r.querySelector(':scope > .csfx-cart-row');
      if (!mark) {
        mark = document.createElement('div');
        mark.className = 'csfx-cart-row';
             mark.dataset.csfx = 'cart-bs';
        var sp = document.createElement('span');
        sp.className = 'csfx-amount';
        sp.textContent = fmtBs(bs);
        mark.appendChild(sp);
        r.appendChild(mark);
      } else {
        var sp2 = mark.querySelector('.csfx-amount');
        if (sp2) sp2.textContent = fmtBs(bs);
      }
    });
  }

  function findTotalsContainer() {
    // footer/totales (suele vivir al final del panel derecho)
    // Intenta localizar el contenedor de totales. Abarcamos varios casos: componentes
    // Angular específicos, clases con "total" o "summary" y variantes de OpenPOS.
    return document.querySelector('app-pos-order-total, app-pos-order-summary, app-pos-summary, .op-total, .order-total, [class*="totals"], [class*="summary"], [class*="checkout-footer"], .openpos-summary');
  }
  function findTotalsRow(container, rx) {
    if (!container) return null;
    var rows = Array.prototype.slice.call(container.querySelectorAll('div,li,tr'));
    // busca por label
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var txt = (row.textContent || '').trim();
      if (!txt) continue;
      var label = (row.querySelector('span,div,b,strong,td') || row);
      var t = (label.textContent || '').trim().toLowerCase();
      if (rx.test(t)) return row;
    }
    return null;
  }

  function decorateTotals() {
    if (!FX.rate) return;
    // Alternativamente, procesar contenedores .total-paid-total si están presentes (sub y total)
    var tp = document.querySelectorAll('.total-paid-total');
    if (tp && tp.length) {
      var labels = ['Subtotal', 'Total'];
      tp.forEach(function (row, idx) {
        var usd = parsePrice(row.textContent);
        if (isNaN(usd)) return;
        var bs = usd2bs(usd);
        var lbl = labels[idx] || 'Total';
        var cls = 'csfx-total-' + lbl.toLowerCase();
        var next = row.nextElementSibling;
        if (!(next && next.classList && next.classList.contains(cls))) {
          var nrow = document.createElement('div');
          nrow.className = 'csfx-row ' + cls;
          var l = document.createElement('span');
          l.textContent = lbl + ' (Bs)';
          var v = document.createElement('span');
          v.className = 'csfx-amount';
          v.textContent = fmtBs(bs);
          nrow.appendChild(l);
          nrow.appendChild(v);
          row.insertAdjacentElement('afterend', nrow);
        } else {
          var v3 = next.querySelector('.csfx-amount');
          if (v3) v3.textContent = fmtBs(bs);
        }
      });
      // barra info
      var last = tp[tp.length - 1];
      var infoP = last.parentElement.querySelector('.csfx-info');
      if (!infoP) {
        infoP = document.createElement('div');
        infoP.className = 'csfx-info';
        last.parentElement.appendChild(infoP);
      }
        infoP.innerHTML = buildInfoText();
    }
    // intenta usar contenedor nativo de totales de OpenPOS (app-pos-order-total)
    var containerApp = document.querySelector('app-pos-order-total');
    if (containerApp) {
      var items = containerApp.querySelectorAll('.mat-list-item');
      if (items && items.length) {
        items.forEach(function (row) {
     var type = (row.getAttribute('data-total-type') || '').toLowerCase();
          if (!type) {
            var lbltxt = (row.textContent || '').toLowerCase();
            if (/(impuesto|iva|tax)/.test(lbltxt)) type = 'tax';
          }
          if (FX.hideTax && type === 'tax') {
            hideHard(row.closest('.mat-list-item,li,tr,div') || row);
            return;
          }
        if (type === 'subtotal' || type === 'total') {
          // calcula valor USD
          var usdEl = Array.prototype.slice.call(row.querySelectorAll('span,div,strong,b,td')).reverse().find(function (n) {
            return /-?\d+[.,]\d{1,2}$/.test((n.textContent || '').trim());
          });
          if (!usdEl) return;
          var usd = parsePrice(usdEl.textContent);
          if (isNaN(usd)) return;
          var bs = usd2bs(usd);
          // normaliza clave para descuento
          var key = type;
          if (key === 'discount' || key === 'desc') key = 'descuento';
          var cls = 'csfx-total-' + key;
          var existing = containerApp.querySelector('.' + cls);
          if (!existing) {
            var newRow = document.createElement('div');
            newRow.className = 'csfx-row ' + cls;
            var l = document.createElement('span');
            // etiqueta (Subtotal (Bs), Total (Bs) o Descuento (Bs))
            var labelEl = Array.prototype.slice.call(row.querySelectorAll('span,div,strong,b,td')).find(function (n) {
              var t2 = (n.textContent || '').trim().toLowerCase();
              return t2 && !/-?\d+[.,]\d{1,2}$/.test(t2);
            });
            var label = labelEl ? (labelEl.textContent || '').trim() : key;
            l.textContent = label + ' (Bs)';
            var v = document.createElement('span');
            v.className = 'csfx-amount';
            v.textContent = fmtBs(bs);
            newRow.appendChild(l);
            newRow.appendChild(v);
            // inserta después de la fila original
            row.insertAdjacentElement('afterend', newRow);
          } else {
            var v2 = existing.querySelector('.csfx-amount');
            if (v2) v2.textContent = fmtBs(bs);
          }
        }
      });
        // barra informativa dentro del contenedor
        var info = containerApp.querySelector('.csfx-info');
        if (!info) {
          info = document.createElement('div');
          info.className = 'csfx-info';
          containerApp.appendChild(info);
        }
           info.innerHTML = buildInfoText();
        // si no existe una fila de descuento en las nativas, elimina cualquier fila Bs de descuento
        var nativeDisc = containerApp.querySelector(
          '.mat-list-item[data-total-type="discount"], .mat-list-item[data-total-type="descuento"], .mat-list-item[data-total-type="desc"]'
        );
        if (!nativeDisc) {
          var bd = containerApp.querySelector('.csfx-total-descuento');
          if (bd) bd.remove();
        }
        // se encontraron y procesaron filas, no ejecutar fallback
        return;
      }
    }
    // fallback genérico para otros temas
    var container = findTotalsContainer();
    if (!container) return;
    // Subtotal y total generados a partir de labels
    var subRow = findTotalsRow(container, /^sub\s?total/i);
    if (subRow) injectBsRow(container, subRow, 'subtotal');
    var totRow = findTotalsRow(container, /^total/i);
    if (totRow) injectBsRow(container, totRow, 'total');
    var discountRow = findTotalsRow(container, /desc|descuento|discount/);
    // no se inyecta fila de descuento (Bs); si existiera una fila previa, se elimina
    if (discountRow) {
      // mantener descuento oculto: eliminar fila Bs de descuento
      var dRow2 = container.querySelector('.csfx-total-descuento');
      if (dRow2) dRow2.remove();
    } else {
      var dRow = container.querySelector('.csfx-total-descuento');
      if (dRow) dRow.remove();
    }
    var taxRow = findTotalsRow(container, /impuesto|iva|tax/);
    if (FX.hideTax && taxRow) {
      hideHard(taxRow.closest('.mat-list-item,li,tr,div') || taxRow);
    }
    // si existe descuento, ajusta padding-bottom para evitar superposición con el botón verde
    if (discountRow) {
      container.style.paddingBottom = '84px';
      // si también hay fila de total, insertar Total (Bs) justo después de la fila de descuento
      var totRow = findTotalsRow(container, /^total/i);
      if (totRow) {
        // calcula el valor USD total para convertir
        var valElT = Array.prototype.slice.call(totRow.querySelectorAll('span,div,b,strong,td')).reverse().find(function (n) {
          return /-?\d+[.,]\d{1,2}/.test((n.textContent || ''));
        });
        if (valElT) {
          var usdT = parsePrice(valElT.textContent);
          if (!isNaN(usdT)) {
            var bsT = usd2bs(usdT);
            // elimina cualquier fila Total (Bs) previa insertada por descuento
            var oldTotBs = container.querySelector('.csfx-total-desc-total');
            if (oldTotBs) oldTotBs.remove();
            // crea nueva fila
            var nrowT = document.createElement('div');
            nrowT.className = 'csfx-total-row csfx-row csfx-total-desc-total';
              nrowT.dataset.csfx = 'total-desc';
            var lT = document.createElement('span');
            lT.textContent = 'Total (Bs)';
            var vT = document.createElement('span');
            vT.className = 'csfx-amount';
            vT.textContent = fmtBs(bsT);
            nrowT.appendChild(lT);
            nrowT.appendChild(vT);
            discountRow.insertAdjacentElement('afterend', nrowT);
          }
        }
      }
    } else {
      container.style.paddingBottom = '';
      // elimina cualquier fila Total (Bs) creada para descuento anterior
      var oldTotBs2 = container.querySelector('.csfx-total-desc-total');
      if (oldTotBs2) oldTotBs2.remove();
    }
    var info2 = container.querySelector('.csfx-info');
    if (!info2) {
      info2 = document.createElement('div');
      info2.className = 'csfx-info';
      container.appendChild(info2);
    }
     info2.innerHTML = buildInfoText();

    if (FX.hideTax) {
      var allRows = container.querySelectorAll('div,li,tr');
      allRows.forEach(function (row) {
        var tt = (row.textContent || '').trim().toLowerCase();
        if (/impuesto|iva|tax/.test(tt)) {
          hideHard(row);
        }
      });
    }
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

  function injectBsRow(container, nativeRow, key) {
    // busca el valor USD en la fila nativa (toma el último número)
    var valEl = Array.prototype.slice.call(nativeRow.querySelectorAll('span,div,b,strong,td')).reverse()
      .find(function (n) { return /-?\d+[.,]\d{2}/.test(n.textContent || ''); });
    if (!valEl) return;
    var usd = parsePrice(valEl.textContent);
    if (isNaN(usd)) return;

    var bs = usd2bs(usd);
    var cls = 'csfx-total-' + key;
    var row = container.querySelector('.' + cls);
    var labelMap = { subtotal: 'Subtotal (Bs)', total: 'Total (Bs)', descuento: 'Descuento (Bs)' };
    var label = labelMap[key] || (key.charAt(0).toUpperCase() + key.slice(1) + ' (Bs)');
    if (!row) {
      row = document.createElement('div');
      row.className = 'csfx-total-row csfx-row ' + cls;
            row.dataset.csfx = 'total-' + key;
      var l = document.createElement('span');
      l.textContent = label;
      var v = document.createElement('span');
      v.className = 'csfx-amount';
      v.textContent = fmtBs(bs);
         if (key === 'subtotal' || key === 'total') {
        v.style.color = (FX.style.bsColor || '#0057b7');
      }
      if (key === 'descuento') {
        v.style.color = (FX.style.discountColor || '#28a745');
      }
      row.appendChild(l);
      row.appendChild(v);
      // insertamos justo DESPUÉS de la fila nativa para que la UX sea consistente
      nativeRow.insertAdjacentElement('afterend', row);
    } else {
      var v2 = row.querySelector('.csfx-amount');
      if (v2) v2.textContent = fmtBs(bs);
    }
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
    var t = findTotalsContainer();
    if (t) {
      if (!obsTotals || obsEls.totals !== t) {
        if (obsTotals) obsTotals.disconnect();
        obsTotals = new MutationObserver(function () { schedule(decorateTotals); });
        obsTotals.observe(t, { childList: true, subtree: true });
        obsEls.totals = t;
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
        obsSearch = new MutationObserver(function () { schedule(decorateSearch); });
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
        obsPayment = new MutationObserver(function () { schedule(decoratePaymentModal); });
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
