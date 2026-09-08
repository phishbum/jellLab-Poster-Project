import { clean, checkoutProduct, ensureOrderSchema, getAllowedOrigin, getSql, getStripe, integrationIdentifier, newOrderIdentity, priceFor, verifyPrintMaster } from "./_orders.js";
import { exclusionError, hasExcludedReference, sanitizeLayout, sanitizeStyle } from "./_poster-policy.js";

const WINDOW_MS = 10 * 60 * 1000;
const MAX_REQUESTS = 12;
const requestBuckets = new Map();

function underRateLimit(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  const now = Date.now();
  const bucket = requestBuckets.get(forwarded);
  if (!bucket || now - bucket.startedAt >= WINDOW_MS) {
    requestBuckets.set(forwarded, { startedAt: now, count: 1 });
    return true;
  }
  if (bucket.count >= MAX_REQUESTS) return false;
  bucket.count += 1;
  return true;
}

function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST for this endpoint." });
  }

  const origin = getAllowedOrigin(req);
  if (!origin) return res.status(403).json({ error: "This request origin is not allowed." });
  if (!underRateLimit(req)) return res.status(429).json({ error: "Too many checkout attempts. Please wait a moment." });
  if (!process.env.DATABASE_URL || !process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: "Secure checkout is being connected. Please try again shortly." });

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  } catch {
    return res.status(400).json({ error: "The request body must be valid JSON." });
  }

  const customerName = clean(body.customerName, 120);
  const customerEmail = clean(body.customerEmail, 254).toLowerCase();
  const format = ["Digital file", "Printed poster"].includes(body.format) ? body.format : "";
  const size = ["12 × 16 in", "18 × 24 in"].includes(body.size) ? body.size : "";
  const amountTotal = priceFor(format, size);
  const snapshot = {
    artist: clean(body.poster?.artist, 120),
    venue: clean(body.poster?.venue, 120),
    city: clean(body.poster?.city, 100),
    date: clean(body.poster?.date, 20),
    song: clean(body.poster?.song, 180),
    style: sanitizeStyle(body.poster?.style),
    layout: sanitizeLayout(body.poster?.layout)
  };

  if (!customerName || !validEmail(customerEmail)) return res.status(400).json({ error: "Enter your name and a valid email." });
  if (!amountTotal) return res.status(400).json({ error: "Choose a valid poster format and size." });
  if (!snapshot.artist || !snapshot.venue || !snapshot.date) return res.status(400).json({ error: "Your poster needs an artist, show date, and venue." });
  if (hasExcludedReference(snapshot.artist, snapshot.song)) return res.status(400).json({ error: exclusionError() });

  let printMaster;
  try {
    printMaster = await verifyPrintMaster(body.finalArtwork);
  } catch {
    return res.status(502).json({ error: "Your private print master could not be verified. Please try again." });
  }
  if (!printMaster) return res.status(400).json({ error: "Approve the artwork and prepare its print master before checkout." });

  const identity = newOrderIdentity();
  const sql = getSql();

  try {
    await ensureOrderSchema();
    await sql`
      INSERT INTO poster_orders (
        id, order_number, access_hash, status, customer_name, customer_email,
        format, size, amount_total, artwork_id, artwork_token, poster_snapshot
      ) VALUES (
        ${identity.id}, ${identity.number}, ${identity.accessHash}, 'checkout_pending', ${customerName}, ${customerEmail},
        ${format}, ${size}, ${amountTotal}, ${printMaster.id}, ${printMaster.token}, ${JSON.stringify(snapshot)}::jsonb
      )
    `;

    const product = checkoutProduct(format, size, snapshot);
    const params = {
      mode: "payment",
      client_reference_id: identity.id,
      customer_email: customerEmail,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: amountTotal,
          product_data: product
        }
      }],
      success_url: `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}#order-confirmation`,
      cancel_url: `${origin}/?checkout=cancelled#order`,
      metadata: {
        order_id: identity.id,
        order_number: identity.number,
        artwork_id: printMaster.id,
        format,
        size
      },
      payment_intent_data: {
        metadata: {
          order_id: identity.id,
          order_number: identity.number,
          artwork_id: printMaster.id
        }
      },
      integration_identifier: integrationIdentifier()
    };
    if (format === "Printed poster") params.shipping_address_collection = { allowed_countries: ["US"] };

    const stripe = getStripe();
    const session = await stripe.checkout.sessions.create(params, { idempotencyKey: `good-times-order-${identity.id}` });
    if (!session?.id || !session?.url) throw new Error("Stripe did not return a checkout URL.");

    try {
      await sql`
        UPDATE poster_orders
           SET stripe_checkout_session_id = ${session.id}, status = 'checkout_open', updated_at = NOW()
         WHERE id = ${identity.id}
      `;
    } catch (error) {
      try { await stripe.checkout.sessions.expire(session.id); } catch {}
      throw error;
    }
    return res.status(201).json({ checkoutUrl: session.url, orderNumber: identity.number });
  } catch (error) {
    try {
      await sql`UPDATE poster_orders SET status = 'checkout_failed', updated_at = NOW() WHERE id = ${identity.id}`;
    } catch {}
    console.error("Checkout Session creation failed.", { name: error?.name || "Error", message: error?.message || "Unknown error" });
    return res.status(502).json({ error: "Secure checkout could not be opened. Please try again." });
  }
}
