// Wraps a phone number as a tel: link so clicking it opens the OS's default
// calling app — works today with zero backend, same technique as the
// panic button's WhatsApp escalation on the main site. On a phone this
// opens the dialer directly; on desktop it opens whatever's registered to
// handle tel: links (FaceTime, Skype, etc.) or does nothing if none is.
export function PhoneLink({ phone, fallback = "—", style }) {
  if (!phone) return <span style={{ color: "var(--text-muted)" }}>{fallback}</span>;
  return (
    <a href={`tel:${phone}`} style={{ color: "var(--teal)", fontWeight: 600, textDecoration: "none", ...style }}>
      📞 {phone}
    </a>
  );
}
