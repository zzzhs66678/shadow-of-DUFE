import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { MaterialAvailability } from "../MaterialAvailability";
import { PublicMasthead } from "../../PublicMasthead";
import styles from "../materials.module.css";
import { getMaterialById } from "../materials-catalog.mjs";

type PageProps = { params: Promise<{ materialId: string }> };

function fileSize(bytes: number) {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const material = getMaterialById((await params).materialId);
  if (!material) return { title: "资料未找到" };
  return {
    title: material.name,
    description: `${material.courseTitle} · ${material.kind} · ${material.description}`,
  };
}

export default async function MaterialDetailPage({ params }: PageProps) {
  const material = getMaterialById((await params).materialId);
  if (!material) notFound();
  return (
    <main className={styles.detailPage} id="main-content">
      <PublicMasthead
        navigationLabel="资料详情导航"
        items={[
          { href: "/materials", label: "返回资料档案" },
          { href: "/?view=catalog", label: "课程库", showOnMobile: false },
        ]}
      />
      <article className={styles.detailSheet}>
        <div className={styles.detailIndex} aria-hidden="true">
          <span>MATERIAL</span>
          <b>{material.extension.replace(".", "").toUpperCase()}</b>
        </div>
        <div className={styles.detailMain}>
          <p className={styles.eyebrow}>{material.courseTitle} · {material.category}</p>
          <h1>{material.name}</h1>
          <p className={styles.description}>{material.description}</p>
          <dl>
            <div><dt>课程</dt><dd>{material.courseTitle}<small>{material.courseIds.join(" / ")}</small></dd></div>
            <div><dt>教师</dt><dd>{material.teachers.length ? material.teachers.join(" / ") : "未标注"}</dd></div>
            <div><dt>文件</dt><dd>{material.kind} · {material.extension.replace(".", "").toUpperCase()} · {fileSize(material.sizeBytes)}</dd></div>
            <div><dt>适用范围</dt><dd>{material.terms.map((item) => item === "fall" ? "上学期" : "下学期").join(" / ") || "未标注"}{material.years.length ? ` · 大${material.years.map((item) => "一二三四"[item - 1]).join(" / 大")}` : ""}</dd></div>
          </dl>
          <MaterialAvailability downloadUrl={material.downloadUrl} previewUrl={material.previewUrl} previewable={material.previewable} />
        </div>
        <aside className={styles.detailAside}>
          <span>资料标签</span>
          <div>{material.tags.map((tag) => <Link key={tag} href={`/materials?tag=${encodeURIComponent(tag)}`}>{tag}</Link>)}</div>
          <p>资料由站长整理发布。课程与文件如有更新，以学校官方信息和文件内容为准。</p>
        </aside>
      </article>
    </main>
  );
}
