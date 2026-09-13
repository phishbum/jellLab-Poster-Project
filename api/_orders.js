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
    const sql = getSql();
    orderSchemaReady = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS poster_orders (
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
      )`;
      await sql`ALTER TABLE poster_orders ADD COLUMN IF NOT EXISTS printful_order_id TEXT`;
      await sql`ALTER TABLE poster_orders ADD COLUMN IF NOT EXISTS printful_status VARCHAR(32)`;
      await sql`ALTER TABLE poster_orders ADD COLUMN IF NOT EXISTS printful_error TEXT`;
      await sql`ALTER TABLE poster_orders ADD COLUMN IF NOT EXISTS printful_attempted_at TIMESTAMPTZ`;
    })().catch(error => {
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
  const show = [clean(snapshot.artist, 80), clean(snapshot.venue, 80), clean(snapshot.date, 20)].filter(Boolean).join(" · ");
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

const PRINTFUL_VARIANTS = Object.freeze({
  "12 × 16 in": 1349,
  "18 × 24 in": 1
});

export function printfulVariantFor(size) {
  return PRINTFUL_VARIANTS[size] || null;
}

function printfulArtworkUrl(order) {
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || "jell-lab-poster-project.vercel.app";
  return `https://${host}/api/artwork?id=${encodeURIComponent(order.artwork_id)}&token=${encodeURIComponent(order.artwork_token)}`;
}

export async function fulfillPrintfulOrder(session) {
  const sessionId = clean(session?.id, 160);
  if (!CHECKOUT_SESSION_PATTERN.test(sessionId)) return { skipped: true };

  const sql = getSql();
  const [order] = await sql`
    SELECT id, order_number, customer_name, customer_email, format, size, amount_total,
           artwork_id, artwork_token, shipping_details, printful_order_id, printful_status
      FROM poster_orders
     WHERE stripe_checkout_session_id = ${sessionId} AND status = 'paid'
     LIMIT 1
  `;
  if (!order || order.format !== "Printed poster") return { skipped: true };
  if (order.printful_order_id) return { orderId: order.printful_order_id, status: order.printful_status, existing: true };
  if (!process.env.PRINTFUL_TOKEN) throw new Error("PRINTFUL_TOKEN is missing.");

  const variantId = printfulVariantFor(order.size);
  const shipping = order.shipping_details || {};
  if (!variantId || !shipping.name || !shipping.line1 || !shipping.city || !shipping.state || !shipping.postalCode || shipping.country !== "US") {
    throw new Error("The paid printed order is missing a supported size or complete US shipping address.");
  }

  const claimed = await sql`
    UPDATE poster_orders
       SET printful_status = 'submitting', printful_error = NULL,
           printful_attempted_at = NOW(), updated_at = NOW()
     WHERE id = ${order.id}
       AND printful_order_id IS NULL
       AND (printful_status IS NULL OR printful_status <> 'submitting' OR printful_attempted_at < NOW() - INTERVAL '10 minutes')
    RETURNING id
  `;
  if (!claimed.length) return { skipped: true, pending: true };

  const payload = {
    external_id: order.order_number,
    shipping: "STANDARD",
    recipient: {
      name: shipping.name,
      email: order.customer_email,
      address1: shipping.line1,
      address2: shipping.line2 || undefined,
      city: shipping.city,
      state_code: shipping.state,
      country_code: shipping.country,
      zip: shipping.postalCode
    },
    items: [{
      variant_id: variantId,
      quantity: 1,
      name: `Good Times custom concert poster — ${order.size}`,
      retail_price: (Number(order.amount_total) / 100).toFixed(2),
      files: [{ type: "default", url: printfulArtworkUrl(order) }]
    }]
  };

  try {
    const response = await fetch("https://api.printful.com/orders?confirm=1&update_existing=1", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.PRINTFUL_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result?.result?.id) throw new Error(`Printful order request failed (${response.status}).`);
    const printfulId = String(result.result.id);
    const printfulStatus = clean(result.result.status || "submitted", 32);
    await sql`
      UPDATE poster_orders
         SET printful_order_id = ${printfulId}, printful_status = ${printfulStatus},
             printful_error = NULL, updated_at = NOW()
       WHERE id = ${order.id}
    `;
    return { orderId: printfulId, status: printfulStatus };
  } catch (error) {
    await sql`
      UPDATE poster_orders
         SET printful_status = 'failed', printful_error = ${clean(error?.message || "Printful request failed.", 500)}, updated_at = NOW()
       WHERE id = ${order.id} AND printful_order_id IS NULL
    `.catch(() => {});
    throw error;
  }
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
