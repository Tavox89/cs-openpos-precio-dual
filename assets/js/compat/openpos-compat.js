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
