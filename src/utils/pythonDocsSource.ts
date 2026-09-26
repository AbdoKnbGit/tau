/**
 * The Python side of tau's local document reader (see pythonDocs.ts).
 *
 * Run as `python tau_docs.py <mode> <file> [args]` with whichever interpreter
 * has the library the mode needs; prints one JSON object on stdout. The modes:
 *
 *   pdf-render <file> <first> <last> <outdir> <dpi>   PyMuPDF
 *   pdf-text   <file> <first> <last>                  PyMuPDF, pypdf, PyPDF2 or pdfplumber
 *   docx       <file>                                 python-docx
 *   xlsx       <file> <max_rows>                      openpyxl
 *   xls        <file> <max_rows>                      xlrd
 *   pptx       <file>                                 python-pptx
 *
 * `last` of 0 means the last page. Output JSON is ASCII (json.dumps default),
 * so it survives any Windows console code page. Python 3.8 syntax at most:
 * this runs on whatever interpreter the user has.
 */
export const PYTHON_DOCS_SOURCE = String.raw`"""Tau's local document reader. Run by tau, never imported."""
import datetime
import json
import os
import sys

MAX_CHARS = 5000000


def emit(result):
    sys.stdout.write(json.dumps(result))
    sys.stdout.flush()


def load_fitz():
    try:
        import pymupdf as fitz
    except ImportError:
        import fitz
    return fitz


def page_range(first, last, total):
    first = max(1, first)
    last = total if last <= 0 else min(last, total)
    return first, last


def pdf_render(path, first, last, outdir, dpi):
    fitz = load_fitz()
    doc = fitz.open(path)
    try:
        if doc.needs_pass:
            return {"error": "password"}
        total = doc.page_count
        first, last = page_range(first, last, total)
        count = 0
        for number in range(first, last + 1):
            pix = doc[number - 1].get_pixmap(dpi=dpi)
            target = os.path.join(outdir, "page-%04d" % number)
            try:
                pix.save(target + ".jpg")
            except Exception:
                # JPEG output needs PyMuPDF 1.22 or later; PNG always works.
                if os.path.exists(target + ".jpg"):
                    os.remove(target + ".jpg")
                pix.save(target + ".png")
            count += 1
        return {"count": count, "total": total, "library": "PyMuPDF"}
    finally:
        doc.close()


def pdf_text(path, first, last):
    try:
        fitz = load_fitz()
    except ImportError:
        fitz = None
    if fitz is not None:
        doc = fitz.open(path)
        try:
            if doc.needs_pass:
                return {"error": "password"}
            total = doc.page_count
            first, last = page_range(first, last, total)
            pages = [[n, doc[n - 1].get_text("text")] for n in range(first, last + 1)]
            return {"pages": pages, "total": total, "library": "PyMuPDF"}
        finally:
            doc.close()
    pdflib = None
    name = ""
    for candidate in ("pypdf", "PyPDF2"):
        try:
            pdflib = __import__(candidate)
            name = candidate
            break
        except ImportError:
            pass
    if pdflib is not None:
        reader = pdflib.PdfReader(path)
        if reader.is_encrypted:
            try:
                if not reader.decrypt(""):
                    return {"error": "password"}
            except Exception:
                return {"error": "password"}
        total = len(reader.pages)
        first, last = page_range(first, last, total)
        pages = [[n, reader.pages[n - 1].extract_text() or ""] for n in range(first, last + 1)]
        return {"pages": pages, "total": total, "library": name}
    import pdfplumber
    with pdfplumber.open(path) as pdf:
        total = len(pdf.pages)
        first, last = page_range(first, last, total)
        pages = [[n, pdf.pages[n - 1].extract_text() or ""] for n in range(first, last + 1)]
        return {"pages": pages, "total": total, "library": "pdfplumber"}


def cell_text(value):
    return " ".join(str(value).split()).replace("|", "\\|")


def markdown_table(rows):
    rows = [[cell_text(c) for c in row] for row in rows]
    rows = [row for row in rows if any(row)]
    if not rows:
        return []
    width = max(len(row) for row in rows)
    rows = [row + [""] * (width - len(row)) for row in rows]
    out = ["| " + " | ".join(rows[0]) + " |", "|" + " --- |" * width]
    out.extend("| " + " | ".join(row) + " |" for row in rows[1:])
    out.append("")
    return out


def tidy(lines):
    out = []
    for line in lines:
        line = line.rstrip()
        if not line and (not out or not out[-1]):
            continue
        out.append(line)
    while out and not out[-1]:
        out.pop()
    text = "\n".join(out)
    if len(text) > MAX_CHARS:
        text = text[:MAX_CHARS] + "\n\n[... cut at %d characters]" % MAX_CHARS
    return text


def docx_markdown(path):
    import docx
    from docx.table import Table
    from docx.text.paragraph import Paragraph

    document = docx.Document(path)
    lines = []
    for child in document.element.body.iterchildren():
        tag = child.tag.rsplit("}", 1)[-1]
        if tag == "p":
            paragraph = Paragraph(child, document)
            text = paragraph.text.strip()
            if not text:
                lines.append("")
                continue
            style = ""
            try:
                style = paragraph.style.name or ""
            except Exception:
                pass
            if style == "Title":
                lines.append("# " + text)
            elif style.startswith("Heading"):
                level = style[len("Heading"):].strip()
                level = int(level) if level.isdigit() else 1
                lines.append("#" * min(max(level, 1), 6) + " " + text)
            elif "List" in style:
                lines.append("- " + text)
            else:
                lines.append(text)
            lines.append("")
        elif tag == "tbl":
            table = Table(child, document)
            lines.extend(markdown_table([[cell.text for cell in row.cells] for row in table.rows]))
    return tidy(lines)


def cell_value(value):
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    return str(value)


def sheet_markdown(title, rows, more):
    while rows and not any(c.strip() for c in rows[-1]):
        rows.pop()
    width = 0
    for row in rows:
        for index, value in enumerate(row):
            if value.strip():
                width = max(width, index + 1)
    rows = [row[:width] for row in rows]
    lines = ["## Sheet: " + title, ""]
    table = markdown_table(rows)
    lines.extend(table if table else ["(empty)", ""])
    if more > 0:
        lines.extend(["(%d more rows not shown)" % more, ""])
    return lines


def xlsx_markdown(path, max_rows):
    import openpyxl

    book = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        lines = []
        for sheet in book.worksheets:
            rows = []
            for row in sheet.iter_rows(values_only=True):
                if len(rows) >= max_rows:
                    break
                rows.append([cell_value(v) for v in row])
            more = max(0, (sheet.max_row or 0) - len(rows)) if len(rows) >= max_rows else 0
            lines.extend(sheet_markdown(sheet.title, rows, more))
        return tidy(lines)
    finally:
        book.close()


def xls_markdown(path, max_rows):
    import xlrd

    book = xlrd.open_workbook(path, on_demand=True)
    lines = []
    for index in range(book.nsheets):
        sheet = book.sheet_by_index(index)
        rows = []
        for r in range(min(sheet.nrows, max_rows)):
            values = []
            for c in range(sheet.ncols):
                cell = sheet.cell(r, c)
                if cell.ctype == xlrd.XL_CELL_DATE:
                    try:
                        values.append(xlrd.xldate_as_datetime(cell.value, book.datemode).isoformat())
                    except Exception:
                        values.append(str(cell.value))
                elif cell.ctype == xlrd.XL_CELL_EMPTY:
                    values.append("")
                elif cell.ctype == xlrd.XL_CELL_BOOLEAN:
                    values.append("TRUE" if cell.value else "FALSE")
                else:
                    values.append(cell_value(cell.value))
            rows.append(values)
        lines.extend(sheet_markdown(sheet.name, rows, max(0, sheet.nrows - max_rows)))
        book.unload_sheet(index)
    return tidy(lines)


def walk_shapes(shapes):
    for shape in shapes:
        yield shape
        inner = getattr(shape, "shapes", None)
        if inner is not None:
            for nested in walk_shapes(inner):
                yield nested


def pptx_markdown(path):
    from pptx import Presentation

    deck = Presentation(path)
    lines = []
    for number, slide in enumerate(deck.slides, 1):
        lines.extend(["## Slide %d" % number, ""])
        for shape in walk_shapes(slide.shapes):
            if getattr(shape, "has_text_frame", False) and shape.has_text_frame:
                for paragraph in shape.text_frame.paragraphs:
                    text = "".join(run.text for run in paragraph.runs).strip()
                    if text:
                        lines.append(("  " * paragraph.level + "- " + text) if paragraph.level else text)
                lines.append("")
            if getattr(shape, "has_table", False) and shape.has_table:
                lines.extend(markdown_table([[cell.text for cell in row.cells] for row in shape.table.rows]))
        if slide.has_notes_slide:
            frame = slide.notes_slide.notes_text_frame
            notes = frame.text.strip() if frame is not None else ""
            if notes:
                lines.extend(["Notes: " + notes, ""])
    return tidy(lines)


def main(argv):
    mode, path = argv[1], argv[2]
    try:
        if mode == "pdf-render":
            result = pdf_render(path, int(argv[3]), int(argv[4]), argv[5], int(argv[6]))
        elif mode == "pdf-text":
            result = pdf_text(path, int(argv[3]), int(argv[4]))
        elif mode == "docx":
            result = {"markdown": docx_markdown(path), "library": "python-docx"}
        elif mode == "xlsx":
            result = {"markdown": xlsx_markdown(path, int(argv[3])), "library": "openpyxl"}
        elif mode == "xls":
            result = {"markdown": xls_markdown(path, int(argv[3])), "library": "xlrd"}
        elif mode == "pptx":
            result = {"markdown": pptx_markdown(path), "library": "python-pptx"}
        else:
            result = {"error": "failed", "message": "unknown mode: " + mode}
    except ImportError as exc:
        result = {"error": "missing", "module": getattr(exc, "name", None) or str(exc)}
    except Exception as exc:
        text = str(exc)
        lowered = text.lower()
        kind = "password" if ("password" in lowered or "encrypted" in lowered) else "failed"
        result = {"error": kind, "type": type(exc).__name__, "message": text[:500]}
    emit(result)


if __name__ == "__main__":
    main(sys.argv)
`
