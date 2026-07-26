// Renamed to useCreateStreamVideoClient.js — kept as a thin re-export only
// so nothing breaks if some other file still imports from this old path.
// See useCreateStreamVideoClient.js for the real implementation and the
// reasoning for the rename (avoiding a name collision with the Stream SDK's
// own useStreamVideoClient() context hook).
export { useCreateStreamVideoClient as useStreamVideoClient } from "./useCreateStreamVideoClient";
