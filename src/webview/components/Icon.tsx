const paths = {
  book: 'M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-3H4V4Zm16 0h-4a3 3 0 0 0-3 3m0 14a4 4 0 0 1 4-3h3V4Z',
  plus: 'M12 5v14M5 12h14',
  left: 'm14 6-6 6 6 6', right: 'm10 6 6 6-6 6',
  menu: 'M4 6h16M4 12h16M4 18h16',
  settings: 'M4 7h16M4 17h16M8 4v6m8 4v6',
  close: 'm6 6 12 12M18 6 6 18',
  shelf: 'M4 4v16h16M8 4v12m5-12v12m3-11 4 10',
  search: 'M15 15 21 21M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5m4-5v5',
  check: 'm5 12 4 4L19 6',
};
export function Icon({ name, size = 18 }: { name: keyof typeof paths; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
