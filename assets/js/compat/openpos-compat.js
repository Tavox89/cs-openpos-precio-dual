(function(global){
  'use strict';

  function centsToFloat(c){
    return (c ?? 0) / 100;
  }

  function normalizeProduct(p){
    p = p || {};
    var isCamel = ('priceInclTax' in p) || ('manageStock' in p) || ('parentId' in p);
    var price = isCamel ? centsToFloat(p.price) : (p.price ?? 0);
    var priceInclTax = isCamel ? centsToFloat(p.priceInclTax) : (p.price_incl_tax ?? 0);
    return {
      id: p.id,
      parentId: p.parentId ?? p.parent_id ?? null,
      price: price,
      priceInclTax: priceInclTax,
      stockQty: p.stockQty ?? p.qty ?? 0,
      manageStock: p.manageStock ?? p.manage_stock ?? false,
      additionInfo: p.additionInfo ?? p.addition_info ?? {}
    };
  }

  function normalizeItemDiscounts(item){
    var codes = Array.isArray(item?.discount_codes)
      ? item.discount_codes
      : (item?.discount_code ? [item.discount_code] : []);
    return codes.filter(Boolean);
  }

  global.OpenPOSCompat = {
    centsToFloat: centsToFloat,
    normalizeProduct: normalizeProduct,
    normalizeItemDiscounts: normalizeItemDiscounts
  };
})(typeof window !== 'undefined' ? window : this);