import Link from "next/link";
import styles from "../materials.module.css";

export default function MaterialNotFound() {
  return (
    <main className={styles.detailPage} id="main-content">
      <section className={styles.notFound}>
        <span>404 / ARCHIVE GAP</span>
        <h1>这份资料不存在，或已经撤下。</h1>
        <p>资料编号没有匹配到当前公开档案。可以返回搜索页换课程名、教师或文件标题再找一次。</p>
        <Link href="/materials">返回资料搜索</Link>
      </section>
    </main>
  );
}
