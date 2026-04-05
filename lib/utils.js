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
  const normalizeDate = (value) => {
    if (!value) return '';
    if (typeof value === 'string') {
      const s = value.trim();
      const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
      return m ? m[1] : '';
    }
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
      return value.toISOString().slice(0, 10);
    }
    if (typeof value === 'object') {
      return normalizeDate(value.value || value.date || value.fromISO || value.toISO || '');
    }
    return '';
  };
  const from = normalizeDate(fromISO);
  const to = normalizeDate(toISO);
  const filters = [];
  if (from) filters.push({ op: 'gte', value: `${from}T00:00:00.000Z` });
  if (to) filters.push({ op: 'lte', value: `${to}T23:59:59.999Z` });
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

function formatGs(value) {
  return Number(value || 0).toLocaleString('es-PY');
}

function getGuideOrderCode(order) {
  const explicitCode = String(order.order_code || order.external_ref || '').trim();
  if (explicitCode) return explicitCode;
  const rawId = String(order.id || '').trim();
  return rawId ? `A${rawId}` : '';
}

export function buildGuideText(order) {
  const lines = [];
  const orderCode = getGuideOrderCode(order);
  const items = Array.isArray(order.items) ? order.items : [];
  const totalGs =
    Number(order.total_gs ?? order.sale_total_gs ?? items.reduce((sum, item) => {
      return sum + (Number(item.qty || 0) * Number(item.price_gs || 0));
    }, 0));

  lines.push(`Pedido: ${orderCode || order.id || ''}`);
  lines.push(`Vendedor: ${order.vendor_email || order.created_by || ''}`);
  lines.push(`Cliente: ${order.customer_name || ''}`);
  lines.push(`Teléfono: ${order.phone || ''}`);
  lines.push(`Ciudad: ${order.city || ''}`);
  lines.push(`Calle: ${order.street || ''}`);
  lines.push(`Barrio: ${order.district || ''}`);
  lines.push(`Email: ${order.email || ''}`);
  if (order.obs) lines.push(`Observación: ${order.obs}`);
  lines.push('');
  lines.push('Items:');
  for (const item of items) {
    lines.push(
      `- ${item.title || item.sku || 'Producto'} — Cant: ${Number(item.qty || 0)} — Precio: ${formatGs(item.price_gs || 0)} Gs`
    );
  }
  lines.push(`Total: ${formatGs(totalGs)} Gs`);
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
