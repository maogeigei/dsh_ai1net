#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""零依赖 Office 文件生成器（docx / xlsx / pptx）。

为什么存在：本平台的用户实例跑在 glibc 2.32 上，而 Univer 的 Office 导入导出走
`@univerjs-pro/exchange-node` 的 Rust 原生绑定（要求 GLIBC >= 2.35）⇒ **在实例里不可用**。
而"AI 生成一个 Word/Excel/PPT 文件给用户下载"这件事**根本不需要那个原生库**：
Office 文件就是 zip + XML，Python 标准库自带 `zipfile`，手写 OOXML 即可。

因此本脚本只依赖 Python 标准库（3.8+），可在任何实例里直接跑（无需 pip、无需联网）。

用法：
    python3 office_gen.py docx --out 报告.docx --spec spec.json
    python3 office_gen.py xlsx --out 数据.xlsx --spec spec.json
    python3 office_gen.py pptx --out 汇报.pptx --spec spec.json
    python3 office_gen.py csv2xlsx --csv 数据.csv --out 数据.xlsx --sheet 数据
    # 也支持 --json '<json 字符串>' 或从 stdin 读（--spec -）

规格（spec）：
 docx: {"title": "可选",
        "blocks": [{"type": "title|heading1|heading2|heading3|paragraph|bullet|table",
                    "text": "段落文本",
                    "items": ["列表项 1", "列表项 2"],
                    "rows": [["表头A","表头B"], ["v1","v2"]],
                    "header": true}]}
 xlsx: {"sheets": [{"name": "Sheet1", "header": true, "widths": [12, 20],
                    "rows": [["名称", "数量"], ["甲", 12], ["乙", "=SUM(B2:B2)"]]}]}
 pptx: {"title": "可选（封面）", "slides": [{"title": "页标题",
                                            "bullets": ["要点 1", "要点 2"]}]}
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import sys
import zipfile
from xml.sax.saxutils import escape, quoteattr

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
REL = "http://schemas.openxmlformats.org/package/2006/relationships"
OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
SS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'


