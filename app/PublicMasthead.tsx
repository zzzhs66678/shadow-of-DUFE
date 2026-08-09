import Link from "next/link";
import styles from "./public-masthead.module.css";

type MastheadItem = {
  href: string;
  label: string;
  current?: boolean;
  showOnMobile?: boolean;
};

type MastheadAction = {
  label: string;
  onClick: () => void;
  badge?: string;
  badgeLabel?: string;
};

export function PublicMasthead({
  navigationLabel,
  items,
  action,
}: {
  navigationLabel: string;
  items: MastheadItem[];
  action?: MastheadAction;
}) {
  return (
    <header className={styles.masthead}>
      <Link href="/" className={styles.wordmark} aria-label="返回东财之影首页">
        <b>东财之影</b>
        <span>DUFE STUDENT DESK</span>
      </Link>
      <nav className={styles.navigation} aria-label={navigationLabel}>
        {items.map((item) => (
          <Link
            key={`${item.href}-${item.label}`}
            href={item.href}
            aria-current={item.current ? "page" : undefined}
            data-mobile={item.showOnMobile === false ? "hide" : "show"}
          >
            {item.label}
          </Link>
        ))}
        {action && (
          <button type="button" onClick={action.onClick}>
            {action.label}
            {action.badge ? (
              <i aria-label={action.badgeLabel}>{action.badge}</i>
            ) : null}
          </button>
        )}
      </nav>
    </header>
  );
}
