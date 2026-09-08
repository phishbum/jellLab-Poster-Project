import { get } from "@vercel/blob";
import { neon } from "@neondatabase/serverless";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import Stripe from "stripe";

export function normalizeStripeSecret(value) {
  const copied = String(value || "")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .trim();
  const withoutAssignment = copied
    .replace(/^["']?\s*STRIPE_SECRET_KEY\s*=\s*/i, "")
    .replace(/["']?\s*$/, "")
    .trim();
  const key = withoutAssignment.match(/(?:^|[^A-Za-z0-9])((?:sk|rk)_(?:live|test)_[A-Za-z0-9]+)(?:[^A-Za-z0-9]|$)/)?.[1];
  return key || withoutAssignment.replace(/\s+/g, "");
}

const configuredStripeSecret = normalizeStripeSecret(process.env.STRIPE_SECRET_KEY || process.env.Secret || "");
if (configuredStripeSecret) {
  process.env.STRIPE_SECRET_KEY = configuredStripeSecret;
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const TOKEN_PATTERN = /^[0-9a-f]{64}$/i;
export const CHECKOUT_SESSION_PATTERN = /^cs_(?:test|live)_[A-Za-z0-9]{20,}$/;

const PRICE_CENTS = Object.freeze({
  "Digital file|12 × 16 in": 2400,
  "Digital file|18 × 24 in": 4400,
  "Printed poster|12 × 16 in": 4900,
  "Printed poster|18 × 24 in": 6900
});

let sqlClient;
let orderSchemaReady;
let stripeClient;

export function clean(value, max) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
}

export function getSql() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is missing.");
  if (!sqlClient) sqlClient = neon(process.env.DATABASE_URL);
  return sqlClient;
}

export async function ensureOrderSchema() {
  if (!orderSchemaReady) {
    orderSchemaReady = getSql()`
      CREATE TABLE IF NOT EXISTS poster_orders (
        id UUID PRIMARY KEY,
        order_number VARCHAR(24) UNIQUE NOT NULL,
        access_hash CHAR(64) NOT NULL,
        stripe_checkout_session_id TEXT UNIQUE,
        stripe_payment_intent_id TEXT,
        status VARCHAR(32) NOT NULL,
        customer_name TEXT NOT NULL,
        customer_email TEXT NOT NULL,
        format VARCHAR(32) NOT NULL,
        size VARCHAR(32) NOT NULL,
        amount_total INTEGER NOT NULL,
        currency CHAR(3) NOT NULL DEFAULT 'usd',
        artwork_id UUID NOT NULL,
        artwork_token CHAR(64) NOT NULL,
        poster_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
        shipping_details JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        paid_at TIMESTAMPTZ
      )
    `.catch(error => {
      orderSchemaReady = undefined;
      throw error;
    });
  }
  return orderSchemaReady;
}

export function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("STRIPE_SECRET_KEY is missing.");
  if (!stripeClient) {
    stripeClient = new Stripe(key, {
      apiVersion: "2026-07-29.dahlia",
      appInfo: { name: "Good Times Poster Checkout", version: "1.0.0" }
    });
  }
  return stripeClient;
}

export function getAllowedOrigin(req) {
  const origin = clean(req.headers.origin, 300);
  const allowed = new Set([
    "https://jell-lab-poster-project.vercel.app",
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "",
    process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:3210",
    "http://127.0.0.1:3210"
  ]);
  return origin && allowed.has(origin) ? origin : null;
}

export function priceFor(format, size) {
  return PRICE_CENTS[`${format}|${size}`] || null;
}

export function newOrderIdentity() {
  const now = new Date();
  const stamp = now.toISOString().slice(2, 10).replace(/-/g, "");
  const suffix = randomBytes(4).toString("hex").toUpperCase();
  const token = randomBytes(32).toString("hex");
  return {
    id: randomUUID(),
    number: `GT-${stamp}-${suffix}`,
    token,
    accessHash: createHash("sha256").update(token).digest("hex")
  };
}

export function integrationIdentifier() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  const bytes = randomBytes(8);
  return `good_times_${Array.from(bytes, byte => alphabet[byte % alphabet.length]).join("")}`;
}

export async function verifyPrintMaster(source) {
  const id = clean(source?.id, 40);
  const token = clean(source?.token, 70);
  if (!UUID_PATTERN.test(id) || !TOKEN_PATTERN.test(token)) return null;
  const result = await get(`records/${id}-${token}.json`, { access: "private" });
  if (!result || result.statusCode !== 200) return null;
  const record = JSON.parse(await new Response(result.stream).text());
  if (record?.id !== id || record?.kind !== "print-master" || !clean(record.pathname, 260)) return null;
  return { id, token, pathname: record.pathname };
}

export function checkoutProduct(format, size, snapshot) {
  const show = [clean(snapshot.venue, 80), clean(snapshot.date, 20)].filter(Boolean).join(" · ");
  return {
    name: `GOOD TIMES ${format}`,
    description: `${size}${show ? ` · ${show}` : ""}`.slice(0, 500)
  };
}

export function sessionShipping(session) {
  const details = session?.collected_information?.shipping_details || session?.shipping_details || null;
  if (!details) return null;
  const address = details.address || {};
  return {
    name: clean(details.name, 120),
    line1: clean(address.line1, 160),
    line2: clean(address.line2, 160),
    city: clean(address.city, 100),
    state: clean(address.state, 100),
    postalCode: clean(address.postal_code, 24),
    country: clean(address.country, 2)
  };
}

export async function markOrderFromSession(session) {
  const orderId = clean(session?.metadata?.order_id || session?.client_reference_id, 40);
  if (!UUID_PATTERN.test(orderId) || !CHECKOUT_SESSION_PATTERN.test(clean(session?.id, 160))) return false;
  const paid = session.payment_status === "paid" || session.payment_status === "no_payment_required";
  if (!paid) return false;
  const paymentIntent = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id || null;
  const shipping = sessionShipping(session);
  const sql = getSql();
  const rows = await sql`
    UPDATE poster_orders
       SET status = 'paid',
           stripe_payment_intent_id = ${paymentIntent},
           shipping_details = ${shipping ? JSON.stringify(shipping) : null}::jsonb,
           paid_at = COALESCE(paid_at, NOW()),
           updated_at = NOW()
     WHERE id = ${orderId}
       AND stripe_checkout_session_id = ${session.id}
       AND amount_total = ${Number(session.amount_total || 0)}
       AND currency = ${clean(session.currency, 3).toLowerCase()}
    RETURNING id
  `;
  return rows.length > 0;
}
