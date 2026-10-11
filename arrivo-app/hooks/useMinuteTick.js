import { useEffect, useState } from "react";

// Re-renders the screen every `everyMs` and returns the current time. Booking
// screens use it so "is this time still far enough away" and "which day is
// today" are re-checked while the screen sits open, instead of only when the
// rider next touches a field. Without it, a form left open past midnight (or
// until the 12 hour line moves past the chosen time) keeps a stale answer and
// the failure only shows after payment.
export default function useMinuteTick(everyMs = 30000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}
