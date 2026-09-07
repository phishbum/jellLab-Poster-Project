# GOOD TIMES Concert Poster Project

A three-step Phish concert-memory poster prototype with AI-assisted creative direction, private AI artwork generation, and permanent private project links.

## Architecture

- `index.html` is the public poster builder.
- `api/generate-poster.js` is a Vercel Function that securely calls the OpenAI Responses API.
- `api/generate-artwork.js` calls the OpenAI Images API and saves each generated draft plus a minimal generation record in private Vercel Blob storage.
- `api/artwork.js` serves a private draft only when its unguessable capability link is supplied, and controls inline viewing versus download.
- `api/project.js` saves and restores sanitized poster-builder state in Neon Postgres using a UUID plus a 256-bit private access token. Only a SHA-256 hash of the project token is stored in the database.
- The browser never receives the OpenAI API key.
- Only the show date, venue, city, song/moment, memory, selected style, and generated creative direction are sent for artwork generation. Checkout name, email, and payment details are excluded.

## Environment variables

Configure these in Vercel, not in client code:

- `OpenAI_API_key` (required; the existing production variable)
- `OPENAI_TEXT_MODEL` (optional; defaults to `gpt-5.6-luna`)
- `OPENAI_IMAGE_MODEL` (optional; defaults to `gpt-image-2`)
- `BLOB_READ_WRITE_TOKEN` (provided automatically when the private Blob store is connected)
- `DATABASE_URL` (provided automatically when Neon is connected through Vercel Marketplace)

Use `.env.example` only as a local template. Never commit a real key.

## Local development

Run with the Vercel CLI so the static site and `/api` function share one local origin:

```sh
vercel dev
```

Then open the local URL, enter a show date and venue, choose a style, and select **Create AI direction**. Artwork generation requires an environment pulled from the linked Vercel project.

## Safety and cost controls

The endpoints validate and bound inputs, use server-authored prompts, reject unexpected browser origins, rate-limit repeated requests per function instance, set request timeouts, and return generic errors without exposing secrets. Image generation is an explicit paid click, defaults to a low-quality 1024 Ã— 1536 WebP draft, and is limited to three requests per 30 minutes per warm function instance.

Generated images are stored in a private Blob store under a random UUID plus a 256-bit capability token. A user can create a permanent project link whose secret stays in the URL fragment, so it is not sent in ordinary page requests or server logs. Project records contain the show, creative state, artwork reference, approval, format, size, and total; checkout name, email, and payment details are not persisted. Changing the memory, show, or style invalidates the active artwork link but does not delete the persisted generation record.
