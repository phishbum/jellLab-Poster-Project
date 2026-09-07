import { CHECKOUT_SESSION_PATTERN, clean, ensureOrderSchema, getSql, getStripe, markOrderFromSession } from "./_orders.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, private");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Use GET for this endpoint." });
  }
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: "Order confirmation is temporarily unavailable." });

  const sessionId = clean(req.query?.session_id, 160);
  if (!CHECKOUT_SESSION_PATTERN.test(sessionId)) return res.status(400).json({ error: "That checkout confirmation link is invalid." });

  try {
    await ensureOrderSchema();
    const sql = getSql();
    let rows = await sql`
      SELECT order_number, status, format, size, amount_total, currency, artwork_id, artwork_token, created_at, paid_at
        FROM poster_orders
       WHERE stripe_checkout_session_id = ${sessionId}
       LIMIT 1
    `;
    if (!rows.length) return res.status(404).json({ error: "That order could not be found." });

    if (rows[0].status !== "paid" && process.env.STRIPE_SECRET_KEY) {
      const session = await getStripe().checkout.sessions.retrieve(sessionId);
      await markOrderFromSession(session);
      rows = await sql`
        SELECT order_number, status, format, size, amount_total, currency, artwork_id, artwork_token, created_at, paid_at
          FROM poster_orders
         WHERE stripe_checkout_session_id = ${sessionId}
         LIMIT 1
      `;
    }

    const order = rows[0];
    const paid = order.status === "paid";
    const query = paid ? `id=${encodeURIComponent(order.artwork_id)}&token=${encodeURIComponent(order.artwork_token)}&download=1` : "";
    return res.status(200).json({
      order: {
        number: order.order_number,
        status: order.status,
        paid,
        format: order.format,
        size: order.size,
        amountTotal: Number(order.amount_total),
        currency: order.currency,
        createdAt: order.created_at,
        paidAt: order.paid_at,
        downloadUrl: query ? `/api/artwork?${query}` : null
      }
    });
  } catch (error) {
    console.error("Order confirmation lookup failed.", { name: error?.name || "Error", message: error?.message || "Unknown error" });
    return res.status(502).json({ error: "Your order confirmation could not be loaded. Please refresh and try again." });
  }
}
