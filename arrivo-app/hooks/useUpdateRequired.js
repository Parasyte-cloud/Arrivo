import { useSyncExternalStore } from "react";
import { getUpdateRequired, subscribeUpdateRequired } from "../utils/updateRequired";

// The update-required details once any request has been told this build is too
// old, otherwise null.
export default function useUpdateRequired() {
  return useSyncExternalStore(subscribeUpdateRequired, getUpdateRequired, getUpdateRequired);
}
