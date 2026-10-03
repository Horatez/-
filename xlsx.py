"""Минимальные чтение и запись .xlsx средствами стандартной библиотеки."""
import io
import re
import zipfile
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"


def _col(n):
    s = ""
    n += 1
    while n:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def _cell(ref, value, bold):
    if value is None or value == "":
        return ""
    if isinstance(value, bool):
        value = "да" if value else "нет"
    if isinstance(value, (int, float)):
        return f'<c r="{ref}" s="{3 if bold else 2}"><v>{value!r}</v></c>'
    text = escape(str(value))
    return (f'<c r="{ref}" t="inlineStr" s="{1 if bold else 0}">'
            f'<is><t xml:space="preserve">{text}</t></is></c>')


def _sheet(rows, header_rows, widths):
    cols = "".join(f'<col min="{i + 1}" max="{i + 1}" width="{w}" customWidth="1"/>'
                   for i, w in enumerate(widths))
    body = []
    for r, row in enumerate(rows):
        cells = "".join(_cell(f"{_col(c)}{r + 1}", v, r < header_rows)
                        for c, v in enumerate(row))
        body.append(f'<row r="{r + 1}">{cells}</row>')
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            f'<cols>{cols}</cols><sheetData>{"".join(body)}</sheetData></worksheet>')


STYLES = ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
          '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
          '<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>'
          '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
          '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
          '<fills count="2"><fill><patternFill patternType="none"/></fill>'
          '<fill><patternFill patternType="gray125"/></fill></fills>'
          '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
          '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
          '<cellXfs count="4">'
          '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
          '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
          '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
          '<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>'
          '</cellXfs></styleSheet>')


def write(sheets):
    """sheets: список (название, строки, число строк заголовка). Возвращает bytes."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        types = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                 '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                 '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                 '<Default Extension="xml" ContentType="application/xml"/>'
                 '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
                 '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>']
        wb, rels = [], []
        for i, (name, rows, header_rows) in enumerate(sheets, 1):
            name = re.sub(r"[\[\]:*?/\\]", " ", name)[:31]
            ncols = max((len(r) for r in rows), default=1)
            widths = []
            for c in range(ncols):
                longest = max((len(str(r[c])) for r in rows
                               if c < len(r) and r[c] is not None), default=8)
                widths.append(min(max(longest + 2, 10), 70))
            z.writestr(f"xl/worksheets/sheet{i}.xml", _sheet(rows, header_rows, widths))
            types.append(f'<Override PartName="/xl/worksheets/sheet{i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>')
            wb.append(f'<sheet name="{escape(name, {chr(34): "&quot;"})}" sheetId="{i}" r:id="rId{i}"/>')
            rels.append(f'<Relationship Id="rId{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet{i}.xml"/>')
        n = len(sheets) + 1
        rels.append(f'<Relationship Id="rId{n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>')
        z.writestr("[Content_Types].xml", "".join(types) + "</Types>")
        z.writestr("_rels/.rels",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
                   '</Relationships>')
        z.writestr("xl/workbook.xml",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                   'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
                   f'<sheets>{"".join(wb)}</sheets></workbook>')
        z.writestr("xl/_rels/workbook.xml.rels",
                   '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                   '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   f'{"".join(rels)}</Relationships>')
        z.writestr("xl/styles.xml", STYLES)
    return buf.getvalue()


def _col_index(ref):
    n = 0
    for ch in ref:
        if ch.isalpha():
            n = n * 26 + ord(ch.upper()) - 64
    return n - 1


def read(content, max_rows=5000):
    """Читает все листы книги. Возвращает общий список строк (списков значений)."""
    with zipfile.ZipFile(io.BytesIO(content)) as z:
        names = z.namelist()
        shared = []
        if "xl/sharedStrings.xml" in names:
            root = ET.fromstring(z.read("xl/sharedStrings.xml"))
            for si in root.iter(f"{NS}si"):
                shared.append("".join(t.text or "" for t in si.iter(f"{NS}t")))
        sheet_names = sorted(
            (n for n in names if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n)),
            key=lambda n: int(re.search(r"\d+", n).group()))
        rows = []
        for sn in sheet_names:
            root = ET.fromstring(z.read(sn))
            for row in root.iter(f"{NS}row"):
                cells = {}
                for c in row.iter(f"{NS}c"):
                    t = c.get("t")
                    v = c.find(f"{NS}v")
                    if t == "inlineStr":
                        val = "".join(x.text or "" for x in c.iter(f"{NS}t"))
                    elif v is None or v.text is None:
                        continue
                    elif t == "s":
                        val = shared[int(v.text)]
                    elif t in ("str", "b", "e"):
                        val = v.text
                    else:
                        try:
                            val = float(v.text)
                        except ValueError:
                            val = v.text
                    cells[_col_index(c.get("r", "A1"))] = val
                if cells:
                    width = max(cells) + 1
                    rows.append([cells.get(i) for i in range(width)])
                if len(rows) >= max_rows:
                    return rows
        return rows
