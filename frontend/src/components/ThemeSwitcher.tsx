import { setThemePreference, THEME_LABELS, THEME_ORDER, useThemePreference } from '../theme';
import { ActionMenu } from './ActionMenu';

// The theme choice («Світла / Темна / Як у системі») for every role: in the sidebar, the compact rail (icon), the
// mobile menu and on the login page. One shared component and store (theme.ts); the menu is the shared ActionMenu
// with radio items, so keyboard, Escape and focus return work as everywhere else.

export function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const pref = useThemePreference();
  const items = THEME_ORDER.map((p) => ({
    key: p, label: THEME_LABELS[p], checked: p === pref, disabled: false, onSelect: () => { setThemePreference(p); },
  }));
  const name = `Тема оформлення: ${THEME_LABELS[pref]}`;
  return (
    <span className="theme-switcher" data-tip={compact ? name : undefined}>
      <ActionMenu name="Тема оформлення" menuLabel="Тема оформлення" ariaLabel={name} items={items}
        label={compact ? '◐' : `Тема: ${THEME_LABELS[pref]}`} iconOnly={compact} subtle={!compact} />
    </span>
  );
}
