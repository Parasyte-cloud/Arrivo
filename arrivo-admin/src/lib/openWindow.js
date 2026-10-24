// Opens an Ops Console view in its own window. Inside the RA-workspace iframe it asks the
// workspace to open another window; on its own it opens a normal browser tab.
export function openInWindow(path, title) {
  const clean = String(path).replace(/^#?\/?/, "");
  const hash = `#/${clean}`;
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: "arrivoops:open", hash, title: title || "Ops Console" }, "*");
      return;
    }
  } catch { /* fall through to a normal tab */ }
  window.open(`${window.location.origin}${window.location.pathname}${hash}`, "_blank", "noopener");
}
