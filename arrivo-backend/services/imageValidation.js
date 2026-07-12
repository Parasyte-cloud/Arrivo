// Shared by routes/auth.js (rider/driver avatar at signup) and
// routes/drivers.js (license/vehicle photos) — one validation rule for
// every base64 image the API accepts, so the limits can't drift apart.
function validateImageDataUrl(dataUrl, label, maxBytes) {
  if (!dataUrl) return null; // optional by default — caller decides if it's required
  const match = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(dataUrl);
  if (!match) return `${label} must be a PNG, JPEG, or WEBP image.`;
  const approxBytes = (match[2].length * 3) / 4; // rough base64 -> bytes size
  if (approxBytes > maxBytes) return `${label} must be smaller than ${Math.round(maxBytes / (1024 * 1024))}MB.`;
  return null;
}

module.exports = { validateImageDataUrl };
