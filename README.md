# GOOD TIMES Concert Poster Project

A three-step Phish concert-memory poster prototype with AI-assisted creative direction.

## Architecture

- `index.html` is the public poster builder.
- `api/generate-poster.js` is a Vercel Function that securely calls the OpenAI Responses API.
- The browser never receives the OpenAI API key.
- Only the show date, venue, city, song/moment, memory, and selected style are sent for creative-direction generation. Checkout name, email, and payment details are excluded.

## Environment variables

Configure these in Vercel, not in client code:

- `OpenAI_API_key` (required; the existing production variable)
- `OPENAI_TEXT_MODEL` (optional; defaults to `gpt-6-astra`)

Use `.env.example` only as a local template. Never commit a real key.

## Local development

Run with the Vercel CLI so the static site and `/api` function share one local origin:

```sh
vercel dev
```

Then open the local URL, enter a show date and venue, choose a style, and select **Create AI direction**.

## Safety and cost controls

The endpoint validates and bounds inputs, uses a fixed server-authored instruction, requests strict structured JSON, disables response storage, rejects unexpected browser origins, limits repeated requests per function instance, sets output limits, and returns generic errors without exposing secrets.
