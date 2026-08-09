# 教师评价与教材工作簿预检（2026-08-09）

本报告是 M3 的首次正式 dry-run 结果，只记录统计、稳定错误码和导入边界，不包含历史评价原文、联系方式或其他高风险正文。源工作簿没有被修改，数据库没有写入。

## 输入指纹

| 类型 | 文件 | SHA-256 |
|---|---|---|
| 教师评价 | `教师评价（学长学姐）.xlsx` | `802f2f5f062601eee3c0c5b14c648ac70e4f1307cadf196a8155fefd52d1ad2d` |
| 教材计划 | `附件：2026-2027学年第一学期本科教材使用计划 (1).xlsx` | `4557fcd0c32507d1b1af3a92425b2b64f5cfd80afbf948386750af23c346e8b7` |

字段映射版本：`academic-workbooks-v1`。

## 教师与历史评价

- 教师候选行 863 条，历史评价候选 3,321 条。
- 发现 10 组跨学院同名教师；每一组必须依赖来源教师键映射到独立 UUID，不能按姓名合并。
- 2 行身份字段不完整：1 行缺教师姓名，另 1 行缺稳定来源键；两行涉及的 6 条评价候选均拒绝自动导入。
- 1,370 条评价候选至少包含一项内容风险：1,264 条时效性考核/给分陈述、88 条疑似人身攻击、63 条涉及其他教师、7 条疑似联系方式，另有 1 条超过 500 字。
- 全部 3,321 条历史评价均只进入私有 `pending` 候选；联系方式先脱敏，五维评分不从历史文本自动推断。管理员明确批准后，才可生成标注“历史整理内容”的公开评价。

## 教材与教学班

- 官方教材计划 1,143 行；展开后的教学班教材关系 2,660 行，覆盖 1,018 门课程。
- 777 行为“不指定教材”并使用占位 ISBN；保留为 `not_specified + placeholder`，不得伪造书目信息。
- 4 行官方计划出版日期无法规范化；连同展开表异常值，共产生 10 条 `invalid_publication_date` 警告，原始值保留待核对。
- 13 门课程存在多个教材版本，共影响 201 条教学班关系；数据模型按“学期 × 课程号 × 课序号 × 教师 × 教材项”保存，不覆盖目录课程的单一教材字段。
- 1 条课程号不在现有站点课程目录，拒绝自动写入；13 条教学班键无法与现有课表直接匹配，保留快照并进入人工核对。

## 导入边界

1. `teacher_id` 是随机稳定 UUID；来源系统与外部教师键单独映射，姓名和学院只用于检索与人工消歧。
2. dry-run 行证据不可变；实际写入另记 append-only mutation，重复应用同一文件摘要由数据库唯一索引阻止。
3. 历史评价候选与导入暂存对 auth runtime 完全撤权；原始评价正文不进入错误报告。
4. 教材事实按版本新增，旧版本标记 `superseded/withdrawn`；回滚不依靠硬删除。
5. 当前完成预检、数据库迁移代码和嵌入式 PostgreSQL 17.5 空库/重复迁移；尚未在原生 staging 执行 apply、并发幂等、运行角色权限和业务回滚演练，也没有发布或部署任何教师评价。

## 私有导入包验证

- 从本次两份正式源文件生成 861 条完整教师来源身份、3,294 条去重且已脱敏的历史评价候选、2,659 条可保存的教学班教材；2 行不完整教师身份、其 6 条评价、21 条同教师重复评价和 1 条缺目录课程没有进入可写记录。
- 私有包约 3.48MB，只保存在临时非公开目录；真实规模已在嵌入式 PostgreSQL 17.5 完成首次 apply、第二次幂等 no-op 和依赖顺序回滚，随后临时包被删除。
- 测试库首次形成 861 个独立教师 UUID、3,294 条 `pending` 候选和 2,659 条教学班教材；回滚后分别变为 861 个 `retired`、3,294 个 `rolled_back` 和 2,659 个 `withdrawn`，两批 mutation 全程保留。

## 可复现命令

```powershell
npm run import:academic:preflight -- --teacher "<教师评价.xlsx>" --textbook "<教材计划.xlsx>" --course-data "public/data/course-data.json" --out "<输出目录>"
```

命令生成 `preflight-summary.json`、可用 Excel 打开的 `preflight-errors.csv` 和权限受限的 `private-import-bundle.json`。CSV 只包含工作表、行列、处置状态、稳定错误码和实体键，不包含评价正文，并防止公式注入；私有包包含脱敏候选正文，只能保存在非公开目录，不得提交 Git 或放入 `public/`。

数据库写入必须使用专用 importer 角色，并显式开启写入开关：

```powershell
$env:IMPORT_ALLOW_APPLY = "true"
$env:IMPORT_DATABASE_URL = "postgresql://<importer>@<staging-host>/<database>"
npm run import:academic:write -- apply --bundle "<私有导入包>"
npm run import:academic:write -- rollback --batch "<批次 UUID>"
```

上述命令尚未对生产环境执行；生产数据库禁止用 owner 或 auth runtime 代替 importer 角色。
