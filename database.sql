create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  password_hash text not null,
  role text not null check (role in ('ADMIN','PROVEEDOR','VENDEDOR','DELIVERY','DESPACHANTE')),
  approved boolean not null default false,
  is_active boolean not null default true,
  provider_logo_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists products (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  sku text not null unique,
  description text default '',
  price_gs numeric not null default 0,
  provider_price_gs numeric not null default 0,
  stock integer not null default 0,
  real_stock integer not null default 0,
  image_url text default '',
  image_url_2 text default '',
  image_url_3 text default '',
  provider_email text,
  provider_logo_url text default '',
  vendor_private_to text default '',
  created_by text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists orders (
  id bigint generated always as identity primary key,
  customer_name text not null,
  phone text not null,
  city text not null,
  street text default '',
  district text default '',
  email text default '',
  obs text default '',
  vendor_email text,
  provider_email text,
  provider_emails_list text default '',
  source text default 'MANUAL',
  source_status text default '',
  status text not null default 'PENDIENTE',
  status2 text not null default 'GUIA PENDIENTE',
  retiro_status text default 'PENDIENTE',
  assigned_delivery text,
  assigned_at timestamptz,
  delivery_fee_gs numeric not null default 0,
  sale_total_gs numeric not null default 0,
  cost_total_gs numeric not null default 0,
  pack_count integer not null default 0,
  rendicion_pagada boolean not null default false,
  rendicion_pagada_at timestamptz,
  public_report_token text unique,
  google_maps_url text,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists order_items (
  id bigint generated always as identity primary key,
  order_id bigint not null references orders(id) on delete cascade,
  sku text,
  title text,
  qty integer not null default 1,
  price_gs numeric not null default 0,
  provider_price_gs numeric not null default 0,
  provider_email text,
  vendor_email text,
  created_at timestamptz not null default now()
);

create table if not exists delivery_rates (
  id bigint generated always as identity primary key,
  email text not null,
  city text not null,
  rate_gs numeric not null default 0,
  created_at timestamptz not null default now(),
  unique(email, city)
);

create table if not exists client_city_prices (
  id bigint generated always as identity primary key,
  city text not null unique,
  price_gs numeric not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists vendor_commissions (
  id bigint generated always as identity primary key,
  order_id bigint not null unique references orders(id) on delete cascade,
  vendor_email text,
  provider_email text,
  amount_gs numeric not null default 0,
  paid boolean not null default false,
  paid_at timestamptz,
  order_status text default '',
  created_at timestamptz not null default now()
);

create table if not exists commission_requests (
  id bigint generated always as identity primary key,
  vendor_email text not null,
  provider_email text,
  amount_gs numeric not null default 0,
  note text default '',
  status text not null default 'PENDIENTE',
  resolution_note text default '',
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create table if not exists wallet_transactions (
  id bigint generated always as identity primary key,
  user_email text not null,
  type text not null,
  order_id bigint,
  amount_gs numeric not null default 0,
  note text default '',
  created_at timestamptz not null default now()
);

create table if not exists news (
  id bigint generated always as identity primary key,
  type text not null,
  note text default '',
  order_id bigint,
  actor_email text,
  created_at timestamptz not null default now()
);

create table if not exists password_reset_tokens (
  id bigint generated always as identity primary key,
  user_id uuid not null references users(id) on delete cascade,
  token text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists delivery_tracking (
  user_email text primary key,
  consent boolean not null default false,
  updated_at timestamptz not null default now()
);

create table if not exists live_locations (
  user_email text primary key,
  lat numeric not null,
  lng numeric not null,
  accuracy numeric,
  updated_at timestamptz not null default now()
);

create table if not exists shopify_inbox (
  id bigint generated always as identity primary key,
  external_ref text unique,
  customer_name text default '',
  phone text default '',
  city text default '',
  street text default '',
  note text default '',
  status text not null default 'NUEVO',
  raw_text text default '',
  created_by text,
  created_at timestamptz not null default now()
);

create table if not exists app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

create table if not exists user_favorites (
  id bigint generated always as identity primary key,
  user_email text not null,
  sku text not null,
  created_at timestamptz not null default now(),
  unique(user_email, sku)
);

create table if not exists chat_threads (
  id uuid primary key default gen_random_uuid(),
  user_a text not null,
  user_b text not null,
  updated_at timestamptz not null default now(),
  unique(user_a, user_b)
);

create table if not exists chat_messages (
  id bigint generated always as identity primary key,
  thread_id uuid not null references chat_threads(id) on delete cascade,
  sender_email text not null,
  body text not null default '',
  created_at timestamptz not null default now()
);

insert into app_settings(key, value)
values ('order_counter', '1000')
on conflict (key) do nothing;
