import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { supabase } from './supabase.js';

const JWT_SECRET = process.env.JWT_SECRET || 'change-me';

export async function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

export async function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash || '');
}

export function signSession(user, remember = false) {
  const payload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    name: user.name
  };
  const expiresIn = remember ? '30d' : '12h';
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

export function decodeSession(token) {
  return jwt.verify(token, JWT_SECRET);
}

export async function requireUser(token) {
  if (!token) throw new Error('No autenticado');
  const decoded = decodeSession(token);
  const { data, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', decoded.sub)
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error('Sesión inválida');
  if (!data.is_active) throw new Error('Usuario inactivo');
  if (!data.approved) throw new Error('Usuario pendiente de aprobación');
  return data;
}

export function requireRole(user, roles) {
  const allowed = Array.isArray(roles) ? roles : [roles];
  if (!allowed.includes(user.role)) {
    throw new Error('No tienes permisos para esta acción');
  }
}
