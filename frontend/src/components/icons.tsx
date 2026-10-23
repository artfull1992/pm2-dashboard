// Small line icons for the navigation (no icon dependency in the project; design reference 1.0 asks for an existing
// set, and the project has none — these are plain inline SVG paths). Always decorative: the link or button that holds
// an icon carries the accessible name.

export type IconName = 'overview' | 'servers' | 'applications' | 'alerts' | 'users' | 'audit' | 'settings' | 'account' | 'logout';

const PATHS: Record<IconName, string> = {
  overview: 'M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z',
  servers: 'M4 5h16v6H4zM4 13h16v6H4zM7.5 8h.01M7.5 16h.01',
  applications: 'M4 5h16M4 9.67h16M4 14.33h16M4 19h16',
  alerts: 'M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20.5a2 2 0 0 0 4 0',
  users: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20a7.5 7.5 0 0 1 15 0',
  audit: 'M6 4h12v16H6zM9 8.5h6M9 12h6M9 15.5h4',
  settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4',
  account: 'M12 12a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM5.5 19.5a6.5 6.5 0 0 1 13 0',
  logout: 'M10 5H5v14h5M14 8l4 4-4 4M18 12H9',
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"
      fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[name]} />
    </svg>
  );
}
