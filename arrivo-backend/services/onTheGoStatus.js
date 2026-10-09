// Status changes ops can make on an On the Go request from the admin queue.
const STATUSES = ["pending", "confirmed", "cancelled"];

// Returns { value: status } or { error } for a 400 response.
function parseStatusUpdate(body) {
  const status = body && typeof body.status === "string" ? body.status.trim() : "";
  if (!STATUSES.includes(status)) {
    return { error: `status must be one of: ${STATUSES.join(", ")}` };
  }
  return { value: status };
}

module.exports = { STATUSES, parseStatusUpdate };