def _pkg(parts: dict[str, str], out: str) -> None:
    """把 {内路径: XML 文本} 写成一个 zip（OOXML 包=zip）。"""
    parent = os.path.dirname(os.path.abspath(out))
    if parent:
        os.makedirs(parent, exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name, text in parts.items():
            z.writestr(name, text.encode("utf-8"))


# --------------------------------------------------------------------------- docx


def _wc(text: str, bold: bool = False, italic: bool = False, size_half_pt: int | None = None) -> str:
    rpr = ""
    if bold or italic or size_half_pt:
        inner = ("<w:b/>" if bold else "") + ("<w:i/>" if italic else "")
        if size_half_pt:
            inner += f'<w:sz w:val="{size_half_pt}"/>'
        rpr = f"<w:rPr>{inner}</w:rPr>"
    return f'<w:r>{rpr}<w:t xml:space="preserve">{escape(text)}</w:t></w:r>'


def _wpara(text: str, style: str | None = None, *, bullet: bool = False, bold: bool = False) -> str:
    if bullet:
        text = "•  " + text
    ppr = f'<w:pPr><w:pStyle w:val={quoteattr(style)}/></w:pPr>' if style else ""
    return f"<w:p>{ppr}{_wc(text, bold=bold)}</w:p>"


def _wtable(rows: list[list[object]], header: bool) -> str:
    borders = (
        "<w:tblBorders>"
        + "".join(
            f'<w:{edge} w:val="single" w:sz="4" w:space="0" w:color="999999"/>'
            for edge in ("top", "left", "bottom", "right", "insideH", "insideV")
        )
        + "</w:tblBorders>"
    )
    # ⚠️ `w:tblGrid` 是**必需**子元素（缺了 Word 可能容忍，但 python-docx 等严格解析器直接报
    # `InvalidXmlError: required <w:tblGrid> child element not present`）⇒ 必须算好列数写出来。
    columns = max((len(row) for row in rows), default=1) or 1
    total_width = 9026  # A4 纵向正文宽（11906 - 左右各 1440 twips）
    column_width = max(1, total_width // columns)
    grid = "<w:tblGrid>" + "".join(
        f'<w:gridCol w:w="{column_width}"/>' for _ in range(columns)
    ) + "</w:tblGrid>"
    out = [
        "<w:tbl><w:tblPr>"
        f'<w:tblW w:w="{column_width * columns}" w:type="dxa"/>{borders}'
        '<w:tblLayout w:type="fixed"/>'
        "</w:tblPr>",
        grid,
    ]
    for r_index, row in enumerate(rows):
        cells = []
        for value in row:
            text = "" if value is None else str(value)
            cell_body = (
                _wpara(text, bold=True) if (header and r_index == 0) else _wpara(text)
            )
            cells.append(f'<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>{cell_body}</w:tc>')
        out.append("<w:tr>" + "".join(cells) + "</w:tr>")
    out.append("</w:tbl>")
    # Word 要求表格后必须跟一个段落，否则文档尾部会异常
    out.append("<w:p/>")
    return "".join(out)


def _wstyles() -> str:
    def style(style_id: str, name: str, size: int, bold: bool, outline: int | None = None) -> str:
        ppr = f'<w:pPr><w:outlineLvl w:val="{outline}"/></w:pPr>' if outline is not None else ""
        return (
            f'<w:style w:type="paragraph" w:styleId="{style_id}">'
            f'<w:name w:val="{name}"/><w:basedOn w:val="Normal"/>{ppr}'
            f'<w:rPr>{"<w:b/>" if bold else ""}<w:sz w:val="{size}"/></w:rPr></w:style>'
        )

    return (
        XML_DECL
        + f'<w:styles xmlns:w="{W}">'
        '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>'
        '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
        + style("Title", "Title", 56, True)
        + style("Heading1", "heading 1", 40, True, 0)
        + style("Heading2", "heading 2", 32, True, 1)
        + style("Heading3", "heading 3", 26, True, 2)
        + "</w:styles>"
    )


def build_docx(spec: dict, out: str) -> None:
    body: list[str] = []
    if spec.get("title"):
        body.append(_wpara(str(spec["title"]), "Title"))
    for block in spec.get("blocks") or []:
        kind = str(block.get("type") or "paragraph")
        text = block.get("text")
        if kind == "table":
            body.append(_wtable(block.get("rows") or [], bool(block.get("header", True))))
        elif kind == "bullet":
            items = block.get("items") or ([text] if text else [])
            body.extend(_wpara(str(item), bullet=True) for item in items)
        elif kind in ("title", "heading1", "heading2", "heading3"):
            style = {"title": "Title", "heading1": "Heading1", "heading2": "Heading2", "heading3": "Heading3"}[kind]
            body.append(_wpara("" if text is None else str(text), style))
        else:
            body.append(_wpara("" if text is None else str(text)))

    document = (
        XML_DECL
        + f'<w:document xmlns:w="{W}"><w:body>'
        + "".join(body)
        + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>'
        + "</w:body></w:document>"
    )
    parts = {
        "[Content_Types].xml": (
            XML_DECL
            + f'<Types xmlns="{CT}">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
            "</Types>"
        ),
        "_rels/.rels": (
            XML_DECL
            + f'<Relationships xmlns="{REL}">'
            f'<Relationship Id="rId1" Type="{OFFICE_REL}/officeDocument" Target="word/document.xml"/>'
            "</Relationships>"
        ),
        "word/document.xml": document,
        "word/_rels/document.xml.rels": (
            XML_DECL
            + f'<Relationships xmlns="{REL}">'
            f'<Relationship Id="rId1" Type="{OFFICE_REL}/styles" Target="styles.xml"/>'
            "</Relationships>"
        ),
        "word/styles.xml": _wstyles(),
    }
    _pkg(parts, out)


# --------------------------------------------------------------------------- xlsx


def _col_ref(index: int) -> str:
    ref = ""
    index += 1
    while index:
        index, rem = divmod(index - 1, 26)
        ref = chr(65 + rem) + ref
    return ref


def _cell(ref: str, value: object, style: int | None = None) -> str:
    attr = f' s="{style}"' if style else ""
    if isinstance(value, bool):
        return f'<c r="{ref}"{attr} t="b"><v>{1 if value else 0}</v></c>'
    if isinstance(value, (int, float)):
        return f'<c r="{ref}"{attr}><v>{value}</v></c>'
    text = "" if value is None else str(value)
    if text.startswith("=") and len(text) > 1:  # 公式
        return f'<c r="{ref}"{attr}><f>{escape(text[1:])}</f></c>'
    return f'<c r="{ref}"{attr} t="inlineStr"><is><t xml:space="preserve">{escape(text)}</t></is></c>'


def _sheet_xml(sheet: dict) -> str:
    rows = sheet.get("rows") or []
    widths = sheet.get("widths") or []
    header = bool(sheet.get("header"))
    cols = ""
    if widths:
        cols = "<cols>" + "".join(
            f'<col min="{i + 1}" max="{i + 1}" width="{w}" customWidth="1"/>'
            for i, w in enumerate(widths)
        ) + "</cols>"
    body = []
    for r_index, row in enumerate(rows):
        cells = "".join(
            _cell(f"{_col_ref(c_index)}{r_index + 1}", value, 1 if (header and r_index == 0) else None)
            for c_index, value in enumerate(row)
        )
        body.append(f'<row r="{r_index + 1}">{cells}</row>')
    return (
        XML_DECL
        + f'<worksheet xmlns="{SS}">{cols}<sheetData>{"".join(body)}</sheetData></worksheet>'
    )


def _xstyles() -> str:
    return (
        XML_DECL
        + f'<styleSheet xmlns="{SS}">'
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
        '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
        '<fills count="3"><fill><patternFill patternType="none"/></fill>'
        '<fill><patternFill patternType="gray125"/></fill>'
        '<fill><patternFill patternType="solid"><fgColor rgb="FFEEEEEE"/><bgColor indexed="64"/></patternFill></fill></fills>'
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>'
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        "</styleSheet>"
    )


def build_xlsx(spec: dict, out: str) -> None:
    sheets = spec.get("sheets") or [{"name": "Sheet1", "rows": spec.get("rows") or []}]
    parts: dict[str, str] = {}
    overrides = [
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    ]
    sheet_tags = []
    rel_tags = []
    for i, sheet in enumerate(sheets):
        name = str(sheet.get("name") or f"Sheet{i + 1}")
        sheet_path = f"xl/worksheets/sheet{i + 1}.xml"
        parts[sheet_path] = _sheet_xml(sheet)
        overrides.append(
            f'<Override PartName="/{sheet_path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        )
        sheet_tags.append(f'<sheet name={quoteattr(name)} sheetId="{i + 1}" r:id="rId{i + 1}"/>')
        rel_tags.append(
            f'<Relationship Id="rId{i + 1}" Type="{OFFICE_REL}/worksheet" Target="worksheets/sheet{i + 1}.xml"/>'
        )
    parts["[Content_Types].xml"] = (
        XML_DECL
        + f'<Types xmlns="{CT}">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        + "".join(overrides)
        + "</Types>"
    )
    parts["_rels/.rels"] = (
        XML_DECL
        + f'<Relationships xmlns="{REL}">'
        f'<Relationship Id="rId1" Type="{OFFICE_REL}/officeDocument" Target="xl/workbook.xml"/>'
        "</Relationships>"
    )
    parts["xl/workbook.xml"] = (
        XML_DECL
        + f'<workbook xmlns="{SS}" xmlns:r="{R}"><sheets>{"".join(sheet_tags)}</sheets></workbook>'
    )
    parts["xl/_rels/workbook.xml.rels"] = (
        XML_DECL
        + f'<Relationships xmlns="{REL}">'
        + "".join(rel_tags)
        + f'<Relationship Id="rId{len(sheets) + 1}" Type="{OFFICE_REL}/styles" Target="styles.xml"/>'
        "</Relationships>"
    )
    parts["xl/styles.xml"] = _xstyles()
    _pkg(parts, out)


# --------------------------------------------------------------------------- pptx

THEME = (
    XML_DECL
    + f'<a:theme xmlns:a="{A}" name="Office"><a:themeElements>'
    '<a:clrScheme name="Office">'
    '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>'
    '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>'
    '<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>'
    '<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>'
    '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>'
    '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>'
    '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>'
    "</a:clrScheme>"
    '<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>'
    '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>'
    '<a:fmtScheme name="Office">'
    '<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>'
    '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'
    '<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'
    '<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>'
    '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle>'
    '<a:effectStyle><a:effectLst/></a:effectStyle>'
    '<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>'
    '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>'
    "</a:fmtScheme></a:themeElements></a:theme>"
)


def _slide_xml(title: str, bullets: list[str]) -> str:
    def run(text: str, size: int, bold: bool) -> str:
        return (
            "<a:r><a:rPr lang=\"zh-CN\" sz=\"%d\"%s dirty=\"0\"/><a:t>%s</a:t></a:r>"
            % (size, ' b="1"' if bold else "", escape(text))
        )

    paras_title = (
        "<a:p><a:pPr algn=\"l\"/>" + run(title, 3200, True) + "</a:p>"
    )
    body_paras = "".join(
        '<a:p><a:pPr marL="0" indent="0"/>' + run("•  " + item, 1800, False) + "</a:p>"
        for item in bullets
    )
    return (
        XML_DECL
        + f'<p:sld xmlns:a="{A}" xmlns:r="{R}" xmlns:p="{P}">'
        "<p:cSld><p:spTree>"
        '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
        '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
        '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
        # 标题
        '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>'
        '<p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/>'
        f"<p:txBody><a:bodyPr/><a:lstStyle/>{paras_title}</p:txBody></p:sp>"
        # 正文
        '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>'
        '<p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/>'
        f'<p:txBody><a:bodyPr/><a:lstStyle/>{body_paras or "<a:p/>"}</p:txBody></p:sp>'
        "</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"
    )


def _slide_master() -> str:
    return (
        XML_DECL
        + f'<p:sldMaster xmlns:a="{A}" xmlns:r="{R}" xmlns:p="{P}">'
        "<p:cSld><p:spTree>"
        '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
        '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
        '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
        '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>'
        '<p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr>'
        '<a:xfrm><a:off x="838200" y="457200"/><a:ext cx="9144000" cy="1143000"/></a:xfrm></p:spPr>'
        '<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>'
        '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>'
        '<p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr>'
        '<a:xfrm><a:off x="838200" y="1825625"/><a:ext cx="9144000" cy="4351338"/></a:xfrm></p:spPr>'
        '<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>'
        "</p:spTree></p:cSld>"
        "<p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" "
        "accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/>"
        "<p:sldLayoutIdLst><p:sldLayoutId id=\"2147483649\" r:id=\"rId1\"/></p:sldLayoutIdLst>"
        "<p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>"
    )


def _slide_layout() -> str:
    return (
        XML_DECL
        + f'<p:sldLayout xmlns:a="{A}" xmlns:r="{R}" xmlns:p="{P}" type="obj" preserve="1">'
        "<p:cSld name=\"Title and Content\"><p:spTree>"
        '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>'
        '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>'
        '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>'
        '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>'
        '<p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody>'
        '<a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>'
        '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>'
        '<p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody>'
        '<a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>'
        "</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"
    )


def build_pptx(spec: dict, out: str) -> None:
    slides = list(spec.get("slides") or [])
    if spec.get("title"):
        slides = [{"title": str(spec["title"]), "bullets": list(spec.get("subtitle") or [])}] + slides
    slides = slides or [{"title": "Slide", "bullets": []}]

    overrides = [
        '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>',
        '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>',
        '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>',
        '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
    ]
    slide_ids = []
    slide_rels = []
    for i, slide in enumerate(slides, start=1):
        overrides.append(
            f'<Override PartName="/ppt/slides/slide{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
        )
        slide_ids.append(f'<p:sldId id="{255 + i}" r:id="rId{i}"/>')
        slide_rels.append(
            f'<Relationship Id="rId{i}" Type="{OFFICE_REL}/slide" Target="slides/slide{i}.xml"/>'
        )

    parts: dict[str, str] = {}
    for i, slide in enumerate(slides, start=1):
        parts[f"ppt/slides/slide{i}.xml"] = _slide_xml(
            str(slide.get("title") or ""), [str(b) for b in (slide.get("bullets") or [])]
        )
        parts[f"ppt/slides/_rels/slide{i}.xml.rels"] = (
            XML_DECL
            + f'<Relationships xmlns="{REL}">'
            f'<Relationship Id="rId1" Type="{OFFICE_REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
            "</Relationships>"
        )
    parts["[Content_Types].xml"] = (
        XML_DECL
        + f'<Types xmlns="{CT}">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        + "".join(overrides)
        + "</Types>"
    )
    parts["_rels/.rels"] = (
        XML_DECL
        + f'<Relationships xmlns="{REL}">'
        f'<Relationship Id="rId1" Type="{OFFICE_REL}/officeDocument" Target="ppt/presentation.xml"/>'
        "</Relationships>"
    )
    parts["ppt/presentation.xml"] = (
        XML_DECL
        + f'<p:presentation xmlns:a="{A}" xmlns:r="{R}" xmlns:p="{P}" saveSubsetFonts="1">'
        '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>'
        f'<p:sldIdLst>{"".join(slide_ids)}</p:sldIdLst>'
        '<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>'
        "</p:presentation>"
    )
    tail = len(slides)
    parts["ppt/_rels/presentation.xml.rels"] = (
        XML_DECL
        + f'<Relationships xmlns="{REL}">'
        + "".join(slide_rels)
        + f'<Relationship Id="rId{tail + 1}" Type="{OFFICE_REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>'
        + f'<Relationship Id="rId{tail + 2}" Type="{OFFICE_REL}/theme" Target="theme/theme1.xml"/>'
        "</Relationships>"
    )
    parts["ppt/slideMasters/slideMaster1.xml"] = _slide_master()
    parts["ppt/slideMasters/_rels/slideMaster1.xml.rels"] = (
        XML_DECL
        + f'<Relationships xmlns="{REL}">'
        f'<Relationship Id="rId1" Type="{OFFICE_REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>'
        f'<Relationship Id="rId2" Type="{OFFICE_REL}/theme" Target="../theme/theme1.xml"/>'
        "</Relationships>"
    )
    parts["ppt/slideLayouts/slideLayout1.xml"] = _slide_layout()
    parts["ppt/slideLayouts/_rels/slideLayout1.xml.rels"] = (
        XML_DECL
        + f'<Relationships xmlns="{REL}">'
        f'<Relationship Id="rId1" Type="{OFFICE_REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>'
        "</Relationships>"
    )
    parts["ppt/theme/theme1.xml"] = THEME
    _pkg(parts, out)


# --------------------------------------------------------------------------- cli


def _spec_from_args(args: argparse.Namespace) -> dict:
    if args.csv:
        text = open(args.csv, encoding="utf-8-sig", newline="").read()
        rows = [row for row in csv.reader(io.StringIO(text))]
        return {"sheets": [{"name": args.sheet, "header": True, "rows": rows}]}
    if args.spec in (None, "-"):
        text = sys.stdin.read()
    elif args.spec.strip().startswith("{"):
        text = args.spec
    else:
        text = open(args.spec, encoding="utf-8").read()
    if not text.strip():
        raise SystemExit("empty spec")
    return json.loads(text)


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Generate docx / xlsx / pptx with zero dependencies.")
    ap.add_argument("format", choices=["docx", "xlsx", "pptx", "csv2xlsx"])
    ap.add_argument("--out", required=True)
    ap.add_argument("--spec", help="spec JSON 文件路径、JSON 字符串，或 '-' 从 stdin 读")
    ap.add_argument("--json", dest="spec", help=argparse.SUPPRESS)
    ap.add_argument("--csv", help="csv2xlsx：源 CSV 文件")
    ap.add_argument("--sheet", default="Sheet1", help="csv2xlsx：工作表名")
    args = ap.parse_args(argv)

    if args.format == "csv2xlsx":
        args.format = "xlsx"
    spec = _spec_from_args(args)
    out = args.out
    if args.format == "docx":
        build_docx(spec, out)
    elif args.format == "xlsx":
        build_xlsx(spec, out)
    else:
        build_pptx(spec, out)
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
