// Opens an Ops Console view as a standalone browser tab.
//
// This used to try postMessage-ing the embedding RA-workspace shell first
// (so it could open the view as another workspace window), only falling
// back to window.open when NOT embedded. RA-workspace never grew a
// listener for that "arrivoops:open" message, so inside the iframe this
// silently did nothing -- the postMessage went into the void and the
// function returned before ever reaching the window.open fallback. "Pop
// out" looked like a dead button either way: embedded or not, you always
// want a real tab here, so just open one unconditionally.
export function openInWindow(path, title) {
  const clean = String(path).replace(/^#?\/?/, "");
  const hash = `#/${clean}`;
  window.open(`${window.location.origin}${window.location.pathname}${hash}`, "_blank", "noopener");
}
