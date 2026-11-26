var assert = require('node:assert/strict');
var test = require('node:test');
var coupons = require('../lib/coupons');
var invoice = require('../lib/invoice');
var orders = require('../lib/orders');
var pricing = require('../lib/pricing');
var reports = require('../lib/reports');

function makeOrder(items, coupon) {
  var billed = pricing.computeTotals(items, coupon);
  var db = { nextOrderId: 1, orders: [] };

  return orders.add(db, {
    date: '15/06/2024',
    items: items,
    coupon: coupon,
    subtotal: billed.subtotal,
    discount: billed.discount,
    tax: billed.tax,
    total: billed.total
  });
}

test('checkout applies the capped coupon before GST and apportions it across HSN slabs', function () {
  var totals = pricing.computeTotals([
    { price: 500, qty: 2, hsn: '1006' },
    { price: 1000, qty: 1, hsn: '0405' }
  ], 'SAVE10');

  var { lines, ...summary } = totals;
  assert.deepEqual(summary, {
    subtotal: 2000, discount: 150, taxable: 1850,
    tax: 157.25, cgst: 78.63, sgst: 78.62, total: 2007.25
  });
  assert.deepEqual(lines.map(function (line) {
    var { gstPercent, gross, discount, taxable, tax, net } = line;
    return { gstPercent, gross, discount, taxable, tax, net };
  }), [
    { gstPercent: 5, gross: 1000, discount: 75, taxable: 925, tax: 46.25, net: 971.25 },
    { gstPercent: 12, gross: 1000, discount: 75, taxable: 925, tax: 111, net: 1036 }
  ]);
});

test('checkout and invoice agree on an undiscounted line using default GST', function () {
  var order = makeOrder([{ name: 'Item', price: 100, qty: 2 }]);
  var figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.tax, 36);
  assert.equal(order.total, 236);
  assert.equal(figures.tax, 36);
  assert.equal(figures.total, 236);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('invoice resolves HSN rates from saved order lines', function () {
  var order = makeOrder([
    { name: 'Rice', hsn: '1006', price: 100, qty: 2 },
    { name: 'Ghee', hsn: '0405', price: 100, qty: 1 }
  ]);
  var figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.tax, 22);
  assert.equal(order.total, 322);
  assert.deepEqual(figures.rows.map(function (row) {
    return [row.hsn, row.gstPercent, row.lineTax];
  }), [['1006', 5, 10], ['0405', 12, 12]]);
  assert.equal(figures.tax, 22);
  assert.equal(figures.cgst, 11);
  assert.equal(figures.sgst, 11);
  assert.equal(figures.total, 322);

  var html = invoice.render(order);
  assert.match(html, /5%<\/td><td class="r">₹10\.00/);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td class="r">₹22\.00/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹322\.00/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('invoice applies capped percentage coupons before GST', function () {
  var order = makeOrder([{ price: 2000, qty: 1 }], 'SAVE10');
  var figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual([order.discount, order.tax, order.total], [150, 333, 2183]);
  assert.deepEqual([figures.discount, figures.tax, figures.total], [150, 333, 2183]);
});

test('flat coupons reduce invoice GST', function () {
  var order = makeOrder([{ price: 400, qty: 1 }], 'FLAT50');
  var figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual([order.discount, order.tax, order.total], [50, 63, 413]);
  assert.deepEqual([figures.discount, figures.tax, figures.total], [50, 63, 413]);
});

test('invoice ignores an inactive coupon', function () {
  var order = makeOrder([{ price: 1000, qty: 1 }]);
  order.coupon = 'DIWALI20';
  var figures = invoice.computeInvoiceFigures(order);

  assert.equal(coupons.validate(order.coupon, order.subtotal).valid, false);
  assert.equal(pricing.computeTotals(order.items, order.coupon).discount, 0);
  assert.deepEqual([figures.discount, figures.tax, figures.total], [0, 180, 1180]);
});

test('invoice accepts a saved decimal GST rate', function () {
  var order = makeOrder([{ price: 100, qty: 1, gstRate: 0.05 }]);
  var figures = invoice.computeInvoiceFigures(order);

  assert.equal(order.tax, 5);
  assert.equal(order.total, 105);
  assert.equal(figures.rows[0].gstPercent, 5);
  assert.equal(figures.tax, 5);
  assert.equal(figures.total, 105);
});

test('invoice sums rounded line GST', function () {
  var order = makeOrder([{ price: 0.03, qty: 1 }, { price: 0.03, qty: 1 }]);
  var figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual([order.tax, order.total], [0.02, 0.08]);
  assert.deepEqual(figures.rows.map(function (row) { return row.lineTax; }), [0.01, 0.01]);
  assert.deepEqual([figures.tax, figures.total], [0.02, 0.08]);
});

test('reconciliation skips cancelled orders and sums absolute invoice total differences', function () {
  var higherInvoice = makeOrder([{ price: 100, qty: 1, hsn: '1006' }]);
  var lowerInvoice = makeOrder([{ price: 2000, qty: 1 }], 'SAVE10');
  var matchedOrder = makeOrder([{ price: 100, qty: 1 }]);
  var cancelledOrder = { ...higherInvoice, id: 4, status: 'cancelled' };
  higherInvoice.total -= 13;
  lowerInvoice.total += 59;
  lowerInvoice.id = 2;
  matchedOrder.id = 3;

  var result = reports.getGstReconciliation({
    orders: [higherInvoice, lowerInvoice, matchedOrder, cancelledOrder]
  });

  assert.equal(result.totalChecked, 3);
  assert.equal(result.mismatchCount, 2);
  assert.equal(result.totalDelta, 72);
  assert.deepEqual(result.rows.map(function (row) {
    return [row.orderId, row.ledgerTax, row.invoiceTax, row.delta, row.matched];
  }), [[1, 5, 5, 13, false], [2, 333, 333, -59, false], [3, 18, 18, 0, true]]);
});

test('a GST-only mismatch is flagged by reconciliation but has no invoice banner', function () {
  var order = makeOrder([{ price: 100, qty: 1 }]);
  order.tax = 17;
  var result = reports.getGstReconciliation({ orders: [order] });

  assert.equal(result.mismatchCount, 1);
  assert.equal(result.totalDelta, 0);
  assert.equal(result.rows[0].matched, false);
  assert.equal(result.rows[0].ledgerTax, 17);
  assert.equal(result.rows[0].invoiceTax, 18);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('historical invoice totals and GST reconcile with the checked-in order ledger', function () {
  var db = require('../data/db.json');
  var audit = reports.getGstReconciliation(db);
  assert.equal(audit.totalChecked, 8);
  assert.equal(audit.mismatchCount, 0);
  assert.equal(audit.totalDelta, 0);
});
