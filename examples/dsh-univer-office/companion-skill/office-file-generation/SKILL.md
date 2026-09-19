---
name: office-file-generation
description: Generate real Microsoft Office files (.docx / .xlsx / .pptx) inside the workspace with ZERO dependencies (Python stdlib only), so the user can download them. Use proactively whenever the user asks to 生成/导出/产出 a Word 文档、Excel 表格、PPT 汇报 (docx / xlsx / pptx / doc / excel / ppt), 报告、周报、数据表、榜单、汇报材料 — especially when Univer's own import/export is unavailable on this host. Keywords: docx, xlsx, pptx, Word, Excel, PowerPoint, Office 文件, 生成文档, 生成表格, 生成汇报.
---

# 零依赖生成 docx / xlsx / pptx

## 何时用它（以及**不**用它）

| 用户想要 | 用什么 |
|---|---|
| **一个能下载的 Word/Excel/PPT 文件**（报告、榜单、数据表、汇报） | ✅ **本技能**（不碰任何原生库，本机一定可用） |
| 在 **Univer 里在线看 / 编辑** 表格或文档 | ❌ 不用本技能 → 用 `univer_new` / `univer_unit` / `univer_execute`（写 `.univer`，原生在线） |
| 把**外部** xlsx/docx **导入** Univer 里看 | ⛔ 本机做不到（走 Univer 原生绑定，要求 glibc ≥ 2.35，本机 2.32。别浪费时间，直接告诉用户：下载后用 Excel/Word 打开，或在 Univer 里用工具重新录入） |
| 把 `.univer` **导出**成 xlsx/docx | ⛔ 同上，本机做不到 |

**一句话**：本技能是「AI 直接产出 Office 文件」这条路，与 Univer 的导入导出**无关**、互不影响。

## 用法

脚本就在本技能目录下：`scripts/office_gen.py`（只依赖 Python 标准库，**不需要 pip、不需要联网**）。

```bash
# 1) 文档（docx）
python3 scripts/office_gen.py docx --out <工作区>/报告.docx --spec spec.json
# 2) 表格（xlsx）
python3 scripts/office_gen.py xlsx --out <工作区>/数据.xlsx --spec spec.json
# 3) 演示（pptx）
python3 scripts/office_gen.py pptx --out <工作区>/汇报.pptx --spec spec.json
# 4) CSV 直接转 xlsx（最常见：把采集到的数据变成 Excel）
python3 scripts/office_gen.py csv2xlsx --csv <工作区>/data.csv --out <工作区>/data.xlsx --sheet 数据
```

`--spec` 可以是：JSON 文件路径、**JSON 字符串**（推荐，避免落一个中间文件）、或 `-`（从 stdin 读）。

### spec 速查

```jsonc
// docx
{"title": "文档大标题",
 "blocks": [
   {"type": "heading1", "text": "一、总览"},
   {"type": "paragraph", "text": "正文段落"},
   {"type": "heading2", "text": "二、榜单"},
   {"type": "table", "header": true, "rows": [["排名","标题","播放量"], ["1","A",1200000]]},
   {"type": "bullet", "items": ["要点 1", "要点 2"]},
   {"type": "heading3", "text": "三、结论"}
 ]}

// xlsx（多 sheet、列宽、表头加粗、公式）
{"sheets": [
  {"name": "爆款榜", "header": true, "widths": [8, 26, 14],
   "rows": [["排名","标题","播放量"], ["1","A",1200000], ["合计","","=SUM(C2:C2)"]]}
]}

// pptx
{"title": "封面标题", "subtitle": ["副标题", "日期"],
 "slides": [{"title": "页标题", "bullets": ["要点 1", "要点 2"]}]}
```

- 单元格值类型自动判断：数字原样（可参与计算）、`"=SUM(...)"` 写成**真公式**、其余当文本。
- 表格首行按 `header: true` 自动加粗 + 灰底。

## 产出放哪

写到**用户工作区**里（`ws/...`），用户从实例页右下角 **📁 我的文件** 就能看到并下载。

## 能力边界（**如实告诉用户**，别承诺做不到的）

能做到：标题层级、正文段落、项目符号、**表格**、多工作表、列宽、加粗表头、**真公式**、多页幻灯片。
做不到（本生成器刻意保持零依赖）：图片、图表、页眉页脚、目录、复杂列表自动编号（用 `• ` 前缀代替）、单元格样式模板、公式**重算**（公式写进去了，要 Excel/WPS/Univer 打开时才算出结果）。

若用户要的是"排版精美的成品"，优先问清要素，再用它生成；要样式更复杂时**先说明限制**，不要硬做。

## 生成后自检（建议做）

```bash
python3 - <<'PY'
import zipfile
z = zipfile.ZipFile("你的文件.docx")
assert z.testzip() is None
print(sorted(z.namelist()))
PY
```

## 维护注记（给改这个技能的人）

- 本机（宿主）**glibc 2.32**，Univer 的两个原生绑定（公式引擎、Office 导入导出）都要求 **≥ 2.35** ⇒
  「Office 文件 ↔ Univer 内容」的**原生转换**在实例里不可用；本技能是**绕开原生转换**的正解。
- OOXML 手写有两个**必需**元素容易漏：Word 的 `w:tbl` 里必须有 **`w:tblGrid`**（漏了 strict 解析器直接报错），
  xlsx 的 `styles.xml` 里 `fills` 前两个必须是 `none` / `gray125`。改动后用 `python-docx` / `openpyxl` / `python-pptx` 复验。
