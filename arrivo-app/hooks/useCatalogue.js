import { useEffect, useState } from "react";
import { getServiceCatalogue } from "../services/api";
import { HUB_DEFAULT } from "../utils/services";

// The home-screen cards. Shows the built-in list at once and swaps in the server's
// when it arrives; if the server cannot be reached the built-in list stays.
export default function useCatalogue(token) {
  const [cards, setCards] = useState(HUB_DEFAULT);
  useEffect(() => {
    if (!token) return undefined;
    let off = false;
    getServiceCatalogue(token).then((r) => { if (!off && Array.isArray(r.services) && r.services.length) setCards(r.services); }).catch(() => {});
    return () => { off = true; };
  }, [token]);
  return cards;
}
