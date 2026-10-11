import { CompetitionNavigation } from "../CompetitionNavigation";
import styles from "../competitions.module.css";

export default function CompetitionNotFound() {
  return (
    <section className={styles.heading}>
      <CompetitionNavigation href="/competitions" label="返回考试及竞赛" />
      <h1>没有找到这个项目</h1>
    </section>
  );
}
