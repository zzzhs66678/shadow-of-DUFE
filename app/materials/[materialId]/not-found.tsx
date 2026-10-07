import Link from "next/link";
import styles from "../materials.module.css";

export default function MaterialNotFound() {
  return (
    <main className={styles.detailPage} id="main-content">
      <section className={styles.notFound}>
        <span>404</span>
        <h1>这份资料不存在，或已经撤下。</h1>
        <Link href="/materials">返回资料搜索</Link>
      </section>
    </main>
  );
}
