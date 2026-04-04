
export function okJson(res, result, status = 200) {
  res.status(status).json({ ok: true, result });
}

export function errJson(res, error, status = 500) {
  let message = 'Error';

  if (error instanceof Error) {
    message = error.message;
  } else if (error && typeof error === 'object') {
    message =
      error.message ||
      error.error ||
      error.details ||
      error.hint ||
      JSON.stringify(error, null, 2);
  } else {
    message = String(error || 'Error');
  }

  res.status(status).json({ ok: false, error: message });
}

export function norm(s) {
  return String(s || '').trim().toLowerCase();
}

export function nowIso() {
  return new Date().toISOString();
}

export function parseDateRange(fromISO, toISO) {
  const filters = [];
  if (fromISO) filters.push({ op: 'gte', value: `${fromISO}T00:00:00.000Z` });
  if (toISO) filters.push({ op: 'lte', value: `${toISO}T23:59:59.999Z` });
  return filters;
}

export function parseItems(items) {
  const rows = Array.isArray(items) ? items : [];
  return rows.map((item) => ({
    sku: String(item.sku || '').trim(),
    title: String(item.title || item.name || '').trim(),
    qty: Number(item.qty || item.quantity || 1) || 1,
    price_gs: Number(item.price_gs || item.price || item.sale_price || 0) || 0,
    provider_price_gs: Number(item.provider_price_gs || item.cost_price || item.real_cost || 0) || 0,
    provider_email: String(item.provider_email || '').trim().toLowerCase(),
    vendor_email: String(item.vendor_email || '').trim().toLowerCase()
  }));
}

export function calcOrderTotals(items) {
  const clean = parseItems(items);
  const sale = clean.reduce((sum, item) => sum + item.qty * item.price_gs, 0);
  const cost = clean.reduce((sum, item) => sum + item.qty * item.provider_price_gs, 0);
  return { sale_total_gs: sale, cost_total_gs: cost, items: clean };
}

export function buildGuideText(order) {
  const lines = [];
  lines.push(`Pedido #${order.id}`);
  lines.push(`Cliente: ${order.customer_name || ''}`);
  lines.push(`Teléfono: ${order.phone || ''}`);
  lines.push(`Ciudad: ${order.city || ''}`);
  const addr = [order.street, order.district].filter(Boolean).join(' - ');
  lines.push(`Dirección: ${addr}`);
  if (order.obs) lines.push(`Observación: ${order.obs}`);
  lines.push('');
  lines.push('Productos:');
  for (const item of order.items || []) {
    lines.push(`- ${item.title || item.sku} x${item.qty}`);
  }
  return lines.join('\n');
}

export function groupBy(arr, getKey) {
  return arr.reduce((acc, item) => {
    const key = getKey(item);
    acc[key] = acc[key] || [];
    acc[key].push(item);
    return acc;
  }, {});
}
