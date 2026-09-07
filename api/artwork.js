import { get } from "@vercel/blob";

function allowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const allowed = new Set([
    "https://jell-lab-poster-project.vercel.app",
    process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "",
    process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "",
    "http://localhost:3000",
    "http://127.0.0.1:3000"
  ]);
  return allowed.has(origin);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Use GET for this endpoint." });
  }
  if (!allowedOrigin(req)) return res.status(403).json({ error: "This request origin is not allowed." });

  const id = typeof req.query.id === "string" ? req.query.id : "";
  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (!/^[0-9a-f-]{36}$/i.test(id) || !/^[0-9a-f]{64}$/i.test(token)) return res.status(400).json({ error: "Invalid artwork link." });

  try {
    let record;
    try {
      const recordResult = await get(`records/${id}-${token}.json`, { access: "private" });
      if (recordResult?.statusCode === 200) {
        const recordBytes = await new Response(recordResult.stream).arrayBuffer();
        record = JSON.parse(Buffer.from(recordBytes).toString("utf8"));
      }
    } catch {
      record = null;
    }

    const safePathname = typeof record?.pathname === "string" && /^(generations|finals)\/[0-9a-f-]{36}-[0-9a-f]{64}\.(webp|jpe?g|png)$/i.test(record.pathname)
      ? record.pathname
      : `generations/${id}-${token}.webp`;
    const result = await get(safePathname, { access: "private" });
    if (!result || result.statusCode !== 200) return res.status(404).json({ error: "Artwork not found." });
    const bytes = Buffer.from(await new Response(result.stream).arrayBuffer());
    const contentType = result.blob.contentType || record?.contentType || "image/webp";
    const extension = contentType === "image/jpeg" ? "jpg" : contentType === "image/png" ? "png" : "webp";
    const filename = record?.kind === "print-master" ? `good-times-print-master-${id}.${extension}` : `good-times-poster-${id}.${extension}`;
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", String(bytes.length));
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Content-Disposition", `${req.query.download === "1" ? "attachment" : "inline"}; filename="${filename}"`);
    return res.status(200).end(bytes);
  } catch (error) {
    console.error("Private artwork retrieval failed.", { name: error?.name || "Error", message: error?.message || "Unknown error" });
    return res.status(502).json({ error: "Artwork could not be loaded." });
  }
}
