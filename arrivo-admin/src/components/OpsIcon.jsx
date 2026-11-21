const PATHS = {
  overview: '<path d="M3 3h7v7H3zM14 3h7v4h-7zM14 11h7v10h-7zM3 14h7v7H3z"/>',
  headset: '<path d="M4 13v-2a8 8 0 0 1 16 0v2"/><path d="M18 19h-1a2 2 0 0 1-2-2v-4h5v4a2 2 0 0 1-2 2ZM6 19H5a2 2 0 0 1-2-2v-4h5v4a2 2 0 0 1-2 2Z"/>',
  alert: '<path d="M10.3 2.9 1.8 17.4A2 2 0 0 0 3.5 20h17a2 2 0 0 0 1.7-2.6L13.7 2.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  car: '<path d="M5 17h14l1-5-3-5H7l-3 5 1 5Z"/><path d="M7 17v2M17 17v2M6 12h12M8 14h.01M16 14h.01"/>',
  message: '<path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/>',
  plane: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  ticket: '<path d="M2 9a3 3 0 0 0 0 6v4h20v-4a3 3 0 0 0 0-6V5H2Z"/><path d="M13 5v2M13 17v2M13 11v2"/>',
  wallet: '<path d="M20 7V5a2 2 0 0 0-2-2H5a3 3 0 0 0 0 6h15v10H5a3 3 0 0 1-3-3V6"/><path d="M16 13h.01"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
  pricing: '<path d="M20 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h7"/><path d="M16 3h5v5M10 14 21 3"/>',
  compass: '<circle cx="12" cy="12" r="10"/><path d="m16 8-2.5 5.5L8 16l2.5-5.5Z"/>',
  radar: '<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/>',
  map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3Z"/><path d="M9 3v15M15 6v15"/>',
  chart: '<path d="M3 3v18h18"/><path d="m7 16 4-5 4 3 5-7"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  lock: '<rect x="3" y="11" width="18" height="10" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>',
  external: '<path d="M14 3h7v7M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  refresh: '<path d="M20 6v5h-5M4 18v-5h5"/><path d="M18.5 9A7 7 0 0 0 6 5.5L4 8M5.5 15A7 7 0 0 0 18 18.5l2-2.5"/>',
  bolt: '<path d="m13 2-9 12h8l-1 8 9-12h-8Z"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5Z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/>',
};

export function OpsIcon({ name, size = 18, className = "", strokeWidth = 1.8 }) {
  const markup = PATHS[name] || PATHS.overview;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
