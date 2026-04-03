import { supabase } from '../lib/supabase.js';
import { buildGuideText } from '../lib/utils.js';

export default async function handler(req, res) {
  try {
    const { token } = req.query || {};
    const { data } = await supabase.from('orders').select('*, order_items(*)').eq('public_report_token', token).maybeSingle();
    if (!data) return res.status(404).send('Link no encontrado');
    const order = { ...data, items: data.order_items || [] };
    const text = buildGuideText(order).replace(/\n/g, '<br>');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Pedido ${order.id}</title><style>body{font-family:Arial,sans-serif;margin:24px;background:#111827;color:#f9fafb} .card{max-width:760px;margin:auto;background:#1f2937;padding:24px;border-radius:16px} h1{margin-top:0} .muted{color:#9ca3af} a{color:#93c5fd}</style></head><body><div class="card"><h1>Seguimiento de pedido #${order.id}</h1><p class="muted">Cliente: ${order.customer_name || ''}</p><div>${text}</div><p style="margin-top:20px">Maps: ${order.google_maps_url ? `<a href="${order.google_maps_url}" target="_blank">Abrir ubicación</a>` : 'Aún no cargada'}</p></div></body></html>`);
  } catch (error) {
    res.status(500).send(String(error.message || error));
  }
}
