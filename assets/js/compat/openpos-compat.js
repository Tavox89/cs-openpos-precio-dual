(function (global) {
  'use strict';

  var FX = global.CSFX || global.__CS_FX || {};
  var DEFAULT_DECIMALS = (typeof FX.decimals === 'number' && FX.decimals >= 0) ? FX.decimals : 2;

  function currentDecimals() {
    var fx = global.CSFX || global.__CS_FX;
    if (fx && typeof fx.decimals === 'number') {
      return fx.decimals;
    }
    return DEFAULT_DECIMALS;
  }

  function round(amount, decimals) {
    var d = (typeof decimals === 'number') ? decimals : currentDecimals();
    var factor = Math.pow(10, d);
    return Math.round((Number(amount) || 0) * factor) / factor;
  }

  function centsToFloat(cents) {
    var centsNumber = Number(typeof cents === 'string' ? cents : (cents ?? 0));
    if (!isFinite(centsNumber)) return 0;
    return round(centsNumber / 100, currentDecimals());
  }

  function toCamel(snake) {
    return snake.replace(/_([a-z])/g, function (_, l) { return l.toUpperCase(); });
  }

  function mirror(obj, snake, camel) {
    if (!obj) return;
    if (typeof obj[snake] !== 'undefined' && typeof obj[camel] === 'undefined') {
      obj[camel] = obj[snake];
    } else if (typeof obj[camel] !== 'undefined' && typeof obj[snake] === 'undefined') {
      obj[snake] = obj[camel];
    }
  }

  function ensureObject(value) {
    return (value && typeof value === 'object') ? value : {};
  }

  function looksLikeCartService(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (obj === global || obj === global.document) return false;
    var hasStore = obj.storeName === 'cart';
    var fnCount = 0;
    ['setDiscount', '_initCartTotal', 'saveCart', 'updateTotals', 'getCurrentCart'].forEach(function (fn) {
      if (typeof obj[fn] === 'function') fnCount++;
    });
    return hasStore || fnCount >= 2;
  }

  function normalizeProduct(product) {
    product = product || {};
    var isCamel = ('priceInclTax' in product) || ('manageStock' in product) || ('parentId' in product);
    var price = isCamel ? centsToFloat(product.price) : Number(product.price ?? 0);
    var priceInclTax = isCamel ? centsToFloat(product.priceInclTax) : Number(product.price_incl_tax ?? 0);
    return {
      id: product.id,
      parentId: product.parentId ?? product.parent_id ?? null,
      price: price,
      priceInclTax: priceInclTax,
      stockQty: product.stockQty ?? product.qty ?? 0,
      manageStock: product.manageStock ?? product.manage_stock ?? false,
      additionInfo: product.additionInfo ?? product.addition_info ?? {}
    };
  }

  var CART_MIRRORS = [
    'discount_source',
    'discount_type',
    'discount_amount',
    'discount_final_amount',
    'discount_excl_tax',
    'discount_tax_amount',
    'discount_code_amount',
    'final_items_discount_amount',
    'final_discount_amount',
    'final_discount_amount_incl_tax',
    'cart_discount_amount',
    'grand_total',
    'base_grand_total',
    'total',
    'total_due',
    'add_discount'
  ];

  var TOTALS_MIRRORS = [
    'grand_total',
    'base_grand_total',
    'subtotal',
    'base_subtotal',
    'discount',
    'tax',
    'total'
  ];

  function normalizeCart(cart) {
    cart = cart && typeof cart === 'object' ? cart : {};
    CART_MIRRORS.forEach(function (key) {
      mirror(cart, key, toCamel(key));
    });
    if (typeof cart.add_discount !== 'undefined') {
      cart.addDiscount = cart.add_discount;
    }
    if (typeof cart.addDiscount !== 'undefined') {
      cart.add_discount = cart.addDiscount;
    }
    if (cart.metaData && !cart.meta_data) cart.meta_data = cart.metaData;
    if (cart.meta_data && !cart.metaData) cart.metaData = cart.meta_data;
    cart.totals = ensureObject(cart.totals);
    TOTALS_MIRRORS.forEach(function (key) {
      mirror(cart.totals, key, toCamel(key));
    });
    return cart;
  }

  function pickFirstNumber(values, allowNegative) {
    for (var i = 0; i < values.length; i++) {
      var candidate = Number(values[i]);
      if (!isFinite(candidate)) continue;
      if (!allowNegative && candidate < 0) continue;
      return candidate;
    }
    return NaN;
  }

  function readTotals(cart) {
    cart = normalizeCart(cart);
    var totals = ensureObject(cart.totals);
    var baseSubtotal = pickFirstNumber([
      totals.base_subtotal,
      cart.base_subtotal
    ], true);
    var subtotal = pickFirstNumber([
      totals.subtotal,
      totals.base_subtotal,
      cart.subtotal,
      cart.subtotal
    ], true);
    var discount = pickFirstNumber([
      totals.discount,
      totals.discount_total,
      totals.final_discount_amount,
      totals.final_discount_amount_incl_tax,
      cart.final_discount_amount_incl_tax,
      cart.final_discount_amount,
      cart.discount_final_amount,
      cart.discount_amount
    ], true);
    var tax = pickFirstNumber([
      totals.tax,
      totals.tax_amount,
      cart.tax_amount,
      cart.total_tax
    ], true);
    var grand = pickFirstNumber([
      totals.grand_total,
      totals.total,
      totals.total_due,
      cart.grand_total,
      cart.grandTotal,
      cart.total,
      cart.total_due
    ], true);
    return {
      baseSubtotal: baseSubtotal,
      subtotal: subtotal,
      discount: discount,
      tax: tax,
      grand: grand,
      total: grand
    };
  }

  function applyManualCartDiscount(cart, amount, source) {
    cart = normalizeCart(cart);
    var decimals = currentDecimals();
    var value = round(Math.max(0, Number(amount) || 0), decimals);
    var codeAmount = round(Math.max(0, Number(cart.discount_code_amount || 0)), decimals);
    var itemsAmount = round(Math.max(0, Number(cart.final_items_discount_amount || 0)), decimals);
    var combined = round(codeAmount + itemsAmount + value, decimals);

    var svc = global.__CSFX_CART_SERVICE__ || (global.OpenPOSApp && global.OpenPOSApp.cartService) || null;
    if (svc && typeof svc.setDiscount === 'function' && typeof svc._initCartTotal === 'function') {
      try {
        svc.setDiscount(value, 'fixed');
        var activeCart = null;
        if (typeof svc.getCurrentCart === 'function') {
          activeCart = svc.getCurrentCart();
        } else if (svc.cart) {
          activeCart = svc.cart;
        }
        if (activeCart && typeof activeCart === 'object') {
          cart = normalizeCart(activeCart);
        }
        if (cart) {
          cart.discount_source = '';
          cart.discountSource = '';
        }
        svc._initCartTotal();
        if (typeof svc.updateTotals === 'function') svc.updateTotals();
        if (typeof svc.saveCart === 'function') svc.saveCart();
        normalizeCart(cart);
        return cart;
      } catch (_nativeErr) {
        /* Fallback to manual path */
      }
    }

    cart.discount_source = source || cart.discount_source || 'csfx';
    cart.discountSource = cart.discount_source;
    cart.discount_type = 'fixed';
    cart.discountType = cart.discount_type;

    cart.discount_amount = value;
    cart.discountAmount = value;
    cart.discount_final_amount = value;
    cart.discountFinalAmount = value;
    cart.discount_excl_tax = value;
    cart.discountExclTax = value;
    cart.discount_tax_amount = 0;
    cart.discountTaxAmount = 0;
    cart.cart_discount_amount = value;
    cart.cartDiscountAmount = value;

    cart.discount_code_amount = codeAmount;
    cart.discountCodeAmount = codeAmount;
    cart.final_items_discount_amount = itemsAmount;
    cart.finalItemsDiscountAmount = itemsAmount;

    cart.final_discount_amount = combined;
    cart.finalDiscountAmount = combined;
    cart.final_discount_amount_incl_tax = combined;
    cart.finalDiscountAmountInclTax = combined;

    cart.add_discount = true;
    cart.addDiscount = true;

    cart.totals = ensureObject(cart.totals);
    cart.totals.discount = combined;
    cart.totals.discountAmount = combined;
    cart.totals.final_discount_amount = combined;
    cart.totals.finalDiscountAmount = combined;

    normalizeCart(cart);
    return cart;
  }

  function normalizeItemDiscounts(item) {
    item = item && typeof item === 'object' ? item : {};
    ['discount_amount', 'discount_final_amount', 'final_discount_amount', 'final_discount_amount_incl_tax'].forEach(function (key) {
      mirror(item, key, toCamel(key));
    });
    var codes = Array.isArray(item.discount_codes) ? item.discount_codes.slice() : [];
    if (!codes.length && item.discount_code) {
      codes.push(item.discount_code);
    }
    return codes.filter(Boolean);
  }

  var compat = global.OpenPOSCompat || {};
  compat.centsToFloat = centsToFloat;
  compat.normalizeProduct = normalizeProduct;
  compat.normalizeCart = normalizeCart;
  compat.readTotals = readTotals;
  compat.applyManualCartDiscount = applyManualCartDiscount;
  compat.normalizeItemDiscounts = normalizeItemDiscounts;
  compat.resolveCartService = function () {
    var svc = global.__CSFX_CART_SERVICE__ ||
      (global.OpenPOSApp && global.OpenPOSApp.cartService) ||
      (global.posApp && global.posApp.cartService) ||
      (global.POSApp && global.POSApp.cartService) ||
      null;

    if (svc && !looksLikeCartService(svc)) {
      svc = null;
    }

    if (!svc && global.ng && typeof global.ng.getInjector === 'function' && global.document) {
      var root = global.document.querySelector('app-root, pos-root, openpos-root, [ng-version]');
      if (root) {
        try {
          var injector = global.ng.getInjector(root);
          if (injector && typeof injector.get === 'function') {
            try { svc = injector.get('CartService'); } catch (_errToken) {}
            if (!svc && typeof global.CartService !== 'undefined') {
              try { svc = injector.get(global.CartService); } catch (_errClass) {}
            }
            if (svc && !looksLikeCartService(svc)) {
              svc = null;
            }
          }
        } catch (_errNg) {}
      }
    }

    if (!svc && global.document) {
      try {
        var nodes = global.document.querySelectorAll('*');
        for (var i = 0; i < nodes.length && !svc; i++) {
          var ctx = nodes[i].__ngContext__;
          if (!ctx) continue;
          for (var j = 0; j < ctx.length; j++) {
            var entry = ctx[j];
            if (!entry) continue;
            if (entry.cartService && looksLikeCartService(entry.cartService)) {
              svc = entry.cartService;
              break;
            }
            if (looksLikeCartService(entry)) {
              svc = entry;
              break;
            }
          }
        }
      } catch (_errCtx) {}
    }

    if (svc) {
      try { global.__CSFX_CART_SERVICE__ = svc; } catch (_errExpose) {}
    }
    return svc;
  };
  compat.round = compat.round || round;

  global.OpenPOSCompat = compat;
})(typeof window !== 'undefined' ? window : this);

