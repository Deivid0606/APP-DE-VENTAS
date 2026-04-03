import { supabase } from '../lib/supabase.js';
import { hashPassword } from '../lib/auth.js';
import { errJson, okJson, norm } from '../lib/utils.js';

const SETUP_SECRET = process.env.SETUP_SECRET || '';

export default async function handler(req, res) {
  if (req.method !== 'POST') return errJson(res, 'Método no permitido', 405);
  try {
    const { setup_secret, name, email, password, create_demo = true } = req.body || {};
    if (!SETUP_SECRET || setup_secret !== SETUP_SECRET) throw new Error('SETUP_SECRET inválido');
    const { count } = await supabase.from('users').select('*', { count: 'exact', head: true });
    if ((count || 0) > 0) throw new Error('La app ya fue inicializada');

    const password_hash = await hashPassword(password);
    const adminEmail = norm(email);
    const { data: admin, error } = await supabase.from('users').insert({
      name,
      email: adminEmail,
      password_hash,
      role: 'ADMIN',
      approved: true,
      is_active: true
    }).select('*').single();
    if (error) throw error;

    if (create_demo) {
      const demoPassword = await hashPassword('12345678');
      await supabase.from('users').insert([
        { name: 'Proveedor Demo', email: 'proveedor@demo.com', password_hash: demoPassword, role: 'PROVEEDOR', approved: true, is_active: true },
        { name: 'Vendedor Demo', email: 'vendedor@demo.com', password_hash: demoPassword, role: 'VENDEDOR', approved: true, is_active: true },
        { name: 'Delivery Demo', email: 'delivery@demo.com', password_hash: demoPassword, role: 'DELIVERY', approved: true, is_active: true },
        { name: 'Despachante Demo', email: 'despachante@demo.com', password_hash: demoPassword, role: 'DESPACHANTE', approved: true, is_active: true }
      ]).throwOnError();

      await supabase.from('client_city_prices').insert([
        { city: 'Asunción', price_gs: 15000 },
        { city: 'Ciudad del Este', price_gs: 18000 },
        { city: 'San Lorenzo', price_gs: 14000 }
      ]).throwOnError();

      await supabase.from('delivery_rates').insert([
        { email: 'delivery@demo.com', city: 'Asunción', rate_gs: 12000 },
        { email: 'delivery@demo.com', city: 'Ciudad del Este', rate_gs: 15000 },
        { email: 'delivery@demo.com', city: 'San Lorenzo', rate_gs: 11000 }
      ]).throwOnError();
    }

    okJson(res, { ok: true, admin_id: admin.id, message: 'App inicializada correctamente' });
  } catch (error) {
    errJson(res, error, 500);
  }
}
