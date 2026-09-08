Exit code: 0
Wall time: 2.7 seconds
Output:
import test from "node:test";
import assert from "node:assert/strict";
import createCheckout from "../api/create-checkout-session.js";
import orderStatus from "../api/order-status.js";
import stripeWebhook from "../api/stripe-webhook.js";
import { checkoutProduct, integrationIdentifier, normalizeStripeSecret, priceFor } from "../api/_orders.js";

function response() {
  return {
    headers: {},
    statusCode: 200,
    payload: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; }
  };
}

test("catalog prices are calculated only on the server-approved matrix", () => {
  assert.equal(priceFor("Digital file", "12 × 16 in"), 2400);
  assert.equal(priceFor("Digital file", "18 × 24 in"), 4400);
  assert.equal(priceFor("Printed poster", "12 × 16 in"), 4900);
  assert.equal(priceFor("Printed poster", "18 × 24 in"), 6900);
  assert.equal(priceFor("Printed poster", "free"), null);
});

test("Checkout integration identifiers contain eight random letters", () => {
  assert.match(integrationIdentifier(), /^good_times_[a-z]{8}$/);
});

test("copied Stripe secrets are normalized without logging or exposing them", () => {
  const key = ["rk", "live", "abc123XYZ"].join("_");
  assert.equal(normalizeStripeSecret(key), key);
  assert.equal(normalizeStripeSecret(`STRIPE_SECRET_KEY=${key}`), key);
  assert.equal(normalizeStripeSecret(`\uFEFF\"STRIPE_SECRET_KEY=${key}\"\n`), key);
  assert.equal(normalizeStripeSecret(`copied value: ${key}`), key);
});

test("Checkout product copy is bounded and contains the exact selection", () => {
  const product = checkoutProduct("Printed poster", "18 × 24 in", { venue: "The Gorge", date: "1997-08-02" });
  assert.equal(product.name, "GOOD TIMES Printed poster");
  assert.equal(product.description, "18 × 24 in · The Gorge · 1997-08-02");
});

test("checkout rejects unsupported methods and origins before touching services", async () => {
  const methodResponse = response();
  await createCheckout({ method: "GET", headers: {} }, methodResponse);
  assert.equal(methodResponse.statusCode, 405);

  const originResponse = response();
  await createCheckout({ method: "POST", headers: { origin: "https://example.com" }, body: {} }, originResponse);
  assert.equal(originResponse.statusCode, 403);
});

test("checkout reports configuration safely without exposing environment details", async () => {
  const priorDatabase = process.env.DATABASE_URL;
  const priorStripe = process.env.STRIPE_SECRET_KEY;
  delete process.env.DATABASE_URL;
  delete process.env.STRIPE_SECRET_KEY;
  const res = response();
  await createCheckout({ method: "POST", headers: { origin: "https://jell-lab-poster-project.vercel.app" }, body: {} }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.error, "Secure checkout is being connected. Please try again shortly.");
  if (priorDatabase) process.env.DATABASE_URL = priorDatabase;
  if (priorStripe) process.env.STRIPE_SECRET_KEY = priorStripe;
});

test("order confirmation rejects malformed Checkout Session IDs", async () => {
  const priorDatabase = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://unused-for-validation";
  const res = response();
  await orderStatus({ method: "GET", query: { session_id: "not-a-session" } }, res);
  assert.equal(res.statusCode, 400);
  if (priorDatabase) process.env.DATABASE_URL = priorDatabase;
  else delete process.env.DATABASE_URL;
});

test("webhook endpoint requires POST and server-only secrets", async () => {
  const methodResponse = response();
  await stripeWebhook({ method: "GET", headers: {} }, methodResponse);
  assert.equal(methodResponse.statusCode, 405);

  const priorStripe = process.env.STRIPE_SECRET_KEY;
  const priorWebhook = process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  const configResponse = response();
  await stripeWebhook({ method: "POST", headers: {} }, configResponse);
  assert.equal(configResponse.statusCode, 503);
  if (priorStripe) process.env.STRIPE_SECRET_KEY = priorStripe;
  if (priorWebhook) process.env.STRIPE_WEBHOOK_SECRET = priorWebhook;
});

