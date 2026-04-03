import crypto from 'crypto';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { supabase } from '../lib/supabase.js';
import { errJson, okJson, norm, parseDateRange, calcOrderTotals, buildGuideText, groupBy, nowIso } from '../lib/utils.js';
import { hashPassword, requireRole, requireUser, signSession, verifyPassword } from '../lib/auth.js';

const APP_BASE_URL = process.env.APP_BASE_URL || '';

function sanitizeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    approved: user.approved,
    is_active: user.is_active,
    provider_logo_url: user.provider_logo_url || ''
  };
}

async function logNews(type, note = '', orderId = null, actorEmail = '') {
  await supabase.from('news').insert({ type, note, order_id: orderId, actor_email: actorEmail || null }).throwOnError();
}

async function fetchOrder(orderId) {
  const { data, error } = await supabase
    .from('orders')
    .select('*, order_items(*)')
    .eq('id', orderId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Pedido no encontrado');
  return {
    ...data,
    items: (data.order_items || []).map((x) => ({
      sku: x.sku,
      title: x.title,
      qty: x.qty,
      price_gs: x.price_gs,
      provider_price_gs: x.provider_price_gs,
      provider_email: x.provider_email,
      vendor_email: x.vendor_email
    })),
    items_json: JSON.stringify(data.order_items || [])
  };
}

function applyRange(query, fromISO, toISO, column = 'created_at') {
  for (const f of parseDateRange(fromISO, toISO)) {
    query = query[f.op](column, f.value);
  }
  return query;
}

function filterOrdersInMemory(rows, q) {
  const qq = norm(q);
  if (!qq) return rows;
  return rows.filter((o) => {
    const hay = [o.id, o.customer_name, o.phone, o.city, o.street, o.district, o.email, o.status, o.status2, o.assigned_delivery, o.provider_emails_list]
      .map((v) => String(v || '').toLowerCase())
      .join(' ');
    return hay.includes(qq);
  });
}

async function listOrdersBase(user, fromISO, toISO, q, onlyStatus = '', onlyDelivery = '', onlyProvider = '') {
  let query = supabase
    .from('orders')
    .select('*, order_items(*)')
    .order('id', { ascending: false });

  query = applyRange(query, fromISO, toISO);

  if (onlyStatus) query = query.eq('status', onlyStatus);
  if (onlyDelivery) query = query.eq('assigned_delivery', onlyDelivery);

  if (user.role === 'DELIVERY') query = query.eq('assigned_delivery', user.email);
  if (user.role === 'PROVEEDOR') query = query.or(`provider_email.eq.${user.email},provider_emails_list.ilike.%${user.email}%`);
  if (user.role === 'VENDEDOR') query = query.eq('vendor_email', user.email);
  if (onlyProvider) query = query.or(`provider_email.eq.${onlyProvider},provider_emails_list.ilike.%${onlyProvider}%`);

  const { data, error } = await query;
  if (error) throw error;

  const rows = (data || []).map((o) => ({
    ...o,
    assigned_delivery: o.assigned_delivery || '',
    items: o.order_items || [],
    items_json: JSON.stringify(o.order_items || [])
  }));
  return filterOrdersInMemory(rows, q);
}

async function getDeliveryRateByCity(email, city) {
  const { data } = await supabase
    .from('delivery_rates')
    .select('rate_gs')
    .eq('email', email)
    .eq('city', city)
    .maybeSingle();
  return Number(data?.rate_gs || 0);
}

async function recalculateProviderEmails(orderId) {
  const order = await fetchOrder(orderId);
  const emails = [...new Set((order.items || []).map((x) => norm(x.provider_email)).filter(Boolean))];
  const provider_email = emails[0] || null;
  const provider_emails_list = emails.join(',');
  await supabase.from('orders').update({ provider_email, provider_emails_list }).eq('id', orderId).throwOnError();
  return { providers: provider_emails_list };
}

async function createGuidePdf(orderIds) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  for (const orderId of orderIds) {
    const order = await fetchOrder(orderId);
    const page = pdf.addPage([595, 842]);
    let y = 800;
    page.drawText(`Guía de entrega #${order.id}`, { x: 40, y, font: bold, size: 18 });
    y -= 28;
    const lines = buildGuideText(order).split('\n');
    for (const line of lines) {
      if (y < 50) {
        y = 800;
      }
      page.drawText(line, { x: 40, y, font, size: 11 });
      y -= 16;
    }
  }

  const bytes = await pdf.save();
  return Buffer.from(bytes).toString('base64');
}

