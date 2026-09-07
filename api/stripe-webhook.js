import { clean, ensureOrderSchema, getSql, getStripe, markOrderFromSession } from "./_orders.js";

export const config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > 1024 * 1024) throw new Error("Webhook body is too large.");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST for this endpoint." });
  }
  if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET || !process.env.DATABASE_URL) {
    return res.status(503).json({ error: "Webhook processing is not configured." });
  }

  const signature = clean(req.headers["stripe-signature"], 1000);
  if (!signature) return res.status(400).json({ error: "Missing Stripe signature." });

  let event;
  try {
    const rawBody = await readRawBody(req);
    event = getStripe().webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    console.warn("Rejected Stripe webhook.", { name: error?.name || "Error", message: error?.message || "Invalid signature" });
    return res.status(400).json({ error: "Invalid Stripe webhook signature." });
  }

  try {
    await ensureOrderSchema();
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      await markOrderFromSession(event.data.object);
    } else if (event.type === "checkout.session.expired" || event.type === "checkout.session.async_payment_failed") {
      const session = event.data.object;
      const orderId = clean(session?.metadata?.order_id || session?.client_reference_id, 40);
      if (orderId) {
        const status = event.type === "checkout.session.expired" ? "checkout_expired" : "payment_failed";
        await getSql()`
          UPDATE poster_orders
             SET status = ${status}, updated_at = NOW()
           WHERE id = ${orderId} AND stripe_checkout_session_id = ${session.id} AND status <> 'paid'
        `;
      }
    } else if (event.type === "charge.refunded") {
      const charge = event.data.object;
      const paymentIntent = typeof charge?.payment_intent === "string" ? charge.payment_intent : charge?.payment_intent?.id;
      if (paymentIntent) {
        await getSql()`
          UPDATE poster_orders
             SET status = 'refunded', updated_at = NOW()
           WHERE stripe_payment_intent_id = ${paymentIntent} AND status = 'paid'
        `;
      }
    }
    return res.status(200).json({ received: true });
  } catch (error) {
    console.error("Stripe webhook processing failed.", { eventId: clean(event?.id, 120), type: clean(event?.type, 120), message: error?.message || "Unknown error" });
    return res.status(500).json({ error: "Webhook processing failed." });
  }
}
