import wordmark from "../assets/parasyte-wordmark-v2.png";

// PArAsYtE signature: centered alone at the base of every screen, links to parasyte.cloud.
export function ParasyteSignature() {
  return (
    <div className="parasyte-bar">
      <a className="parasyte-signature" href="https://www.parasyte.cloud" target="_blank" rel="noopener noreferrer" aria-label="PArAsYtE, major controller and engineering behind this product" title="PArAsYtE: major controller and engineering">
        <img src={wordmark} alt="PArAsYtE" width="900" height="167" decoding="async" draggable="false" />
      </a>
    </div>
  );
}