async function dispatch(fn, args) {
  const handlers = {
    async register(name, email, password, role) {
      email = norm(email);
      if (!name || !email || !password || !role) throw new Error('Completa todos los campos');
      const { data: exists } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
      if (exists) throw new Error('Ese email ya está registrado');
      const password_hash = await hashPassword(password);
      const approved = false;
      const { data, error } = await supabase.from('users').insert({
        name,
        email,
        password_hash,
        role,
        approved,
        is_active: true
      }).select('*').single();
      if (error) throw error;
      await logNews('REGISTER', `Nuevo usuario registrado: ${email}`, null, email);
      return { user: sanitizeUser(data) };
    },

    async login(email, password, remember = false) {
      email = norm(email);
      const { data: user, error } = await supabase.from('users').select('*').eq('email', email).maybeSingle();
      if (error) throw error;
      if (!user) throw new Error('Credenciales inválidas');
      if (!user.approved) throw new Error('Tu cuenta todavía no fue aprobada');
      if (!user.is_active) throw new Error('Tu cuenta está desactivada');
      const ok = await verifyPassword(password, user.password_hash);
      if (!ok) throw new Error('Credenciales inválidas');
      const token = signSession(user, remember);
      return { session: { token }, user: sanitizeUser(user) };
    },

    async me(token) {
      const user = await requireUser(token);
      return sanitizeUser(user);
    },

    async requestPasswordReset(email) {
      email = norm(email);
      const { data: user } = await supabase.from('users').select('*').eq('email', email).maybeSingle();
      if (!user) return { ok: true };
      const token = crypto.randomBytes(24).toString('hex');
      const expires_at = new Date(Date.now() + 1000 * 60 * 60).toISOString();
      await supabase.from('password_reset_tokens').insert({ user_id: user.id, token, expires_at }).throwOnError();
      return { ok: true, reset_link: `${APP_BASE_URL}/?reset=${token}` };
    },

    async resetPasswordWithToken(resetToken, newPassword) {
      const { data: row, error } = await supabase
        .from('password_reset_tokens')
        .select('*, users(*)')
        .eq('token', resetToken)
        .is('used_at', null)
        .gte('expires_at', nowIso())
        .maybeSingle();
      if (error) throw error;
      if (!row?.users) throw new Error('Token inválido o vencido');
      const password_hash = await hashPassword(newPassword);
      await supabase.from('users').update({ password_hash }).eq('id', row.user_id).throwOnError();
      await supabase.from('password_reset_tokens').update({ used_at: nowIso() }).eq('id', row.id).throwOnError();
      const token = signSession(row.users, false);
      return { session: { token }, user: sanitizeUser(row.users) };
    },

    async getAllUsersWithStatus(token) {
      const user = await requireUser(token);
      requireRole(user, 'ADMIN');
      const { data, error } = await supabase.from('users').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []).map(sanitizeUser);
    },

    async approveUser(token, userId) {
      const user = await requireUser(token);
      requireRole(user, 'ADMIN');
      const { data, error } = await supabase.from('users').update({ approved: true }).eq('id', userId).select('*').single();
      if (error) throw error;
      return sanitizeUser(data);
    },

    async rejectUser(token, userId) {
      const user = await requireUser(token);
      requireRole(user, 'ADMIN');
      await supabase.from('users').update({ approved: false, is_active: false }).eq('id', userId).throwOnError();
      return { ok: true };
    },

    async listUsersByRole(token, role) {
      await requireUser(token);
      const { data, error } = await supabase.from('users').select('id,name,email,role,approved,is_active,provider_logo_url').eq('role', role).eq('approved', true).eq('is_active', true).order('name');
      if (error) throw error;
      return data || [];
    },

    async saveProviderLogo(token, providerEmail, logoUrl) {
      const user = await requireUser(token);
      if (!(user.role === 'ADMIN' || user.role === 'PROVEEDOR')) throw new Error('Sin permisos');
      providerEmail = norm(providerEmail || user.email);
      if (user.role === 'PROVEEDOR' && providerEmail !== user.email) throw new Error('Solo puedes cambiar tu propio logo');
      const { data, error } = await supabase.from('users').update({ provider_logo_url: logoUrl || '' }).eq('email', providerEmail).select('*').single();
      if (error) throw error;
      return { logo_url: data.provider_logo_url || '', logo_url_raw: data.provider_logo_url || '' };
    },

    async addProduct(token, payload) {
      const user = await requireUser(token);
      requireRole(user, ['ADMIN', 'PROVEEDOR', 'DESPACHANTE']);
      const provider_email = norm(payload.provider_email || (user.role === 'PROVEEDOR' ? user.email : ''));
      const vendor_private_to = String(payload.private_to_emails || payload.private_to || '').trim();
      const row = {
        title: payload.title,
        sku: String(payload.sku || '').trim(),
        description: payload.description || '',
        price_gs: Number(payload.price_gs || payload.price || 0),
        provider_price_gs: Number(payload.provider_price_gs || payload.real_cost_gs || payload.real_cost || 0),
        stock: Number(payload.stock || 0),
        real_stock: Number(payload.real_stock || payload.stock || 0),
        image_url: payload.image_url || payload.img || payload.img1 || '',
        image_url_2: payload.image_url_2 || payload.img2 || '',
        image_url_3: payload.image_url_3 || payload.img3 || '',
        provider_email,
        vendor_private_to,
        provider_logo_url: payload.provider_logo_url || '',
        is_active: true,
        created_by: user.email
      };
      const { data, error } = await supabase.from('products').insert(row).select('*').single();
      if (error) throw error;
      return data;
    },

    async updateProduct(token, productId, payload) {
      const user = await requireUser(token);
      requireRole(user, ['ADMIN', 'PROVEEDOR', 'DESPACHANTE']);
      const { data: current } = await supabase.from('products').select('*').eq('id', productId).single();
      if (user.role === 'PROVEEDOR' && current.provider_email !== user.email) throw new Error('Solo puedes editar tus productos');
      const patch = {
        title: payload.title,
        sku: payload.sku,
        description: payload.description || '',
        price_gs: Number(payload.price_gs || payload.price || 0),
        provider_price_gs: Number(payload.provider_price_gs || payload.real_cost_gs || payload.real_cost || 0),
        stock: Number(payload.stock || 0),
        real_stock: Number(payload.real_stock || payload.stock || 0),
        image_url: payload.image_url || payload.img || payload.img1 || '',
        image_url_2: payload.image_url_2 || payload.img2 || '',
        image_url_3: payload.image_url_3 || payload.img3 || '',
        provider_email: norm(payload.provider_email || current.provider_email),
        vendor_private_to: String(payload.private_to_emails || payload.private_to || '').trim(),
        updated_at: nowIso()
      };
      const { data, error } = await supabase.from('products').update(patch).eq('id', productId).select('*').single();
      if (error) throw error;
      return data;
    },

    async deleteProduct(token, productId) {
      const user = await requireUser(token);
      requireRole(user, ['ADMIN', 'PROVEEDOR', 'DESPACHANTE']);
      const { data: current } = await supabase.from('products').select('*').eq('id', productId).single();
      if (user.role === 'PROVEEDOR' && current.provider_email !== user.email) throw new Error('Solo puedes eliminar tus productos');
      await supabase.from('products').delete().eq('id', productId).throwOnError();
      return { ok: true };
    },

    async listProducts(token) {
      const user = await requireUser(token);
      const { data, error } = await supabase.from('products').select('*').eq('is_active', true).order('created_at', { ascending: false });
      if (error) throw error;
      const rows = (data || []).filter((p) => {
        if (user.role === 'PROVEEDOR') return p.provider_email === user.email;
        if (!p.vendor_private_to) return true;
        const emails = p.vendor_private_to.split(',').map(norm).filter(Boolean);
        return user.role === 'ADMIN' || emails.includes(user.email);
      });
      return rows;
    },

    async getMyFavorites(token) {
      const user = await requireUser(token);
      const { data, error } = await supabase.from('user_favorites').select('sku').eq('user_email', user.email);
      if (error && error.code !== 'PGRST116') throw error;
      return (data || []).map((x) => x.sku);
    },

    async getDeliveryClientPrices(token) {
      await requireUser(token);
      const { data, error } = await supabase.from('client_city_prices').select('*').order('city');
      if (error) throw error;
      return data || [];
    },

    async setClientCityPrice(token, city, priceGs) {
      const user = await requireUser(token);
      requireRole(user, ['ADMIN', 'PROVEEDOR']);
      const row = { city, price_gs: Number(priceGs || 0) };
      await supabase.from('client_city_prices').upsert(row, { onConflict: 'city' }).throwOnError();
      return { ok: true };
    },

    async addOrder(token, order) {
      const user = await requireUser(token);
      const totals = calcOrderTotals(order.items || []);
      const provider_emails = [...new Set(totals.items.map((x) => norm(x.provider_email)).filter(Boolean))];
      const vendor_email = norm(order.vendor_email || (user.role === 'VENDEDOR' ? user.email : '')) || null;
      const row = {
        customer_name: order.customer_name,
        phone: order.phone,
        city: order.city,
        street: order.street || '',
        district: order.district || '',
        email: order.email || '',
        obs: order.obs || '',
        vendor_email,
        provider_email: provider_emails[0] || null,
        provider_emails_list: provider_emails.join(','),
        source: order.source || 'MANUAL',
        source_status: order.source_status || '',
        sale_total_gs: totals.sale_total_gs,
        cost_total_gs: totals.cost_total_gs,
        status: order.status || 'PENDIENTE',
        status2: order.status2 || 'GUIA PENDIENTE',
        created_by: user.email
      };
      const { data, error } = await supabase.from('orders').insert(row).select('*').single();
      if (error) throw error;
      const itemsRows = totals.items.map((item) => ({
        order_id: data.id,
        sku: item.sku,
        title: item.title,
        qty: item.qty,
        price_gs: item.price_gs,
        provider_price_gs: item.provider_price_gs,
        provider_email: item.provider_email || null,
        vendor_email: item.vendor_email || vendor_email
      }));
      if (itemsRows.length) await supabase.from('order_items').insert(itemsRows).throwOnError();
      await logNews('ORDER_CREATED', `Pedido #${data.id} creado`, data.id, user.email);
      return { id: data.id };
    },

    async updateOrder(token, orderId, patch) {
      const user = await requireUser(token);
      const allowed = {
        customer_name: patch.customer_name,
        phone: patch.phone,
        city: patch.city,
        street: patch.street,
        district: patch.district,
        email: patch.email,
        obs: patch.obs,
        updated_at: nowIso()
      };
      const { data, error } = await supabase.from('orders').update(allowed).eq('id', orderId).select('*').single();
      if (error) throw error;
      await logNews('ORDER_UPDATED', `Pedido #${orderId} actualizado`, orderId, user.email);
      return data;
    },

    async deleteOrder(token, orderId) {
      const user = await requireUser(token);
      requireRole(user, ['ADMIN', 'DESPACHANTE', 'PROVEEDOR']);
      await supabase.from('order_items').delete().eq('order_id', orderId).throwOnError();
      await supabase.from('orders').delete().eq('id', orderId).throwOnError();
      await logNews('ORDER_DELETED', `Pedido #${orderId} eliminado`, orderId, user.email);
      return { ok: true };
    },

    async listOrdersFiltered(token, fromISO, toISO, q, onlyStatus = '', onlyDelivery = '') {
      const user = await requireUser(token);
      return listOrdersBase(user, fromISO, toISO, q, onlyStatus, onlyDelivery);
    },

    async listOrders(token, fromISO = '', toISO = '', q = '') {
      const user = await requireUser(token);
      return listOrdersBase(user, fromISO, toISO, q);
    },

    async listProviderOrders(token, fromISO, toISO, q) {
      const user = await requireUser(token);
      return listOrdersBase({ ...user, role: 'PROVEEDOR' }, fromISO, toISO, q);
    },

    async listDespachanteOrders(token, fromISO, toISO, q) {
      const user = await requireUser(token);
      return listOrdersBase({ ...user, role: 'DESPACHANTE' }, fromISO, toISO, q);
    },

    async listOrdersForAssignment(token, fromISO, toISO, q) {
      const user = await requireUser(token);
      requireRole(user, ['ADMIN', 'DESPACHANTE', 'PROVEEDOR']);
      let rows = await listOrdersBase(user, fromISO, toISO, q);
      rows = rows.filter((x) => !x.assigned_delivery && !['CANCELADO', 'RENDIDO'].includes(String(x.status2 || '').toUpperCase()));
      return rows;
    },

    async assignDelivery(token, orderId, deliveryEmail) {
      const user = await requireUser(token);
      requireRole(user, ['ADMIN', 'DESPACHANTE', 'PROVEEDOR']);
      const order = await fetchOrder(orderId);
      const delivery_fee_gs = await getDeliveryRateByCity(deliveryEmail, order.city);
      const { data, error } = await supabase.from('orders').update({
        assigned_delivery: norm(deliveryEmail),
        assigned_at: nowIso(),
        delivery_fee_gs,
        status2: order.status2 === 'GUIA PENDIENTE' ? 'GUIA GENERADA' : order.status2
      }).eq('id', orderId).select('*').single();
      if (error) throw error;
      await logNews('ORDER_ASSIGNED', `Pedido #${orderId} asignado a ${deliveryEmail}`, orderId, user.email);
      return data;
    },

    async bulkAssignOrdersByIds(token, orderIds, deliveryEmail) {
      const user = await requireUser(token);
      requireRole(user, ['ADMIN', 'DESPACHANTE', 'PROVEEDOR']);
      const successIds = [];
      const failedIds = [];
      for (const rawId of orderIds || []) {
        try {
          await handlers.assignDelivery(token, rawId, deliveryEmail);
          successIds.push(rawId);
        } catch {
          failedIds.push(rawId);
        }
      }
      return { successIds, failedIds };
    },

    async bulkAssignToDelivery(token, orderIds, deliveryEmail) {
      return handlers.bulkAssignOrdersByIds(token, orderIds, deliveryEmail);
    },

    async assignOrderToSelf(token, orderId) {
      const user = await requireUser(token);
      requireRole(user, 'DELIVERY');
      return handlers.assignDelivery(token, orderId, user.email);
    },

    async updateOrderStatus(token, orderId, status) {
      const user = await requireUser(token);
      const { data, error } = await supabase.from('orders').update({ status, updated_at: nowIso() }).eq('id', orderId).select('*').single();
      if (error) throw error;
      if (String(status).toUpperCase() === 'ENTREGADO') {
        const commissionAmount = Math.max(Number(data.sale_total_gs || 0) - Number(data.cost_total_gs || 0) - Number(data.delivery_fee_gs || 0), 0);
        await supabase.from('vendor_commissions').upsert({
          order_id: data.id,
          vendor_email: data.vendor_email,
          provider_email: data.provider_email,
          amount_gs: commissionAmount,
          paid: false,
          order_status: status
        }, { onConflict: 'order_id' }).throwOnError();
      }
      await logNews('ORDER_STATUS', `Pedido #${orderId} → ${status}`, orderId, user.email);
      return data;
    },

    async updateOrderStatus2(token, orderId, status2) {
      const user = await requireUser(token);
      const { data, error } = await supabase.from('orders').update({ status2, updated_at: nowIso() }).eq('id', orderId).select('*').single();
      if (error) throw error;
      await logNews('ORDER_STATUS2', `Pedido #${orderId} → ${status2}`, orderId, user.email);
      return data;
    },

    async updateRetiroStatus(token, orderId, retiroStatus) {
      const user = await requireUser(token);
      const { data, error } = await supabase.from('orders').update({ retiro_status: retiroStatus, updated_at: nowIso() }).eq('id', orderId).select('*').single();
      if (error) throw error;
      return data;
    },

    async updateOrderProviders(token, orderId) {
      await requireUser(token);
      return recalculateProviderEmails(orderId);
    },

    async updateAllOrdersProviders(token) {
      await requireUser(token);
      const { data, error } = await supabase.from('orders').select('id');
      if (error) throw error;
      for (const row of data || []) await recalculateProviderEmails(row.id);
      return { message: 'Proveedores actualizados' };
    },

    async getGuideText(token, orderId) {
      await requireUser(token);
      const order = await fetchOrder(orderId);
      return buildGuideText(order);
    },

    async getGuideCleanText(token, orderId) {
      await requireUser(token);
      const order = await fetchOrder(orderId);
      return { success: true, text: buildGuideText(order) };
    },

    async generateGuidePDF(token, orderId) {
      await requireUser(token);
      return { url: `${APP_BASE_URL}/api/guide-single?orderId=${encodeURIComponent(orderId)}&token=${encodeURIComponent(token)}` };
    },

    async generateBulkGuidesPDF(token, orderIds) {
      await requireUser(token);
      const ids = (orderIds || []).join(',');
      return { success: true, url: `${APP_BASE_URL}/api/guide-bulk?ids=${encodeURIComponent(ids)}&token=${encodeURIComponent(token)}`, downloadUrl: `${APP_BASE_URL}/api/guide-bulk?ids=${encodeURIComponent(ids)}&token=${encodeURIComponent(token)}` };
    },

    async generateBulkGuidesTXT(token, orderIds) {
      await requireUser(token);
      const texts = [];
      for (const id of orderIds || []) {
        const order = await fetchOrder(id);
        texts.push(buildGuideText(order));
        texts.push('');
        texts.push('----------------------------------------');
        texts.push('');
      }
      return { success: true, text: texts.join('\n') };
    },

    async generateOrderReportLinks(token, orderIds, deliveryEmail = '') {
      await requireUser(token);
      const links = [];
      for (const orderId of orderIds || []) {
        const public_token = crypto.randomBytes(12).toString('hex');
        await supabase.from('orders').update({ public_report_token: public_token }).eq('id', orderId).throwOnError();
        links.push({
          order_id: orderId,
          url: `${APP_BASE_URL}/api/report-link?token=${public_token}`,
          phone_url: `${APP_BASE_URL}/api/report-link?token=${public_token}`,
          delivery_email: deliveryEmail || ''
        });
      }
      return { links };
    },


    async metrics(token, fromISO = '', toISO = '') {
      const user = await requireUser(token);
      const rows = await listOrdersBase(user, fromISO, toISO, '');
      const cards = {
        orders: rows.length,
        sold: rows.reduce((s, x) => s + Number(x.sale_total_gs || 0), 0),
        delivered: rows.filter((x) => String(x.status || '').toUpperCase() === 'ENTREGADO').length,
        canceled: rows.filter((x) => String(x.status || '').toUpperCase() === 'CANCELADO').length
      };
      const byCity = groupBy(rows, (x) => x.city || 'Sin ciudad');
      const map = Object.entries(byCity).map(([city, items]) => ({
        city,
        qty: items.length,
        revenue: items.reduce((s, x) => s + Number(x.sale_total_gs || 0), 0)
      }));
      return { cards, map };
    },

    async providerMetrics(token, fromISO = '', toISO = '') {
      const user = await requireUser(token);
      const providerEmail = user.role === 'PROVEEDOR' ? user.email : user.email;
      const rows = await listOrdersBase({ ...user, role: 'PROVEEDOR', email: providerEmail }, fromISO, toISO, '');
      const cards = {
        orders: rows.length,
        sold: rows.reduce((s, x) => s + Number(x.sale_total_gs || 0), 0),
        delivered: rows.filter((x) => String(x.status || '').toUpperCase() === 'ENTREGADO').length,
        canceled: rows.filter((x) => String(x.status || '').toUpperCase() === 'CANCELADO').length,
        profit: rows.reduce((s, x) => s + Math.max(Number(x.sale_total_gs || 0) - Number(x.cost_total_gs || 0), 0), 0)
      };
      const byCity = groupBy(rows, (x) => x.city || 'Sin ciudad');
      const map = Object.entries(byCity).map(([city, items]) => ({ city, qty: items.length, revenue: items.reduce((s, x) => s + Number(x.sale_total_gs || 0), 0) }));
      return { cards, map };
    },

    async getWallet(token) {
      const user = await requireUser(token);
      let query = supabase.from('wallet_transactions').select('*').order('created_at', { ascending: false });
      query = query.eq('user_email', user.email);
      const { data, error } = await query;
      if (error) throw error;
      const txs = data || [];
      const balance_gs = txs.reduce((sum, x) => sum + Number(x.amount_gs || 0), 0);
      return { balance_gs, txs };
    },

    async getProviderEarnings(token, fromISO, toISO) {
      const user = await requireUser(token);
      const providerEmail = user.role === 'PROVEEDOR' ? user.email : '';
      let query = supabase.from('order_items').select('*, orders!inner(created_at,status,provider_email,provider_emails_list)');
      query = applyRange(query, fromISO, toISO, 'orders.created_at');
      const { data, error } = await query;
      if (error) throw error;
      const filtered = (data || []).filter((x) => !providerEmail || x.provider_email === providerEmail || String(x.orders.provider_emails_list || '').includes(providerEmail));
      const grouped = groupBy(filtered, (x) => x.title || x.sku || 'Sin título');
      const rows = Object.entries(grouped).map(([title, items]) => {
        const delivered_qty = items.filter((x) => String(x.orders.status || '').toUpperCase() === 'ENTREGADO').reduce((s, x) => s + Number(x.qty || 0), 0);
        const gain_unit_gs = Number(items[0]?.price_gs || 0) - Number(items[0]?.provider_price_gs || 0);
        return {
          title,
          price_gs: Number(items[0]?.price_gs || 0),
          real_cost_gs: Number(items[0]?.provider_price_gs || 0),
          gain_unit_gs,
          real_stock: 0,
          delivered_qty,
          gain_total_gs: gain_unit_gs * delivered_qty
        };
      });
      const kpis = {
        gain_today_gs: rows.reduce((s, x) => s + x.gain_total_gs, 0),
        gain_range_gs: rows.reduce((s, x) => s + x.gain_total_gs, 0),
        delivered_units: rows.reduce((s, x) => s + x.delivered_qty, 0),
        products: rows.length
      };
      return { kpis, rows };
    },

    async listNews(token) {
      await requireUser(token);
      const { data, error } = await supabase.from('news').select('*').order('created_at', { ascending: false }).limit(200);
      if (error) throw error;
      return data || [];
    },

    async getDeliveryRates(token) {
      await requireUser(token);
      const { data, error } = await supabase.from('delivery_rates').select('*').order('email').order('city');
      if (error) throw error;
      return data || [];
    },

    async setDeliveryRate(token, email, city, rateGs) {
      const user = await requireUser(token);
      requireRole(user, ['ADMIN', 'PROVEEDOR']);
      await supabase.from('delivery_rates').upsert({ email: norm(email), city, rate_gs: Number(rateGs || 0) }, { onConflict: 'email,city' }).throwOnError();
      return { ok: true };
    },

    async getDeliveryProfit(token, fromISO = '', toISO = '') {
      const user = await requireUser(token);
      const rows = await listOrdersBase({ ...user, role: 'DELIVERY' }, fromISO, toISO, '', '', user.email);
      const delivered = rows.filter((x) => String(x.status || '').toUpperCase() === 'ENTREGADO');
      const profit_gs = delivered.reduce((sum, x) => sum + Number(x.delivery_fee_gs || 0), 0);
      return { delivered_count: delivered.length, profit_gs };
    },

    async getDeliveryRankingWithProviderFilter(token, fromISO = '', toISO = '', providerFilter = '') {
      await requireUser(token);
      const { data, error } = await supabase.from('orders').select('*');
      if (error) throw error;
      const rows = filterOrdersInMemory(data || [], '').filter((x) => !providerFilter || x.provider_email === providerFilter || String(x.provider_emails_list || '').includes(providerFilter));
      const map = {};
      for (const row of rows) {
        const email = row.assigned_delivery || 'SIN ASIGNAR';
        map[email] = map[email] || { delivery_email: email, delivered: 0, canceled: 0, total: 0, profit_gs: 0 };
        map[email].total += 1;
        if (String(row.status || '').toUpperCase() === 'ENTREGADO') {
          map[email].delivered += 1;
          map[email].profit_gs += Number(row.delivery_fee_gs || 0);
        }
        if (String(row.status || '').toUpperCase() === 'CANCELADO') map[email].canceled += 1;
      }
      return Object.values(map).sort((a, b) => b.delivered - a.delivered || b.profit_gs - a.profit_gs);
    },

    async listCommissionsFlex(token, fromISO = '', toISO = '', vendorEmail = '', only = '', q = '', providerFilter = '') {
      const user = await requireUser(token);
      let query = supabase.from('vendor_commissions').select('*, orders(*)').order('created_at', { ascending: false });
      query = applyRange(query, fromISO, toISO);
      if (user.role === 'VENDEDOR') query = query.eq('vendor_email', user.email);
      if (vendorEmail) query = query.eq('vendor_email', norm(vendorEmail));
      if (providerFilter) query = query.eq('provider_email', norm(providerFilter));
      if (only === 'PAGADO') query = query.eq('paid', true);
      if (only === 'PENDIENTE') query = query.eq('paid', false);
      const { data, error } = await query;
      if (error) throw error;
      return (data || []).filter((x) => !q || JSON.stringify(x).toLowerCase().includes(String(q).toLowerCase()));
    },

    async payVendorCommission(token, orderId, paid) {
      const user = await requireUser(token);
      requireRole(user, ['ADMIN', 'PROVEEDOR']);
      const { data, error } = await supabase.from('vendor_commissions').update({ paid: !!paid, paid_at: paid ? nowIso() : null }).eq('order_id', orderId).select('*').single();
      if (error) throw error;
      return data;
    },

    async getVendorCommissions(token, vendorEmail) {
      const user = await requireUser(token);
      if (user.role === 'VENDEDOR') vendorEmail = user.email;
      const { data, error } = await supabase.from('vendor_commissions').select('*').eq('vendor_email', norm(vendorEmail));
      if (error) throw error;
      return data || [];
    },

    async getVendorProviderBalances(token, vendorEmail, fromISO = '', toISO = '') {
      const user = await requireUser(token);
      if (user.role === 'VENDEDOR') vendorEmail = user.email;
      let query = supabase.from('vendor_commissions').select('*').eq('vendor_email', norm(vendorEmail));
      query = applyRange(query, fromISO, toISO);
      const { data, error } = await query;
      if (error) throw error;
      const grouped = groupBy(data || [], (x) => x.provider_email || 'sin-proveedor');
      return Object.entries(grouped).map(([provider_email, rows]) => ({
        provider_email,
        total_gs: rows.reduce((s, x) => s + Number(x.amount_gs || 0), 0),
        pending_gs: rows.filter((x) => !x.paid).reduce((s, x) => s + Number(x.amount_gs || 0), 0),
        paid_gs: rows.filter((x) => x.paid).reduce((s, x) => s + Number(x.amount_gs || 0), 0)
      }));
    },

    async createCommissionRequest(token, payload) {
      const user = await requireUser(token);
      requireRole(user, 'VENDEDOR');
      const row = {
        vendor_email: user.email,
        provider_email: norm(payload.provider_email || ''),
        amount_gs: Number(payload.amount_gs || 0),
        note: payload.note || '',
        status: 'PENDIENTE'
      };
      const { data, error } = await supabase.from('commission_requests').insert(row).select('*').single();
      if (error) throw error;
      return data;
    },

    async listCommissionRequests(token) {
      const user = await requireUser(token);
      let query = supabase.from('commission_requests').select('*').order('created_at', { ascending: false });
      if (user.role === 'VENDEDOR') query = query.eq('vendor_email', user.email);
      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },

    async resolveCommissionRequest(token, requestId, status, note = '') {
      const user = await requireUser(token);
      requireRole(user, ['ADMIN', 'PROVEEDOR']);
      const { data, error } = await supabase.from('commission_requests').update({ status, resolved_at: nowIso(), resolution_note: note }).eq('id', requestId).select('*').single();
      if (error) throw error;
      return data;
    },

    async getVendorProviderRequestBalances(token, vendorEmail) {
      const user = await requireUser(token);
      if (user.role === 'VENDEDOR') vendorEmail = user.email;
      const { data, error } = await supabase.from('commission_requests').select('*').eq('vendor_email', norm(vendorEmail));
      if (error) throw error;
      const grouped = groupBy(data || [], (x) => x.provider_email || 'sin-proveedor');
      return Object.entries(grouped).map(([provider_email, rows]) => ({
        provider_email,
        pending_gs: rows.filter((x) => x.status === 'PENDIENTE').reduce((s, x) => s + Number(x.amount_gs || 0), 0),
        approved_gs: rows.filter((x) => x.status === 'APROBADO').reduce((s, x) => s + Number(x.amount_gs || 0), 0),
        rejected_gs: rows.filter((x) => x.status === 'RECHAZADO').reduce((s, x) => s + Number(x.amount_gs || 0), 0)
      }));
    },

    async getClosuresDetailedKPIs(token, deliveryEmail = '', fromISO = '', toISO = '') {
      const user = await requireUser(token);
      if (user.role === 'DELIVERY') deliveryEmail = user.email;
      let rows = await listOrdersBase(user, fromISO, toISO, '', '', deliveryEmail);
      if (deliveryEmail) rows = rows.filter((x) => x.assigned_delivery === deliveryEmail);
      return {
        total: rows.length,
        delivered: rows.filter((x) => String(x.status || '').toUpperCase() === 'ENTREGADO').length,
        pending: rows.filter((x) => !['ENTREGADO', 'CANCELADO'].includes(String(x.status || '').toUpperCase())).length,
        rendidos: rows.filter((x) => String(x.status2 || '').toUpperCase() === 'RENDIDO').length,
        rows
      };
    },

    async markRendicionPagada(token, orderId) {
      const user = await requireUser(token);
      requireRole(user, ['ADMIN', 'PROVEEDOR']);
      const { data, error } = await supabase.from('orders').update({ rendicion_pagada: true, rendicion_pagada_at: nowIso() }).eq('id', orderId).select('*').single();
      if (error) throw error;
      return data;
    },

    async unmarkRendicionPagada(token, orderId) {
      const user = await requireUser(token);
      requireRole(user, ['ADMIN', 'PROVEEDOR']);
      const { data, error } = await supabase.from('orders').update({ rendicion_pagada: false, rendicion_pagada_at: null }).eq('id', orderId).select('*').single();
      if (error) throw error;
      return data;
    },

    async getRendicionesPagadas(token, fromISO = '', toISO = '') {
      const user = await requireUser(token);
      let query = supabase.from('orders').select('*').eq('rendicion_pagada', true).order('rendicion_pagada_at', { ascending: false });
      query = applyRange(query, fromISO, toISO, 'rendicion_pagada_at');
      if (user.role === 'PROVEEDOR') query = query.or(`provider_email.eq.${user.email},provider_emails_list.ilike.%${user.email}%`);
      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },

    async setDeliveryTrackingConsent(token, consent) {
      const user = await requireUser(token);
      requireRole(user, 'DELIVERY');
      await supabase.from('delivery_tracking').upsert({ user_email: user.email, consent: !!consent, updated_at: nowIso() }, { onConflict: 'user_email' }).throwOnError();
      return { ok: true, consent: !!consent };
    },

    async getDeliveryTrackingStatus(token) {
      const user = await requireUser(token);
      requireRole(user, 'DELIVERY');
      const { data, error } = await supabase.from('delivery_tracking').select('*').eq('user_email', user.email).maybeSingle();
      if (error) throw error;
      return data || { user_email: user.email, consent: false };
    },

    async updateMyLiveLocation(token, lat, lng, accuracy = null) {
      const user = await requireUser(token);
      requireRole(user, 'DELIVERY');
      await supabase.from('live_locations').upsert({ user_email: user.email, lat, lng, accuracy, updated_at: nowIso() }, { onConflict: 'user_email' }).throwOnError();
      return { ok: true };
    },

    async listLiveDeliveryLocations(token) {
      await requireUser(token);
      const { data, error } = await supabase.from('live_locations').select('*').order('updated_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },

    async importShopifyPaste(token, raw) {
      const user = await requireUser(token);
      requireRole(user, ['ADMIN', 'DESPACHANTE', 'PROVEEDOR']);
      const lines = String(raw || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      let imported = 0;
      let duplicates = 0;
      for (const line of lines) {
        const parts = line.split('\t');
        const external_ref = String(parts[0] || '').trim();
        const customer_name = String(parts[1] || '').trim();
        const phone = String(parts[2] || '').trim();
        const city = String(parts[3] || '').trim();
        const street = String(parts[4] || '').trim();
        const note = String(parts[5] || '').trim();
        if (!external_ref) continue;
        const { data: exists } = await supabase.from('shopify_inbox').select('id').eq('external_ref', external_ref).maybeSingle();
        if (exists) { duplicates += 1; continue; }
        await supabase.from('shopify_inbox').insert({ external_ref, customer_name, phone, city, street, note, status: 'NUEVO', raw_text: line, created_by: user.email }).throwOnError();
        imported += 1;
      }
      return { imported, duplicates, total: lines.length };
    },

    async listShopifyInbox(token, filters = {}) {
      await requireUser(token);
      let query = supabase.from('shopify_inbox').select('*').order('created_at', { ascending: false });
      query = applyRange(query, filters.fromISO, filters.toISO);
      if (filters.status) query = query.eq('status', filters.status);
      const { data, error } = await query;
      if (error) throw error;
      return data || [];
    },

    async getShopifyInboxRow(token, rowId) {
      await requireUser(token);
      const { data, error } = await supabase.from('shopify_inbox').select('*').eq('id', rowId).single();
      if (error) throw error;
      return data;
    },

    async setShopifyInboxStatus(token, rowId, status) {
      await requireUser(token);
      const { data, error } = await supabase.from('shopify_inbox').update({ status }).eq('id', rowId).select('*').single();
      if (error) throw error;
      return data;
    },

    async listChatThreads(token) {
      const user = await requireUser(token);
      const { data, error } = await supabase.from('chat_threads').select('*').or(`user_a.eq.${user.email},user_b.eq.${user.email}`).order('updated_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },

    async listChatContacts(token) {
      await requireUser(token);
      const { data, error } = await supabase.from('users').select('name,email,role').eq('approved', true).eq('is_active', true).order('name');
      if (error) throw error;
      return data || [];
    },

    async listChatMessages(token, threadId) {
      await requireUser(token);
      const { data, error } = await supabase.from('chat_messages').select('*').eq('thread_id', threadId).order('created_at');
      if (error) throw error;
      return data || [];
    },

    async sendChatMessage(token, payload) {
      const user = await requireUser(token);
      let threadId = payload.thread_id;
      if (!threadId) {
        const members = [norm(user.email), norm(payload.to_email)].sort();
        const { data: thread } = await supabase.from('chat_threads').upsert({ user_a: members[0], user_b: members[1], updated_at: nowIso() }, { onConflict: 'user_a,user_b' }).select('*').single();
        threadId = thread.id;
      }
      const { data, error } = await supabase.from('chat_messages').insert({ thread_id: threadId, sender_email: user.email, body: payload.body || '' }).select('*').single();
      if (error) throw error;
      await supabase.from('chat_threads').update({ updated_at: nowIso() }).eq('id', threadId).throwOnError();
      return data;
    },

    async markChatRead(token, threadId) {
      await requireUser(token);
      return { ok: true, thread_id: threadId };
    },

    async chatPing(token) {
      await requireUser(token);
      return { ok: true, at: nowIso() };
    },

    async adminGetOrderCounter(token) {
      const user = await requireUser(token);
      requireRole(user, 'ADMIN');
      const { data } = await supabase.from('app_settings').select('value').eq('key', 'order_counter').maybeSingle();
      return Number(data?.value || 1000);
    },

    async adminSetOrderCounter(token, value) {
      const user = await requireUser(token);
      requireRole(user, 'ADMIN');
      await supabase.from('app_settings').upsert({ key: 'order_counter', value: String(Number(value || 1000)) }, { onConflict: 'key' }).throwOnError();
      return { ok: true };
    },

    async getOrdersByProvider(token, providerEmail, fromISO = '', toISO = '') {
      const user = await requireUser(token);
      if (user.role === 'PROVEEDOR') providerEmail = user.email;
      return listOrdersBase(user, fromISO, toISO, '', '', '', norm(providerEmail));
    },

    async debugProducts(token) {
      await requireUser(token);
      const { count } = await supabase.from('products').select('*', { count: 'exact', head: true });
      return { count };
    },

    async debugProviderData(token) {
      await requireUser(token);
      const { data, error } = await supabase.from('orders').select('id,provider_email,provider_emails_list').limit(20);
      if (error) throw error;
      return data || [];
    }
  };

  if (!handlers[fn]) throw new Error(`Función no soportada: ${fn}`);
  return handlers[fn](...(args || []));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return errJson(res, 'Método no permitido', 405);
  try {
    const { fn, args = [] } = req.body || {};
    const result = await dispatch(fn, args);
    okJson(res, result);
  } catch (error) {
    errJson(res, error, 500);
  }
}
