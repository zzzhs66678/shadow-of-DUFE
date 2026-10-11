import styles from "./campus-shell.module.css";

/** One wordmark across the workspace and public pages, without a second title. */
export function CampusWordmark() {
  return <b className={styles.wordmark}>东财之<em>影</em></b>;
}
