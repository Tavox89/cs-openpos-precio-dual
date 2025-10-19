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

  var csfxCustomModalUI = null;
  var csfxExplainModalUI = null;
  var csfxCustomModalState = {
    open: false,
    authorized: false,
    pin: ''
  };

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

  var csfxCachedRegisterId = null;
  var csfxRegisterIdSource = '';
  var csfxRegisterScanAt = 0;
  var csfxCartKeyCache = null;
  var csfxCartKeyCacheAt = 0;
  var csfxServerCartCache = null;
  var csfxServerCartFetchedAt = 0;
  var csfxServerCartPromise = null;
  var csfxServerCartLastErrorAt = 0;
  var csfxServerCartDebug = null;
  var csfxAsyncCartCache = null;
  var csfxAsyncCartFetchedAt = 0;
  var csfxAsyncCartDebug = null;
  var csfxSessionCartKeyCache = null;
  var csfxSessionCartKeyCacheAt = 0;
  var CSFX_SESSION_KEY_CACHE_TTL = 5000;
  var CSFX_REGISTER_SCAN_COOLDOWN = 2500;
  var CSFX_LS_KEY_CACHE_TTL = 5000;
  var CSFX_SERVER_CART_TTL_MS = 5000;
  var CSFX_SERVER_CART_ERROR_COOLDOWN = 4000;
  var CSFX_ASYNC_CART_TTL_MS = 4000;
  var CSFX_DEEP_CART_MAX_DEPTH = 6;
  var CSFX_DEEP_CART_MAX_BRANCH = 120;

  function csfxRememberRegisterId(candidate, source) {
    if (candidate === null || candidate === undefined) return null;
    var str = String(candidate).trim();
    if (!str) return null;
    csfxCachedRegisterId = str;
    if (source) csfxRegisterIdSource = source;
    return str;
  }

  function csfxExtractRegisterId(obj, source) {
    if (!obj || typeof obj !== 'object') return null;
    var directKeys = ['register_id', 'registerId', 'registerID', 'registerid', 'pos_register_id'];
    for (var i = 0; i < directKeys.length; i++) {
      var key = directKeys[i];
      if (obj[key] !== undefined && obj[key] !== null) {
        return csfxRememberRegisterId(obj[key], (source || '') + '.' + key);
      }
    }
    if (typeof obj.id !== 'undefined' && (obj.type === 'register' || obj.entity === 'register')) {
      return csfxRememberRegisterId(obj.id, (source || '') + '.id');
    }
    var relatedKeys = ['register', 'current_register', 'cashdrawer', 'drawer', 'session', 'meta', 'data'];
    for (var j = 0; j < relatedKeys.length; j++) {
      var nestedKey = relatedKeys[j];
      if (obj[nestedKey] && typeof obj[nestedKey] === 'object') {
        var nested = csfxExtractRegisterId(obj[nestedKey], (source || '') + '.' + nestedKey);
        if (nested) return nested;
      }
    }
    var keys = Object.keys(obj);
    for (var k = 0; k < keys.length; k++) {
      var name = keys[k];
      if (!name || name.length > 40) continue;
      if (!/register/i.test(name)) continue;
      var value = obj[name];
      if (!value) continue;
      if (typeof value === 'string' || typeof value === 'number') {
        return csfxRememberRegisterId(value, (source || '') + '.' + name);
      }
      if (typeof value === 'object') {
        var nestedVal = csfxExtractRegisterId(value, (source || '') + '.' + name);
        if (nestedVal) return nestedVal;
      }
    }
    return null;
  }

  function csfxScanForRegisterId() {
    var now = Date.now();
    if (csfxCachedRegisterId && csfxCachedRegisterId.trim()) {
      return { id: csfxCachedRegisterId, source: csfxRegisterIdSource || 'cache' };
    }
    if (now - csfxRegisterScanAt < CSFX_REGISTER_SCAN_COOLDOWN) {
      return csfxCachedRegisterId ? { id: csfxCachedRegisterId, source: csfxRegisterIdSource || 'cache' } : null;
    }
    csfxRegisterScanAt = now;
    var sources = [];
    try {
      if (typeof FX === 'object' && FX) {
        if (FX.register_id != null) sources.push({ value: FX.register_id, source: 'FX.register_id' });
        if (FX.registerId != null) sources.push({ value: FX.registerId, source: 'FX.registerId' });
        if (FX.session && typeof FX.session === 'object') {
          var viaSession = csfxExtractRegisterId(FX.session, 'FX.session');
          if (viaSession) sources.push({ value: viaSession, source: csfxRegisterIdSource || 'FX.session' });
        }
      }
    } catch (_errFxReg) {}
    try {
      if (typeof window !== 'undefined') {
        var globals = [
          { value: window.CSFX_REGISTER_ID, source: 'window.CSFX_REGISTER_ID' },
          { value: window.CSFX_REGISTER, source: 'window.CSFX_REGISTER' },
          { value: window.OP_REGISTER_ID, source: 'window.OP_REGISTER_ID' },
          { value: window.OPRegisterID, source: 'window.OPRegisterID' },
          { value: window.register_id, source: 'window.register_id' },
          { value: window.RegisterID, source: 'window.RegisterID' }
        ];
        for (var g = 0; g < globals.length; g++) {
          var gl = globals[g];
          if (gl.value !== undefined && gl.value !== null) {
            sources.push(gl);
          }
        }
        var appGlobals = [
          { host: window.OpenPOSApp, source: 'window.OpenPOSApp' },
          { host: window.OpenposApp, source: 'window.OpenposApp' },
          { host: window.openposApp, source: 'window.openposApp' },
          { host: window.POSApp, source: 'window.POSApp' },
          { host: window.posApp, source: 'window.posApp' },
          { host: window.OPApp, source: 'window.OPApp' }
        ];
        for (var ag = 0; ag < appGlobals.length; ag++) {
          var app = appGlobals[ag];
          if (!app.host || typeof app.host !== 'object') continue;
          var extracted = csfxExtractRegisterId(app.host, app.source);
          if (extracted) {
            sources.push({ value: extracted, source: csfxRegisterIdSource || app.source });
            break;
          }
        }
      }
    } catch (_errWinReg) {}
    if (typeof csfxCachedCartService === 'object' && csfxCachedCartService) {
      var svcRegister = csfxExtractRegisterId(csfxCachedCartService, 'cartService');
      if (svcRegister) {
        sources.push({ value: svcRegister, source: csfxRegisterIdSource || 'cartService' });
      }
    }
    var fromStorage = null;
    if (typeof localStorage !== 'undefined') {
      try {
        var keys = Object.keys(localStorage);
        for (var i = 0; i < keys.length; i++) {
          var key = keys[i];
          if (!key) continue;
          if (!/register/i.test(key) && !/session/i.test(key) && !/drawer/i.test(key)) continue;
          var raw = localStorage.getItem(key);
          if (!raw || raw.length > 200000) continue;
          try {
            var parsed = JSON.parse(raw);
            var reg = csfxExtractRegisterId(parsed, 'localStorage.' + key);
            if (reg) {
              fromStorage = { value: reg, source: csfxRegisterIdSource || ('localStorage.' + key) };
              break;
            }
          } catch (_errParseLs) {}
        }
      } catch (_errLs) {}
    }
    if (fromStorage) sources.push(fromStorage);
    if (sources.length) {
      for (var s = 0; s < sources.length; s++) {
        var src = sources[s];
        var remembered = csfxRememberRegisterId(src.value, src.source);
        if (remembered) {
          return { id: remembered, source: csfxRegisterIdSource || src.source };
        }
      }
    }
    return csfxCachedRegisterId ? { id: csfxCachedRegisterId, source: csfxRegisterIdSource || 'cache' } : null;
  }

  function csfxGuessRegisterId() {
    var found = csfxScanForRegisterId();
    return found ? found.id : null;
  }

  function csfxCartStorageKeyList() {
    var now = Date.now();
    if (csfxCartKeyCache && now - csfxCartKeyCacheAt < CSFX_LS_KEY_CACHE_TTL) {
      return csfxCartKeyCache.slice();
    }
    var keys = [];
    if (typeof localStorage !== 'undefined') {
      try {
        keys = Object.keys(localStorage);
      } catch (_errKeys) {
        keys = [];
      }
    }
    var preferred = [
      'op_cart', 'op_cache_cart', 'op_local_cart', '_op_cart_data', 'op_cart_data',
      'op_cart_v8', 'op_v5_cart', 'op_cart_backup', 'op_cart_latest', 'op_cart_store',
      'openpos_cart', 'openpos_last_cart', 'op_cart_temp', 'op_current_cart', 'op_cart_memory',
      'op_cart_snapshot', 'op_checkout_cart'
    ];
    var seen = {};
    var list = [];
    var push = function (key) {
      if (!key || typeof key !== 'string') return;
      if (seen[key]) return;
      seen[key] = true;
      list.push(key);
    };
    for (var i = 0; i < preferred.length; i++) push(preferred[i]);
    for (var j = 0; j < keys.length; j++) push(keys[j]);
    csfxCartKeyCache = list.slice();
    csfxCartKeyCacheAt = now;
    return list;
  }

  function csfxSessionCartKeyList() {
    var now = Date.now();
    if (csfxSessionCartKeyCache && now - csfxSessionCartKeyCacheAt < CSFX_SESSION_KEY_CACHE_TTL) {
      return csfxSessionCartKeyCache.slice();
    }
    var keys = [];
    if (typeof sessionStorage !== 'undefined') {
      try {
        keys = Object.keys(sessionStorage);
      } catch (_errSession) {
        keys = [];
      }
    }
    var preferred = [
      'op_cart', 'op_session_cart', 'op_cart_buffer', 'op_cart_temp', 'op_cart_memory',
      'op_cart_snapshot', 'openpos_cart_session', '_op_cart_data', 'op_cart_cache'
    ];
    var seen = {};
    var list = [];
    var push = function (key) {
      if (!key || typeof key !== 'string') return;
      if (seen[key]) return;
      seen[key] = true;
      list.push(key);
    };
    for (var i = 0; i < preferred.length; i++) push(preferred[i]);
    for (var j = 0; j < keys.length; j++) push(keys[j]);
    csfxSessionCartKeyCache = list.slice();
    csfxSessionCartKeyCacheAt = now;
    return list;
  }

  function csfxGetCachedServerCart() {
    if (!csfxServerCartCache) return null;
    var age = Date.now() - csfxServerCartFetchedAt;
    if (age > CSFX_SERVER_CART_TTL_MS) return null;
    return csfxServerCartCache;
  }

  function csfxRememberAsyncCart(cart, source) {
    if (!cart || typeof cart !== 'object') return;
    csfxAsyncCartCache = cart;
    csfxAsyncCartFetchedAt = Date.now();
    csfxAsyncCartDebug = {
      source: source || 'service',
      capturedAt: csfxAsyncCartFetchedAt
    };
    try {
      document.dispatchEvent(new CustomEvent('csfx:cart-updated', {
        detail: {
          source: source || 'service',
          async: true
        }
      }));
    } catch (_errAsyncEvent) {}
  }

  function csfxGetCachedAsyncCart() {
    if (!csfxAsyncCartCache) return null;
    if (Date.now() - csfxAsyncCartFetchedAt > CSFX_ASYNC_CART_TTL_MS) return null;
    return csfxAsyncCartCache;
  }

  function csfxLooksLikeCartSkeleton(candidate) {
    if (!candidate || typeof candidate !== 'object') return false;
    if (Array.isArray(candidate)) return false;
    var keys = Object.keys(candidate);
    if (!keys.length) return false;
    var itemKeys = ['items', 'cart_items', 'cartItems', 'products', 'lines', 'line_items', 'quote_items'];
    for (var i = 0; i < itemKeys.length; i++) {
      var value = candidate[itemKeys[i]];
      if (!value) continue;
      if (Array.isArray(value) && value.length) return true;
      if (value && typeof value === 'object' && Object.keys(value).length) return true;
    }
    if (candidate.totals && typeof candidate.totals === 'object' && Object.keys(candidate.totals).length) return true;
    if (candidate.base_grand_total || candidate.grand_total || candidate.total || candidate.subtotal) return true;
    if (candidate.quote_id || candidate.order_id || candidate.draft_id) return true;
    return false;
  }

  function csfxBranchScoreForKey(key) {
    if (!key) return 0;
    var name = String(key).toLowerCase();
    var score = 0;
    if (name.indexOf('cart') > -1) score += 6;
    if (name.indexOf('current') > -1) score += 3;
    if (name.indexOf('active') > -1) score += 2;
    if (name.indexOf('session') > -1 || name.indexOf('register') > -1) score += 1;
    if (name.indexOf('order') > -1 || name.indexOf('quote') > -1) score += 2;
    if (name.indexOf('items') > -1 || name.indexOf('lines') > -1) score += 2;
    if (name.indexOf('data') > -1 || name.indexOf('response') > -1 || name.indexOf('payload') > -1) score += 1;
    return score;
  }

  function csfxDeepFindCart(value, depth, visited) {
    if (value == null) return null;
    if (depth > CSFX_DEEP_CART_MAX_DEPTH) return null;
    if (typeof value === 'string') {
      try {
        var parsed = JSON.parse(value);
        return csfxDeepFindCart(parsed, depth + 1, visited);
      } catch (_errStr) {
        return null;
      }
    }
    if (typeof value !== 'object') return null;
    if (!visited) {
      visited = typeof WeakSet !== 'undefined' ? new WeakSet() : [];
    }
    if (visited.has && visited.has(value)) return null;
    if (visited.add) {
      visited.add(value);
    } else if (Array.isArray(visited)) {
      if (visited.indexOf(value) > -1) return null;
      visited.push(value);
    }
    if (!Array.isArray(value)) {
      var normalized = csfxNormalizeCartCandidate(value);
      if (normalized && typeof normalized === 'object') {
        var items = csfxCollectCartItems(normalized);
        if (items && items.length) return normalized;
      }
      if (csfxLooksLikeCartSkeleton(value)) {
        return value;
      }
    }
    var branchCount = 0;
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) {
        if (branchCount++ > CSFX_DEEP_CART_MAX_BRANCH) break;
        var found = csfxDeepFindCart(value[i], depth + 1, visited);
        if (found) return found;
      }
      return null;
    }
    var keys = Object.keys(value);
    keys.sort(function (a, b) {
      return csfxBranchScoreForKey(b) - csfxBranchScoreForKey(a);
    });
    for (var j = 0; j < keys.length; j++) {
      if (branchCount++ > CSFX_DEEP_CART_MAX_BRANCH) break;
      var key = keys[j];
      var child = value[key];
      if (child == null) continue;
      var childFound = csfxDeepFindCart(child, depth + 1, visited);
      if (childFound) return childFound;
    }
    return null;
  }

  function csfxInspectCandidate(value, source, svcRef, debug) {
    var type = value == null ? String(value) : typeof value;
    var normalized = null;
    var itemsCount = 0;
    var error = null;
    try {
      normalized = csfxNormalizeCartCandidate(value);
    } catch (errNorm) {
      error = errNorm;
    }
    if (normalized && typeof normalized === 'object') {
      try {
        var items = csfxCollectCartItems(normalized);
        if (Array.isArray(items)) itemsCount = items.length;
      } catch (errItems) {
        error = error || errItems;
      }
    }
    if (debug && debug.tried && typeof debug.tried.push === 'function') {
      var logEntry = {
        source: source,
        hit: !!normalized && itemsCount > 0,
        items: itemsCount,
        type: type
      };
      if (normalized) logEntry.normalized = true;
      if (error) logEntry.error = String(error);
      if (!normalized) logEntry.normalized = false;
      debug.tried.push(logEntry);
    }
    if (normalized) {
      return {
        cart: normalized,
        source: source,
        cartService: svcRef || null,
        debug: debug || null,
        itemsCount: itemsCount
      };
    }
    return null;
  }

  function csfxEnumerateStorageCarts(debug) {
    var stores = [];
    if (typeof localStorage !== 'undefined') {
      stores.push({ api: localStorage, label: 'localStorage', keys: csfxCartStorageKeyList() });
    }
    if (typeof sessionStorage !== 'undefined') {
      stores.push({ api: sessionStorage, label: 'sessionStorage', keys: csfxSessionCartKeyList() });
    }
    var map = {};
    var results = [];

    function rememberCandidate(mapKey, candidate, meta) {
      if (!candidate) return;
      var current = map[mapKey];
      if (!current || (candidate.itemsCount || 0) >= (current.itemsCount || 0)) {
        candidate.storageKey = meta.key;
        candidate.storageType = meta.label;
        candidate.storageSource = meta.label + '.' + meta.key;
        map[mapKey] = candidate;
      }
    }

    stores.forEach(function (store) {
      if (!store || !store.api) return;
      var keys = Array.isArray(store.keys) ? store.keys : [];
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (!key || typeof key !== 'string') continue;
        var mapKey = store.label + ':' + key;
        try {
          var raw = store.api.getItem(key);
          if (!raw) {
            if (debug && debug.tried) {
              debug.tried.push({ source: store.label + '.' + key, hit: false, empty: true, type: 'string' });
            }
            continue;
          }
          if (typeof raw === 'string' && raw.length > 2e6) {
            continue;
          }
          var parsed = raw;
          try {
            parsed = JSON.parse(raw);
          } catch (_errParse) {}
          var candidate = csfxInspectCandidate(parsed, store.label + '.' + key, null, debug);
          if (!candidate && parsed !== raw) {
            candidate = csfxInspectCandidate(raw, store.label + '.' + key + '(raw)', null, debug);
          }
          if (!candidate) {
            var deep = csfxDeepFindCart(parsed, 0, null);
            if (!deep && parsed !== raw) {
              deep = csfxDeepFindCart(raw, 0, null);
            }
            if (deep) {
              candidate = csfxInspectCandidate(deep, store.label + '.' + key + '(deep)', null, debug);
            }
          }
          rememberCandidate(mapKey, candidate, { key: key, label: store.label });
        } catch (_errStorage) {
          if (debug && debug.tried) {
            debug.tried.push({
              source: store.label + '.' + key,
              error: String(_errStorage),
              hit: false
            });
          }
        }
      }
    });
    Object.keys(map).forEach(function (k) {
      if (map[k]) results.push(map[k]);
    });
    results.sort(function (a, b) {
      return (b.itemsCount || 0) - (a.itemsCount || 0);
    });
    return results;
  }

  function csfxFindCartKeyInSettings(obj, depth) {
    if (!obj || typeof obj !== 'object') return '';
    if (depth > 6) return '';
    var markers = [
      'current_cart_key', 'active_cart_key', 'currentCartKey', 'activeCartKey',
      'current_cart', 'active_cart', 'selected_cart_key', 'selectedCartKey',
      'current_cart_id', 'currentCartId', 'active_cart_id', 'activeCartId'
    ];
    for (var i = 0; i < markers.length; i++) {
      var key = markers[i];
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        var val = obj[key];
        if (typeof val === 'string' || typeof val === 'number') {
          return String(val);
        }
      }
    }
    var keys = Object.keys(obj);
    for (var j = 0; j < keys.length; j++) {
      var name = keys[j];
      var value = obj[name];
      if (value == null) continue;
      if (typeof value === 'string' || typeof value === 'number') {
        if (/cart.*key/i.test(name) || /key.*cart/i.test(name) || /cart.*id/i.test(name) || /id.*cart/i.test(name)) {
          return String(value);
        }
      }
    }
    for (var k = 0; k < keys.length; k++) {
      var childKey = keys[k];
      var child = obj[childKey];
      if (!child || typeof child !== 'object') continue;
      var nested = csfxFindCartKeyInSettings(child, depth + 1);
      if (nested) return nested;
    }
    return '';
  }

  function csfxReadActiveCartKey(debug) {
    if (typeof localStorage === 'undefined') return '';
    var raw = null;
    try {
      raw = localStorage.getItem('op_settings');
    } catch (_errSettings) {
      raw = null;
    }
    if (!raw) return '';
    var parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (_errParseSettings) {
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object') return '';
    var found = csfxFindCartKeyInSettings(parsed, 0);
    if (debug) {
      debug.activeCartKey = found || '';
    }
    return found || '';
  }

  function csfxSelectActiveCart(localCarts, debug) {
    if (!Array.isArray(localCarts) || !localCarts.length) return null;
    var activeKey = csfxReadActiveCartKey(debug);
    if (activeKey) {
      for (var i = 0; i < localCarts.length; i++) {
        var entry = localCarts[i];
        if (!entry) continue;
        var key = entry.storageKey || entry.source || '';
        if (!key) continue;
        if (String(key).toLowerCase() === String(activeKey).toLowerCase()) {
          return entry;
        }
      }
    }
    var best = null;
    var fallback = null;
    for (var j = 0; j < localCarts.length; j++) {
      var candidate = localCarts[j];
      if (!candidate || !candidate.cart) continue;
      var count = candidate.itemsCount || 0;
      if (count > 0) {
        if (!best || count > (best.itemsCount || 0)) {
          best = candidate;
        }
      } else if (!fallback) {
        fallback = candidate;
      }
    }
    return best || fallback || null;
  }


  function csfxEnsureServerCartFetch(debug, svcRef) {
    if (typeof fetch !== 'function') return null;
    var now = Date.now();
    if (csfxServerCartPromise) return csfxServerCartPromise;
    if (now - csfxServerCartLastErrorAt < CSFX_SERVER_CART_ERROR_COOLDOWN) return null;

    var registerId = null;
    if (svcRef && typeof svcRef === 'object') {
      registerId = csfxExtractRegisterId(svcRef, 'cartService') || registerId;
    }
    if (!registerId) {
      registerId = csfxGuessRegisterId();
    }
    var payload = {};
    if (registerId) {
      payload.register_id = registerId;
    }
    csfxServerCartDebug = {
      status: 'pending',
      requestedAt: now,
      registerId: registerId || null
    };
    var requestInit = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin'
    };
    try {
      requestInit.body = JSON.stringify(payload);
    } catch (_errStr) {
      requestInit.body = '{}';
    }
    csfxServerCartPromise = fetch('/wp-json/op/v1/cart/current-cart', requestInit).then(function (resp) {
      csfxServerCartDebug = Object.assign({}, csfxServerCartDebug, {
        httpStatus: resp.status,
        ok: resp.ok
      });
      if (!resp.ok) {
        throw new Error('HTTP ' + resp.status);
      }
      return resp.json().catch(function (errJson) {
        throw new Error('Invalid JSON: ' + (errJson && errJson.message ? errJson.message : 'parse error'));
      });
    }).then(function (payload) {
      var data = null;
      if (payload && typeof payload === 'object') {
        if (payload.response && typeof payload.response === 'object') {
          if (payload.response.data && typeof payload.response.data === 'object') {
            data = payload.response.data;
          }
          csfxServerCartDebug = Object.assign({}, csfxServerCartDebug, {
            responseStatus: payload.response.status
          });
        } else if (payload.data && typeof payload.data === 'object') {
          data = payload.data;
        }
      }
      var normalized = csfxNormalizeCartCandidate(data);
      csfxServerCartCache = normalized || null;
      csfxServerCartFetchedAt = Date.now();
      csfxServerCartLastErrorAt = 0;
      csfxServerCartDebug = Object.assign({}, csfxServerCartDebug, {
        status: normalized ? 'success' : 'empty',
        fetchedAt: csfxServerCartFetchedAt,
        itemCount: normalized && normalized.items ? (Array.isArray(normalized.items) ? normalized.items.length : Object.keys(normalized.items).length || 0) : 0
      });
      try {
        document.dispatchEvent(new CustomEvent('csfx:cart-updated', {
          detail: {
            source: 'rest.current-cart',
            async: true,
            registerId: registerId || null
          }
        }));
      } catch (_errEvent) {}
      return csfxServerCartCache;
    }).catch(function (err) {
      csfxServerCartLastErrorAt = Date.now();
      csfxServerCartDebug = Object.assign({}, csfxServerCartDebug || {}, {
        status: 'error',
        error: err && err.message ? err.message : String(err)
      });
      return null;
    }).finally(function () {
      csfxServerCartPromise = null;
    });
    if (debug && debug.tried && Array.isArray(debug.tried)) {
      debug.tried.push({
        source: 'rest.current-cart',
        hit: false,
        async: true,
        registerId: registerId || null
      });
    }
    return csfxServerCartPromise;
  }

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
      '.csfx-dual-box{margin-top:10px;padding:14px;border-radius:14px;background:linear-gradient(160deg,rgba(0,87,183,.13),rgba(255,255,255,.97));border:1px solid rgba(0,87,183,.22);box-shadow:0 8px 24px rgba(10,30,70,.16);max-width:320px;font-family:inherit;}',
      '.csfx-dual-box h4{margin:0 0 10px;font-size:17px;font-weight:700;color:#0f172a;display:flex;align-items:center;gap:8px;}',
      '.csfx-dual-heading-icon{display:inline-flex;width:30px;height:30px;border-radius:10px;background:#0c4a94;color:#fff;align-items:center;justify-content:center;font-size:18px;box-shadow:0 4px 10px rgba(12,74,148,.3);}',
      '.csfx-dual-grid{display:grid;grid-template-columns:auto auto;column-gap:12px;row-gap:6px;font-size:14px;color:#0f172a;font-weight:600;}',
      '.csfx-dual-grid strong{color:#0b1f3a;font-size:16px;font-weight:700;}',
      '.csfx-dual-input{margin-top:12px;display:flex;flex-direction:column;gap:6px;font-size:13px;}',
      '.csfx-dual-input span{font-weight:700;color:#072c59;font-size:14px;}',
      '.csfx-dual-input input{padding:7px 10px;border:1px solid rgba(0,87,183,.26);border-radius:10px;font-size:15px;font-weight:600;color:#0f172a;background:#fff;transition:box-shadow .2s ease,border-color .2s ease;}',
      '.csfx-dual-input input:focus{outline:none;border-color:#0057b7;box-shadow:0 0 0 2px rgba(0,87,183,.18);}',
      '.csfx-dual-metrics{margin-top:12px;border-radius:10px;background:#f8fbff;border:1px solid rgba(7,44,89,.07);overflow:hidden;box-shadow:0 4px 12px rgba(7,44,89,.06);}',
      '.csfx-dual-metrics-row{display:grid;grid-template-columns:1fr auto;padding:9px 12px;font-size:13px;font-weight:600;color:#0f172a;align-items:center;gap:10px;}',
      '.csfx-dual-metrics-row:nth-child(odd){background:rgba(227,242,255,.65);}',
      '.csfx-dual-metrics-row.is-highlight{background:rgba(16,185,129,.18)!important;color:#065f46;}',
      '.csfx-dual-metrics-row.is-warning{background:rgba(251,191,36,.22)!important;color:#92400e;}',
      '.csfx-dual-metrics-label{display:flex;align-items:center;gap:6px;}',
      '.csfx-dual-metrics-help{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:#0d5ad6;color:#fff;font-size:11px;box-shadow:0 2px 4px rgba(11,106,212,.25);position:relative;cursor:help;}',
      '.csfx-dual-metrics-help::after{content:attr(data-tooltip);position:absolute;left:50%;top:calc(100% + 8px);transform:translateX(-50%);background:#0f172a;color:#fff;font-size:11px;font-weight:500;line-height:1.35;padding:6px 8px;border-radius:6px;opacity:0;pointer-events:none;white-space:normal;width:180px;box-shadow:0 8px 16px rgba(15,23,42,.25);transition:opacity .15s ease .3s;}',
      '.csfx-dual-metrics-help::before{content:\"\";position:absolute;left:50%;top:100%;transform:translateX(-50%);border:6px solid transparent;border-top-color:#0f172a;opacity:0;transition:opacity .15s ease .3s;}',
      '.csfx-dual-metrics-help:hover::after,.csfx-dual-metrics-help:focus::after{opacity:1;transition-delay:.25s;}',
      '.csfx-dual-metrics-help:hover::before,.csfx-dual-metrics-help:focus::before{opacity:1;transition-delay:.25s;}',
      '.csfx-dual-metrics-value{font-size:16px;font-weight:700;color:#052c65;}',
      '.csfx-dual-helper{margin-top:8px;display:flex;align-items:center;gap:8px;font-size:12px;color:#0f172a;background:rgba(0,87,183,.08);padding:6px 10px;border-radius:9px;border:1px dashed rgba(0,87,183,.2);cursor:pointer;}',
      '.csfx-dual-helper-icon{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:50%;background:#0b6ad4;color:#fff;font-size:11px;box-shadow:0 2px 4px rgba(11,106,212,.25);position:relative;cursor:help;}',
      '.csfx-dual-helper-icon::after{content:attr(data-tooltip);position:absolute;left:50%;top:calc(100% + 8px);transform:translateX(-50%);background:#0f172a;color:#fff;font-size:11px;font-weight:500;line-height:1.35;padding:6px 8px;border-radius:6px;opacity:0;pointer-events:none;white-space:normal;width:200px;box-shadow:0 8px 16px rgba(15,23,42,.25);transition:opacity .15s ease .3s;}',
      '.csfx-dual-helper-icon::before{content:\"\";position:absolute;left:50%;top:100%;transform:translateX(-50%);border:6px solid transparent;border-top-color:#0f172a;opacity:0;transition:opacity .15s ease .3s;}',
      '.csfx-dual-helper-icon:hover::after,.csfx-dual-helper-icon:focus::after{opacity:1;transition-delay:.25s;}',
      '.csfx-dual-helper-icon:hover::before,.csfx-dual-helper-icon:focus::before{opacity:1;transition-delay:.25s;}',
      '.csfx-dual-helper-label{font-size:12px;font-weight:600;color:#0f172a;}',
      '.csfx-dual-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:12px;}',
      '.csfx-btn{appearance:none;border:0;border-radius:999px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;transition:transform .2s ease,box-shadow .2s ease,background .2s ease,color .2s ease;font-family:inherit;min-width:0;}',
      '.csfx-btn:disabled{opacity:.45;cursor:not-allowed;box-shadow:none;transform:none;}',
      '.csfx-btn--primary{background:#0057b7;color:#fff;box-shadow:0 4px 12px rgba(0,87,183,.3);min-width:132px;}',
      '.csfx-btn--primary:hover:not(:disabled){background:#0b6ad4;box-shadow:0 6px 16px rgba(0,87,183,.4);}',
      '.csfx-btn--ghost{background:rgba(255,255,255,.65);color:#0f172a;border:1px solid rgba(15,23,42,.12);}',
      '.csfx-btn--ghost:hover:not(:disabled){background:#f1f5f9;}',
      '.csfx-btn--accent{background:#10b981;color:#fff;box-shadow:0 3px 12px rgba(16,185,129,.35);}',
      '.csfx-btn--accent:hover:not(:disabled){background:#0d9668;}',
      '.csfx-dual-status{margin-top:10px;font-size:13px;color:#0f172a;font-weight:600;}',
      '.csfx-dual-status--info{color:#0f766e;}',
      '.csfx-dual-status--warn{color:#b45309;}',
      '.csfx-dual-status--error{color:#b91c1c;}',
      '.csfx-dual-status--ok{color:#047857;font-weight:700;}',
      '.csfx-dual-note{margin-top:6px;font-size:11px;color:#4b5563;line-height:1.4;}',
      '.csfx-badge-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;cursor:pointer;padding-bottom:6px;border-bottom:1px solid rgba(15,23,42,.08);}',
      '.csfx-badge-top-title{font-size:15px;font-weight:700;color:#0b1f3a;display:flex;align-items:center;gap:8px;}',
      '.csfx-badge-close{background:none;border:0;color:#334155;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;transition:background .2s ease,color .2s ease;}',
      '.csfx-badge-close:hover{background:rgba(148,163,184,.18);color:#0f172a;}',
      '.csfx-badge-info{margin-bottom:8px;font-size:15px;line-height:1.5;color:#0f172a;font-weight:600;}',
      '.csfx-dual-note strong{font-weight:700;}',
      // compactar el hueco de impuestos si se decide ocultar
       '.csfx-hide-tax{display:none!important;line-height:0!important;height:0!important;overflow:hidden!important;margin:0!important;padding:0!important;border:0!important;}',
      // badge colapsable para mostrar la tasa y hora
      '.csfx-badge{position:fixed;right:12px;bottom:96px;z-index:10000;font-family:inherit;cursor:pointer;display:flex;flex-direction:column;align-items:stretch;width:auto;}', /* bottom se recalcula por JS */
      '.csfx-badge-handle{background:#0057b7;color:#fff;padding:10px 16px;border-radius:12px 12px 0 0;font-size:15px;display:flex;align-items:center;gap:10px;box-shadow:0 8px 18px rgba(0,87,183,.35);transition:background .2s ease,box-shadow .2s ease;width:100%;}',
      '.csfx-badge-handle:hover{background:#0b6ad4;}',
      '.csfx-badge-handle *{pointer-events:none;}',
      '.csfx-badge:not(.open) .csfx-badge-handle{padding:8px 6px;font-size:13px;gap:4px;justify-content:flex-end;}',
      '.csfx-badge:not(.open) .csfx-badge-label{font-size:13px;text-align:right;display:inline-block;}',
      '.csfx-badge:not(.open) .csfx-badge-icon{width:20px;height:20px;}',
      '.csfx-badge-icon{display:inline-flex;width:24px;height:24px;border-radius:50%;background:rgba(255,255,255,.3);align-items:center;justify-content:center;font-size:15px;box-shadow:0 4px 10px rgba(255,255,255,.2);}',
      '.csfx-badge-label{font-size:13px;font-weight:600;}',
      '.csfx-badge-content{background:#ffffff;color:#0f172a;padding:12px 14px;border-radius:0 0 12px 12px;display:none;font-size:13px;white-space:nowrap;box-shadow:0 16px 32px rgba(15,23,42,.25);border:1px solid rgba(15,23,42,.06);min-width:260px;}',
       '.csfx-badge.open .csfx-badge-content{display:block;}',
      '.csfx-modal-backdrop{position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(15,23,42,.45);backdrop-filter:blur(3px);z-index:10001;}',
      '.csfx-modal-backdrop[data-open=\"true\"]{display:flex;}',
      '.csfx-modal{background:#ffffff;border-radius:16px;min-width:320px;max-width:520px;width:90%;box-shadow:0 18px 48px rgba(15,23,42,.35);overflow:hidden;font-family:inherit;}',
      '.csfx-modal-header{background:#0057b7;color:#fff;padding:16px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;}',
      '.csfx-modal-header-title{display:flex;align-items:center;gap:10px;font-size:16px;font-weight:700;}',
      '.csfx-modal-header-icon{display:inline-flex;width:28px;height:28px;border-radius:8px;background:rgba(255,255,255,.18);align-items:center;justify-content:center;font-size:16px;}',
      '.csfx-modal-header-ref{font-size:12px;font-weight:600;opacity:.85;}',
      '.csfx-modal-body{padding:18px 20px;display:flex;flex-direction:column;gap:16px;}',
      '.csfx-auth-card{border:1px solid rgba(0,87,183,.22);background:rgba(0,87,183,.06);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px;}',
      '.csfx-auth-title{font-size:13px;font-weight:700;color:#0f172a;}',
      '.csfx-auth-row{display:flex;gap:10px;align-items:center;}',
      '.csfx-auth-row input{flex:1;padding:8px 12px;border-radius:8px;border:1px solid rgba(15,23,42,.12);font-size:14px;}',
      '.csfx-auth-row input:focus{outline:none;border-color:#0057b7;box-shadow:0 0 0 2px rgba(0,87,183,.2);}',
      '.csfx-auth-hint{font-size:12px;color:#334155;}',
      '.csfx-auth-status{font-size:12px;font-weight:600;color:#334155;}',
      '.csfx-auth-status--ok{color:#0f766e;}',
      '.csfx-auth-status--error{color:#b91c1c;}',
      '.csfx-item-list{display:flex;flex-direction:column;gap:10px;max-height:45vh;overflow:auto;padding-right:4px;}',
      '.csfx-item-card{border:1px solid rgba(15,23,42,.1);border-radius:10px;padding:12px 14px;background:#f8fafc;display:flex;flex-direction:column;gap:6px;}',
      '.csfx-item-header{display:flex;justify-content:space-between;gap:8px;color:#0f172a;font-weight:700;font-size:13px;}',
      '.csfx-item-meta{display:flex;flex-wrap:wrap;gap:12px;font-size:12px;color:#475569;}',
      '.csfx-item-actions{display:flex;gap:8px;align-items:center;margin-top:4px;}',
      '.csfx-item-actions input{width:90px;padding:6px 8px;border-radius:8px;border:1px solid rgba(15,23,42,.16);font-size:13px;text-align:right;}',
      '.csfx-item-actions input:focus{outline:none;border-color:#0057b7;box-shadow:0 0 0 2px rgba(0,87,183,.16);}',
      '.csfx-item-actions small{font-size:11px;color:#475569;}',
      '.csfx-item-feedback{font-size:11px;color:#334155;margin-top:4px;}',
      '.csfx-item-feedback--ok{color:#047857;}',
      '.csfx-item-feedback--error{color:#b91c1c;}',
      '.csfx-modal--info{max-width:420px;}',
      '.csfx-modal--info .csfx-modal-body{gap:14px;}',
      '.csfx-explain-body{display:flex;flex-direction:column;gap:12px;font-size:13px;color:#0f172a;}',
      '.csfx-explain-head{font-weight:700;color:#0b1f3a;}',
      '.csfx-explain-steps{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px;}',
      '.csfx-explain-steps li{display:flex;gap:8px;line-height:1.45;}',
      '.csfx-explain-steps strong{color:#0b6ad4;}',
      '.csfx-explain-inline{font-weight:600;color:#072c59;}',
      '.csfx-explain-foot{font-size:12px;color:#475569;line-height:1.4;}',
      '.csfx-modal-footer{display:flex;justify-content:flex-end;gap:10px;margin-top:8px;}',
      '.csfx-empty-copy{font-size:13px;color:#475569;text-align:center;padding:18px 0;}',
      '.csfx-guard-message{font-size:14px;color:#334155;text-align:center;padding:24px 6px;border:1px dashed rgba(51,65,85,.25);border-radius:12px;background:rgba(241,245,249,.6);}',
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
      t += ' · <strong>Act.:</strong> ' + hh;
    }
    if (FX.disc && FX.disc.active && FX.disc.percent > 0) {
      t += ' · <strong>Desc:</strong> ' + FX.disc.percent + '%';
    }
    return t;
  }

  function csfxUpdateBadgeHandle(badge) {
    if (!badge) return;
    var handle = badge.querySelector('.csfx-badge-handle');
    if (!handle) return;
    var rateText = '--';
    try {
      if (FX.rate) {
        rateText = Number(FX.rate).toFixed(FX.decimals);
      }
    } catch (_errRate) {}
    handle.innerHTML = '<span class="csfx-badge-icon">🏷️</span><span class="csfx-badge-label">' + rateText + '</span>';
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
      handle.innerHTML = '';
      var content = document.createElement('div');
      content.className = 'csfx-badge-content';
      badge.appendChild(handle);
      badge.appendChild(content);
      document.body.appendChild(badge);
    }
    var handle = badge.querySelector('.csfx-badge-handle');
    if (handle && !handle.dataset.csfxBound) {
      handle.dataset.csfxBound = '1';
      handle.addEventListener('click', function (e) {
        e.stopPropagation();
        badge.classList.toggle('open');
        if (badge.classList.contains('open')) {
          csfxRenderBadgeContent(badge);
        }
      });
    }
    if (!badge.dataset.csfxBadgeBound) {
      badge.dataset.csfxBadgeBound = '1';
      badge.addEventListener('click', function (ev) {
        if (ev.target.closest('.csfx-badge-content')) return;
        if (!badge.classList.contains('open')) {
          badge.classList.add('open');
          csfxRenderBadgeContent(badge);
        }
        ev.stopPropagation();
      });
    }
    csfxUpdateBadgeHandle(badge);
    csfxRenderBadgeContent(badge);
  }

  if (typeof window !== 'undefined' && !window.__CSFX_BADGE_OUTSIDE__) {
    window.__CSFX_BADGE_OUTSIDE__ = true;
    document.addEventListener('click', function (ev) {
      var badge = document.querySelector('.csfx-badge');
      if (!badge || !badge.classList.contains('open')) return;
      if (badge.contains(ev.target)) return;
      if (csfxCustomModalState && csfxCustomModalState.open) return;
      badge.classList.remove('open');
    });
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
    var svc = csfxGetCartService(debug);
    var best = null;
    var fallback = null;

    function consider(candidate) {
      if (!candidate || !candidate.cart) return;
      candidate.debug = debug;
      if (typeof candidate.itemsCount !== 'number') candidate.itemsCount = 0;
      if (candidate.itemsCount > 0) {
        if (!best || candidate.itemsCount > (best.itemsCount || 0)) {
          best = candidate;
        }
      } else if (!fallback) {
        fallback = candidate;
      }
    }

    function noteAsyncPromise(promise, sourceLabel) {
      if (!promise || typeof promise.then !== 'function') return;
      debug.tried.push({ source: sourceLabel, hit: false, async: true });
      promise.then(function (payload) {
        var normalized = csfxNormalizeCartCandidate(payload);
        if (!normalized) return;
        var items = csfxCollectCartItems(normalized);
        if (items && items.length) {
          csfxRememberAsyncCart(normalized, sourceLabel);
        }
      }).catch(function () {});
    }

    if (svc && typeof svc === 'object') {
      var svcSources = [];
      try {
        if (typeof svc.getCurrentCart === 'function') {
          var current = svc.getCurrentCart();
          if (current && typeof current.then === 'function') {
            noteAsyncPromise(current, 'cartService.getCurrentCart()');
          } else {
            svcSources.push({ value: current, source: 'cartService.getCurrentCart()' });
          }
        }
      } catch (errCurrent) {
        debug.tried.push({ source: 'cartService.getCurrentCart()', error: String(errCurrent) });
      }
      try {
        if (typeof svc.getCart === 'function') {
          var legacy = svc.getCart();
          if (legacy && typeof legacy.then === 'function') {
            noteAsyncPromise(legacy, 'cartService.getCart()');
          } else {
            svcSources.push({ value: legacy, source: 'cartService.getCart()' });
          }
        }
      } catch (errLegacy) {
        debug.tried.push({ source: 'cartService.getCart()', error: String(errLegacy) });
      }
      svcSources.push(
        { value: svc.cart, source: 'cartService.cart' },
        { value: svc._cart, source: 'cartService._cart' },
        { value: svc.cart_data, source: 'cartService.cart_data' },
        { value: svc.cartData, source: 'cartService.cartData' }
      );
      for (var si = 0; si < svcSources.length; si++) {
        var svcCandidate = svcSources[si];
        if (!svcCandidate) continue;
        consider(csfxInspectCandidate(svcCandidate.value, svcCandidate.source, svc, debug));
        var deepSvc = csfxDeepFindCart(svcCandidate.value, 0, null);
        if (deepSvc) {
          consider(csfxInspectCandidate(deepSvc, svcCandidate.source + '(deep)', svc, debug));
        }
      }
      var deepSvcRoot = csfxDeepFindCart(svc, 0, null);
      if (deepSvcRoot) {
        consider(csfxInspectCandidate(deepSvcRoot, 'cartService(deep)', svc, debug));
      }
    }

    var asyncCart = csfxGetCachedAsyncCart();
    if (asyncCart) {
      consider(csfxInspectCandidate(asyncCart, 'cart.async-cache', svc, debug));
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
    for (var gi = 0; gi < globalCandidates.length; gi++) {
      var gc = globalCandidates[gi];
      if (!gc) continue;
      consider(csfxInspectCandidate(gc.value, gc.source, gc.service, debug));
      var deepGlobal = csfxDeepFindCart(gc.value, 0, null);
      if (deepGlobal) {
        consider(csfxInspectCandidate(deepGlobal, gc.source + '(deep)', gc.service, debug));
      }
    }

    var localCarts = csfxEnumerateStorageCarts(debug);
    if (localCarts && localCarts.length) {
      var selected = csfxSelectActiveCart(localCarts, debug);
      if (selected) {
        consider(selected);
      } else {
        localCarts.forEach(function (entry) { consider(entry); });
      }
    }

    var cachedServerCart = csfxGetCachedServerCart();
    if (cachedServerCart) {
      var serverCandidate = csfxInspectCandidate(cachedServerCart, 'rest.current-cart(cache)', svc, debug);
      if (serverCandidate) {
        serverCandidate.debug.serverCart = Object.assign({ source: 'cache' }, csfxServerCartDebug || {});
      }
      consider(serverCandidate);
    } else {
      csfxEnsureServerCartFetch(debug, svc);
    }

    if (csfxAsyncCartDebug) {
      debug.asyncCart = Object.assign({}, csfxAsyncCartDebug);
    }
    if (!debug.serverCart && csfxServerCartDebug) {
      debug.serverCart = Object.assign({ source: 'debug' }, csfxServerCartDebug);
    }

    return best || fallback || { cart: null, source: null, debug: debug, cartService: svc, itemsCount: 0 };
  }

  function csfxLoadStoredCart() {
    var carts = csfxEnumerateStorageCarts(null);
    if (!carts || !carts.length) return null;
    var selected = csfxSelectActiveCart(carts, null);
    if (selected && selected.cart) return selected.cart;
    return carts[0] && carts[0].cart ? carts[0].cart : null;
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
    var shouldConsole = false;
    try {
      if (FX && FX.debug) shouldConsole = true;
      if (!shouldConsole && window && typeof window.CSFX_DEBUG_LOGS !== 'undefined') {
        shouldConsole = !!window.CSFX_DEBUG_LOGS;
      }
      if (!shouldConsole && typeof localStorage !== 'undefined') {
        shouldConsole = localStorage.getItem('csfx_debug_logs') === '1';
      }
    } catch (_errDebugFlag) {}
    try {
      if (shouldConsole && window && window.console) {
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

  /**
   * csfx: fallback UI para aplicar descuento manual cuando no hay CartService.
   *
   * Referencia (probado manualmente):
   * // Fallback UI: abre el diálogo de descuento manual y aplica discountValue
   * // function applyDualDiscountViaUI(discountValue) {
   * //   const btn = document.querySelector('button[mat-icon-button][aria-label*="Descu"]') ||
   * //               document.querySelector('.cart-discount button');
   * //   if (!btn) return false;
   * //   btn.click();
   * //   setTimeout(() => {
   * //     const input = document.querySelector('input[formcontrolname="discount_amount"]') ||
   * //                   document.querySelector('input[name="discount_amount"]');
   * //     const typeSelect = document.querySelector('mat-select[formcontrolname="discount_type"]') ||
   * //                        document.querySelector('select[name="discount_type"]');
   * //     const formatted = discountValue.toFixed(2).replace('.', ',');
   * //     if (input) {
   * //       input.value = formatted;
   * //       input.dispatchEvent(new Event('input', { bubbles: true }));
   * //     }
   * //     if (typeSelect) {
   * //       typeSelect.value = 'fixed';
   * //       typeSelect.dispatchEvent(new Event('change', { bubbles: true }));
   * //     } else {
   * //       const fixedBtn = document.querySelector('button[role="radio"][aria-label*="$"]');
   * //       if (fixedBtn) fixedBtn.click();
   * //     }
   * //     const confirmBtn = document.querySelector('button[mat-dialog-confirm]') ||
   * //                        document.querySelector('button[mat-raised-button][color="primary"]');
   * //     if (confirmBtn) confirmBtn.click();
   * //   }, 150);
   * //   return true;
   * // }
   */
  function applyDualDiscountViaUI(discountValue, hooks) {
    var rawNormalized = discountValue;
    if (typeof rawNormalized === 'string') {
      var sanitized = rawNormalized.replace(/\s+/g, '').replace(/[^0-9,.\-]/g, '');
      if (sanitized.indexOf(',') > -1 && sanitized.indexOf('.') > -1) {
        sanitized = sanitized.replace(/\./g, '');
      }
      rawNormalized = sanitized.replace(/,/g, '.');
    }
    var numericDiscount = Number(rawNormalized);
    var amount = round(Math.max(0, numericDiscount || 0), FX.decimals);
    if (!isFinite(amount) || amount <= 0) {
      csfxDualLog('ui-discount:invalid-amount', { amount: discountValue });
      return false;
    }
    var trigger = document.querySelector('button[mat-icon-button][aria-label*="Descu"]') ||
      document.querySelector('.cart-discount button') ||
      document.querySelector('button[aria-label*="Descuento"], button[aria-label*="discount"]');
    if (!trigger) {
      csfxDualLog('ui-discount:no-trigger', { amount: amount });
      return false;
    }
    try { trigger.click(); } catch (_errClick) {}
    csfxDualLog('ui-discount:open', { amount: amount });
    var formatted = amount.toFixed(2).replace('.', ',');
    var afterFn = hooks && typeof hooks.after === 'function' ? hooks.after : null;
    var doneFn = hooks && typeof hooks.onDone === 'function' ? hooks.onDone : null;

    setTimeout(function () {
      var input = document.querySelector('input[formcontrolname="discount_amount"]') ||
        document.querySelector('input[name="discount_amount"]') ||
        (function () {
          var dialogs = document.querySelectorAll('mat-dialog-container input, .mat-dialog-container input');
          return dialogs.length ? dialogs[0] : null;
        })();
      if (input) {
        try {
          input.focus();
          input.value = formatted;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('blur', { bubbles: true }));
        } catch (_errInput) {}
      } else {
        csfxDualLog('ui-discount:no-input', {});
      }

      var select = document.querySelector('mat-select[formcontrolname="discount_type"]') ||
        document.querySelector('select[name="discount_type"]');

      var ensureFixed = function () {
        var fixedBtn = document.querySelector('button[role="radio"][aria-label*="$"]') ||
          document.querySelector('button[role="radio"][aria-label*="fijo"]') ||
          document.querySelector('button[role="radio"][aria-label*="fixed"]');
        if (fixedBtn) {
          try { fixedBtn.click(); } catch (_errRadio) {}
          return true;
        }
        var fixedOption = Array.prototype.find.call(document.querySelectorAll('mat-option'),
          function (opt) {
            return opt && /fijo|fixed|\$/i.test(opt.textContent || '');
          });
        if (fixedOption) {
          try { fixedOption.click(); } catch (_errOpt) {}
          return true;
        }
        return false;
      };

      var fixedHandled = false;
      if (select) {
        try {
          var tagName = select.tagName ? select.tagName.toLowerCase() : '';
          if (tagName === 'select') {
            select.value = 'fixed';
            select.dispatchEvent(new Event('change', { bubbles: true }));
            fixedHandled = true;
          } else {
            select.dispatchEvent(new Event('click', { bubbles: true }));
            setTimeout(ensureFixed, 160);
            fixedHandled = true;
          }
        } catch (_errSelect) {}
      }
      if (!fixedHandled) {
        ensureFixed();
      }

      setTimeout(function () {
        var confirmBtn = document.querySelector('button[mat-dialog-confirm]') ||
          document.querySelector('button[mat-raised-button][color="primary"]') ||
          document.querySelector('mat-dialog-container button.mat-primary') ||
          document.querySelector('.mat-dialog-container button.mat-primary');
        if (confirmBtn) {
          try { confirmBtn.click(); } catch (_errConfirm) {}
          csfxDualLog('ui-discount:confirm', { amount: amount });
          csfxDualLog('ui-discount:manualVia', { manualVia: 'ui' });
          setTimeout(function () {
            if (afterFn) {
              try {
                var snap = csfxGetCartSnapshot();
                afterFn(snap);
              } catch (afterErr) {
                csfxDualLog('ui-discount:after-error', { error: String(afterErr) });
              }
            }
            if (doneFn) doneFn(true);
          }, 600);
        } else {
          csfxDualLog('ui-discount:no-confirm', {});
          if (doneFn) doneFn(false);
        }
      }, 160);
    }, 180);

    return true;
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
      cart.discount_source = '';
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
      cart.discountSource = '';
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
    var keys = ['op_cart', 'op_cache_cart', 'op_local_cart', '_op_cart_data', 'op_cart_data', 'op_cart_v8', 'op_v5_cart', 'op_cart_backup', 'op_cart_latest', 'op_cart_store'];
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
    if (!snapshot || !calc) return false;
    var cart = (snapshot.cart && typeof snapshot.cart === 'object') ? snapshot.cart : {};
    if (!cart.totals || typeof cart.totals !== 'object') cart.totals = {};
    if (!snapshot.cart) {
      csfxDualLog('apply:no-cart', {
        cartSource: snapshot.cartSource,
        cartDebug: snapshot.cartDebug
      });
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
    var discountValue = round(Math.max(0, calc && calc.discount ? calc.discount : 0), FX.decimals);
    if (!isFinite(discountValue) || discountValue <= 0) {
      csfxDualLog('apply:no-discount', { calc: calc, discountValue: discountValue });
      return false;
    }
    csfxDualLog('apply:start', {
      baseTotal: baseTotal,
      calc: calc,
      snapshotTotal: snapshot.totalUSD,
      existingDiscount: cart.discount_amount,
      existingFinalDiscount: cart.final_discount_amount,
      hasService: !!snapshot.cartService,
      cartSource: snapshot.cartSource,
      manualVia: 'ui'
    });
    if (snapshot.cartDebug && typeof snapshot.cartDebug === 'object') {
      snapshot.cartDebug.manualVia = 'ui';
    }

    var usdPaidRounded = round(calc.netEffective, FX.decimals);
    var pctStored = Number(FX && FX.disc && FX.disc.percent ? FX.disc.percent : 0);
    var pctDisplay = pctStored;
    if (pctDisplay > 0 && pctDisplay < 1) pctDisplay = pctDisplay * 100;
    var pctRounded = round(pctDisplay, 2);
    var note = 'Descuento dual del ' + pctRounded.toFixed(2) + '% aplicado sobre ' + fmtUsd(calc.grossCovered) + ', cliente pagó ' + fmtUsd(calc.netEffective) + ' en divisas.';

    var syncDiscountFields = function (targetCart) {
      if (!targetCart || typeof targetCart !== 'object') return;
      if (!targetCart.totals || typeof targetCart.totals !== 'object') targetCart.totals = {};
      var codeAmt = round(Math.max(0, Number(targetCart.discount_code_amount || 0)), FX.decimals);
      var itemsAmt = round(Math.max(0, Number(targetCart.final_items_discount_amount || 0)), FX.decimals);
      var combined = round(codeAmt + itemsAmt + discountValue, FX.decimals);
      targetCart.discount_source = '';
      targetCart.discountSource = '';
      targetCart.discount_type = 'fixed';
      targetCart.discountType = 'fixed';
      targetCart.discount_amount = discountValue;
      targetCart.discountAmount = discountValue;
      targetCart.discount_final_amount = discountValue;
      targetCart.discountFinalAmount = discountValue;
      targetCart.discount_tax_amount = 0;
      targetCart.discountTaxAmount = 0;
      targetCart.discount_excl_tax = discountValue;
      targetCart.discountExclTax = discountValue;
      targetCart.cart_discount_amount = discountValue;
      targetCart.cartDiscountAmount = discountValue;
      targetCart.discount_code_amount = codeAmt;
      targetCart.discountCodeAmount = codeAmt;
      targetCart.final_items_discount_amount = itemsAmt;
      targetCart.finalItemsDiscountAmount = itemsAmt;
      targetCart.final_discount_amount = combined;
      targetCart.finalDiscountAmount = combined;
      targetCart.final_discount_amount_incl_tax = combined;
      targetCart.finalDiscountAmountInclTax = combined;
      targetCart.add_discount = true;
      targetCart.addDiscount = true;
      targetCart.totals.discount = combined;
      targetCart.totals.discountAmount = combined;
      targetCart.totals.final_discount_amount = combined;
      targetCart.totals.finalDiscountAmount = combined;
    };

    var applyMetaToCart = function (targetCart) {
      if (!targetCart || typeof targetCart !== 'object') return;
      syncDiscountFields(targetCart);
      var targetMetaBase = targetCart.meta_data || targetCart.metaData;
      var targetMeta = csfxSanitizeMetaList(targetMetaBase && targetMetaBase.slice ? targetMetaBase.slice() : targetMetaBase);
      targetMeta = csfxUpsertMeta(targetMeta, 'csfx_usd_paid', usdPaidRounded);
      targetMeta = csfxUpsertMeta(targetMeta, 'csfx_discount_pct', pctStored);
      targetMeta = csfxUpsertMeta(targetMeta, 'csfx_discount_value', discountValue);
      targetMeta = csfxUpsertMeta(targetMeta, 'csfx_base_total', baseTotal);
      targetMeta = csfxUpsertMeta(targetMeta, 'csfx_discount_note', note);
      targetCart.meta_data = targetMeta;
      targetCart.metaData = targetMeta;
      targetCart.csfx_usd_paid = usdPaidRounded;
      targetCart.csfx_discount_pct = pctStored;
      targetCart.csfx_discount_value = discountValue;
      targetCart.csfx_base_total = baseTotal;
      targetCart.csfx_discount_note = note;
    };

    applyMetaToCart(cart);
    csfxPersistCart(cart);
    csfxDualLog('apply:meta', {
      discountValue: discountValue,
      pctStored: pctStored,
      meta: cart.meta_data,
      cartSummary: {
        discount_amount: cart.discount_amount,
        final_discount_amount: cart.final_discount_amount,
        grand_total: cart.grand_total,
        total: cart.total,
        total_due: cart.total_due,
        add_discount: cart.add_discount
      }
    });

    var uiPersisted = false;
    var uiDoneSuccess = null;

    var uiTriggered = applyDualDiscountViaUI(discountValue, {
      after: function (snapshotAfter) {
        if (!snapshotAfter || !snapshotAfter.cart) return;
        var uiCart = snapshotAfter.cart;
        if (OPCompat && typeof OPCompat.normalizeCart === 'function') {
          try { uiCart = OPCompat.normalizeCart(uiCart) || uiCart; } catch (_errUiNorm) {}
        }
        applyMetaToCart(uiCart);
        csfxPersistCart(uiCart);
        uiPersisted = true;
        csfxDualLog('apply:ui-persist', { success: true });
      },
      onDone: function (success) {
        uiDoneSuccess = !!success;
        csfxDualLog('apply:ui-done', { success: success });
      }
    });

    if (!uiTriggered) {
      csfxDualLog('apply:ui-not-triggered', { amount: discountValue });
      return false;
    }

    if (!uiPersisted) {
      setTimeout(function () {
        if (uiPersisted) return;
        try {
          var snapshotAfter = csfxGetCartSnapshot();
          if (snapshotAfter && snapshotAfter.cart) {
            applyMetaToCart(snapshotAfter.cart);
            csfxPersistCart(snapshotAfter.cart);
            csfxDualLog('apply:ui-persist-fallback', { amount: discountValue });
          } else {
            csfxPersistCart(cart);
          }
        } catch (persistErr) {
          csfxDualLog('apply:ui-persist-error', { error: String(persistErr) });
        }
      }, 800);
    }

    csfxDualLog('apply:ui', {
      manualVia: 'ui',
      cartDiscountAmount: cart.discount_amount,
      cartFinalDiscountAmount: cart.final_discount_amount
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

    csfxDualLog('apply:finished', {
      discountValue: discountValue,
      finalDiscountAmount: cart.final_discount_amount,
      finalDiscountAmountInclTax: cart.final_discount_amount_incl_tax,
      manualVia: 'ui',
      uiTriggered: true,
      uiDoneSuccess: uiDoneSuccess
    });

    return true;
  }

  function csfxRenderBadgeContent(badge) {
    if (!badge) return;
    csfxUpdateBadgeHandle(badge);
    var contentDiv = badge.querySelector('.csfx-badge-content');
    if (!contentDiv) return;
    if (!contentDiv.dataset.csfxBound) {
      contentDiv.dataset.csfxBound = '1';
      contentDiv.addEventListener('click', function (ev) {
        ev.stopPropagation();
      });
    }
    var topBar = contentDiv.querySelector('.csfx-badge-top');
    if (!topBar) {
      topBar = document.createElement('div');
      topBar.className = 'csfx-badge-top';
      var topTitle = document.createElement('span');
      topTitle.className = 'csfx-badge-top-title';
      topTitle.innerHTML = '<span class="csfx-badge-icon">🏷️</span><span>Referencia de tasa y descuento</span>';
      var closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'csfx-badge-close';
      closeBtn.setAttribute('aria-label', 'Cerrar panel');
      closeBtn.innerHTML = '&times;';
      topBar.appendChild(topTitle);
      topBar.appendChild(closeBtn);
      contentDiv.insertBefore(topBar, contentDiv.firstChild);
      topBar.addEventListener('click', function (ev) {
        ev.stopPropagation();
        badge.classList.remove('open');
      });
      closeBtn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        badge.classList.remove('open');
      });
    }
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
    var titleIcon = document.createElement('span');
    titleIcon.className = 'csfx-dual-heading-icon';
    titleIcon.textContent = '🏷️';
    var titleText = document.createElement('span');
    titleText.textContent = 'Descuento precio dual';
    title.appendChild(titleIcon);
    title.appendChild(titleText);
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

    var metrics = document.createElement('div');
    metrics.className = 'csfx-dual-metrics';
    var metricDefs = [
      { key: 'gross', label: 'Parte bruta', tip: 'Monto cubierto por el pago en divisas antes de descuentos.' },
      { key: 'discount', label: 'Descuento', tip: 'Descuento aplicado según la política de precio dual.' },
      { key: 'remaining-usd', label: 'Resta USD', tip: 'Saldo que queda por pagar en divisas luego del descuento.' },
      { key: 'remaining-bs', label: 'Resta Bs.', tip: 'Saldo restante en bolívares calculado con la tasa vigente.' }
    ];
    metricDefs.forEach(function (def) {
      var row = document.createElement('div');
      row.className = 'csfx-dual-metrics-row';
      row.dataset.csfxMetric = def.key;
      var labelWrap = document.createElement('span');
      labelWrap.className = 'csfx-dual-metrics-label';
      var helpIcon = document.createElement('span');
      helpIcon.className = 'csfx-dual-metrics-help';
      helpIcon.dataset.tooltip = def.tip;
      helpIcon.textContent = 'i';
      labelWrap.appendChild(helpIcon);
      labelWrap.appendChild(document.createTextNode(def.label));
      var value = document.createElement('span');
      value.className = 'csfx-dual-metrics-value';
      value.dataset.csfxMetricValue = def.key;
      value.textContent = '—';
      row.appendChild(labelWrap);
      row.appendChild(value);
      metrics.appendChild(row);
    });
    panel.appendChild(metrics);

    var helper = document.createElement('div');
    helper.className = 'csfx-dual-helper';
    var helperIcon = document.createElement('span');
    helperIcon.className = 'csfx-dual-helper-icon';
    helperIcon.dataset.tooltip = 'Haz clic para ver cómo explicar el descuento al cliente.';
    helperIcon.textContent = 'i';
    var helperLabel = document.createElement('span');
    helperLabel.className = 'csfx-dual-helper-label';
    helperLabel.textContent = 'Cómo explicar el descuento';
    helper.appendChild(helperIcon);
    helper.appendChild(helperLabel);
    helper.setAttribute('role', 'button');
    helper.tabIndex = 0;
    var explainHandler = function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      csfxOpenDualExplainModal(panel);
    };
    helper.addEventListener('click', explainHandler);
    helper.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') {
        explainHandler(ev);
      }
    });
    panel.appendChild(helper);

    var actions = document.createElement('div');
    actions.className = 'csfx-dual-actions';
    var confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'csfx-btn csfx-btn--primary';
    confirm.dataset.csfx = 'confirm';
    confirm.textContent = 'Aplicar descuento dual';
    actions.appendChild(confirm);
    var customBtn = document.createElement('button');
    customBtn.type = 'button';
    customBtn.className = 'csfx-btn csfx-btn--ghost';
    customBtn.dataset.csfx = 'custom-discount';
    customBtn.textContent = 'Descuento personalizado';
    actions.appendChild(customBtn);
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
    customBtn.addEventListener('click', function () { csfxOpenCustomDiscountModal(); });

    csfxUpdateDualPanel(panel);
    return panel;
  }

  function csfxResetDualChips(panel) {
    panel.querySelectorAll('[data-csfx-metric-value]').forEach(function (node) {
      node.textContent = '—';
    });
    panel.querySelectorAll('.csfx-dual-metrics-row').forEach(function (row) {
      row.classList.remove('is-highlight', 'is-warning');
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

    var metricsMap = {
      'gross': fmtUsd(calc.grossCovered),
      'discount': fmtUsd(calc.discount),
      'remaining-usd': fmtUsd(calc.remainderUsd),
      'remaining-bs': fmtBs(calc.remainderBs)
    };

    Object.keys(metricsMap).forEach(function (key) {
      var node = panel.querySelector('[data-csfx-metric-value="' + key + '"]');
      if (node) node.textContent = metricsMap[key];
    });
    var discountRow = panel.querySelector('[data-csfx-metric="discount"]');
    if (discountRow) {
      if (calc.discount > 0.009) {
        discountRow.classList.add('is-highlight');
      } else {
        discountRow.classList.remove('is-highlight');
      }
    }
    var remainingUsdRow = panel.querySelector('[data-csfx-metric="remaining-usd"]');
    if (remainingUsdRow) {
      if (calc.remainderUsd > 0.009) {
        remainingUsdRow.classList.add('is-warning');
      } else {
        remainingUsdRow.classList.remove('is-warning');
      }
    }
    var remainingBsRow = panel.querySelector('[data-csfx-metric="remaining-bs"]');
    if (remainingBsRow) {
      if (calc.remainderBs > 0.009) {
        remainingBsRow.classList.add('is-warning');
      } else {
        remainingBsRow.classList.remove('is-warning');
      }
    }

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

  function csfxEnsureExplainModal() {
    if (csfxExplainModalUI && csfxExplainModalUI.backdrop && document.body.contains(csfxExplainModalUI.backdrop)) {
      return csfxExplainModalUI;
    }
    var backdrop = document.createElement('div');
    backdrop.className = 'csfx-modal-backdrop';
    var modal = document.createElement('div');
    modal.className = 'csfx-modal csfx-modal--info';
    var header = document.createElement('div');
    header.className = 'csfx-modal-header';
    var headerTitle = document.createElement('div');
    headerTitle.className = 'csfx-modal-header-title';
    var icon = document.createElement('span');
    icon.className = 'csfx-modal-header-icon';
    icon.textContent = 'ℹ️';
    var titleText = document.createElement('span');
    titleText.textContent = 'Detalle del descuento';
    headerTitle.appendChild(icon);
    headerTitle.appendChild(titleText);
    var headerRef = document.createElement('span');
    headerRef.className = 'csfx-modal-header-ref';
    headerRef.textContent = 'Explicación';
    header.appendChild(headerTitle);
    header.appendChild(headerRef);
    var body = document.createElement('div');
    body.className = 'csfx-modal-body';
    var footer = document.createElement('div');
    footer.className = 'csfx-modal-footer';
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'csfx-btn csfx-btn--ghost';
    closeBtn.textContent = 'Cerrar';
    footer.appendChild(closeBtn);
    modal.appendChild(header);
    modal.appendChild(body);
    modal.appendChild(footer);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    var close = function () { csfxCloseExplainModal(); };
    closeBtn.addEventListener('click', close);
    header.addEventListener('click', close);
    backdrop.addEventListener('click', function (ev) {
      if (ev.target === backdrop) close();
    });
    modal.addEventListener('click', function (ev) {
      ev.stopPropagation();
    });

    csfxExplainModalUI = {
      backdrop: backdrop,
      modal: modal,
      header: header,
      body: body,
      footer: footer,
      closeBtn: closeBtn,
      open: false
    };
    return csfxExplainModalUI;
  }

  function csfxCloseExplainModal() {
    if (!csfxExplainModalUI || !csfxExplainModalUI.backdrop) return;
    csfxExplainModalUI.backdrop.removeAttribute('data-open');
    csfxExplainModalUI.open = false;
  }

  function csfxOpenDualExplainModal(panel) {
    var ui = csfxEnsureExplainModal();
    if (!ui) return;
    var base = Number(panel && panel.dataset ? panel.dataset.csfxBase : 0) || 0;
    var discount = Number(panel && panel.dataset ? panel.dataset.csfxCalcDiscount : 0) || 0;
    var pctStored = Number(panel && panel.dataset ? panel.dataset.csfxPct : 0) || 0;
    var pctDisplay = pctStored;
    if (pctDisplay > 0 && pctDisplay < 1) pctDisplay = pctDisplay * 100;
    var net = Number(panel && panel.dataset ? panel.dataset.csfxCalcNet : 0) || 0;
    var grossCovered = Number(panel && panel.dataset ? panel.dataset.csfxCalcGross : 0) || 0;
    var remainderUsd = Number(panel && panel.dataset ? panel.dataset.csfxCalcRemainder : 0) || 0;
    var total = base && discount ? base - discount : 0;

    if (!isFinite(base) || base <= 0 || !isFinite(discount) || discount <= 0) {
      ui.body.innerHTML = '<div class="csfx-explain-body"><p>No hay datos suficientes. Introduce el pago en divisas y calcula el descuento primero.</p></div>';
      ui.backdrop.setAttribute('data-open', 'true');
      ui.open = true;
      return;
    }

    var remainderBs = usd2bs(remainderUsd);
    var pctText = isFinite(pctDisplay) ? pctDisplay.toFixed(2) + '%' : '—';
    var explainHtml = '' +
      '<div class="csfx-explain-body">' +
        '<div class="csfx-explain-head">¿Cómo se calcula este descuento?</div>' +
        '<ul class="csfx-explain-steps">' +
          '<li><strong>1.</strong> Base sin descuento (subtotal): <span class="csfx-explain-inline">' + fmtUsd(base) + '</span></li>' +
          '<li><strong>2.</strong> Pago neto declarado en divisas: <span class="csfx-explain-inline">' + fmtUsd(net) + '</span></li>' +
          '<li><strong>3.</strong> Parte cubierta por las divisas: <span class="csfx-explain-inline">' + fmtUsd(grossCovered) + '</span></li>' +
          '<li><strong>4.</strong> Porcentaje configurado: <span class="csfx-explain-inline">' + pctText + '</span></li>' +
          '<li><strong>5.</strong> Descuento aplicado = porción cubierta × % = <span class="csfx-explain-inline">' + fmtUsd(grossCovered) + ' × ' + pctText + ' = ' + fmtUsd(discount) + '</span></li>' +
          '<li><strong>6.</strong> Total con descuento: <span class="csfx-explain-inline">' + fmtUsd(total) + '</span></li>' +
          '<li><strong>7.</strong> Saldo restante por cobrar: <span class="csfx-explain-inline">' + fmtUsd(remainderUsd) + ' / ' + fmtBs(remainderBs) + '</span></li>' +
        '</ul>' +
        '<div class="csfx-explain-foot">Comparte este detalle con el cliente para justificar el descuento dual y el saldo que queda por cancelar en bolívares.</div>' +
      '</div>';

    ui.body.innerHTML = explainHtml;
    ui.backdrop.setAttribute('data-open', 'true');
    ui.open = true;
  }

  function csfxEnsureCustomDiscountModal() {
    if (csfxCustomModalUI && csfxCustomModalUI.backdrop && document.body.contains(csfxCustomModalUI.backdrop)) {
      return csfxCustomModalUI;
    }
    var backdrop = document.createElement('div');
    backdrop.className = 'csfx-modal-backdrop';
    var modal = document.createElement('div');
    modal.className = 'csfx-modal';
    var header = document.createElement('div');
    header.className = 'csfx-modal-header';
    var headerTitle = document.createElement('div');
    headerTitle.className = 'csfx-modal-header-title';
    var headerIcon = document.createElement('span');
    headerIcon.className = 'csfx-modal-header-icon';
    headerIcon.textContent = '🛡️';
    var headerText = document.createElement('span');
    headerText.textContent = 'Descuentos personalizados';
    headerTitle.appendChild(headerIcon);
    headerTitle.appendChild(headerText);
    var headerRef = document.createElement('span');
    headerRef.className = 'csfx-modal-header-ref';
    headerRef.textContent = 'Referencia POS';
    header.appendChild(headerTitle);
    header.appendChild(headerRef);
    var body = document.createElement('div');
    body.className = 'csfx-modal-body';

    var authCard = document.createElement('div');
    authCard.className = 'csfx-auth-card';
    var authTitle = document.createElement('div');
    authTitle.className = 'csfx-auth-title';
    authTitle.textContent = 'Autorización requerida';
    var authHint = document.createElement('div');
    authHint.className = 'csfx-auth-hint';
    authHint.textContent = 'El encargado puede escanear su QR o ingresar la contraseña para habilitar descuentos por producto.';
    var authRow = document.createElement('div');
    authRow.className = 'csfx-auth-row';
    var pinInput = document.createElement('input');
    pinInput.type = 'password';
    pinInput.placeholder = 'Contraseña del encargado';
    pinInput.autocomplete = 'one-time-code';
    pinInput.inputMode = 'numeric';
    pinInput.maxLength = 12;
    var validateBtn = document.createElement('button');
    validateBtn.type = 'button';
    validateBtn.className = 'csfx-btn csfx-btn--primary';
    validateBtn.textContent = 'Validar';
    var scanBtn = document.createElement('button');
    scanBtn.type = 'button';
    scanBtn.className = 'csfx-btn csfx-btn--ghost';
    scanBtn.textContent = 'Escanear QR';
    authRow.appendChild(pinInput);
    authRow.appendChild(validateBtn);
    authRow.appendChild(scanBtn);
    var authStatus = document.createElement('div');
    authStatus.className = 'csfx-auth-status';
    authStatus.textContent = 'Requiere autorización del encargado.';
    authCard.appendChild(authTitle);
    authCard.appendChild(authHint);
    authCard.appendChild(authRow);
    authCard.appendChild(authStatus);

    var itemList = document.createElement('div');
    itemList.className = 'csfx-item-list';
    itemList.dataset.csfxList = 'items';

    var footer = document.createElement('div');
    footer.className = 'csfx-modal-footer';
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'csfx-btn csfx-btn--ghost';
    closeBtn.textContent = 'Cerrar';
    footer.appendChild(closeBtn);

    body.appendChild(authCard);
    body.appendChild(itemList);
    body.appendChild(footer);
    modal.appendChild(header);
    modal.appendChild(body);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    csfxCustomModalUI = {
      backdrop: backdrop,
      modal: modal,
      header: header,
      pinInput: pinInput,
      validateBtn: validateBtn,
      scanBtn: scanBtn,
      authStatus: authStatus,
      itemList: itemList,
      closeBtn: closeBtn
    };

    backdrop.addEventListener('click', function (ev) {
      if (ev.target === backdrop) csfxCloseCustomDiscountModal();
    });
    modal.addEventListener('click', function (ev) {
      ev.stopPropagation();
    });
    header.addEventListener('click', function () {
      if (csfxCustomModalState.open) csfxCloseCustomDiscountModal();
    });
    closeBtn.addEventListener('click', csfxCloseCustomDiscountModal);
    validateBtn.addEventListener('click', function () {
      csfxAttemptCustomPinValidation(pinInput.value, csfxCustomModalUI);
    });
    pinInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        csfxAttemptCustomPinValidation(pinInput.value, csfxCustomModalUI);
      }
    });
    scanBtn.addEventListener('click', function () {
      var handled = false;
      try {
        var detail = {
          respond: function (pin) {
            handled = true;
            if (typeof pin === 'string' && pin.trim()) {
              csfxCustomModalUI.pinInput.value = pin.trim();
              csfxAttemptCustomPinValidation(pin, csfxCustomModalUI);
            }
          }
        };
        document.dispatchEvent(new CustomEvent('csfx:request-custom-pin-scan', { detail: detail }));
        if (!handled) {
          csfxShowCustomFeedback(csfxCustomModalUI.authStatus, 'Conecta un escáner para recibir la contraseña.', null);
        }
      } catch (_errScan) {
        csfxShowCustomFeedback(csfxCustomModalUI.authStatus, 'No se pudo iniciar el escaneo.', false);
      }
    });

    return csfxCustomModalUI;
  }

  function csfxCloseCustomDiscountModal() {
    if (!csfxCustomModalUI || !csfxCustomModalUI.backdrop) return;
    csfxCustomModalUI.backdrop.removeAttribute('data-open');
    csfxCustomModalState.open = false;
  }

  function csfxOpenCustomDiscountModal() {
    var ui = csfxEnsureCustomDiscountModal();
    csfxCustomModalState.open = true;
    csfxCustomModalState.authorized = false;
    csfxCustomModalState.pin = '';
    ui.pinInput.value = '';
    ui.pinInput.disabled = false;
    ui.validateBtn.disabled = false;
    ui.scanBtn.disabled = false;
    csfxShowCustomFeedback(ui.authStatus, 'Requiere autorización del encargado.', null);
    csfxPopulateCustomDiscountItems(ui);
    ui.backdrop.setAttribute('data-open', 'true');
    setTimeout(function () {
      try { ui.pinInput.focus(); } catch (_errFocus) {}
    }, 60);
  }

  function csfxCollectCartItems(cart) {
    var items = [];
    if (!cart || typeof cart !== 'object') return items;
    var rawLists = [];
    var keys = ['items', 'cart_items', 'cartItems', 'products', 'product_items', 'lines', 'line_items'];
    for (var i = 0; i < keys.length; i++) {
      var value = cart[keys[i]];
      if (!value) continue;
      if (Array.isArray(value)) {
        rawLists = rawLists.concat(value);
      } else if (typeof value === 'object') {
        Object.keys(value).forEach(function (k) {
          rawLists.push(value[k]);
        });
      }
    }
    if (!rawLists.length && cart.items && typeof cart.items === 'object') {
      Object.keys(cart.items).forEach(function (k) { rawLists.push(cart.items[k]); });
    }
    rawLists.forEach(function (entry, idx) {
      if (!entry || typeof entry !== 'object') return;
      var unwrapKeys = ['item', 'item_data', 'data', 'product', 'product_data', 'cart_item'];
      for (var u = 0; u < unwrapKeys.length; u++) {
        var candidate = unwrapKeys[u];
        if (entry && entry[candidate] && typeof entry[candidate] === 'object' && !Array.isArray(entry[candidate])) {
          entry = Object.assign({}, entry, entry[candidate]);
        }
      }
      var name = String(entry.name || entry.title || entry.label || entry.product_name || 'Producto sin nombre');
      var sku = entry.sku || entry.product_sku || entry.productId || entry.id || entry.item_id || '';
      var quantity = Number(entry.qty || entry.quantity || entry.qty_ordered || entry.qtyInCart || entry.qtyOrdered || 1);
      if (!isFinite(quantity) || quantity <= 0) quantity = 1;
      var unit = csfxToNumber(
        entry.price || entry.base_price || entry.regular_price || entry.unit_price ||
        entry.final_price || entry.base_final_price || entry.price_incl_tax ||
        entry.priceInclTax || entry.price_inc_tax || entry.price_excl_tax || entry.priceExclTax
      );
      var total = csfxToNumber(
        entry.row_total || entry.total || entry.row_total_incl_tax || entry.rowTotal ||
        entry.line_total || entry.grand_total || entry.total_price || entry.lineTotal
      );
      if (isNaN(unit) && !isNaN(total) && quantity) {
        unit = total / quantity;
      }
      if (isNaN(unit)) unit = csfxToNumber(entry.base_row_total) / (quantity || 1);
      if (isNaN(unit)) unit = 0;
      if (isNaN(total)) total = round(unit * quantity, FX.decimals);
      items.push({
        id: entry.item_id || entry.id || entry.product_id || entry.cart_item_id || ('item-' + idx),
        name: name,
        sku: sku && String(sku),
        qty: quantity,
        unit: round(unit, FX.decimals),
        total: round(total, FX.decimals),
        original: entry
      });
    });
    return items;
  }

  function csfxPopulateCustomDiscountItems(ui) {
    if (!ui || !ui.itemList) return;
    ui.itemList.innerHTML = '';
    if (!csfxCustomModalState.authorized) {
      var guard = document.createElement('div');
      guard.className = 'csfx-guard-message';
      guard.textContent = 'Autoriza con el PIN del encargado para ver y gestionar los descuentos por producto.';
      ui.itemList.appendChild(guard);
      csfxUpdateCustomItemsState(ui, false);
      return;
    }
    var snapshot = csfxGetCartSnapshot({ totalUSD: readCheckoutUSD() });
    var cartSource = snapshot.cart;
    if (!cartSource) {
      var located = csfxLocateCartDetailed();
      if (located && located.cart) {
        cartSource = located.cart;
      } else {
        cartSource = csfxLoadStoredCart();
      }
    }
    var items = csfxCollectCartItems(cartSource);
    if (!items.length) {
      var storedCart = csfxLoadStoredCart();
      if (storedCart && storedCart !== cartSource) {
        items = csfxCollectCartItems(storedCart);
        if (!cartSource || items.length) {
          cartSource = storedCart;
        }
      }
    }
    if (!items.length) {
      var empty = document.createElement('div');
      empty.className = 'csfx-empty-copy';
      empty.textContent = 'El carrito está vacío. Agrega productos para aplicar descuentos individuales.';
      ui.itemList.appendChild(empty);
      csfxUpdateCustomItemsState(ui, true);
      return;
    }
    items.forEach(function (item) {
      var card = document.createElement('div');
      card.className = 'csfx-item-card';
      card.dataset.itemId = String(item.id || '');

      var header = document.createElement('div');
      header.className = 'csfx-item-header';
      var title = document.createElement('span');
      title.textContent = item.name;
      var qty = document.createElement('span');
      qty.textContent = 'x' + item.qty;
      header.appendChild(title);
      header.appendChild(qty);
      card.appendChild(header);

      var meta = document.createElement('div');
      meta.className = 'csfx-item-meta';
      var sku = document.createElement('span');
      sku.textContent = 'SKU: ' + (item.sku ? String(item.sku) : '—');
      var price = document.createElement('span');
      price.textContent = 'Precio: ' + fmtUsd(item.unit);
      var total = document.createElement('span');
      total.textContent = 'Total: ' + fmtUsd(item.total);
      meta.appendChild(sku);
      meta.appendChild(price);
      meta.appendChild(total);
      card.appendChild(meta);

      var actions = document.createElement('div');
      actions.className = 'csfx-item-actions';
      var amountInput = document.createElement('input');
      amountInput.type = 'number';
      amountInput.step = '0.01';
      amountInput.min = '0';
      amountInput.placeholder = '0,00';
      amountInput.dataset.role = 'custom-amount';
      amountInput.dataset.itemId = String(item.id || '');
      var applyBtn = document.createElement('button');
      applyBtn.type = 'button';
      applyBtn.className = 'csfx-btn csfx-btn--accent';
      applyBtn.dataset.role = 'custom-apply';
      applyBtn.dataset.itemId = String(item.id || '');
      applyBtn.textContent = 'Aplicar';
      actions.appendChild(amountInput);
      actions.appendChild(applyBtn);
      var hint = document.createElement('small');
      hint.textContent = 'Ingresa el descuento a restar en USD.';
      actions.appendChild(hint);
      card.appendChild(actions);

      var feedback = document.createElement('div');
      feedback.className = 'csfx-item-feedback';
      feedback.dataset.state = 'locked';
      feedback.textContent = 'Requiere autorización del encargado.';
      card.appendChild(feedback);

      applyBtn.addEventListener('click', function () {
        csfxHandleCustomItemDiscount(item, amountInput.value, {
          button: applyBtn,
          input: amountInput,
          feedback: feedback
        });
      });
      amountInput.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          applyBtn.click();
        }
      });

      ui.itemList.appendChild(card);
    });
    csfxDualLog('custom-items:list', {
      count: items.length,
      snapshotCart: !!snapshot.cart,
      fallbackUsed: !snapshot.cart && !!cartSource
    });
    csfxUpdateCustomItemsState(ui, csfxCustomModalState.authorized);
  }

  function csfxUpdateCustomItemsState(ui, authorized) {
    if (!ui || !ui.itemList) return;
    var amounts = ui.itemList.querySelectorAll('input[data-role="custom-amount"]');
    amounts.forEach(function (input) {
      input.disabled = !authorized;
      if (!authorized) input.value = '';
    });
    var buttons = ui.itemList.querySelectorAll('button[data-role="custom-apply"]');
    buttons.forEach(function (btn) {
      btn.disabled = !authorized;
    });
    var feedbacks = ui.itemList.querySelectorAll('.csfx-item-feedback');
    feedbacks.forEach(function (node) {
      if (!authorized) {
        node.dataset.state = 'locked';
        csfxShowCustomFeedback(node, 'Requiere autorización del encargado.', null);
      } else if (node.dataset.state === 'locked') {
        node.dataset.state = 'ready';
        csfxShowCustomFeedback(node, 'Listo para aplicar descuento.', null);
      }
    });
  }

  function csfxValidateCustomDiscountPin(pin) {
    return new Promise(function (resolve) {
      var resolved = false;
      var detail = {
        pin: pin,
        handled: false,
        respond: function (result) {
          if (resolved) return;
          resolved = true;
          resolve(!!result);
        }
      };
      try {
        document.dispatchEvent(new CustomEvent('csfx:validate-custom-discount-pin', { detail: detail }));
      } catch (_errDispatch) {}
      (function waitFallback(iterations) {
        if (resolved) return;
        if (detail.handled && iterations < 20) {
          return setTimeout(function () { waitFallback(iterations + 1); }, 100);
        }
        if (resolved) return;
        var configured = '';
        try {
          if (FX && typeof FX.customDiscountPin !== 'undefined' && FX.customDiscountPin !== null) {
            configured = String(FX.customDiscountPin).trim();
          } else if (FX && typeof FX.managerPin !== 'undefined' && FX.managerPin !== null) {
            configured = String(FX.managerPin).trim();
          }
        } catch (_errCfg) {}
        if (!configured) {
          configured = '1234';
        }
        resolved = true;
        resolve(pin === configured);
      })(0);
    });
  }

  function csfxAttemptCustomPinValidation(pin, ui) {
    if (!ui) return;
    var trimmed = String(pin || '').trim();
    if (!trimmed) {
      csfxShowCustomFeedback(ui.authStatus, 'Ingresa la contraseña del encargado para continuar.', false);
      try { ui.pinInput.focus(); } catch (_errFocus) {}
      return;
    }
    ui.validateBtn.disabled = true;
    ui.scanBtn.disabled = true;
    csfxShowCustomFeedback(ui.authStatus, 'Validando autorización…', null);
    csfxValidateCustomDiscountPin(trimmed).then(function (ok) {
      if (ok) {
        csfxCustomModalState.authorized = true;
        csfxCustomModalState.pin = trimmed;
        csfxShowCustomFeedback(ui.authStatus, 'Autorización confirmada. Puedes asignar descuentos por producto.', true);
        ui.pinInput.value = '';
        ui.pinInput.disabled = true;
        csfxUpdateCustomItemsState(ui, true);
        csfxPopulateCustomDiscountItems(ui);
      } else {
        csfxCustomModalState.authorized = false;
        csfxCustomModalState.pin = '';
        csfxShowCustomFeedback(ui.authStatus, 'Contraseña incorrecta. Intenta nuevamente.', false);
        ui.pinInput.disabled = false;
        ui.validateBtn.disabled = false;
        ui.scanBtn.disabled = false;
        try { ui.pinInput.focus(); } catch (_errFocus) {}
        csfxPopulateCustomDiscountItems(ui);
      }
    }).catch(function (err) {
      csfxCustomModalState.authorized = false;
      csfxCustomModalState.pin = '';
      csfxShowCustomFeedback(ui.authStatus, 'No se pudo validar la contraseña: ' + (err && err.message ? err.message : 'error desconocido'), false);
      ui.validateBtn.disabled = false;
      ui.scanBtn.disabled = false;
      csfxPopulateCustomDiscountItems(ui);
    }).finally(function () {
      if (csfxCustomModalState.authorized) {
        ui.validateBtn.disabled = true;
        ui.scanBtn.disabled = true;
      }
    });
  }

  function csfxShowCustomFeedback(node, message, ok) {
    if (!node) return;
    node.textContent = message;
    if (node.classList.contains('csfx-auth-status')) {
      node.classList.remove('csfx-auth-status--ok', 'csfx-auth-status--error');
      if (ok === true) {
        node.classList.add('csfx-auth-status--ok');
      } else if (ok === false) {
        node.classList.add('csfx-auth-status--error');
      }
    } else if (node.classList.contains('csfx-item-feedback')) {
      node.classList.remove('csfx-item-feedback--ok', 'csfx-item-feedback--error');
      if (ok === true) {
        node.classList.add('csfx-item-feedback--ok');
        node.dataset.state = 'ok';
      } else if (ok === false) {
        node.classList.add('csfx-item-feedback--error');
        node.dataset.state = 'error';
      }
    }
  }

  function csfxHandleCustomItemDiscount(item, rawValue, ctx) {
    ctx = ctx || {};
    var input = ctx.input;
    var button = ctx.button;
    var feedback = ctx.feedback;
    if (!csfxCustomModalState.authorized) {
      csfxShowCustomFeedback(feedback, 'Necesitas autorización del encargado para aplicar este descuento.', false);
      return;
    }
    var amount = parseFloat(String(rawValue || '').replace(',', '.'));
    if (!isFinite(amount) || amount <= 0) {
      csfxShowCustomFeedback(feedback, 'Ingresa un monto válido mayor a cero.', false);
      if (input) {
        try { input.focus(); input.select(); } catch (_errSelect) {}
      }
      return;
    }
    if (button) button.disabled = true;
    if (input) input.disabled = true;
    csfxShowCustomFeedback(feedback, 'Enviando solicitud de descuento…', null);

    var responded = false;
    var fallbackTimer = null;
    var detail = {
      item: item,
      discount: round(amount, FX.decimals),
      discountType: 'fixed',
      pin: csfxCustomModalState.pin,
      handled: false,
      respond: function (success, message) {
        if (fallbackTimer) {
          clearTimeout(fallbackTimer);
          fallbackTimer = null;
        }
        responded = true;
        detail.handled = true;
        if (input) input.disabled = false;
        if (button) button.disabled = false;
        if (success) {
          csfxShowCustomFeedback(feedback, message || 'Descuento aplicado desde integración externa.', true);
        } else {
          csfxShowCustomFeedback(feedback, message || 'No se pudo aplicar el descuento desde la integración.', false);
          if (input) {
            try { input.focus(); input.select(); } catch (_errSel) {}
          }
        }
      }
    };
    try {
      document.dispatchEvent(new CustomEvent('csfx:custom-discount-request', { detail: detail }));
    } catch (errDispatch) {
      responded = true;
      csfxShowCustomFeedback(feedback, 'No se pudo enviar la solicitud: ' + (errDispatch && errDispatch.message ? errDispatch.message : 'error'), false);
    }
    if (!responded) {
      csfxDualLog('custom-discount:request', {
        itemId: item.id,
        amount: amount
      });
      fallbackTimer = setTimeout(function () {
        if (responded) return;
        detail.handled = false;
        var fallbackApplied = applyDualDiscountViaUI(amount);
        if (fallbackApplied) {
          csfxShowCustomFeedback(feedback, 'Descuento aplicado manualmente al carrito.', true);
          schedule(decorateCart);
          schedule(decorateTotals);
          schedule(decoratePaymentModal);
          schedule(decorateBill);
          csfxDualLog('custom-discount:fallback-ui', { itemId: item.id, amount: amount });
        } else {
          csfxShowCustomFeedback(feedback, 'No se pudo aplicar el descuento automáticamente. Comunícate con soporte.', false);
          csfxDualLog('custom-discount:fallback-ui-failed', { itemId: item.id, amount: amount });
        }
        if (input) input.disabled = false;
        if (button) button.disabled = false;
        responded = true;
      }, 180);
      if (input) input.disabled = false;
      if (button) button.disabled = false;
    }
  }

  try {
    document.addEventListener('csfx:custom-pin-scanned', function (ev) {
      if (!csfxCustomModalState.open || !csfxCustomModalUI || !csfxCustomModalUI.pinInput) return;
      var pin = ev && ev.detail && typeof ev.detail.pin === 'string' ? ev.detail.pin.trim() : '';
      if (!pin) return;
      csfxCustomModalUI.pinInput.value = pin;
      csfxAttemptCustomPinValidation(pin, csfxCustomModalUI);
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        if (csfxCustomModalState.open) {
          csfxCloseCustomDiscountModal();
        } else if (csfxExplainModalUI && csfxExplainModalUI.open) {
          csfxCloseExplainModal();
        }
      }
    });
    document.addEventListener('csfx:cart-updated', function () {
      if (csfxCustomModalState.open && csfxCustomModalUI) {
        csfxPopulateCustomDiscountItems(csfxCustomModalUI);
      }
    });
  } catch (_errCustomScan) {}

// csfx: fin descuento dual
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