// === CSFX: Interceptor para adjuntar nota de supervisor en addition_information ===
(function setupCsfxSupervisorAddition(){
  'use strict';

  if (typeof window === 'undefined') {
    return;
  }

  var FLAG_FETCH = '__csfxFetchPatched__';
  var FLAG_XHR = '__csfxXHRPatched__';
  var ORDER_MARKERS = ['items', 'line_items', 'totals', 'grand_total', 'order_id', 'discount_amount'];
  var INFO_LABEL = 'Supervisor';

  function markPatched(flag) {
    try { window[flag] = true; } catch (_errMark) {}
  }

  function hasBeenPatched(flag) {
    if (flag === FLAG_FETCH) {
      if (window[flag]) return true;
      return Boolean(window.fetch && window.fetch[flag]);
    }
    if (flag === FLAG_XHR) {
      if (window[flag]) return true;
      var proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
      return Boolean(proto && proto[flag]);
    }
    return Boolean(window[flag]);
  }

  function isPlainObject(value) {
    if (!value || typeof value !== 'object') return false;
    var proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function parseJsonObject(value) {
    if (typeof value !== 'string') return null;
    var trimmed = value.trim();
    if (!trimmed || trimmed.charAt(0) !== '{') return null;
    try {
      var parsed = JSON.parse(trimmed);
      return (parsed && typeof parsed === 'object') ? parsed : null;
    } catch (_errParse) {
      return null;
    }
  }

  function shouldIntercept(method, obj) {
    if (!method || method.toUpperCase() !== 'POST') return false;
    if (!obj || typeof obj !== 'object') return false;
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      if (ORDER_MARKERS.indexOf(keys[i]) !== -1) {
        return true;
      }
    }
    return false;
  }

  function normalizeAdditionEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    var label = typeof entry.label === 'string' ? entry.label : '';
    if (!label) return null;
    var value = entry.value;
    if (value === null || typeof value === 'undefined') {
      value = '';
    } else if (typeof value !== 'string') {
      value = String(value);
    }
    return { label: label, value: value };
  }

  function injectAdditionInformation(target, note) {
    if (!target || typeof target !== 'object' || !note) return;
    var combined = [];
    var sources = [];
    if (Array.isArray(target.addition_information)) sources.push(target.addition_information);
    if (Array.isArray(target.additionInformation)) sources.push(target.additionInformation);
    for (var i = 0; i < sources.length; i++) {
      var list = sources[i];
      for (var j = 0; j < list.length; j++) {
        var normalized = normalizeAdditionEntry(list[j]);
        if (normalized && normalized.label !== INFO_LABEL) {
          combined.push(normalized);
        }
      }
    }
    combined.push({ label: INFO_LABEL, value: note });
    target.addition_information = combined;
    target.additionInformation = combined.slice();
  }

  function ensureJsonContentType(init) {
    if (!init) return;
    if (!init.headers) {
      init.headers = { 'Content-Type': 'application/json' };
      return;
    }
    var headers = init.headers;
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }
      return;
    }
    if (Array.isArray(headers)) {
      var found = false;
      for (var i = 0; i < headers.length; i++) {
        var pair = headers[i];
        if (pair && typeof pair[0] === 'string' && pair[0].toLowerCase() === 'content-type') {
          found = true;
          break;
        }
      }
      if (!found) {
        headers = headers.slice();
        headers.push(['Content-Type', 'application/json']);
        init.headers = headers;
      }
      return;
    }
    var own = Object.prototype.hasOwnProperty;
    for (var key in headers) {
      if (!own.call(headers, key)) continue;
      if (key && key.toLowerCase() === 'content-type') {
        return;
      }
    }
    init.headers = Object.assign({}, headers, { 'Content-Type': 'application/json' });
  }

  function getSupervisorNote() {
    try {
      var raw = null;
      if (typeof sessionStorage !== 'undefined') {
        raw = sessionStorage.getItem('csfx_last_supervisor');
      }
      if (!raw && typeof localStorage !== 'undefined') {
        raw = localStorage.getItem('csfx_last_supervisor');
      }
      if (!raw) return null;
      var sup = JSON.parse(raw);
      if (!sup || typeof sup !== 'object') return null;
      var label = sup.name || sup.email || (sup.id ? ('ID ' + sup.id) : '');
      if (!label) return null;
      return 'CSFX · Supervisor ' + label + ' autorizó descuentos personalizados.';
    } catch (_errNote) {
      return null;
    }
  }

  function findOrderContext(method, payload) {
    if (!method || method.toUpperCase() !== 'POST') return null;
    if (!payload) return null;

    function buildJsonContextFromObject(obj) {
      if (!obj || typeof obj !== 'object') return null;
      if (!shouldIntercept(method, obj)) return null;
      return {
        target: obj,
        ensureJson: true,
        serialize: function() {
          return JSON.stringify(obj);
        }
      };
    }

    function buildNestedOrderContext(container, nested, stringifyNested) {
      if (!nested || typeof nested !== 'object') return null;
      if (!shouldIntercept(method, nested)) return null;
      return {
        target: nested,
        ensureJson: true,
        serialize: function() {
          if (stringifyNested) {
            container.order = JSON.stringify(nested);
          } else {
            container.order = nested;
          }
          return JSON.stringify(container);
        }
      };
    }

    function buildFormDataContext(form) {
      if (typeof form.has !== 'function' || !form.has('order')) return null;
      var raw = form.get('order');
      if (typeof raw !== 'string') return null;
      var orderObj = parseJsonObject(raw);
      if (!orderObj || !shouldIntercept(method, orderObj)) return null;
      return {
        target: orderObj,
        ensureJson: false,
        serialize: function() {
          form.set('order', JSON.stringify(orderObj));
          return form;
        }
      };
    }

    function buildUrlEncodedContext(params, shouldStringify) {
      if (typeof params.has !== 'function' || !params.has('order')) return null;
      var raw = params.get('order');
      if (typeof raw !== 'string') return null;
      var orderObj = parseJsonObject(raw);
      if (!orderObj || !shouldIntercept(method, orderObj)) return null;
      return {
        target: orderObj,
        ensureJson: false,
        serialize: function() {
          params.set('order', JSON.stringify(orderObj));
          return shouldStringify ? params.toString() : params;
        }
      };
    }

    if (typeof payload === 'string') {
      var jsonObj = parseJsonObject(payload);
      if (jsonObj) {
        var ctx = buildJsonContextFromObject(jsonObj);
        if (ctx) return ctx;
        if (jsonObj.order) {
          if (typeof jsonObj.order === 'string') {
            var nestedString = parseJsonObject(jsonObj.order);
            if (nestedString) {
              var nestedCtx = buildNestedOrderContext(jsonObj, nestedString, true);
              if (nestedCtx) return nestedCtx;
            }
          } else if (isPlainObject(jsonObj.order)) {
            var nestedObjCtx = buildNestedOrderContext(jsonObj, jsonObj.order, false);
            if (nestedObjCtx) return nestedObjCtx;
          }
        }
      }
      if (typeof URLSearchParams !== 'undefined') {
        try {
          var paramsFromString = new URLSearchParams(payload);
          return buildUrlEncodedContext(paramsFromString, true);
        } catch (_errParams) {
          return null;
        }
      }
      return null;
    }

    if (typeof payload === 'object') {
      if (typeof FormData !== 'undefined' && payload instanceof FormData) {
        return buildFormDataContext(payload);
      }
      if (typeof Blob !== 'undefined' && payload instanceof Blob) return null;
      if (typeof ArrayBuffer !== 'undefined') {
        if (payload instanceof ArrayBuffer) return null;
        if (typeof ArrayBuffer.isView === 'function' && ArrayBuffer.isView(payload)) return null;
      }
      if (typeof URLSearchParams !== 'undefined' && payload instanceof URLSearchParams) {
        return buildUrlEncodedContext(payload, false);
      }
      if (typeof ReadableStream !== 'undefined' && payload instanceof ReadableStream) return null;
      if (!isPlainObject(payload)) return null;

      var directContext = buildJsonContextFromObject(payload);
      if (directContext) {
        return directContext;
      }

      if (payload.order) {
        if (typeof payload.order === 'string') {
          var nestedParsed = parseJsonObject(payload.order);
          if (nestedParsed) {
            return buildNestedOrderContext(payload, nestedParsed, true);
          }
        } else if (isPlainObject(payload.order)) {
          return buildNestedOrderContext(payload, payload.order, false);
        }
      }
    }

    return null;
  }

  if (window.fetch && !hasBeenPatched(FLAG_FETCH)) {
    var originalFetch = window.fetch;
    window.fetch = function(input, init) {
      try {
        var method = (init && init.method) || (input && input.method) || 'GET';
        var bodyPayload = init && Object.prototype.hasOwnProperty.call(init, 'body') ? init.body : null;
        var context = bodyPayload ? findOrderContext(method, bodyPayload) : null;
        if (context) {
          var note = getSupervisorNote();
          if (note) {
            injectAdditionInformation(context.target, note);
            var nextInit = init ? Object.assign({}, init) : {};
            nextInit.body = context.serialize();
            if (context.ensureJson) {
              ensureJsonContentType(nextInit);
            }
            arguments[1] = nextInit;
          }
        }
      } catch (_errFetch) {
        // swallow
      }
      return originalFetch.apply(this, arguments);
    };
    window.fetch[FLAG_FETCH] = true;
    markPatched(FLAG_FETCH);
  }

  if (window.XMLHttpRequest && window.XMLHttpRequest.prototype && !hasBeenPatched(FLAG_XHR)) {
    var xhrOpen = XMLHttpRequest.prototype.open;
    var xhrSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
      this.__csfxMethod = method;
      return xhrOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function(body) {
      var transformedBody = body;
      try {
        var method = this.__csfxMethod || 'GET';
        var context = findOrderContext(method, body);
        if (context) {
          var note = getSupervisorNote();
          if (note) {
            injectAdditionInformation(context.target, note);
            transformedBody = context.serialize();
            if (context.ensureJson) {
              try { this.setRequestHeader('Content-Type', 'application/json'); } catch (_errHeader) {}
            }
          }
        }
      } catch (_errSend) {
        // swallow
      } finally {
        this.__csfxMethod = null;
      }
      return xhrSend.call(this, transformedBody);
    };
    XMLHttpRequest.prototype[FLAG_XHR] = true;
    markPatched(FLAG_XHR);
  }
})();
