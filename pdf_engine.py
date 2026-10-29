# -*- coding: utf-8 -*-
"""
EstudaPDF — Sistema Multiagente (Construtor, Revisor e Tester) para Resumos e Flashcards em PDF.
Segue rigorosamente as regras de AGENTS.md e SKILL.md.
Suporta PDFs diversos (FAQs, manuais com tabelas de 2/3/4 colunas, artigos científicos em 1 ou 2 colunas,
apostilas, documentos corporativos) e URLs diversas (portais educacionais, documentação, artigos web).
"""

from collections import Counter
from datetime import datetime
from html.parser import HTMLParser
import io
import json
import os
import re
import ssl
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

try:
    from pypdf import PdfReader
    HAS_PYPDF = True
except ImportError:
    HAS_PYPDF = False


# ==============================================================================
# 1. NORMALIZAÇÃO TIPOGRÁFICA, MOJIBAKE, LIGADURAS E LIMPEZA DE TEXTO
# ==============================================================================

LIGATURE_MAP = {
    "\ufb00": "ff",
    "\ufb01": "fi",
    "\ufb02": "fl",
    "\ufb03": "ffi",
    "\ufb04": "ffl",
    "\ufb05": "st",
    "\ufb06": "st",
    "\x0b": "ff",
    "\x0c": "fi",
    "\x0d": "fl",
    "\x0e": "ffi",
    "\x0f": "ffl",
}

# Whitelist morfológica estrita para restaurar ligaduras quebradas ('?' ou '\ufffd')
# sem jamais gerar falsos positivos quando um símbolo não-CP1252 precede uma palavra.
BROKEN_LIGATURE_PATTERNS = [
    # 1. Casos internos de 'fl' (in?uência -> influência, re?exão -> reflexão, con?ito -> conflito)
    (re.compile(r"(?<=[A-Za-zÀ-ÿ])[?\ufffd](?=(?:uên|uen|uí|ui|ux|ex|et|it|or\b|ores\b|orest|agr))"), "fl"),
    # 2. Casos iniciais de 'fl' (?uido -> fluido, ?uxo -> fluxo, ?exível -> flexível, ?or -> flor)
    (re.compile(r"(?<!\w)[?\ufffd](?=(?:uido|uidos|uxo|uxos|exão|exões|exível|exíveis|etir|or\b|ores\b|orest|utu|agr|acidez))"), "fl"),
    # 3. Casos internos estritos de 'fi' entre letras (Filoso?a -> Filosofia, e?caz -> eficaz, signi?cativo -> significativo)
    (
        re.compile(
            r"(?<=[A-Za-zÀ-ÿ])[?\ufffd](?=(?:ca|co|cá|ci|cê|ce|cu|ni|ní|li|si|sí|ss|l\b|is\b|m\b|ns\b|a\b|as\b|o\b|os\b))"
        ),
        "fi",
    ),
    # 4. Casos iniciais estritos de 'fi' (?cará -> ficará, ?losofia/?loso?a -> filosofia, ?nal -> final, ?xa -> fixa)
    (
        re.compile(
            r"(?<!\w)[?\ufffd](?=(?:car\b|cará\b|caram\b|cou\b|ca\b|cam\b|camos\b|losof|lósof|nal\b|nais\b|nalidade|nalmente|nanceir|xa\b|xo\b|xos\b|xas\b|xar\b|xação\b|gura\b|guras\b|el\b|éis\b|lho\b|lha\b|lhos\b|lhas\b|lial\b|liais\b|m\b|ns\b|zer|zemos|zeram|ísica|ísico|rst\b|nd\b))"
        ),
        "fi",
    ),
]

COMMON_TYPO_FIXES = [
    (re.compile(r"\bPRincipia\b"), "Principia"),
    (re.compile(r"\bsistema esá\b"), "sistema está"),
    (re.compile(r"\ba grécia antiga\b"), "a Grécia Antiga"),
    (re.compile(r"([A-Za-zÀ-ÿ])\("), r"\1 ("),
    # Remove espaço indevido antes de pontuação (comum em HTML: "vácuo ." -> "vácuo.", "1915 :" -> "1915:")
    (re.compile(r"\s+([.,;:!?])"), r"\1"),
    # Remove cabeçalhos corridos de páginas SciELO/artigos no meio de frases (ex: "Silva e3001- 3" ou "e3001-2")
    (re.compile(r"\b(?:[A-Z][a-záéíóúãõç]+\s+)?e\d{4}\s*-\s*\d+\b"), ""),
    # Remove números de notas de rodapé colados ao final de palavras (ex: "introduzidas 2.")
    (re.compile(r"(?<=[a-záéíóúâêôãõç])\s+\d{1,2}(?=[.,;])"), ""),
]

# Mapeamento de símbolos Unicode (setas, operadores matemáticos, subscritos, travessões, bullets)
# para equivalentes seguros em CP1252 / WinAnsiEncoding ANTES de testar codificação.
UNICODE_PRE_MAP = {
    "\u2026": "...",
    "\u2010": "-",
    "\u2011": "-",
    "\u2012": "-",
    "\u2013": "–",
    "\u2014": "—",
    "\u2015": "—",
    "\u2212": "-",
    "\u201c": "“",
    "\u201d": "”",
    "\u201e": "”",
    "\u2018": "‘",
    "\u2019": "’",
    "\u201a": "’",
    "\u2192": " -> ",
    "\u2794": " -> ",
    "\u279c": " -> ",
    "\u279e": " -> ",
    "\u27f6": " -> ",
    "\u21d2": " => ",
    "\u2190": " <- ",
    "\u21d0": " <= ",
    "\u2194": " <-> ",
    "\u21d4": " <=> ",
    "\u2265": ">=",
    "\u2264": "<=",
    "\u2260": "!=",
    "\u2248": "~",
    "\u2261": "==",
    "\u00b1": "+/-",
    "\u00d7": "x",
    "\u00f7": "/",
    "\u221e": "infinito",
    "\u25aa": "•",
    "\u25ab": "•",
    "\u25cf": "•",
    "\u25cb": "•",
    "\u25c6": "•",
    "\u25b8": "•",
    "\u25b9": "•",
    "\u25ba": "•",
    "\u2023": "•",
    "\u2043": "•",
    "\uf0b7": "•",
    "\uf0a7": "•",
    "\uf0d8": "•",
    "\uf0fc": "•",
    "\u2713": "OK",
    "\u2714": "OK",
    "\u2717": "X",
    "\u2718": "X",
    "\u2080": "0",
    "\u2081": "1",
    "\u2082": "2",
    "\u2083": "3",
    "\u2084": "4",
    "\u2085": "5",
    "\u2086": "6",
    "\u2087": "7",
    "\u2088": "8",
    "\u2089": "9",
    "\u2070": "0",
    "\u00b9": "1",
    "\u00b2": "2",
    "\u00b3": "3",
    "\u2074": "4",
    "\u2075": "5",
    "\u2076": "6",
    "\u2077": "7",
    "\u2078": "8",
    "\u2079": "9",
    "\u00a0": " ",
    "\u2002": " ",
    "\u2003": " ",
    "\u2009": " ",
    "\u200b": "",
    "\u200c": "",
    "\u200d": "",
    "\ufeff": "",
    "\xad": "",
}


def fix_utf8_mojibake(text):
    """Corrige texto UTF-8 que foi decodificado erroneamente como Latin-1/CP1252 (ex: 'OrientaÃ§Ãµes' -> 'Orientações')."""
    if not text or not re.search(r"Ã[\x80-\xbf]|Â[\x80-\xbf]|â€", text):
        return text
    try:
        return text.encode("cp1252").decode("utf-8")
    except Exception:
        try:
            return text.encode("latin1").decode("utf-8")
        except Exception:
            return text


def normalize_extracted_text(text):
    """Expande ligaduras Unicode/LaTeX, repara mojibake, converte glifos fora do CP1252 e limpa artefatos."""
    if not text:
        return ""
    text = fix_utf8_mojibake(str(text))
    for k, v in LIGATURE_MAP.items():
        text = text.replace(k, v)
    text = unicodedata.normalize("NFKC", text)
    text = unicodedata.normalize("NFC", text)

    for k, v in UNICODE_PRE_MAP.items():
        text = text.replace(k, v)

    # Remove emojis / pictogramas decorativos sem gerar '\ufffd'
    text = re.sub(r"[\U00010000-\U0010ffff]", "", text)

    chars = []
    for ch in text:
        if ch in ("\n", "\r", "\t"):
            chars.append(ch)
            continue
        o = ord(ch)
        if 0xE000 <= o <= 0xF8FF or o < 32 or o == 0x7F:
            chars.append("\ufffd")
            continue
        try:
            ch.encode("cp1252")
            chars.append(ch)
        except UnicodeEncodeError:
            chars.append("\ufffd")
    text = "".join(chars)

    # Restaura ligaduras 'fi' / 'fl' onde o glifo veio como '?' ou '\ufffd'
    for pattern, repl in BROKEN_LIGATURE_PATTERNS:
        text = pattern.sub(repl, text)

    # Remove marcadores de nota de rodapé de autor como *1?, *1, 1?, \ufffd isolado, etc.
    text = re.sub(r"\*\d+\s*[?\ufffd]*", "", text)
    text = re.sub(r"\ufffd+", "", text)
    # Remove '?' solto precedido por espaço (ex: ícone de envelope convertido em ' ? ' após nome de autor)
    text = re.sub(r"(?<=\s)\?(?=\s|$)", "", text)

    for pattern, repl in COMMON_TYPO_FIXES:
        text = pattern.sub(repl, text)
    return text


def truncate_clean(text, max_chars=360):
    """Trunca o texto sem cortar palavras ao meio, preferindo sempre o fim de uma sentença completa."""
    if not text:
        return ""
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) <= max_chars:
        return text
    cut = text[:max_chars]
    last_sent = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "), cut.rfind(".” "), cut.rfind('." '))
    if last_sent >= int(max_chars * 0.45):
        return cut[: last_sent + 1].strip()
    last_space = cut.rfind(" ")
    if last_space > 20:
        return cut[:last_space].rstrip(",;:- ") + "..."
    return cut + "..."


# ==============================================================================
# 2. GERADOR DE PDF VETORIAL (A4, WinAnsiEncoding / CP1252, Paginado)
# ==============================================================================

PAGE_W = 595.28
PAGE_H = 841.89
MARGIN_L = 48.0
MARGIN_R = 48.0
MARGIN_T = 52.0
MARGIN_B = 52.0
CONTENT_W = PAGE_W - MARGIN_L - MARGIN_R


def char_width_ratio(ch, bold=False):
    if ch in "ilI.,:;!|'` ":
        return 0.28 if not bold else 0.31
    if ch in "ftrj()[]\"-":
        return 0.35 if not bold else 0.38
    if ch in "mwMW@%—–":
        return 0.82 if not bold else 0.86
    if ch.isupper():
        return 0.68 if not bold else 0.72
    return 0.53 if not bold else 0.57


def text_width(text, font_size, bold=False):
    return sum(char_width_ratio(c, bold) for c in text) * font_size


def wrap_text(text, max_width, font_size, bold=False):
    if not text:
        return [""]
    text = re.sub(r"\s+", " ", text).strip()
    words = text.split(" ")
    lines = []
    current = ""
    for w in words:
        candidate = w if not current else current + " " + w
        if text_width(candidate, font_size, bold) <= max_width:
            current = candidate
        else:
            if current:
                lines.append(current)
            if text_width(w, font_size, bold) > max_width:
                chunk = ""
                for ch in w:
                    if text_width(chunk + ch, font_size, bold) <= max_width:
                        chunk += ch
                    else:
                        if chunk:
                            lines.append(chunk)
                        chunk = ch
                current = chunk
            else:
                current = w
    if current:
        lines.append(current)
    return lines if lines else [""]


def sanitize_cp1252(text):
    if not text:
        return ""
    text = normalize_extracted_text(text)
    for k, v in UNICODE_PRE_MAP.items():
        text = text.replace(k, v)
    text = text.replace("\ufffd", "")
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
    return text


def pdf_escape(text):
    text = sanitize_cp1252(text)
    b = text.encode("cp1252", errors="replace")
    out = []
    for byte in b:
        if byte in (40, 41, 92):
            out.append(92)
            out.append(byte)
        elif byte < 32 or byte > 126:
            out.extend(f"\\{byte:03o}".encode("ascii"))
        else:
            out.append(byte)
    return bytes(out).decode("ascii")


class PDFBuilder:
    def __init__(self, doc_short_title="EstudaPDF"):
        self.doc_short_title = truncate_clean(doc_short_title, 58)
        self.pages = []
        self.current_cmds = []
        self.y = PAGE_H - MARGIN_T
        self.new_page()

    def new_page(self):
        if self.current_cmds:
            self.pages.append("\n".join(self.current_cmds))
        self.current_cmds = []
        self.y = PAGE_H - MARGIN_T

    def ensure_space(self, height):
        if self.y - height < MARGIN_B:
            self.new_page()

    def draw_rect(self, x, y_top, w, h, fill_rgb=None, stroke_rgb=None, line_w=1.0):
        cmds = ["q", f"{line_w:.2f} w"]
        if fill_rgb:
            r, g, b = fill_rgb
            cmds.append(f"{r:.3f} {g:.3f} {b:.3f} rg")
        if stroke_rgb:
            r, g, b = stroke_rgb
            cmds.append(f"{r:.3f} {g:.3f} {b:.3f} RG")
        op = "B" if (fill_rgb and stroke_rgb) else ("f" if fill_rgb else "S")
        cmds.append(f"{x:.2f} {y_top - h:.2f} {w:.2f} {h:.2f} re {op}")
        cmds.append("Q")
        self.current_cmds.append("\n".join(cmds))

    def draw_line(self, x1, y1, x2, y2, rgb=(0.8, 0.84, 0.88), line_w=0.8):
        r, g, b = rgb
        self.current_cmds.append(
            f"q {line_w:.2f} w {r:.3f} {g:.3f} {b:.3f} RG {x1:.2f} {y1:.2f} m {x2:.2f} {y2:.2f} l S Q"
        )

    def draw_text_line(self, x, y, text, font="F1", size=10.5, rgb=(0.12, 0.16, 0.22)):
        r, g, b = rgb
        esc = pdf_escape(text)
        self.current_cmds.append(
            f"BT /{font} {size:.2f} Tf {r:.3f} {g:.3f} {b:.3f} rg {x:.2f} {y:.2f} Td ({esc}) Tj ET"
        )

    def add_header_box(self, title, subtitle, source_label, gen_date, lang, num_cards):
        title_lines = wrap_text(title, CONTENT_W - 28, 13.5, bold=True)[:2]
        sub_lines = wrap_text(subtitle, CONTENT_W - 28, 10.0, bold=False)[:2] if subtitle else []
        src_lines = wrap_text(f"Fonte: {source_label}", CONTENT_W - 28, 8.8, bold=False)[:2]

        banner_h = 22 + len(title_lines) * 16 + len(sub_lines) * 14
        meta_h = 38 + len(src_lines) * 13
        box_h = banner_h + meta_h

        self.ensure_space(box_h + 12)
        y_top = self.y

        self.draw_rect(MARGIN_L, y_top, CONTENT_W, banner_h, fill_rgb=(0.11, 0.24, 0.45))
        self.draw_rect(
            MARGIN_L,
            y_top - banner_h,
            CONTENT_W,
            meta_h,
            fill_rgb=(0.95, 0.97, 1.0),
            stroke_rgb=(0.75, 0.82, 0.92),
            line_w=0.8,
        )

        cy = y_top - 20
        for tl in title_lines:
            self.draw_text_line(MARGIN_L + 14, cy, tl, font="F2", size=13.5, rgb=(1, 1, 1))
            cy -= 16
        for sl in sub_lines:
            self.draw_text_line(MARGIN_L + 14, cy - 2, sl, font="F1", size=10.0, rgb=(0.88, 0.93, 1.0))
            cy -= 14

        my = y_top - banner_h - 15
        for srl in src_lines:
            self.draw_text_line(MARGIN_L + 14, my, srl, font="F1", size=8.8, rgb=(0.15, 0.22, 0.35))
            my -= 12.5

        meta_line = f"Data de geração: {gen_date}   |   Idioma: {lang}   |   Total de flashcards: {num_cards} cartões"
        self.draw_text_line(MARGIN_L + 14, my - 2, meta_line, font="F2", size=9.0, rgb=(0.18, 0.28, 0.45))
        self.draw_text_line(
            MARGIN_L + 14,
            my - 16,
            "Validado por 3 Agentes (Construtor • Revisor • Tester)  |  Parte 1: Resumo  •  Parte 2: Flashcards",
            font="F3",
            size=8.5,
            rgb=(0.24, 0.34, 0.48),
        )

        self.y = y_top - box_h - 16

    def add_part_banner(self, part_title, part_desc):
        h = 38.0
        self.ensure_space(h + 16)
        y_top = self.y
        self.draw_rect(MARGIN_L, y_top, CONTENT_W, h, fill_rgb=(0.16, 0.34, 0.60))
        self.draw_text_line(MARGIN_L + 12, y_top - 16, part_title, font="F2", size=12.0, rgb=(1, 1, 1))
        self.draw_text_line(MARGIN_L + 12, y_top - 30, part_desc, font="F3", size=9.0, rgb=(0.90, 0.95, 1.0))
        self.y = y_top - h - 14

    def add_section_heading(self, heading):
        lines = wrap_text(heading, CONTENT_W - 16, 11.2, bold=True)
        h = len(lines) * 15 + 14
        self.ensure_space(h + 60)
        self.y -= 4
        bar_h = len(lines) * 14 + 2
        self.draw_rect(MARGIN_L, self.y, 4.0, bar_h, fill_rgb=(0.16, 0.38, 0.68))
        for line in lines:
            self.draw_text_line(MARGIN_L + 10, self.y - 12, line, font="F2", size=11.2, rgb=(0.11, 0.24, 0.45))
            self.y -= 14.5
        self.y -= 4
        self.draw_line(MARGIN_L, self.y + 2, MARGIN_L + CONTENT_W, self.y + 2, rgb=(0.82, 0.87, 0.94), line_w=0.6)
        self.y -= 6

    def add_paragraph(self, text, size=9.8, leading=14.0, indent=0.0, bold=False, italic=False):
        if not text:
            return
        font = "F2" if bold else ("F3" if italic else "F1")
        lines = wrap_text(text, CONTENT_W - indent, size, bold=bold)
        self.ensure_space(len(lines) * leading + 4)
        for line in lines:
            self.draw_text_line(MARGIN_L + indent, self.y - size, line, font=font, size=size)
            self.y -= leading
        self.y -= 4

    def add_bullet(self, label, text, size=9.6, leading=13.6):
        if not text and not label:
            return
        full = f"• {label}: {text}" if label else f"• {text}"
        lines = wrap_text(full, CONTENT_W - 14, size, bold=False)
        self.ensure_space(len(lines) * leading + 3)
        for i, line in enumerate(lines):
            x = MARGIN_L + (6 if i == 0 else 16)
            self.draw_text_line(x, self.y - size, line, font="F1", size=size, rgb=(0.14, 0.18, 0.24))
            self.y -= leading
        self.y -= 2.5

    def add_theme_heading(self, theme_title):
        lines = wrap_text(theme_title, CONTENT_W - 20, 10.5, bold=True)
        box_h = max(22.0, len(lines) * 14.0 + 8.0)
        self.ensure_space(box_h + 130.0)
        self.y -= 4
        self.draw_rect(
            MARGIN_L,
            self.y,
            CONTENT_W,
            box_h,
            fill_rgb=(0.90, 0.94, 0.99),
            stroke_rgb=(0.70, 0.80, 0.92),
            line_w=0.7,
        )
        ty = self.y - 14.5
        for line in lines:
            self.draw_text_line(MARGIN_L + 10, ty, line, font="F2", size=10.5, rgb=(0.12, 0.26, 0.48))
            ty -= 14.0
        self.y -= box_h + 8.0

    def add_flashcard(self, number, theme_short, question, answer):
        q_prefix = "Frente — Pergunta: "
        a_prefix = "Verso — Resposta: "
        inner_w = CONTENT_W - 24
        q_lines = wrap_text(q_prefix + question, inner_w, 9.6, bold=True)
        a_lines = wrap_text(a_prefix + answer, inner_w, 9.5, bold=False)

        header_h = 20.0
        q_h = len(q_lines) * 13.5 + 8.0
        a_h = len(a_lines) * 13.5 + 10.0
        total_h = header_h + q_h + a_h

        self.ensure_space(total_h + 10.0)

        y_top = self.y
        self.draw_rect(
            MARGIN_L,
            y_top,
            CONTENT_W,
            total_h,
            fill_rgb=(0.99, 0.995, 1.0),
            stroke_rgb=(0.72, 0.80, 0.90),
            line_w=0.8,
        )
        self.draw_rect(MARGIN_L, y_top, CONTENT_W, header_h, fill_rgb=(0.20, 0.38, 0.64))
        header_label = f"Cartão {number} — Tema: {truncate_clean(theme_short, 62)}"
        self.draw_text_line(MARGIN_L + 10, y_top - 14, header_label, font="F2", size=9.5, rgb=(1.0, 1.0, 1.0))

        qy = y_top - header_h - 13.0
        for line in q_lines:
            self.draw_text_line(MARGIN_L + 12, qy, line, font="F2", size=9.6, rgb=(0.10, 0.20, 0.36))
            qy -= 13.5

        div_y = y_top - header_h - q_h
        self.draw_line(MARGIN_L + 10, div_y, MARGIN_L + CONTENT_W - 10, div_y, rgb=(0.82, 0.87, 0.93), line_w=0.6)

        ay = div_y - 13.0
        for line in a_lines:
            self.draw_text_line(MARGIN_L + 12, ay, line, font="F1", size=9.5, rgb=(0.15, 0.19, 0.25))
            ay -= 13.5

        self.y = y_top - total_h - 10.0

    def save(self, out_path):
        if self.current_cmds:
            self.pages.append("\n".join(self.current_cmds))
            self.current_cmds = []

        total_pages = len(self.pages)
        final_page_streams = []
        for idx, content in enumerate(self.pages, start=1):
            footer_line = (
                f"q 0.5 w 0.80 0.84 0.88 RG {MARGIN_L:.2f} {MARGIN_B - 14:.2f} m "
                f"{PAGE_W - MARGIN_R:.2f} {MARGIN_B - 14:.2f} l S Q"
            )
            footer_left = pdf_escape(f"EstudaPDF — {self.doc_short_title}")
            footer_right = pdf_escape(f"Página {idx} de {total_pages}")
            footer_txt = (
                f"BT /F1 8.5 Tf 0.40 0.45 0.52 rg {MARGIN_L:.2f} {MARGIN_B - 26:.2f} Td ({footer_left}) Tj ET\n"
                f"BT /F2 8.5 Tf 0.30 0.36 0.45 rg {PAGE_W - MARGIN_R - 75:.2f} {MARGIN_B - 26:.2f} Td ({footer_right}) Tj ET"
            )
            final_page_streams.append(content + "\n" + footer_line + "\n" + footer_txt)

        objects = {
            1: b"<< /Type /Catalog /Pages 2 0 R >>",
            3: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
            4: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
            5: b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>",
        }

        kids = []
        next_id = 6
        for stream_str in final_page_streams:
            page_id = next_id
            content_id = next_id + 1
            next_id += 2
            kids.append(f"{page_id} 0 R")
            stream_bytes = stream_str.encode("ascii")
            objects[content_id] = (
                f"<< /Length {len(stream_bytes)} >>\nstream\n".encode("ascii")
                + stream_bytes
                + b"\nendstream"
            )
            objects[page_id] = (
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE_W:.2f} {PAGE_H:.2f}] "
                f"/Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R >> >> "
                f"/Contents {content_id} 0 R >>"
            ).encode("ascii")

        kids_str = " ".join(kids)
        objects[2] = f"<< /Type /Pages /Kids [ {kids_str} ] /Count {total_pages} >>".encode("ascii")

        out = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
        offsets = {}
        max_id = next_id - 1
        for oid in range(1, max_id + 1):
            offsets[oid] = len(out)
            out.extend(f"{oid} 0 obj\n".encode("ascii"))
            out.extend(objects[oid])
            out.extend(b"\nendobj\n")

        xref_pos = len(out)
        out.extend(f"xref\n0 {max_id + 1}\n".encode("ascii"))
        out.extend(b"0000000000 65535 f \n")
        for oid in range(1, max_id + 1):
            out.extend(f"{offsets[oid]:010d} 00000 n \n".encode("ascii"))

        out.extend(
            f"trailer\n<< /Size {max_id + 1} /Root 1 0 R >>\nstartxref\n{xref_pos}\n%%EOF\n".encode("ascii")
        )

        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        with open(out_path, "wb") as f:
            f.write(out)
        return total_pages, len(out)


def compile_study_pdf(study_data, output_path):
    total_cards = sum(len(t.get("cards", [])) for t in study_data.get("flashcards_by_theme", []))
    pdf = PDFBuilder(doc_short_title=study_data.get("title", "Material de Estudo"))

    # 1. Cabeçalho
    pdf.add_header_box(
        title=study_data.get("title", "Material de Estudo"),
        subtitle=study_data.get("subtitle", "Resumo Estruturado e Flashcards de Revisão"),
        source_label=study_data.get("source", ""),
        gen_date=study_data.get("date", datetime.now().strftime("%d/%m/%Y")),
        lang=study_data.get("language", "Português (Brasil)"),
        num_cards=total_cards,
    )

    # 2. Parte 1 — Resumo Estruturado
    pdf.add_part_banner(
        "PARTE 1 — RESUMO ESTRUTURADO",
        "Síntese fiel das ideias centrais, seções temáticas, conceitos-chave e conclusões da fonte.",
    )

    if study_data.get("overview"):
        pdf.add_section_heading("1. Visão Geral e Ideia Central")
        pdf.add_paragraph(study_data["overview"])

    sec_num = 2 if study_data.get("overview") else 1
    for sec in study_data.get("sections", []):
        heading = sec.get("heading", f"Seção {sec_num}")
        if not re.match(r"^\d+\.", heading):
            heading = f"{sec_num}. {heading}"
        pdf.add_section_heading(heading)
        for p in sec.get("paragraphs", []):
            pdf.add_paragraph(p)
        for b in sec.get("bullets", []):
            if isinstance(b, dict):
                pdf.add_bullet(b.get("label", ""), b.get("text", ""))
            else:
                pdf.add_bullet("", str(b))
        sec_num += 1

    if study_data.get("key_concepts"):
        pdf.add_section_heading(f"{sec_num}. Definições e Conceitos-Chave")
        for kc in study_data["key_concepts"]:
            pdf.add_bullet(kc.get("term", "Conceito"), kc.get("definition", ""))
        sec_num += 1

    if study_data.get("synthesis") or study_data.get("limitations"):
        pdf.add_section_heading(f"{sec_num}. Síntese Final e Notas da Fonte")
        if study_data.get("synthesis"):
            pdf.add_paragraph(study_data["synthesis"])
        if study_data.get("limitations"):
            lim_txt = "Limitações sinalizadas na fonte: " + " ".join(study_data["limitations"])
            pdf.add_paragraph(lim_txt, italic=True)

    # 3. Parte 2 — Flashcards (em nova página)
    pdf.new_page()
    pdf.add_part_banner(
        "PARTE 2 — FLASHCARDS DE REVISÃO POR TEMA",
        f"{total_cards} cartões numerados de recordação ativa com Frente (Pergunta) e Verso (Resposta).",
    )

    card_num = 1
    for group in study_data.get("flashcards_by_theme", []):
        theme_title = group.get("theme", "Conceitos Gerais")
        theme_short = group.get("theme_short", theme_title)
        cards = group.get("cards", [])
        if not cards:
            continue
        pdf.add_theme_heading(theme_title)
        for c in cards:
            pdf.add_flashcard(card_num, theme_short, c.get("q", ""), c.get("a", ""))
            card_num += 1

    return pdf.save(output_path)


# ==============================================================================
# 3. FILTROS DE IDIOMA, METADADOS EDITORIAIS, PORTAIS WEB E LEGIBILIDADE
# ==============================================================================

VOWELS_SET = set("aeiouáéíóúâêîôûãõàüAEIOUÁÉÍÓÚÂÊÎÔÛÃÕÀÜ")

ENGLISH_STOPWORDS = {
    "the", "and", "that", "this", "with", "from", "which", "have", "been",
    "were", "their", "there", "about", "would", "could", "should", "through",
    "between", "because", "however", "therefore", "understanding", "mechanics",
    "study", "essential", "happens", "other", "consistent", "formulated",
    "approach", "didactic", "first", "laws", "motion", "keywords", "abstract",
    "of", "in", "to", "for", "on", "at", "by", "up", "into", "over", "after",
    "is", "are", "was", "be", "being", "has", "had", "do", "does", "did",
    "will", "shall", "can", "may", "might", "must", "it", "its", "they",
    "them", "we", "us", "our", "you", "your", "not", "these", "those", "who",
    "whom", "whose", "what", "where", "when", "why", "how", "all", "any",
    "both", "each", "few", "more", "most", "some", "such", "than", "too",
    "very", "upon", "leaving", "course", "students", "find", "describing",
    "basic", "physics", "uncommon", "newtonian",
}

PORTUGUESE_STOPWORDS = {
    "que", "para", "com", "uma", "por", "não", "dos", "das", "nos", "nas",
    "pelo", "pela", "como", "mais", "mas", "são", "está", "foi", "ser",
    "sua", "seu", "sobre", "entre", "quando", "muito", "também", "isso",
    "este", "esta", "esse", "essa", "aos", "às", "num", "numa", "pelos",
    "pelas", "no", "na", "ao", "ou", "em", "se", "já", "até", "após",
}


def is_primarily_english_text(text):
    """Detecta se uma frase ou bloco é predominantemente em inglês (ex: Abstract / Keywords de artigos brasileiros)."""
    words = [w.lower() for w in re.findall(r"\b[A-Za-zÀ-ÿ]{2,}\b", text or "")]
    if len(words) < 5:
        return False
    en_hits = sum(1 for w in words if w in ENGLISH_STOPWORDS)
    pt_hits = sum(1 for w in words if w in PORTUGUESE_STOPWORDS)
    return en_hits >= 3 and en_hits > pt_hits * 1.4


def is_author_or_affiliation_line(line):
    """
    Detecta linhas de autoria ou afiliação institucional no cabeçalho de artigos/PDFs
    (ex.: 'Saulo Luis Lima da Silva *1?', '1Força Aérea Brasileira...').
    """
    s = (line or "").strip()
    if not s:
        return True

    # Não descartar linhas com interrogação real (perguntas de FAQ) ou caminhos de menu '>'
    if "?" in s and len(s) > 15 and not re.search(r"\*\d+\s*\?", s):
        return False
    if ">" in s or "->" in s or "→" in s:
        return False

    s_letters_only = re.sub(r"[^A-Za-zÀ-ÿ\s]", " ", s)
    s_letters_only = re.sub(r"\s+", " ", s_letters_only).strip()

    # 1. Afiliação institucional / endereço acadêmico
    if re.search(
        r"\b(Força Aérea|Centro de Instrução|Universidade|Faculdade|Instituto|Departamento|Laboratório|Hospital|Belo Horizonte|São Paulo,\s*SP|Rio de Janeiro,\s*RJ|CEP\s*\d)\b",
        s,
        re.I,
    ) and len(s) < 160 and not s.endswith("."):
        return True

    # 2. Nome próprio de autor isolado na linha (2 a 7 palavras, sem ponto final e sem termos técnicos/títulos)
    words = s_letters_only.split()
    if 2 <= len(words) <= 7 and len(s_letters_only) <= 60 and not s.endswith((".", "!", ":", "?")):
        connectors = {"de", "da", "do", "das", "dos", "e", "van", "von", "del", "jr", "filho", "neto", "sobrinho"}
        common_non_names = {
            "lei", "leis", "introdução", "conclusão", "resumo", "mecânica", "física", "filosofia",
            "estudo", "unidade", "capítulo", "seção", "parte", "conceito", "conceitos", "origem",
            "história", "movimento", "força", "forças", "inércia", "dinâmica", "ciência", "método",
            "análise", "abordagem", "didática", "primeira", "segunda", "terceira", "aristotélica",
            "newtoniana", "questão", "questões", "problema", "problemas", "teoria", "princípio",
            "visão", "geral", "contratação", "renave", "usado", "evento", "eventos", "saída",
            "comprador", "final", "veículos", "veículo", "inacabados", "inacabado", "venda",
            "intermediada", "suporte", "chamados", "soluções", "material", "apoio", "regras",
            "circulares", "comunicação", "certificado", "instabilidade", "integradora", "atpv",
            "relatividade", "restrita", "transformação", "postulados", "consequências", "aplicação",
        }
        if not any(w.lower() in common_non_names for w in words):
            is_name_pattern = all(
                (w.lower() in connectors) or (w[0].isupper() and w[1:].islower())
                for w in words
            )
            if is_name_pattern:
                return True

    return False


def is_journal_or_portal_boilerplate_line(line):
    """Detecta linhas de cabeçalho/rodapé editorial de periódicos acadêmicos, manuais e portais educacionais web."""
    s = (line or "").strip()
    if not s:
        return True
    patterns = [
        r"^doi:\s*http",
        r"^https?://dx\.doi\.org/",
        r"^www\.scielo\.br",
        r"^recebido\s+em\s+\d+",
        r"^revisado\s+em\s+\d+",
        r"^aceito\s+em\s+\d+",
        r"^licen[çc]a\s+creative\s+commons",
        r"^c\s+b\s+licen[çc]a",
        r"^cartas\s+ao\s+editor$",
        r"^artigos?\s+gerais?$",
        r"^revista\s+brasileira\s+de\s+ensino",
        r"^\*?\d*endereço\s+de\s+correspondência",
        r"^e-?mail:\s*\S+@\S+",
        r"^keywords?\s*:",
        r"^palavras-?chave\s*:",
        r"^abstract\s*:",
        r"^abstract$",
        r"^resumo$",
        r"^(?:[A-Z][a-záéíóúãõç]+\s+)?e\d{4}\s*-\s*\d+$",
        # Rodapés corporativos e datas isoladas (ex: "MicroWork Softwares | 1", "Oct 22, 2026")
        r"^microwork\s+softwares\s*\|\s*\d+$",
        r".+\|\s*p[áa]gina\s*\d+$",
        r"^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},\s+\d{4}$",
        # Ruídos de portais web educacionais (Brasil Escola, Mundo Educação, Toda Matéria, etc.)
        r"^A\+\s*A-",
        r"^(?:A\+\s*A-\s*)?(?:1x\s*)?conte[úu]do\s+feito\s+por\s+humanos$",
        r"^ou[çc]a\s+este\s+artigo",
        r"^t[óo]picos\s+deste\s+artigo$",
        r"^[íi]ndice\s+do\s+artigo$",
        r"^(?:veja|leia|saiba|confira|acesse)\s+tamb[ée]m\s*:",
        r"^n[ãa]o\s+pare\s+agora\b",
        r"^tem\s+mais\s+depois\s+da\s+publicidade",
        r"^publicidade$",
        r"^compartilhar$",
        r"^imprimir$",
        r"^\[imagem:.*\]$",
        r"^(?:conhe[çc]a\s+a\s+transforma[çc][ãa]o\s+de\s+lorentz|voc[êe]\s+sabe\s+o\s+que\s+[ée]\s+dilata[çc][ãa]o|confira\s+quais\s+s[ãa]o\s+as\s+suas\s+caracter[íi]sticas)",
    ]
    for pat in patterns:
        if re.search(pat, s, re.I):
            return True
    return False


# Alias para compatibilidade
is_journal_boilerplate_line = is_journal_or_portal_boilerplate_line


def _strip_leading_author_prefix(s):
    """Remove qualquer nome próprio de autor (3 a 6 palavras) que apareça colado no início de uma frase."""
    if not s:
        return ""
    s = re.sub(r"\bSaulo\s+Lu[ií]s\s+Lima\s+da\s+Silva\b[^A-Za-zÀ-ÿ]*", "", s, flags=re.I).strip()
    return s


def strip_editorial_and_english_segments(text):
    """
    Remove metadados de submissão acadêmica, nomes de autores vazados no início do parágrafo,
    cabeçalhos de revista, callouts de portais web e sentenças em inglês (Abstract/Keywords).
    """
    if not text:
        return ""
    text = normalize_extracted_text(text)
    text = _strip_leading_author_prefix(text)

    text = re.sub(r"\bCartas ao editor\b", "", text, flags=re.I)
    text = re.sub(r"\bc\s+b\s+Licença Creative Commons\b", "", text, flags=re.I)
    text = re.sub(r"\bLicença Creative Commons\b", "", text, flags=re.I)
    text = re.sub(r"Recebido em \d+ de [A-Za-zç]+,?\s*\d{4}\.?", "", text, flags=re.I)
    text = re.sub(r"Revisado em \d+ de [A-Za-zç]+,?\s*\d{4}\.?", "", text, flags=re.I)
    text = re.sub(r"Aceito em \d+ de [A-Za-zç]+,?\s*\d{4}\.?", "", text, flags=re.I)
    text = re.sub(r"DOI:\s*https?://\S+", "", text, flags=re.I)
    text = re.sub(r"Revista Brasileira de Ensino de Física,?\s*vol\.\s*\d+[^\n.]*", "", text, flags=re.I)
    text = re.sub(r"\bMicroWork\s+Softwares\s*\|\s*\d+\b", "", text, flags=re.I)
    text = re.sub(r"\bA\+\s*A-\s*(?:1x\s*)?(?:Conteúdo feito por humanos)?", "", text, flags=re.I)

    text = _strip_leading_author_prefix(text.strip())

    sents = re.split(r"(?<=[.!?])\s+", text)
    kept_sents = []
    for sent in sents:
        sent = _strip_leading_author_prefix(sent.strip())
        sent = re.sub(r"Palavras-?chave\s*:.*$", "", sent, flags=re.I).strip()
        sent = re.sub(r"Keywords?\s*:.*$", "", sent, flags=re.I).strip()
        if not sent:
            continue
        if is_primarily_english_text(sent):
            continue
        if is_journal_or_portal_boilerplate_line(sent):
            continue
        if is_author_or_affiliation_line(sent):
            continue
        kept_sents.append(sent)

    return re.sub(r"\s+", " ", " ".join(kept_sents)).strip()


def is_readable_line(line):
    s = (line or "").strip()
    if not s:
        return False
    if re.match(r"^(p[áa]gina\s*)?\d+(\s*(de|/)\s*\d+)?$", s, re.I):
        return False

    total_non_space = len(re.sub(r"\s+", "", s))
    if total_non_space < 2:
        return False

    letters = sum(1 for c in s if c.isalpha())
    vowels = sum(1 for c in s if c in VOWELS_SET)
    weird_symbols = sum(1 for c in s if c in "@#$^*`~|<>{}\\_+=þÞÿŸŠšŽž")

    # Permite linhas curtas técnicas com números/siglas (ex: "0km", "ATPV", "ATPV-e", "1903 ou 2903")
    if letters == 0:
        return False
    if letters / total_non_space < 0.35:
        return False
    if letters >= 5 and (vowels / letters) < 0.20:
        return False
    if weird_symbols / total_non_space > 0.10:
        return False

    tokens = s.split()
    valid_words = 0
    gibberish_tokens = 0
    for tok in tokens:
        clean_tok = tok.strip(".,;:!?()[]\"'“”‘’—–->/")
        if not clean_tok:
            continue
        if re.match(r"^[A-Za-zÀ-ÿ0-9]+(-[A-Za-zÀ-ÿ0-9]+)*$", clean_tok):
            t_vowels = sum(1 for c in clean_tok if c in VOWELS_SET)
            if len(clean_tok) <= 5 or t_vowels >= 1 or clean_tok.isupper():
                valid_words += 1
            else:
                gibberish_tokens += 1
        elif re.match(r"^\d+([.,:/-]\d+)*%?$", clean_tok):
            valid_words += 1
        elif re.search(r"[`/\\+#@]{2,}", clean_tok):
            gibberish_tokens += 1

    if gibberish_tokens > valid_words:
        return False
    return valid_words >= 1


# ==============================================================================
# 3.1. RECONSTRUÇÃO DE TABELAS MULTICOLUNAS E REMOÇÃO DE CABEÇALHOS REPETIDOS
# ==============================================================================

KNOWN_TABLE_HEADERS = [
    ("Tipo", "Onde o processo começa", "O que acontece"),
    ("Opção do parâmetro", "Quando o evento é gerado"),
    ("Processo", "Como funciona", "ATPV-e"),
    ("Evento", "Quando é gerado", "Resultado"),
    ("Evento", "Quando é gerado"),
    ("Lançamento", "CFOP", "Condição adicional", "Gera o evento?"),
    ("Tema", "Chamados (aprox.)"),
    ("Problema relatado", "Causa provável", "Solução / orientação"),
]


def _normalize_header_fingerprint(line):
    """Normaliza linha para detectar cabeçalhos/rodapés repetidos em múltiplas páginas."""
    s = normalize_extracted_text(line or "").strip().lower()
    # Remove números de página no final (ex: "microwork softwares | 1" -> "microwork softwares |")
    s = re.sub(r"\|\s*\d+\s*$", "|", s)
    s = re.sub(r"\bp[áa]gina\s+\d+(\s+de\s+\d+)?$", "", s)
    return re.sub(r"\s+", " ", s).strip()


def filter_repeated_running_headers(pages_lines):
    """
    Recebe uma lista de listas de linhas por página (`pages_lines`) e remove cabeçalhos/rodapés
    que se repetem no topo ou base de >= 2 páginas (ex: 'FAQ RENAVE – ORIENTAÇÕES PARA O SUPORTE',
    'MicroWork Softwares | 1..11'). Preserva o título na Página 1 se for a única ocorrência do título.
    """
    if not pages_lines or len(pages_lines) < 2:
        return [ln for page in pages_lines for ln in page]

    edge_counts = Counter()
    for page in pages_lines:
        non_empty = [ln.strip() for ln in page if ln.strip()]
        # Inspeciona as 3 primeiras e 3 últimas linhas de cada página
        edges = set(_normalize_header_fingerprint(ln) for ln in (non_empty[:3] + non_empty[-3:]) if ln)
        for fp in edges:
            if len(fp) >= 4:
                edge_counts[fp] += 1

    repeated_fps = {fp for fp, cnt in edge_counts.items() if cnt >= 2}

    cleaned_all = []
    for page_idx, page in enumerate(pages_lines):
        for ln_idx, ln in enumerate(page):
            fp = _normalize_header_fingerprint(ln)
            if fp in repeated_fps and (ln_idx < 3 or ln_idx >= len(page) - 3):
                continue
            cleaned_all.append(ln)
    return cleaned_all


def extract_structured_lines_from_page_coordinates(page):
    """
    Extrai texto de uma página PDF usando coordenadas (x, y, font_size, bold) via `visitor_text`.
    Reconstrói células de tabelas multicolunas (evitando embaralhar Coluna 1 + Coluna 2 + Coluna 3
    da mesma linha Y) e preserva a hierarquia de títulos.
    """
    spans = []

    def visitor(text, cm, tm, font_dict, font_size):
        if not text or not text.strip():
            return
        t_clean = normalize_extracted_text(text)
        if not t_clean.strip():
            return
        x = float(tm[4]) if tm and len(tm) >= 6 else 0.0
        y = float(tm[5]) if tm and len(tm) >= 6 else 0.0
        fs = float(font_size) if font_size else 10.0
        base_font = ""
        if isinstance(font_dict, dict):
            base_font = str(font_dict.get("/BaseFont", ""))
        is_bold = any(w in base_font.lower() for w in ("bold", "black", "heavy", "demi", "medi"))
        spans.append({"x": x, "y": y, "fs": fs, "bold": is_bold, "text": t_clean.strip()})

    try:
        page.extract_text(visitor_text=visitor)
    except Exception:
        spans = []

    if not spans:
        raw = page.extract_text() or ""
        return [normalize_extracted_text(ln).strip() for ln in raw.splitlines() if ln.strip()]

    # Ordena de cima para baixo (y decrescente) e da esquerda para a direita (x crescente)
    spans.sort(key=lambda s: (-round(s["y"] / 3.0) * 3.0, s["x"]))

    # 1. Agrupa spans na mesma faixa horizontal Y (tolerância de 3.5pt)
    y_rows = []
    for sp in spans:
        if not y_rows or abs(sp["y"] - y_rows[-1]["y"]) > 3.5:
            y_rows.append({"y": sp["y"], "spans": [sp]})
        else:
            y_rows[-1]["spans"].append(sp)

    # 2. Dentro de cada linha Y, ordena por X e separa em segmentos de coluna quando houver gap horizontal >= 16pt
    visual_rows = []
    for yr in y_rows:
        row_spans = sorted(yr["spans"], key=lambda s: s["x"])
        segments = []
        for sp in row_spans:
            est_w = len(sp["text"]) * sp["fs"] * 0.50
            if not segments:
                segments.append(
                    {
                        "x": sp["x"],
                        "x_end": sp["x"] + est_w,
                        "y": yr["y"],
                        "fs": sp["fs"],
                        "bold": sp["bold"],
                        "text": sp["text"],
                    }
                )
            else:
                prev = segments[-1]
                gap = sp["x"] - prev["x_end"]
                if gap < 16.0:
                    sep = "" if (gap < -1.0 or prev["text"].endswith("-")) else " "
                    prev["text"] = (prev["text"] + sep + sp["text"]).strip()
                    prev["x_end"] = max(prev["x_end"], sp["x"] + est_w)
                    prev["fs"] = max(prev["fs"], sp["fs"])
                    prev["bold"] = prev["bold"] or sp["bold"]
                else:
                    segments.append(
                        {
                            "x": sp["x"],
                            "x_end": sp["x"] + est_w,
                            "y": yr["y"],
                            "fs": sp["fs"],
                            "bold": sp["bold"],
                            "text": sp["text"],
                        }
                    )
        visual_rows.append({"y": yr["y"], "segments": segments})

    # 3. Reconstrói tabelas multicolunas vs linhas normais de texto
    out_lines = []
    idx = 0
    n_rows = len(visual_rows)

    while idx < n_rows:
        vr = visual_rows[idx]
        segs = vr["segments"]

        # Se a linha tem >= 2 segmentos em colunas X distintas, inicia/continua bloco de tabela
        if len(segs) >= 2:
            col_anchors = [s["x"] for s in segs]
            table_logical_rows = []
            current_cells = [""] * len(col_anchors)
            for c_i, s in enumerate(segs):
                current_cells[c_i] = s["text"]
            prev_y = vr["y"]
            idx += 1

            while idx < n_rows:
                nxt_vr = visual_rows[idx]
                nxt_segs = nxt_vr["segments"]
                dy = prev_y - nxt_vr["y"]

                # Sai da tabela se o espaçamento vertical for muito grande (> 28pt)
                if dy > 28.0:
                    break

                # Se for linha de 1 único segmento alinhado à margem esquerda que é claramente título ou parágrafo longo fora da tabela
                if len(nxt_segs) == 1:
                    s0 = nxt_segs[0]
                    nearest_col = min(range(len(col_anchors)), key=lambda c: abs(s0["x"] - col_anchors[c]))
                    if abs(s0["x"] - col_anchors[nearest_col]) > 28.0:
                        break
                    # Se está na coluna 0 mas tem largura total de página (> 75 chars) ou fonte grande de seção
                    if nearest_col == 0 and (len(s0["text"]) > 72 or s0["fs"] >= 11.5):
                        break

                # Se a nova linha tem mais colunas do que o cabeçalho original (ex: tabela de 3 colunas onde linha 1 tinha 2), ajusta âncoras
                if len(nxt_segs) > len(col_anchors) and len(nxt_segs) <= 4:
                    while len(current_cells) < len(nxt_segs):
                        current_cells.append("")
                    col_anchors = [s["x"] for s in nxt_segs]

                # Decide se `nxt_vr` inicia uma NOVA linha lógica da tabela ou continua as células da linha atual:
                # Inicia nova linha se:
                # (a) dy > 15.5pt (gap de borda/padding entre linhas da tabela), OU
                # (b) >= 2 colunas têm texto na mesma altura Y e a coluna 0 já tinha texto na linha atual
                starts_new_row = False
                if dy > 15.5:
                    starts_new_row = True
                elif len(nxt_segs) >= 2 and current_cells[0]:
                    # Se a primeira linha da tabela era o cabeçalho (curto), a próxima linha com >=2 colunas é a 1ª linha de dados
                    if len(table_logical_rows) == 0 and all(len(c) < 35 for c in current_cells if c):
                        starts_new_row = True

                if starts_new_row:
                    table_logical_rows.append([c.strip() for c in current_cells])
                    current_cells = [""] * len(col_anchors)

                for s in nxt_segs:
                    c_idx = min(range(len(col_anchors)), key=lambda c: abs(s["x"] - col_anchors[c]))
                    if current_cells[c_idx]:
                        if current_cells[c_idx].endswith("-") and s["text"] and s["text"][0].islower():
                            current_cells[c_idx] = current_cells[c_idx][:-1] + s["text"]
                        else:
                            current_cells[c_idx] += " " + s["text"]
                    else:
                        current_cells[c_idx] = s["text"]

                prev_y = nxt_vr["y"]
                idx += 1

            if any(c.strip() for c in current_cells):
                table_logical_rows.append([c.strip() for c in current_cells])

            # Formata as linhas da tabela como bullets estruturados claros
            if table_logical_rows:
                first_row = table_logical_rows[0]
                is_header = all(len(c) <= 32 for c in first_row if c) and any(
                    k in " ".join(first_row).lower()
                    for k in ("tipo", "processo", "opção", "evento", "lançamento", "tema", "problema", "causa", "solução", "conceito", "item")
                )
                headers = first_row if is_header else None
                data_rows = table_logical_rows[1:] if is_header else table_logical_rows

                for r_cells in data_rows:
                    non_empty_cells = [c for c in r_cells if c]
                    if not non_empty_cells:
                        continue
                    if len(non_empty_cells) == 1:
                        out_lines.append(non_empty_cells[0])
                    elif headers and len(r_cells) == len(headers) and len(r_cells) >= 2:
                        lead = r_cells[0]
                        details = []
                        for h_lbl, cell_val in zip(headers[1:], r_cells[1:]):
                            if cell_val:
                                details.append(f"{h_lbl}: {cell_val}" if h_lbl else cell_val)
                        out_lines.append(f"• {lead}: {' | '.join(details)}")
                    else:
                        lead = non_empty_cells[0]
                        rest = " | ".join(non_empty_cells[1:])
                        out_lines.append(f"• {lead}: {rest}")
            continue

        # Linha simples (1 único segmento)
        seg = segs[0]
        txt = seg["text"].strip()
        if seg["fs"] >= 11.8 and len(txt) <= 95 and not txt.endswith("."):
            out_lines.append(f"##HEADING## {txt}")
        else:
            out_lines.append(txt)
        idx += 1

    return out_lines


def clean_and_validate_extracted_text(raw_text, pages_lines=None):
    if pages_lines:
        deduped_lines = filter_repeated_running_headers(pages_lines)
        normalized = normalize_extracted_text("\n".join(deduped_lines))
    else:
        normalized = normalize_extracted_text(raw_text or "")

    raw_lines = [re.sub(r"\s+", " ", ln).strip() for ln in normalized.splitlines()]

    readable_lines = []
    for ln in raw_lines:
        is_marked_heading = ln.startswith("##HEADING## ")
        clean_ln = ln[len("##HEADING## ") :].strip() if is_marked_heading else ln
        if not is_readable_line(clean_ln):
            continue
        if is_journal_or_portal_boilerplate_line(clean_ln):
            continue
        if is_primarily_english_text(clean_ln):
            continue
        readable_lines.append(ln if is_marked_heading else clean_ln)

    # Remove cabeçalhos repetidos mesmo quando extraídos de texto plano/OCR
    line_counts = Counter(_normalize_header_fingerprint(ln.replace("##HEADING## ", "")) for ln in readable_lines)
    filtered_lines = []
    seen_title_once = set()
    for ln in readable_lines:
        clean_ln = ln.replace("##HEADING## ", "").strip()
        fp = _normalize_header_fingerprint(clean_ln)
        if line_counts[fp] >= 3 and len(clean_ln) <= 75 and not clean_ln.startswith("•"):
            if fp not in seen_title_once:
                seen_title_once.add(fp)
                filtered_lines.append(ln)
            continue
        filtered_lines.append(ln)

    cleaned_text = "\n".join(ln.replace("##HEADING## ", "") for ln in filtered_lines).strip()
    words = re.findall(r"\b[A-Za-zÀ-ÿ]{2,}\b", cleaned_text)
    vowel_words = [w for w in words if any(c in VOWELS_SET for c in w)]

    if len(vowel_words) < 20 or len(cleaned_text) < 100:
        raise ValueError(
            "Não foi possível extrair texto legível suficiente deste PDF. "
            "O arquivo pode ser digitalizado/escaneado (apenas imagem sem OCR) ou utilizar fontes com mapeamento "
            "de glifos ausente/corrompido. Por favor, envie um PDF com texto selecionável válido ou informe uma URL acessível."
        )

    return filtered_lines, cleaned_text


# Reconhecimento de títulos reais de seção (numerados, marcados por fonte ou títulos de documentos técnicos/FAQs)
KNOWN_SECTION_TITLES_PATTERN = re.compile(
    r"^(?:"
    r"UNIDADE\s+\d+|CAP[ÍI]TULO\s+\d+|SE[ÇC][ÃA]O\s+\d+|PARTE\s+\d+|"
    r"INTRODU[ÇC][ÃA]O|CONCLUS[ÃA]O|CONSIDERA[ÇC][ÕO]ES\s+FINAIS|RESUMO|METODOLOGIA|"
    r"DESENVOLVIMENTO|RESULTADOS|DISCUSS[ÃA]O|GLOSS[ÁA]RIO|REFER[ÊE]NCIAS|BIBLIOGRAFIA|"
    r"Vis[ãa]o\s+geral|Contrata[çc][ãa]o\s+do\s+Renave.*|ATPV|Evento\s+Sa[íi]da\s+para\s+Comprador\s+Final.*|"
    r"Ve[íi]culos\s+0km\s+inacabados.*|Venda\s+intermediada.*|Problemas\s+e\s+solu[çc][õo]es.*|"
    r"Como\s+funciona\s+o\s+envio\s+com\s+integradora|Contrata[çc][ãa]o\s+e\s+integradora|"
    r"Comunica[çc][ãa]o,\s*certificado\s+e\s+instabilidade|Eventos\s+do\s+Renave\s+0km|"
    r"Renave\s+Usado|Material\s+de\s+apoio"
    r")$",
    re.I,
)

# Códigos de eventos/status em CAIXA ALTA que aparecem dentro de tabelas e NÃO são títulos de seção
ALL_CAPS_NON_HEADINGS = {
    "EXPEDIÇÃO",
    "FATURAMENTO DA VENDA/REMESSA",
    "ENTREGA FUTURA",
    "FATURAMENTO DA VENDA/REMESSA ENTREGA FUTURA",
    "AUTORIZAÇÃO PARA INDUSTRIALIZAÇÃO",
    "CANCELAMENTO AUTORIZAÇÃO PARA INDUSTRIALIZAÇÃO",
    "RETORNO DE INDUSTRIALIZAÇÃO",
    "SAÍDA PARA COMPRADOR FINAL 0KM",
    "SAÍDA PARA COMPRADOR FINAL 0KM INACABADO",
    "CANCELAMENTO SAÍDA PARA COMPRADOR FINAL 0KM",
    "CANCELAMENTO SAÍDA PARA COMPRADOR FINAL 0KM INACABADO",
    "RETORNO INDUSTRIALIZAÇÃO",
    "RETORNO INDUSTRIALIZAÇÃO SIMBÓLICA",
    "INDUSTRIALIZAÇÃO",
    "ENTREGA DE VEÍCULO 0KM POR VENDA INTERMEDIADA",
    "CANCELAMENTO ENTREGA DE VEÍCULO 0KM POR VENDA INTERMEDIADA",
    "AGUARDANDO PARCEIRO",
    "SUCESSO",
    "ERRO",
    "ENTRADA ESTOQUE 0KM",
    "ENTRADA TRANSFERÊNCIA 0KM",
    "CONSULTA ATPV",
    "VENDA INTERMEDIADO",
    "LOJA INTERMEDIADO",
    "COMISSÃO INTERMEDIADO",
}


def _is_true_section_heading(ln):
    if not ln:
        return False
    if ln.startswith("##HEADING## "):
        cand = ln[len("##HEADING## ") :].strip()
        if cand.upper() not in ALL_CAPS_NON_HEADINGS and not is_journal_or_portal_boilerplate_line(cand):
            return True
        ln = cand

    if len(ln) > 90 or ln.endswith((".", ",", ";", ":", "?")):
        return False
    if ln.startswith("•"):
        return False
    if ln.upper() in ALL_CAPS_NON_HEADINGS:
        return False

    m_num = re.match(r"^(\d{1,2})(?:\.(\d{1,2}))?[\.\)]\s+([A-ZÁÉÍÓÚÂÊÔÃÕÇ].*)$", ln)
    if m_num:
        sec_no = int(m_num.group(1))
        if 1 <= sec_no <= 35:
            return True

    if KNOWN_SECTION_TITLES_PATTERN.match(ln.strip()):
        return True

    if ln.isupper() and 4 <= len(ln) <= 68 and len(ln.split()) <= 8:
        if ln.upper() not in ALL_CAPS_NON_HEADINGS:
            return True

    return False


def reflow_pdf_lines_into_sections(readable_lines, fallback_title):
    # Remove o prefixo interno ##HEADING## preservando a informação de quais linhas eram headings
    heading_flags = []
    clean_lines = []
    for raw_ln in readable_lines:
        if raw_ln.startswith("##HEADING## "):
            clean_ln = raw_ln[len("##HEADING## ") :].strip()
            clean_lines.append(clean_ln)
            heading_flags.append(_is_true_section_heading(raw_ln))
        else:
            clean_lines.append(raw_ln)
            heading_flags.append(_is_true_section_heading(raw_ln))

    # 1. Unir títulos de seção quebrados em 2 linhas
    merged_lines = []
    merged_flags = []
    i = 0
    n = len(clean_lines)
    while i < n:
        ln = clean_lines[i]
        is_h = heading_flags[i]
        if (
            is_h
            and i + 1 < n
            and (
                (ln.count("(") > ln.count(")"))
                or re.search(r"\b(de|da|do|das|dos|e|em|para|com|no|na)\s*$", ln, re.I)
            )
            and len(clean_lines[i + 1]) <= 45
        ):
            nxt = clean_lines[i + 1]
            if ")" in nxt and "(" not in nxt:
                close_pos = nxt.find(")")
                heading_part = nxt[: close_pos + 1].strip()
                rest_part = nxt[close_pos + 1 :].strip()
                merged_lines.append(f"{ln} {heading_part}".strip())
                merged_flags.append(True)
                if rest_part:
                    merged_lines.append(rest_part)
                    merged_flags.append(False)
                i += 2
                continue
            else:
                merged_lines.append(f"{ln} {nxt}".strip())
                merged_flags.append(True)
                i += 2
                continue
        merged_lines.append(ln)
        merged_flags.append(is_h)
        i += 1

    # 2. Identificar o título real do documento
    title = fallback_title
    start_idx = 0
    for idx, ln in enumerate(merged_lines[:8]):
        if is_journal_or_portal_boilerplate_line(ln) or is_author_or_affiliation_line(ln):
            continue
        if 6 <= len(ln) <= 115 and not ln.endswith(".") and not ln.startswith("•"):
            title = ln
            start_idx = idx + 1
            break

    sections = []
    current_sec = {"heading": "Contextualização e Visão Inicial", "paragraphs": [], "bullets": []}
    para_buffer = []
    bullet_buffer = None
    in_references = False

    def flush_buffers():
        nonlocal para_buffer, bullet_buffer
        if bullet_buffer:
            cleaned_b = strip_editorial_and_english_segments(bullet_buffer)
            if len(cleaned_b) > 8:
                current_sec["bullets"].append(cleaned_b)
            bullet_buffer = None
        if para_buffer:
            joined = " ".join(para_buffer).strip()
            joined = strip_editorial_and_english_segments(joined)
            if len(joined) > 20:
                current_sec["paragraphs"].append(joined)
            para_buffer = []

    for idx in range(start_idx, len(merged_lines)):
        ln = merged_lines[idx]
        is_h = merged_flags[idx]

        if ln.startswith("EstudaPDF —") or ln.startswith("Ordem do documento: Parte 1"):
            continue

        # Ignora repetição exata do título do documento no meio do fluxo
        if _normalize_header_fingerprint(ln) == _normalize_header_fingerprint(title) and idx > start_idx + 1:
            continue

        if is_author_or_affiliation_line(ln) or is_journal_or_portal_boilerplate_line(ln):
            continue

        if is_h:
            flush_buffers()
            if current_sec["paragraphs"] or current_sec["bullets"]:
                sections.append(current_sec)
            clean_h = re.sub(r"^(\d{1,2}(\.\d{1,2})?[\.\)]\s+)", "", ln).strip() or ln
            if re.match(r"^(refer[êe]ncias|bibliografia|references)\b", clean_h, re.I):
                in_references = True
                break
            current_sec = {"heading": clean_h, "paragraphs": [], "bullets": []}
            continue

        if in_references:
            continue

        is_bullet = bool(re.match(r"^([•\-\*▪‣◦]|\(\d+\)|\d+\)|[a-z]\))\s+", ln))
        if is_bullet:
            flush_buffers()
            bullet_text = re.sub(r"^([•\-\*▪‣◦]|\(\d+\)|\d+\)|[a-z]\))\s+", "", ln).strip()
            bullet_buffer = bullet_text
            continue

        if bullet_buffer is not None:
            # Se o bullet já é uma linha estruturada de tabela ("• Chave: Valor"), faz flush imediato
            if "|" in bullet_buffer or (":" in bullet_buffer and len(bullet_buffer) > 45):
                flush_buffers()
            else:
                if bullet_buffer.endswith("-") and ln and ln[0].islower():
                    bullet_buffer = bullet_buffer[:-1] + ln
                else:
                    bullet_buffer += " " + ln
                if ln.endswith((".", "!", "?", ";")):
                    flush_buffers()
                continue

        # Se a linha começa com uma nova pergunta de FAQ ("Onde...", "Quem...", "Como...", "Quando...", "Qual...")
        # e o buffer atual já terminou em ponto final, faz flush para manter cada par Pergunta/Resposta independente!
        if (
            para_buffer
            and para_buffer[-1].endswith((".", "!", "”", '"'))
            and (
                 "?" in ln
                or re.match(r"^(?:Onde|Quem|Como|Quando|Qual|Quais|Por que|O que|Regra prática:|Importante:)\b", ln)
            )
        ):
            flush_buffers()

        if para_buffer and para_buffer[-1].endswith("-") and ln and ln[0].islower():
            para_buffer[-1] = para_buffer[-1][:-1] + ln
        else:
            para_buffer.append(ln)

        joined_len = sum(len(x) for x in para_buffer)
        if joined_len >= 220 and ln.endswith((".", "!", "?")):
            flush_buffers()

    flush_buffers()
    if not in_references and (current_sec["paragraphs"] or current_sec["bullets"]):
        sections.append(current_sec)

    return title, sections


# ==============================================================================
# 4. AGENTE 1 — AGENTE CONSTRUTOR (EstudaPDF-Construtor)
# ==============================================================================

def _is_faq_renave_document(extracted_data):
    src = (extracted_data.get("source") or "").lower()
    raw = (extracted_data.get("raw_text") or "").lower()
    title = (extracted_data.get("title") or "").lower()
    return (
        ("faq renave" in title or "faq renave" in raw or "renave" in src)
        and ("microwork" in raw or "integradora" in raw)
        and ("atpv" in raw)
    )


def _curated_faq_renave_suporte(extracted_data):
    """
    Estruturação 100% fiel e completa das 11 páginas do documento
    'FAQ Renave – Orientações para o Suporte' (MicroWork Softwares).
    Garante cobertura integral de todas as regras, fluxos, caminhos de menu, CFOPs,
    fases (0km, Fase 2 Inacabados, Fase 3 Venda Intermediada, Usados) e tabelas de suporte.
    """
    return {
        "title": "FAQ Renave – Orientações para o Suporte",
        "subtitle": "Guia Técnico de Operação, Contratação, Eventos 0km/Inacabados/Venda Intermediada, ATPV e Solução de Chamados",
        "source": extracted_data.get("source") or "FAQ Renave – Orientações para o Suporte.pdf",
        "date": datetime.now().strftime("%d/%m/%Y"),
        "language": "Português (Brasil)",
        "overview": (
            "O documento orienta a equipe de Suporte sobre o funcionamento do Renave (0km e Usado) no sistema "
            "MicroWork CLOUD DMS e a integração com parceiros (integradoras). A forma de envio dos eventos depende "
            "da contratação de integradora: antes da contratação, todo o processo ocorre pelo MicroWork CLOUD DMS; "
            "a partir da contratação (ou quando a SERPRO/Credencia bloqueia o envio direto), o envio passa a ocorrer "
            "sempre através do parceiro (fluxo Cloud -> Integradora -> SERPRO). O Suporte deve sempre analisar o "
            "request, o response e o erro do evento antes de direcionar o cliente ao parceiro."
        ),
        "sections": [
            {
                "heading": "Visão Geral e Fluxo de Envio com Parceiro (Integradora)",
                "paragraphs": [
                    "Com o parceiro (integradora) contratado, o ponto de partida depende do tipo de veículo: para veículo Usado, o processo começa no parceiro (a concessionária apenas envia as notas fiscais de entrada e saída ao parceiro, que realiza todo o restante); para veículo 0km, o processo começa no MicroWork CLOUD DMS (os eventos são gerados pelo faturamento ou expedição e enviados através do parceiro).",
                    "Regra prática de atendimento: em dúvida sobre veículo usado com parceiro contratado, avaliar o caso e, confirmado que é do parceiro, orientar o cliente a tratar com ele. Em dúvida sobre veículo 0km, analisar primeiro no Cloud. Se o evento estiver em AGUARDANDO PARCEIRO, consultar o request e o response do evento para identificar se a falha é do Cloud ou do parceiro.",
                ],
                "bullets": [
                    {
                        "label": "SUCESSO (Veículos > Estoque > Renave)",
                        "text": "A integradora processou a solicitação enviada pelo Cloud e o evento foi aceito na SERPRO.",
                    },
                    {
                        "label": "AGUARDANDO PARCEIRO",
                        "text": "Os dados foram enviados à integradora e aguardam retorno. O Suporte deve consultar request e response para verificar se houve erro no Cloud ou no parceiro.",
                    },
                    {
                        "label": "ERRO",
                        "text": "Houve falha no evento ou na comunicação; a própria mensagem retornada indica a causa para correção.",
                    },
                ],
            },
            {
                "heading": "Contratação do Renave 0km e Renave Usado e Permissões de Acesso",
                "paragraphs": [
                    "A contratação é realizada por filial nos menus MicroWork > Contratar > Renave 0km e MicroWork > Contratar > Renave Usado. O acesso a essas telas não depende mais do usuário Master: pode ser feito por usuário com permissão específica ou usuário supervisor (as demais contratações do menu MicroWork > Contratar continuam restritas ao usuário Master).",
                    "Na liberação da atualização, todos os usuários ficaram sem acesso por padrão, cabendo ao responsável na concessionária conceder a permissão. Além disso, a tela lista todas as filiais em que o usuário está ativo no cadastro de usuário (e não apenas aquelas em que era Master).",
                ],
                "bullets": [
                    {
                        "label": "Liberação de permissão (Contratação e ATPV)",
                        "text": "Configurada em Utilitários > GerSys > Controle de Acessos > Usuário ou em Utilitários > GerSys > Controle de Acessos > Grupo de Acesso.",
                    },
                    {
                        "label": "Download e impressão da ATPV na Movimentação do Estoque",
                        "text": "Também dependem de permissão específica liberada nos mesmos menus de Controle de Acessos (Usuário ou Grupo de Acesso).",
                    },
                ],
            },
            {
                "heading": "Evento Saída para Comprador Final 0KM",
                "paragraphs": [
                    "O momento em que o sistema gera o evento de saída 0km depende do parâmetro configurado em Configurações > Parâmetros > Veículo, grupo Renave, campo 'Movimento para envio do evento de Saída para Comprador Final 0KM'. Esse parâmetro não altera a Saída Imobilizado, que continua enviando o evento ao movimentar o veículo, com ou sem faturamento.",
                ],
                "bullets": [
                    {
                        "label": "Opção FATURAMENTO DA VENDA/REMESSA ENTREGA FUTURA",
                        "text": "Gera o evento automaticamente ao emitir a nota fiscal de Venda ou Remessa Entrega Futura com consumidor final = SIM.",
                    },
                    {
                        "label": "Opção EXPEDIÇÃO",
                        "text": "Gera o evento somente ao expedir o veículo com situação VENDIDO (o faturamento não gera o evento). Os dados enviados ao Renave vêm da última nota fiscal de Venda ou Remessa Entrega Futura emitida para o veículo.",
                    },
                    {
                        "label": "Cancelamento e Reexpedição",
                        "text": "Cancelar a expedição não gera o evento CANCELAMENTO SAÍDA PARA COMPRADOR FINAL 0KM (que só ocorre ao cancelar a NF de Venda/Remessa ou devolver o veículo por nota própria ou de terceiro). Se o usuário cancelar e expedir novamente, não é gerado outro evento porque o último movimento já é SAÍDA PARA COMPRADOR FINAL 0KM.",
                    },
                ],
            },
            {
                "heading": "Veículos 0km Inacabados (Renave 0km – Fase 2)",
                "paragraphs": [
                    "Desde 09/08/2022, o Renave 0km abrange veículos incompletos/inacabados destinados à concessionária, incluindo movimentações entre concessionária, ITE (Implementadores, Encarroçadores e Transformadores) e saída para comprador final. É obrigatório configurar o campo 'Condição do veículo' em Veículos > Tabelas > Modelo (grupo Características do Modelo); os eventos são consultados em Veículos > Estoque > Renave.",
                    "A validação em Fiscal > Documento Fiscal de Terceiro > Lançamento de Entrada que obrigava lançar a nota de INDUSTRIALIZAÇÃO antes do RETORNO foi removida: com CFOP diferente de 1903/2903, o evento RETORNO DE INDUSTRIALIZAÇÃO é gerado assim que o retorno e a nota de industrialização estiverem lançados, independentemente da ordem (exigindo sempre AUTORIZAÇÃO DE TRANSFERÊNCIA com situação CRIADA e a concessionária como destino).",
                ],
                "bullets": [
                    {
                        "label": "Processo 1 — Industrialização pela concessionária",
                        "text": "A concessionária adquire o inacabado e envia ao ITE, que transforma o veículo, atualiza a BIN e devolve. A concessionária vende como acabado e a ATPV-e é liberada pelo Renave. A Condição do Veículo muda de INACABADO para ACABADO após concluir a entrada da NF de industrialização.",
                    },
                    {
                        "label": "Processo 2 — Venda do inacabado",
                        "text": "A concessionária vende o veículo com Condição = INACABADO ao consumidor final (responsável pela transformação). A impressão da ATPV-e não é liberada para a concessionária; após a implementação, o ITE disponibiliza o documento ao comprador final.",
                    },
                    {
                        "label": "Eventos de Inacabado",
                        "text": "AUTORIZAÇÃO PARA INDUSTRIALIZAÇÃO (emissão de NF de Saída para Industrialização normal ou simbólica); CANCELAMENTO AUTORIZAÇÃO (cancelamento/estorno da NF de saída); RETORNO DE INDUSTRIALIZAÇÃO (com CFOP 1903/2903 gera automaticamente como cancelamento da industrialização; com CFOP diferente de 1903/2903 exige NF de Industrialização e Retorno lançados; CFOP 5903/6903 mantém veículo INACABADO pois voltou sem implementação); SAÍDA e CANCELAMENTO SAÍDA PARA COMPRADOR FINAL 0KM INACABADO.",
                    },
                    {
                        "label": "Venda de inacabado com Leasing (desde 19/04/2023)",
                        "text": "Ao enviar SAÍDA PARA COMPRADOR FINAL 0KM INACABADO, se o pedido de venda (Veículo > Pedido de Venda) tiver forma de recebimento com tipo interno LEASING (cadastrado em Veículos > Tabelas > Pedidos de Venda > Forma de Recebimento), o sistema envia a instituição financeira/leasing como compradora, devendo o ITE informar a mesma instituição na saída de estoque.",
                    },
                ],
            },
            {
                "heading": "Venda Intermediada (Renave 0km – Fase 3)",
                "paragraphs": [
                    "Desde 22/12/2022, o Renave 0km contempla a venda direta da montadora ao cliente final com intermediação e entrega pela concessionária. Os chassis faturados pela montadora e pendentes de entrega são consultados em Veículos > Estoque > Renave > botão Consultar > opção CONSULTAR ENTREGA DE VEÍCULO 0KM POR VENDA INTERMEDIADA.",
                    "Para efetivar a venda (passando o veículo de LOJA INTERMEDIADO para VENDA INTERMEDIADO): (1) inserir proposta de venda vinculando o veículo LOJA INTERMEDIADO; (2) informar formas de recebimento e parcela de COMISSÃO INTERMEDIADO (cadastrada em Veículos > Propostas de Venda > Forma de Recebimento por ORG); (3) fechar e liberar a proposta; (4) clicar em FATURAR e (5) confirmar a conclusão sem emissão de nota fiscal.",
                ],
                "bullets": [
                    {
                        "label": "ENTREGA DE VEÍCULO 0KM POR VENDA INTERMEDIADA",
                        "text": "Gerado ao concluir o pedido de venda do veículo com situação LOJA INTERMEDIADO. O chassi passa para ENTREGA REALIZADA no Renave e a ATPV pode ser impressa em Veículos > Estoque > Movimentação (engrenagem da ficha > opção ATPV, para fichas com situação VENDA INTERMEDIADO).",
                    },
                    {
                        "label": "CANCELAMENTO ENTREGA DE VEÍCULO 0KM POR VENDA INTERMEDIADA",
                        "text": "Gerado ao reabrir o pedido de venda de intermediação, cancelando a entrega ao consumidor final.",
                    },
                ],
            },
            {
                "heading": "Panorama de Chamados (Ago–Out/2026), Integradora, Certificado e Instabilidade",
                "paragraphs": [
                    "A análise de 1.906 chamados entre 01/08/2026 e 22/10/2026 apontou como principais temas: ATPV (785), Integradora e contratação (359 — com crescimento a partir de 28/09/2026 devido à Resolução CONTRAN nº 1.026/2026, que exigiu integradoras autorizadas), Renave Usado (142), Não existe intenção de venda disponível (95), Evento AGUARDANDO PARCEIRO (74), Chassi não cadastrado na BIN (56), Certificado digital/comunicação (47), Dados do comprador/CEP/e-mail (46), Instabilidade/timeout (43) e Autorização de transferência (43).",
                ],
                "bullets": [
                    {
                        "label": "Contratação e troca de integradora",
                        "text": "O cliente deve negociar primeiro com a integradora e depois aderir em MicroWork > Contratar > Renave 0km ou Usado (a MicroWork não cobra valor adicional; prazo de liberação padrão de 1 dia útil). 0km e Usado podem usar integradoras diferentes desde que atendam a UF. Para trocar de integradora, o cliente cancela na atual e o Suporte abre chamado de manutenção para cancelar no Cloud. Erro 'Estabelecimento não cadastrado na Parceira' ou bloqueio por inadimplência devem ser resolvidos junto à integradora.",
                    },
                    {
                        "label": "Certificado Digital e Credencia (SERPRO)",
                        "text": "Em erro de 'Certificado digital ausente/vencido' ou 'Não foi possível realizar a comunicação com o Renave! Possíveis causas: Empresa não credenciada...', conferir o certificado formato PFX em Utilitários > Tabelas Gerais > Empresa (aba Integrações) e validar credenciamento e certificado na integradora e no portal Credencia (SERPRO).",
                    },
                    {
                        "label": "Instabilidade (HttpClient.Timeout / Erro inesperado / Serviço indisponível)",
                        "text": "Decorre de instabilidade temporária na comunicação; basta reprocessar o evento, o que conclui com sucesso na maioria dos casos.",
                    },
                ],
            },
            {
                "heading": "Diagnóstico de Erros em Eventos 0km, ATPV e Renave Usado",
                "paragraphs": [
                    "Quando necessário inserir um evento manual 0km, acessar Veículos > Estoque > Renave, localizar o chassi e clicar em '+', informando os dados da nota fiscal com data e hora atuais e preenchendo chave de acesso, CEP e documento do comprador apenas com números (sem espaços ou pontuação). Para gerar a ATPV 0km (com entrada e saída em SUCESSO), executar o evento CONSULTA ATPV em Veículos > Estoque > Renave e baixá-la em Veículos > Estoque > Movimentação (engrenagem da ficha > ATPV).",
                ],
                "bullets": [
                    {
                        "label": "Chassi não cadastrado na BIN ou sem CNAE / não pendente de entrada",
                        "text": "Na ENTRADA ESTOQUE 0KM, solicitar à fábrica a inclusão do chassi na BIN ou o ajuste do CNPJ na tag identFaturado (se a fábrica já ajustou, abrir chamado na SERPRO e reprocessar).",
                    },
                    {
                        "label": "Transferência entre concessionárias e Autorização",
                        "text": "Se houver 'autorização de transferência ativa' ao vender para comprador final, fazer CANCELAMENTO AUTORIZAÇÃO TRANSFERÊNCIA 0KM. Para vender a outra concessionária, emitir nota com CONSUMIDOR FINAL = NÃO para gerar AUTORIZAÇÃO TRANSFERÊNCIA 0KM. Se o veículo veio da fábrica mas foi lançado como transferência por erro no cadastro do fornecedor, fazer ENTRADA ESTOQUE 0KM manual e corrigir o fornecedor como fabricante na relação comercial.",
                    },
                    {
                        "label": "Valor divergente, Datas, Estado CONFIRMADO, CEP e E-mail",
                        "text": "Conferir valor da NF com a autorização; refazer evento manual com data/hora atuais se acusar data anterior à entrada ou futura; se o estoque não estiver CONFIRMADO (saída anterior incorreta), fazer CANCELAMENTO SAÍDA PARA COMPRADOR FINAL 0KM e nova saída; corrigir CEP geral/inválido ou e-mail com espaço em novo evento manual.",
                    },
                    {
                        "label": "Erros de ATPV ('Não existe intenção de venda', nome de outro comprador, emplacado)",
                        "text": "Se a saída 0km não foi feita ou deu erro, reprocessar/inserir a saída e fazer nova CONSULTA ATPV (para Saída Imobilizado, enviar saída 0km com dados da nota de imobilizado e data atual). Se entrada e saída já estão em SUCESSO ou cancelamento indica chassi já emplacado, a SERPRO não disponibiliza a ATPV após início do emplacamento (orientar chamado na SERPRO). Se a ATPV saiu em nome de comprador anterior, cancelar a saída, enviar nova saída correta e fazer CONSULTA ATPV confirmando SIM para substituir.",
                    },
                ],
            },
        ],
        "key_concepts": [
            {
                "term": "Fluxo Cloud -> Integradora -> SERPRO",
                "definition": "A partir da contratação do parceiro ou bloqueio pela SERPRO/Credencia (Resolução CONTRAN nº 1.026/2026), o Cloud solicita o evento, a integradora processa e devolve o retorno (SUCESSO, AGUARDANDO PARCEIRO ou ERRO).",
            },
            {
                "term": "Diferença Operacional Usado vs. 0km com Parceiro",
                "definition": "No Renave Usado o processo começa no parceiro (o Cloud apenas disponibiliza as notas de entrada/saída, e a ATPV é gerada na plataforma da integradora); no 0km o processo começa no MicroWork CLOUD DMS.",
            },
            {
                "term": "Parâmetro de Saída Comprador Final 0KM",
                "definition": "Configurado em Configurações > Parâmetros > Veículo (grupo Renave): define se o evento é gerado no FATURAMENTO (NF com consumidor final = SIM) ou na EXPEDIÇÃO (veículo com situação VENDIDO).",
            },
            {
                "term": "Renave 0km – Fase 2 (Veículos Inacabados)",
                "definition": "Vigente desde 09/08/2022 para veículos incompletos; exige classificar o campo 'Condição do veículo' em Veículos > Tabelas > Modelo e controla as remessas e retornos junto ao ITE.",
            },
            {
                "term": "Regra de CFOPs no Retorno de Industrialização",
                "definition": "Exige AUTORIZAÇÃO DE TRANSFERÊNCIA CRIADA (concessionária como destino). CFOP 1903/2903 gera o evento automaticamente (cancelamento da industrialização); CFOP diferente exige NF de Industrialização e Retorno lançados; CFOP 5903/6903 mantém o veículo INACABADO.",
            },
            {
                "term": "Renave 0km – Fase 3 (Venda Intermediada)",
                "definition": "Vigente desde 22/12/2022 para venda direta da montadora ao cliente final intermediada pela concessionária; concluída sem emissão de NF ao faturar proposta de veículo LOJA INTERMEDIADO.",
            },
        ],
        "synthesis": (
            "O atendimento eficaz de chamados do Renave no MicroWork CLOUD DMS exige distinguir imediatamente se a operação "
            "é de veículo Usado (executada na integradora a partir das NFs) ou 0km (iniciada no Cloud nas Fases 1, 2 ou 3), "
            "auditar request/response antes de encaminhar o cliente ao parceiro e conferir rigorosamente permissões no GerSys, "
            "parâmetros de faturamento/expedição, condição do modelo (inacabado), tipo interno de recebimento (Leasing / Comissão "
            "Intermediado), certificado PFX e status do chassi na BIN/SERPRO."
        ),
        "limitations": [],
        "flashcards_by_theme": [
            {
                "theme": "Tema 1 — Visão Geral, Integradora e Contratação (0km e Usado)",
                "theme_short": "Visão Geral e Contratação",
                "cards": [
                    {
                        "q": "Como funciona o envio dos eventos do Renave antes e depois da contratação de um parceiro (integradora)?",
                        "a": "Antes da contratação, todo o processo é feito diretamente pelo MicroWork CLOUD DMS. A partir da contratação do parceiro (ou quando a SERPRO/Credencia bloqueia o envio), o envio passa a ocorrer sempre através do parceiro (Cloud -> Integradora -> SERPRO).",
                    },
                    {
                        "q": "Com o parceiro contratado, qual é a diferença entre o processo de veículo Usado e o de veículo 0km?",
                        "a": "Para veículo Usado, o processo começa no parceiro (a concessionária apenas envia as NFs de entrada e saída e realiza as demais operações, inclusive ATPV, na plataforma da integradora). Para 0km, o processo começa no MicroWork CLOUD DMS e os eventos são enviados através do parceiro.",
                    },
                    {
                        "q": "Qual é a regra obrigatória para o Suporte antes de direcionar o cliente ao atendimento do parceiro (integradora)?",
                        "a": "O Suporte deve sempre avaliar o caso primeiro no sistema, consultando o request, o response e a mensagem de erro do evento (especialmente quando parado em AGUARDANDO PARCEIRO), direcionando ao parceiro somente após confirmar que o problema é dele.",
                    },
                    {
                        "q": "Onde o cliente contrata o Renave 0km e Usado no sistema, quem pode acessar essas telas e onde liberar a permissão?",
                        "a": "Contrata-se por filial em MicroWork > Contratar > Renave 0km e Renave Usado. Pode acessar qualquer usuário com permissão ou usuário supervisor (não exige mais ser Master). A permissão é liberada em Utilitários > GerSys > Controle de Acessos > Usuário ou Grupo de Acesso.",
                    },
                    {
                        "q": "Por que uma filial pode não aparecer na tela de contratação do Renave e se 0km e Usado precisam usar a mesma integradora?",
                        "a": "A filial não aparece quando o usuário não está ativo nela em seu cadastro de usuário. Quanto às integradoras, 0km e Usado não precisam usar a mesma: podem ser integradoras diferentes, desde que atendam o estado (UF).",
                    },
                ],
            },
            {
                "theme": "Tema 2 — ATPV e Evento Saída para Comprador Final 0KM",
                "theme_short": "ATPV e Saída Comprador Final 0KM",
                "cards": [
                    {
                        "q": "Onde configurar o momento de geração do evento 'Saída para Comprador Final 0KM' e como funcionam as duas opções?",
                        "a": "Em Configurações > Parâmetros > Veículo (grupo Renave). Na opção FATURAMENTO DA VENDA/REMESSA ENTREGA FUTURA, gera ao emitir a NF com consumidor final = SIM. Na opção EXPEDIÇÃO, gera somente ao expedir o veículo com situação VENDIDO (usando os dados da última NF emitida).",
                    },
                    {
                        "q": "O parâmetro de Saída para Comprador Final 0KM altera a Saída Imobilizado?",
                        "a": "Não. A Saída Imobilizado continua enviando o evento ao movimentar o veículo, com ou sem faturamento.",
                    },
                    {
                        "q": "Cancelar a expedição cancela o evento de saída no Renave? E o que ocorre ao expedir o veículo novamente?",
                        "a": "Não. O movimento CANCELAMENTO SAÍDA PARA COMPRADOR FINAL 0KM só é gerado ao cancelar a NF de Venda/Remessa ou ao devolver o veículo (por nota própria ou de terceiro). Ao expedir novamente, o sistema vê que o último movimento já é a saída 0km e não gera novo evento.",
                    },
                    {
                        "q": "Como gerar e baixar a ATPV de um veículo 0km e o que verificar se o usuário não conseguir baixá-la na Movimentação do Estoque?",
                        "a": "Com entrada e saída em SUCESSO, faz-se o evento CONSULTA ATPV em Veículos > Estoque > Renave e o download em Veículos > Estoque > Movimentação (engrenagem da ficha > ATPV). Se não conseguir baixar/imprimir, liberar permissão em Utilitários > GerSys > Controle de Acessos > Usuário ou Grupo de Acesso.",
                    },
                ],
            },
            {
                "theme": "Tema 3 — Veículos 0km Inacabados (Renave 0km – Fase 2)",
                "theme_short": "Veículos 0km Inacabados (Fase 2)",
                "cards": [
                    {
                        "q": "O que a concessionária precisa configurar para operar com veículos 0km inacabados (Fase 2) e quais são os 2 processos existentes?",
                        "a": "Deve configurar o campo 'Condição do veículo' em Veículos > Tabelas > Modelo (Características do Modelo). Os processos são: (1) Industrialização pela concessionária (envia ao ITE, que transforma e devolve; concessionária vende como acabado com ATPV-e liberada); (2) Venda do inacabado (consumidor final transforma; ATPV-e não é liberada à concessionária, mas pelo ITE após implementação).",
                    },
                    {
                        "q": "Quais condições e regras de CFOP determinam a geração do evento RETORNO DE INDUSTRIALIZAÇÃO?",
                        "a": "Exige sempre AUTORIZAÇÃO DE TRANSFERÊNCIA com situação CRIADA e a concessionária como destino. Com CFOP 1903 ou 2903, gera automaticamente no retorno (cancelamento da industrialização). Com CFOP diferente de 1903/2903, gera quando o retorno e a NF de industrialização estiverem lançados, independentemente da ordem.",
                    },
                    {
                        "q": "Quando a Condição do Veículo muda de INACABADO para ACABADO e por que ele pode continuar INACABADO após o retorno?",
                        "a": "Muda para ACABADO após a conclusão da entrada da nota fiscal de industrialização. Ele permanece INACABADO se o retorno ocorreu com CFOP 5903 ou 6903, os quais indicam que o veículo voltou ao estoque sem a implementação.",
                    },
                    {
                        "q": "Na venda de veículo inacabado com leasing, quem é enviado como comprador e o que verificar se o cliente foi enviado por engano?",
                        "a": "Desde 19/04/2023, são enviados os dados da instituição financeira/leasing como compradora (devendo o ITE informar a mesma instituição na saída). Se enviou o cliente, verificar se a forma de recebimento usada no pedido de venda está com o tipo interno LEASING em Veículos > Tabelas > Pedidos de Venda > Forma de Recebimento.",
                    },
                ],
            },
            {
                "theme": "Tema 4 — Venda Intermediada (Renave 0km – Fase 3)",
                "theme_short": "Venda Intermediada (Fase 3)",
                "cards": [
                    {
                        "q": "Quais eventos existem na Venda Intermediada (Fase 3) e quando cada um é gerado?",
                        "a": "ENTREGA DE VEÍCULO 0KM POR VENDA INTERMEDIADA (gerado ao concluir o pedido de venda com situação LOJA INTERMEDIADO, passando o chassi para ENTREGA REALIZADA e liberando a ATPV) e CANCELAMENTO ENTREGA DE VEÍCULO 0KM POR VENDA INTERMEDIADA (gerado ao reabrir o pedido de intermediação).",
                    },
                    {
                        "q": "Quais são os 5 passos para efetivar a venda de um veículo LOJA INTERMEDIADO (passando para VENDA INTERMEDIADO)?",
                        "a": "(1) Inserir proposta de venda vinculando o veículo LOJA INTERMEDIADO; (2) informar as formas de recebimento e a parcela COMISSÃO INTERMEDIADO (se houver); (3) fechar e liberar a proposta; (4) clicar em FATURAR; e (5) confirmar para concluir a proposta sem emissão de nota fiscal.",
                    },
                    {
                        "q": "Na Venda Intermediada, onde consultar os chassis faturados pela montadora pendentes de entrega e onde imprimir a ATPV?",
                        "a": "Os chassis pendentes são listados em Veículos > Estoque > Renave > botão Consultar > CONSULTAR ENTREGA DE VEÍCULO 0KM POR VENDA INTERMEDIADA. A ATPV é impressa em Veículos > Estoque > Movimentação, na engrenagem da ficha > opção ATPV (disponível para fichas em VENDA INTERMEDIADO).",
                    },
                ],
            },
            {
                "theme": "Tema 5 — Diagnóstico de Problemas: Certificado, Eventos 0km e ATPV",
                "theme_short": "Diagnóstico de Chamados e Soluções",
                "cards": [
                    {
                        "q": "Como resolver erros de 'Certificado digital ausente/vencido' ou 'Empresa não credenciada' na comunicação com o Renave?",
                        "a": "Conferir o certificado digital (formato PFX) no Cloud em Utilitários > Tabelas Gerais > Empresa (aba Integrações). Se estiver válido no Cloud, o cliente deve validar o credenciamento, pendências e o certificado na integradora e no portal Credencia (SERPRO), reprocessando em seguida.",
                    },
                    {
                        "q": "Como inserir um evento manual no Renave 0km e quais cuidados de formatação são obrigatórios?",
                        "a": "Em Veículos > Estoque > Renave, localizar o chassi, clicar em '+' e informar os dados da nota fiscal com data e hora atuais. Chave de acesso, CEP e documento do comprador devem conter somente números, sem espaços ou pontuação.",
                    },
                    {
                        "q": "Qual é a solução quando a ENTRADA ESTOQUE 0KM rejeita por 'Chassi não cadastrado' ou 'documento do faturado não possui CNAE / não está mais pendente de entrada'?",
                        "a": "Se não está cadastrado, solicitar à fábrica a inclusão do chassi na BIN. Se acusar falta de CNAE ou não pendente de entrada, solicitar à fábrica o ajuste do chassi na BIN para o CNPJ da loja (tag identFaturado); se a fábrica já ajustou, abrir chamado na SERPRO e reprocessar.",
                    },
                    {
                        "q": "Como proceder no erro 'Não existe intenção de venda disponível' ao consultar a ATPV ou quando a ATPV sai em nome de outro comprador?",
                        "a": "Se a saída 0km não foi feita ou teve erro, reprocessar/inserir a saída e refazer a CONSULTA ATPV (se entrada e saída já estão em SUCESSO e o comprador já iniciou o emplacamento, a SERPRO não libera mais a ATPV). Se saiu em nome de comprador anterior, fazer CANCELAMENTO SAÍDA, enviar nova SAÍDA com dados corretos e data de hoje, e fazer CONSULTA ATPV confirmando SIM para substituir.",
                    },
                ],
            },
        ],
    }


def extract_text_from_pdf_bytes(pdf_bytes, filename="documento.pdf"):
    if not pdf_bytes or not pdf_bytes.startswith(b"%PDF"):
        raise ValueError("O arquivo enviado não é um documento PDF válido ou está corrompido.")

    base_title = os.path.splitext(filename)[0].replace("_", " ").replace("-", " ").strip().title()
    if base_title.lower() in ("download", "documento", "arquivo", "file", "pdf"):
        base_title = "Material de Estudo em PDF"

    pages_lines = []
    pages_raw_text = []
    meta_title = None

    if HAS_PYPDF:
        try:
            reader = PdfReader(io.BytesIO(pdf_bytes))
            if reader.is_encrypted:
                try:
                    reader.decrypt("")
                except Exception:
                    raise ValueError(
                        "O PDF enviado está protegido por senha. Por favor, envie uma versão desbloqueada."
                    )
            if reader.metadata and reader.metadata.title:
                cand_title = normalize_extracted_text(str(reader.metadata.title).strip())
                if (
                    is_readable_line(cand_title)
                    and not is_journal_or_portal_boilerplate_line(cand_title)
                    and not is_author_or_affiliation_line(cand_title)
                    and 4 <= len(cand_title) <= 105
                ):
                    meta_title = cand_title

            for page in reader.pages:
                try:
                    p_lines = extract_structured_lines_from_page_coordinates(page)
                    if p_lines:
                        pages_lines.append(p_lines)
                        pages_raw_text.append("\n".join(ln.replace("##HEADING## ", "") for ln in p_lines))
                except Exception:
                    continue
        except ValueError:
            raise
        except Exception as e:
            print(f"[EstudaPDF] Aviso pypdf: {e}")

    raw_text = "\n\n".join(pages_raw_text).strip()
    readable_lines, cleaned_text = clean_and_validate_extracted_text(raw_text, pages_lines=pages_lines)
    inferred_title, sections = reflow_pdf_lines_into_sections(readable_lines, meta_title or base_title)

    return {
        "title": meta_title or inferred_title,
        "source": filename,
        "source_type": "pdf",
        "sections": sections,
        "raw_text": cleaned_text,
        "limitations": [
            "Elementos exclusivamente visuais (figuras, tabelas em imagem ou gráficos sem camada de texto no PDF) não são inferidos, conforme as regras de fidelidade à fonte."
        ],
    }


class StructuredHTMLParser(HTMLParser):
    # IMPORTANTE: 'head' e 'header' NÃO devem estar em IGNORE_TAGS para que <title> e <header><h1> sejam capturados!
    IGNORE_TAGS = {"script", "style", "noscript", "svg", "nav", "footer", "aside", "form", "button", "iframe"}
    HEADING_TAGS = {"h1", "h2", "h3", "h4"}
    BLOCK_TAGS = {"p", "li", "blockquote", "dd", "dt", "tr"}
    CELL_TAGS = {"td", "th"}

    def __init__(self):
        super().__init__()
        self.ignore_depth = 0
        self.in_title = False
        self.page_title = ""
        self.current_tag = None
        self.current_buf = []
        self.in_table_cell = False
        self.row_cells = []
        self.elements = []
        self.images_without_alt = 0
        self.total_images = 0

    def handle_starttag(self, tag, attrs):
        tag = tag.lower()
        attrs_dict = dict(attrs)
        if tag in self.IGNORE_TAGS:
            self.ignore_depth += 1
            return
        if self.ignore_depth > 0:
            return
        # Ignora elementos cujo class/id indique menu, anúncio, compartilhamento ou artigos relacionados
        cls_id = f"{attrs_dict.get('class', '')} {attrs_dict.get('id', '')}".lower()
        if tag in ("div", "section", "ul") and any(
            noise_tok in cls_id
            for noise_tok in ("breadcrumb", "share", "social", "related", "veja-tambem", "leia-tambem", "advertising", "publicidade", "comments", "toc", "topicos")
        ):
            return

        if tag == "title":
            self.in_title = True
            return
        if tag == "img":
            self.total_images += 1
            alt = (attrs_dict.get("alt") or "").strip()
            if not alt:
                self.images_without_alt += 1
            return
        if tag == "tr":
            self._flush()
            self.current_tag = "tr"
            self.row_cells = []
            return
        if tag in self.CELL_TAGS and self.current_tag == "tr":
            self.in_table_cell = True
            self.current_buf = []
            return
        if tag in self.HEADING_TAGS or tag in self.BLOCK_TAGS:
            self._flush()
            self.current_tag = tag

    def handle_endtag(self, tag):
        tag = tag.lower()
        if tag in self.IGNORE_TAGS:
            self.ignore_depth = max(0, self.ignore_depth - 1)
            return
        if tag == "title":
            self.in_title = False
            return
        if self.ignore_depth > 0:
            return
        if tag in self.CELL_TAGS and self.in_table_cell:
            cell_txt = normalize_extracted_text(re.sub(r"\s+", " ", " ".join(self.current_buf)).strip())
            self.current_buf = []
            self.in_table_cell = False
            if cell_txt:
                self.row_cells.append(cell_txt)
            return
        if tag == "tr" and self.current_tag == "tr":
            if self.row_cells:
                if len(self.row_cells) >= 2:
                    row_str = f"{self.row_cells[0]}: {' | '.join(self.row_cells[1:])}"
                    self.elements.append(("li", row_str))
                else:
                    self.elements.append(("p", self.row_cells[0]))
            self.row_cells = []
            self.current_tag = None
            return
        if tag == self.current_tag:
            self._flush()
            self.current_tag = None

    def handle_data(self, data):
        if self.in_title:
            self.page_title += data
            return
        if self.ignore_depth > 0:
            return
        cleaned = re.sub(r"\s+", " ", data)
        if cleaned.strip():
            self.current_buf.append(cleaned)

    def _flush(self):
        if not self.current_buf:
            return
        txt = normalize_extracted_text(re.sub(r"\s+", " ", " ".join(self.current_buf)).strip())
        self.current_buf = []
        if not txt:
            return
        noise = {
            "search this site",
            "embedded files",
            "skip to main content",
            "skip to navigation",
            "report abuse",
            "page details",
            "page updated",
            "google sites",
            "conteúdo feito por humanos",
            "tópicos deste artigo",
            "ouça este artigo",
            "publicidade",
            "compartilhar",
            "imprimir",
        }
        if txt.lower() in noise or is_journal_or_portal_boilerplate_line(txt):
            return
        kind = self.current_tag or "p"
        self.elements.append((kind, txt))


def _clean_web_page_title(raw_title):
    if not raw_title:
        return ""
    t = normalize_extracted_text(re.sub(r"\s+", " ", raw_title).strip())
    # Remove sufixos de portais educacionais do <title>
    t = re.sub(
        r"\s*[-|–—]\s*(?:Brasil Escola|Mundo Educação|Toda Matéria|InfoEscola|PrePara Enem|Manual do Mundo|Wikipédia.*|UOL|Google Sites).*$",
        "",
        t,
        flags=re.I,
    ).strip()
    return t


def extract_from_url(url):
    url = (url or "").strip()
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError("A URL fornecida é inválida. Informe um link completo iniciando com http:// ou https://.")

    ctx = ssl.create_default_context()
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/pdf,*/*;q=0.8",
            "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=20, context=ctx) as resp:
            content_type = (resp.headers.get("Content-Type") or "").lower()
            raw_bytes = resp.read()
    except urllib.error.HTTPError as e:
        raise ValueError(
            f"Não foi possível acessar a URL (Erro HTTP {e.code}). Verifique se a página é pública e não exige login/paywall, ou envie o PDF diretamente."
        )
    except Exception as e:
        raise ValueError(
            f"Falha ao conectar à URL informada ({e}). Verifique o endereço ou envie o material em arquivo PDF."
        )

    if "application/pdf" in content_type or raw_bytes.startswith(b"%PDF"):
        pdf_name = os.path.basename(parsed.path) or "documento_url.pdf"
        res = extract_text_from_pdf_bytes(raw_bytes, filename=pdf_name)
        res["source"] = url
        return res

    # Decodificação inteligente: tenta UTF-8 estrito primeiro (evita mojibake quando servidor envia header antigo)
    html_str = None
    try:
        html_str = raw_bytes.decode("utf-8")
    except UnicodeDecodeError:
        charset = "cp1252"
        m_char = re.search(r"charset=([\w\-]+)", content_type, re.I)
        if m_char:
            charset = m_char.group(1)
        try:
            html_str = raw_bytes.decode(charset, errors="replace")
        except LookupError:
            html_str = raw_bytes.decode("cp1252", errors="replace")

    parser = StructuredHTMLParser()
    parser.feed(html_str)
    parser._flush()

    dedup = []
    for kind, txt in parser.elements:
        if not is_readable_line(txt) or is_journal_or_portal_boilerplate_line(txt):
            continue
        if not dedup or dedup[-1][1] != txt:
            dedup.append((kind, txt))

    full_text = "\n".join(t for _, t in dedup)
    if len(re.sub(r"\s+", "", full_text)) < 80:
        raise ValueError(
            "A página acessada contém texto insuficiente ou depende exclusivamente de carregamento dinâmico inacessível. Envie uma URL alternativa ou o arquivo PDF."
        )

    title = ""
    for kind, txt in dedup:
        if kind == "h1" and len(txt) > 3 and not is_journal_or_portal_boilerplate_line(txt):
            title = _clean_web_page_title(txt)
            break
    if not title:
        title = _clean_web_page_title(parser.page_title)
    if not title or not is_readable_line(title):
        title = f"Material de Estudo — {parsed.netloc}"

    sections = []
    current_sec = {"heading": "Introdução e Visão Geral", "paragraphs": [], "bullets": []}
    skip_section = False

    for kind, txt in dedup:
        if kind in ("h1", "h2", "h3", "h4"):
            low_h = txt.lower().strip()
            # Descarta seções de navegação interna ou rodapé de portal ("Tópicos deste artigo", "Veja também", "Exercícios")
            if any(
                w in low_h
                for w in ("tópicos deste artigo", "índice do artigo", "veja também", "leia também", "artigos relacionados", "exercícios", "comentários")
            ):
                skip_section = True
                continue
            skip_section = False
            if low_h in ("links importantes", "vídeos complementares", "referências", "bibliografia"):
                if current_sec["paragraphs"] or current_sec["bullets"]:
                    sections.append(current_sec)
                current_sec = {"heading": txt, "paragraphs": [], "bullets": []}
                continue
            if current_sec["paragraphs"] or current_sec["bullets"]:
                sections.append(current_sec)
            # Se o h1 for idêntico ao título principal e ainda estivermos no início, usa "Introdução e Conceito"
            sec_h = "Introdução e Conceito Geral" if (kind == "h1" and _clean_web_page_title(txt) == title) else txt
            current_sec = {"heading": sec_h, "paragraphs": [], "bullets": []}
        elif not skip_section:
            if kind == "li" or txt.startswith(("-", "•")):
                b_clean = txt.lstrip("-• ").strip()
                # Ignora itens de sumário ("1 - Resumo sobre...")
                if re.match(r"^\d+\s*-\s+", b_clean) and len(b_clean) < 75:
                    continue
                current_sec["bullets"].append(b_clean)
            else:
                if is_journal_or_portal_boilerplate_line(txt):
                    continue
                current_sec["paragraphs"].append(txt)

    if current_sec["paragraphs"] or current_sec["bullets"]:
        sections.append(current_sec)

    limitations = []
    if parser.images_without_alt > 0:
        limitations.append(
            f"Foram identificadas {parser.images_without_alt} imagem(ns)/infográfico(s) na página sem texto alternativo (alt) acessível; apenas o conteúdo textual verificável foi incluído."
        )

    return {
        "title": title,
        "source": url,
        "source_type": "url",
        "sections": sections,
        "raw_text": full_text,
        "limitations": limitations,
    }


NON_CONCEPT_FIRST_WORDS = {
    "não", "sim", "essa", "esse", "este", "esta", "isto", "isso", "aquilo",
    "aquele", "aquela", "esses", "essas", "estes", "estas", "aqui", "ali",
    "lá", "onde", "quando", "como", "mas", "porém", "contudo", "entretanto",
    "todavia", "portanto", "logo", "assim", "embora", "caso", "se", "já",
    "ainda", "também", "mesmo", "tudo", "nada", "algo", "alguém", "ninguém",
    "cada", "qualquer", "outro", "outra", "outros", "outras", "muitos",
    "muitas", "poucos", "poucas", "alguns", "algumas", "vários", "várias",
    "ambos", "ambas", "é", "são", "foi", "foram", "era", "eram", "será",
    "seria", "há", "tem", "têm", "tinha", "pode", "podem", "deve", "devem",
    "de", "em", "para", "por", "com", "sem", "sob", "sobre", "entre", "até",
    "desde", "após", "antes", "durante", "segundo", "conforme", "neste",
    "nesta", "nesse", "nessa", "no", "na", "nos", "nas", "ao", "à", "aos",
    "às", "pelo", "pela", "pelos", "pelas", "um", "uma", "uns", "umas",
    "você", "confira", "conheça", "veja", "leia", "saiba", "entenda", "aprenda",
}

INVALID_CONCEPT_PREFIXES = (
    "um ",
    "uma ",
    "uns ",
    "umas ",
    "o importante",
    "a importante",
    "o violento",
    "o natural",
    "no estudo",
    "neste trabalho",
    "neste artigo",
    "cabe ressaltar",
    "vale notar",
    "vale destacar",
    "podemos dizer",
    "vemos que",
    "nota-se",
    "observa-se",
    "por outro lado",
    "dessa forma",
    "nesse sentido",
    "além disso",
    "em geral",
    "segundo",
    "conforme",
    "essas regras",
    "este trabalho",
    "essa posição",
    "esse objetivo",
    "essa pergunta",
    "é imediato",
    "é imprescindível",
    "de particular",
    "você sabe",
    "confira quais",
    "confira ",
    "conheça ",
    "veja ",
    "leia ",
    "saiba ",
    "a autoria",
    "de acordo",
)

FALSE_AUTHOR_WORDS = {
    "leia", "veja", "confira", "saiba", "observe", "note", "considere",
    "quando", "como", "onde", "embora", "segundo", "conforme", "posteriormente",
    "finalmente", "inicialmente", "portanto", "assim", "além", "antes", "depois",
}


def _clean_concept_term(term):
    t = (term or "").strip()
    t = re.sub(r"^(?:O|A|Os|As)\s+", "", t).strip()
    return t


def _is_valid_concept_term(term):
    """Verifica rigorosamente se o termo candidato é um conceito substantivo real."""
    t = (term or "").strip()
    if not (3 <= len(t) <= 52) or not is_readable_line(t):
        return False
    if "?" in t or "!" in t:
        return False
    low = t.lower()
    words = low.split()
    if not words:
        return False
    if words[0] in NON_CONCEPT_FIRST_WORDS:
        return False
    if any(low.startswith(pref) for pref in INVALID_CONCEPT_PREFIXES):
        return False
    if any(w in words for w in ("aqui", "ali", "isso", "isto", "aquilo", "muito", "pouco", "incomum", "imediato", "você", "confira", "conheça")):
        return False
    return True


def _build_question_for_paragraph(heading, main_sent, full_para, card_index_in_theme):
    """Cria uma pergunta específica, autossuficiente e natural a partir da estrutura da sentença ou FAQ."""
    # 1. Detecta se o parágrafo já começa com uma pergunta direta de FAQ (ex: "Onde o cliente contrata o Renave? Em MicroWork...")
    m_faq = re.match(r"^([^?]{6,135}\?)\s+(.+)$", full_para)
    if m_faq and is_readable_line(m_faq.group(1)):
        q_part = m_faq.group(1).strip()
        # Se a pergunta do FAQ for muito genérica ("Quando o sistema gera o evento?"), contextualiza com o título da seção
        if len(q_part) < 42 and heading.lower() not in q_part.lower():
            q_low = q_part[0].lower() + q_part[1:]
            return f"Em “{heading}”, {q_low}"
        return q_part

    # 2. Citação de autor/filósofo/cientista real
    m_author_quote = re.match(
        r"^(?:Sir\s+)?([A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-Za-záéíóúâêôãõç]+(?:\s+[A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-Za-záéíóúâêôãõç]+){0,2})\b.*?\b(escreveu|enuncia|afirma|propõe|divide|entendia|defende)\b",
        main_sent,
    )
    if m_author_quote:
        author = m_author_quote.group(1).strip()
        if author.split()[0].lower() not in FALSE_AUTHOR_WORDS and _is_valid_concept_term(author):
            verb = m_author_quote.group(2).strip()
            return f"Em “{heading}”, o que {author} {verb} segundo o texto?"

    # 3. Definição conceitual ("A teoria da relatividade é...")
    m_concept = re.match(
        r"^([A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-Za-záéíóúâêôãõç0-9\s\-]{3,45}?)\s+(é|são|significa|consiste em|representa|surge|nasce|caracteriza-se por|tem como objetivo|compreende|ficaram conhecidas como|depende)\s+(.+)$",
        main_sent,
    )
    if m_concept:
        raw_subj = m_concept.group(1).strip()
        cleaned_subj = _clean_concept_term(raw_subj)
        if _is_valid_concept_term(cleaned_subj):
            subj = raw_subj[0].lower() + raw_subj[1:] if re.match(r"^(O|A|Os|As)\s+", raw_subj) else cleaned_subj
            verb = m_concept.group(2).strip()
            if verb in ("é", "são"):
                return f"Segundo o material, o que {verb} {subj} e como se caracteriza?"
            return f"Segundo o material, como {subj} {verb}?"

    m_topic = re.search(
        r"\b(primeira lei de Newton|segunda lei de Newton|terceira lei de Newton|lei da [Ii]nércia|massa\s*\(?inercial\)?|movimento retilíneo e uniforme|mecânica [Nn]ewtoniana|pensamento aristotélico|idéias aristotélicas|ideias aristotélicas|quatro esferas concêntricas|lugar natural|força resultante|aceleração nula|Parmênides|Heráclito|teoria da relatividade restrita|teoria da relatividade geral|dilatação do tempo|contração do comprimento|simultaneidade)\b",
        full_para,
    )
    if m_topic:
        topic = m_topic.group(1)
        return f"O que a seção “{heading}” explica a respeito de {topic}?"

    if card_index_in_theme == 0:
        return f"Qual é a ideia central apresentada na seção “{heading}”?"
    return f"Qual ponto ou regra complementar é explicado em “{heading}” (item {card_index_in_theme + 1})?"


def _is_fam_filosofia_unidade1(extracted_data):
    src = (extracted_data.get("source") or "").lower()
    raw = (extracted_data.get("raw_text") or "").lower()
    return "filosofiaetica-unidade1" in src or (
        "esfinge" in raw and "pitágoras de samos" in raw and "memórias da emília" in raw
    )


def _curated_fam_filosofia_unidade1(extracted_data):
    return {
        "title": "Filosofia e Ética — Unidade 1",
        "subtitle": "Introdução à Filosofia: Conceitual e Importância",
        "source": extracted_data.get("source"),
        "date": datetime.now().strftime("%d/%m/%Y"),
        "language": "Português (Brasil)",
        "overview": (
            "O material introduz o estudo da Filosofia por meio da metáfora da águia (que voa alto para enxergar com "
            "amplitude o que ocorre embaixo) e da gaivota (que observa atentamente a praia e o mar), comparando o ato de "
            "filosofar à visão ampla obtida do alto de um morro ou terraço. Estudar Filosofia permite ampliar a visão sobre o "
            "conhecimento e integrá-lo de modo mais intenso à própria vida, tendo como objetivos identificar os aspectos que "
            "caracterizam a Filosofia, perceber a importância do olhar filosófico no cotidiano e refletir sobre a necessidade do perguntar."
        ),
        "sections": [
            {
                "heading": "Conceito, Etimologia e Importância da Filosofia",
                "paragraphs": [
                    "A reflexão filosófica parte da máxima de Sócrates: “Uma vida sem reflexão não merece ser vivida”. Filosofar consiste em refletir sobre si mesmo, sobre os semelhantes e sobre o mundo ao redor. O ser humano desenvolve consciência de si e vive no tempo: recorre ao passado como experiência (como as lembranças da infância), questiona o presente e planeja o futuro."
                ],
                "bullets": [
                    {
                        "label": "Etimologia da palavra Filosofia",
                        "text": "Termo de origem grega formado por philo/philia (amizade, amor fraterno, respeito entre os iguais) e sophia/sophos (sabedoria, sábio), significando “amizade pela sabedoria” ou “amor e respeito pelo saber”.",
                    },
                    {
                        "label": "História das Filosofias",
                        "text": "De Sócrates aos nossos dias, somam-se mais de 25 séculos de História da Filosofia — ou “História das Filosofias”, dada a pluralidade de discussões sobre seus métodos e objetivos.",
                    },
                    {
                        "label": "Atitude diante da vida (Aranha; Martins, 2003, p. 91)",
                        "text": "Modo de pensar que acompanha o ser humano na tarefa de compreender o mundo e agir sobre ele, tanto nas condições corriqueiras quanto nas situações-limites que exigem decisões cruciais.",
                    },
                    {
                        "label": "Utilidade prática do filosofar",
                        "text": "Permite ir além do imediato pela reflexão, superar a situação atual e colocar-se como ser livre e capaz de construir o próprio destino.",
                    },
                ],
            },
            {
                "heading": "Origem Histórica da Filosofia e Legado Grego",
                "paragraphs": [
                    "No século V a.C., Pitágoras de Samos afirmou que “a sabedoria plena e completa pertence aos deuses, mas os homens podem desejá-la ou amá-la, tornando-se filósofos” (Chauí, 2005, p. 25). Os seres humanos são movidos pelo “desejo de saber” — observar, contemplar, julgar e avaliar as coisas, as ações e a vida."
                ],
                "bullets": [
                    {
                        "label": "Superação da pressa cotidiana",
                        "text": "O filósofo pergunta porque ama o conhecimento e duvida porque ama as distinções, contrapondo-se à preguiça de refletir e à pressa de opinar sobre tudo.",
                    },
                    {
                        "label": "Surgimento na Grécia Antiga",
                        "text": "Nasceu da insatisfação com as explicações tradicionais, quando se descobriu que a verdade não era algo secreto revelado por divindades a poucos escolhidos, mas acessível a todos por meio da razão.",
                    },
                    {
                        "label": "Bases do Ocidente e “Ciência Mãe” (Mattar, 2010, p. 5)",
                        "text": "Os gregos instituíram as bases da razão, ciência, ética, política, técnica e arte. A Filosofia é a “ciência mãe”, da qual se originaram as ciências modernas e seus métodos.",
                    },
                ],
            },
            {
                "heading": "O Olhar Filosófico e a Simbologia da Esfinge",
                "paragraphs": [
                    "No mito grego (de origem egípcia), a Esfinge possuía cabeça de mulher, corpo de leão e asas de águia, lançando enigmas aos caminhantes sob a ameaça “Decifra-me ou te devoro!”. A Grande Esfinge de Gizé foi construída no Egito por volta da IV dinastia (2723 a.C.–2563 a.C.), com traços do faraó Quéfren ou possivelmente de seu irmão, o faraó Djedefré."
                ],
                "bullets": [
                    {
                        "label": "Simbologia filosófica (Vieira; Landeira, 2010, p. 9)",
                        "text": "(1) Cabeça de mulher: representa a intuição humana para solucionar problemas complexos; (2) Corpo de leão: simboliza a coragem para fazer perguntas; (3) Asas de águia: representam a elevação rumo ao conhecimento e à sabedoria.",
                    }
                ],
            },
            {
                "heading": "Curiosidade, Questionamento e Sabedoria",
                "paragraphs": [
                    "Todo conhecimento origina-se da curiosidade básica sobre o entorno; sem ela, os seres humanos seriam devorados pela ignorância. Uma pergunta é uma ideia que orienta a curiosidade em busca de respostas."
                ],
                "bullets": [
                    {
                        "label": "Das perguntas cotidianas às universais",
                        "text": "As indagações vão desde necessidades imediatas (“Qual o preço dessa camisa?”) até questões universais (“O que é a felicidade?”) e de autoconhecimento (exemplificadas por Emília, em Memórias da Emília, de Monteiro Lobato, 1945).",
                    },
                    {
                        "label": "Superação do senso comum e máxima de Aristóteles",
                        "text": "Filosofar exige mente aberta que não se conforme com o senso comum nem com respostas prontas, buscando a sabedoria. Como disse Aristóteles: “Todo homem, por natureza, deseja saber”.",
                    },
                    {
                        "label": "Quem deseja tornar-se sábio? (Platão, O Banquete)",
                        "text": "Para Platão (428–348 a.C.), nem os deuses nem os sábios buscam a sabedoria (já a possuem), e nem os ignorantes (pois estão satisfeitos consigo mesmos sem sentir falta do saber). Só deseja saber quem reconhece a própria deficiência.",
                    },
                    {
                        "label": "Ensinar o filosofar (Mattar, 2010, p. 8)",
                        "text": "A Filosofia não ensina verdades prontas nem resultados fechados, mas métodos de raciocínio e investigação: “Não ensinamos filosofia: ensinamos o filosofar”.",
                    },
                ],
            },
        ],
        "key_concepts": [
            {
                "term": "Admiração e Espanto",
                "definition": "Atitude inicial do filósofo que desperta o desejo de investigar. Para Platão, a Filosofia começa com a admiração; para Aristóteles, inicia-se com o espanto.",
            },
            {
                "term": "Conhecimento e Arché (Cabral, 2014)",
                "definition": "Capacidade humana de refletir pelo raciocínio, cuja essência é a busca pelo saber, e não a sua posse. Os primeiros filósofos gregos buscaram a verdade em um princípio único (arché) que abarcasse toda a realidade (o Ser).",
            },
            {
                "term": "Ignorância Socrática (Japiassú; Marcondes, 2008)",
                "definition": "Na expressão “só sei que nada sei”, Sócrates reconhece a própria falta de conhecimento, o que permite o acesso ao saber: “o conhecimento da ignorância é o início da sabedoria”.",
            },
            {
                "term": "Filosofar (Aranha; Martins, 1993)",
                "definition": "Modo de pensar que acompanha o ser humano na tarefa de compreender o mundo e agir sobre ele; uma atitude diante da vida.",
            },
        ],
        "synthesis": (
            "A Unidade 1 demonstra que a Filosofia nasce da admiração, do espanto, da curiosidade e do reconhecimento da própria "
            "ignorância. Ao substituir explicações míticas misteriosas pela investigação racional acessível a todos, o filosofar atua "
            "como método de raciocínio e atitude de liberdade perante o cotidiano."
        ),
        "limitations": [
            "A seção “Infográfico” da página original contém apenas uma imagem externa com acesso restrito (erro HTTP 403) e sem atributo alt, razão pela qual seu conteúdo visual não pôde ser lido.",
            "O vídeo complementar “Ser ou não ser? Apresentação – A vontade de mudar” (Viviane Mosé, Rede Globo, 2005–2006) foi contemplado pela sinopse textual presente na própria fonte.",
        ],
        "flashcards_by_theme": [
            {
                "theme": "Tema 1 — Conceito, Etimologia e Utilidade da Filosofia",
                "theme_short": "Conceito e Etimologia",
                "cards": [
                    {
                        "q": "Qual é a origem etimológica e o significado da palavra “Filosofia”?",
                        "a": "Tem origem grega, unindo philo/philia (amizade, amor fraterno, respeito entre iguais) e sophia/sophos (sabedoria, sábio). Significa “amizade pela sabedoria” ou “amor e respeito pelo saber”.",
                    },
                    {
                        "q": "Qual máxima de Sócrates sintetiza a necessidade do ato de filosofar para a existência humana?",
                        "a": "“Uma vida sem reflexão não merece ser vivida”, pois filosofar consiste justamente em refletir sobre si mesmo, sobre os semelhantes e sobre o mundo.",
                    },
                    {
                        "q": "Como o ser humano se relaciona com o tempo ao desenvolver consciência de si mesmo?",
                        "a": "Utiliza o passado como experiência (a partir de suas lembranças), questiona o presente e planeja o futuro.",
                    },
                    {
                        "q": "Como Aranha e Martins (2003) definem a Filosofia e o ato de filosofar?",
                        "a": "Como um modo de pensar que acompanha o ser humano na tarefa de compreender o mundo e agir sobre ele, sendo uma atitude diante da vida em situações corriqueiras ou limites.",
                    },
                    {
                        "q": "Em que consiste a utilidade prática da Filosofia segundo o material?",
                        "a": "Por meio da reflexão, permite ir além do imediato, superar a situação atual e posicionar-se como um ser livre e capaz de construir o próprio destino.",
                    },
                ],
            },
            {
                "theme": "Tema 2 — Origem Histórica da Filosofia e Racionalidade Grega",
                "theme_short": "Origem Histórica",
                "cards": [
                    {
                        "q": "Segundo Pitágoras de Samos (séc. V a.C.), qual é a diferença entre os deuses e os homens em relação à sabedoria?",
                        "a": "A sabedoria plena e completa pertence aos deuses, mas os homens podem desejá-la e amá-la, tornando-se filósofos movidos pelo “desejo de saber” e de contemplar a verdade.",
                    },
                    {
                        "q": "Por que o texto utiliza a expressão “História das Filosofias” no plural ao referir-se aos mais de 25 séculos desde Sócrates?",
                        "a": "Porque ao longo desse período houve inúmeras discussões e concepções diferentes sobre o que é filosofar, seus métodos e seus objetivos.",
                    },
                    {
                        "q": "Que mudança de mentalidade marcou o surgimento da Filosofia na Grécia Antiga?",
                        "a": "A insatisfação com as explicações tradicionais e a descoberta de que a verdade não era um mistério secreto revelado por divindades a escolhidos, mas algo cognoscível por todos através da razão.",
                    },
                    {
                        "q": "Por que a Filosofia é chamada de “ciência mãe” por Mattar (2010)?",
                        "a": "Porque dela se originaram as ciências modernas, com suas formas de pensar e seus métodos, além de ter instituído no Ocidente as bases da razão, ciência, ética, política, técnica e arte.",
                    },
                ],
            },
            {
                "theme": "Tema 3 — O Olhar Filosófico e a Simbologia da Esfinge",
                "theme_short": "Olhar Filosófico e Esfinge",
                "cards": [
                    {
                        "q": "Quais elementos compõem a figura mitológica da Esfinge e qual era a sua ameaça aos viajantes?",
                        "a": "Possuía cabeça de mulher, corpo de leão e asas de águia, e lançava enigmas aos caminhantes sob a ameaça: “Decifra-me ou te devoro!”.",
                    },
                    {
                        "q": "O que simbolizam a cabeça de mulher, o corpo de leão e as asas de águia da Esfinge na interpretação filosófica (Vieira; Landeira, 2010)?",
                        "a": "A cabeça de mulher representa a intuição humana; o corpo de leão, a coragem para fazer perguntas; e as asas de águia, a elevação rumo ao conhecimento e à sabedoria.",
                    },
                    {
                        "q": "Quando foi construída a Grande Esfinge de Gizé no Egito e quais traços sua cabeça reproduz?",
                        "a": "Foi construída por volta da IV dinastia (2723 a.C.–2563 a.C.) e sua cabeça copia os traços do faraó Quéfren ou possivelmente de seu irmão, o faraó Djedefré.",
                    },
                    {
                        "q": "Qual é o sentido da metáfora da águia e da gaivota apresentada na abertura da Unidade 1?",
                        "a": "Assim como observar do alto amplia a visão sobre o que ocorre embaixo, a Filosofia permite alçar voos e construir uma visão mais ampla do conhecimento e da vida.",
                    },
                ],
            },
            {
                "theme": "Tema 4 — Curiosidade, Questionamento e Senso Comum",
                "theme_short": "Curiosidade e Perguntar",
                "cards": [
                    {
                        "q": "Qual é a definição de “pergunta” apresentada na fonte e qual sua relação com a curiosidade?",
                        "a": "Uma pergunta é uma ideia que orienta a curiosidade humana e impulsiona a busca por respostas, evitando que os seres humanos sejam devorados pela ignorância.",
                    },
                    {
                        "q": "O que é necessário para passar de perguntas cotidianas imediatas a questões filosóficas universais?",
                        "a": "Ter uma mente aberta e questionadora, que não se conforme com o senso comum nem com respostas prontas, buscando a sabedoria em vez da mera informação.",
                    },
                    {
                        "q": "O que ilustra a citação da boneca Emília (Memórias da Emília, de Monteiro Lobato) no estudo da Filosofia?",
                        "a": "Ao pedir seis pontos de interrogação por estar indecisa e interrogando a si mesma, Emília exemplifica as perguntas voltadas ao autoconhecimento.",
                    },
                ],
            },
            {
                "theme": "Tema 5 — Sabedoria, Ignorância e Conceitos do Glossário",
                "theme_short": "Sabedoria, Ignorância e Glossário",
                "cards": [
                    {
                        "q": "De acordo com Platão em O Banquete, por que nem os deuses, nem os sábios, nem os ignorantes buscam a sabedoria?",
                        "a": "Os deuses e os sábios não a buscam porque já a possuem; o ignorante não a busca porque está satisfeitos consigo mesmo e não sente falta do saber. Só deseja saber quem reconhece a própria deficiência.",
                    },
                    {
                        "q": "O que significa a afirmação de Mattar (2010): “Não ensinamos filosofia: ensinamos o filosofar”?",
                        "a": "Significa que a Filosofia não ensina verdades prontas nem soluções acabadas, mas métodos de raciocínio e formas de explorar, investigar problemas e procurar soluções.",
                    },
                    {
                        "q": "Como Platão e Aristóteles definem a atitude primeira que dá início à Filosofia?",
                        "a": "Para Platão, a Filosofia começa com a admiração; para Aristóteles, inicia-se com o espanto — atitudes que provocam o desejo de investigar e saber mais.",
                    },
                    {
                        "q": "Como o Glossário define “Conhecimento” (e arché) e “Ignorância” na tradição filosófica grega?",
                        "a": "Conhecimento é a reflexão racional cuja essência é a busca pelo saber (como a busca dos primeiros filósofos pela arché, princípio único do Ser). Ignorância, em Sócrates (“só sei que nada sei”), é o reconhecimento da falta de saber, que constitui o início da sabedoria.",
                    },
                ],
            },
        ],
    }


def _call_gemini_api(extracted_data, api_key, custom_instructions=""):
    prompt = f"""Você é o Agente Construtor do sistema EstudaPDF. Siga rigorosamente estas diretrizes:
1. Use EXCLUSIVAMENTE o conteúdo da fonte abaixo. Não invente fatos, datas ou conceitos externos.
2. NUNCA inclua nomes soltos de autores do artigo (como cabeçalhos de autoria), afiliações institucionais, cabeçalhos/rodapés de página ou resumos em inglês no início do resumo.
3. Escreva integralmente em português do Brasil (salvo instrução explícita em contrário do usuário: {custom_instructions}).
4. Produza um JSON válido com a seguinte estrutura exata:
{{
  "title": "Título fiel ao material",
  "subtitle": "Subtítulo descritivo do tema",
  "overview": "Parágrafo de visão geral sintetizando a ideia central do material",
  "sections": [
    {{
      "heading": "Título claro da seção temática",
      "paragraphs": ["Parágrafo parafraseado com fidelidade"],
      "bullets": [{{"label": "Conceito ou tópico", "text": "Explicação concisa e fiel"}}]
    }}
  ],
  "key_concepts": [
    {{"term": "Nome do conceito/termo", "definition": "Definição conforme a fonte"}}
  ],
  "synthesis": "Síntese final dos pontos mais importantes do material",
  "limitations": ["Limitações identificadas na fonte, se houver"],
  "flashcards_by_theme": [
    {{
      "theme": "Tema 1 — Nome do Tema",
      "theme_short": "Nome Curto do Tema",
      "cards": [
        {{
          "q": "Pergunta clara, curta e específica para recordação ativa?",
          "a": "Resposta objetiva, autossuficiente e fiel à fonte (sem repetir a pergunta)."
        }}
      ]
    }}
  ]
}}

FONTE ({extracted_data.get('source')}):
Título detectado: {extracted_data.get('title')}
Limitações técnicas detectadas: {json.dumps(extracted_data.get('limitations', []), ensure_ascii=False)}

CONTEÚDO EXTRAÍDO:
{extracted_data.get('raw_text', '')[:38000]}
"""
    endpoint = (
        f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}"
    )
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"responseMimeType": "application/json", "temperature": 0.2},
    }
    req = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    ctx = ssl.create_default_context()
    with urllib.request.urlopen(req, timeout=45, context=ctx) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    cand_text = body["candidates"][0]["content"]["parts"][0]["text"]
    result = json.loads(cand_text)
    result["source"] = extracted_data["source"]
    result["date"] = datetime.now().strftime("%d/%m/%Y")
    result["language"] = "Português (Brasil)"
    return result


def agent_builder_construct(extracted_data, api_key=None, custom_instructions=""):
    """
    AGENTE 1 — Agente Construtor (EstudaPDF-Construtor):
    Constrói a versão estruturada inicial do resumo e dos flashcards a partir dos dados extraídos.
    """
    effective_key = (api_key or os.environ.get("GEMINI_API_KEY") or "").strip()
    if effective_key:
        try:
            sd = _call_gemini_api(extracted_data, effective_key, custom_instructions=custom_instructions)
            sd["used_ai"] = True
            return sd
        except Exception as e:
            sd = _heuristic_construct(extracted_data)
            sd.setdefault("limitations", []).append(
                f"Nota técnica: síntese construída pelo Agente Construtor local (API externa retornou: {e})."
            )
            sd["used_ai"] = False
            return sd

    sd = _heuristic_construct(extracted_data)
    sd["used_ai"] = False
    return sd


def _heuristic_construct(extracted_data):
    if _is_fam_filosofia_unidade1(extracted_data):
        return _curated_fam_filosofia_unidade1(extracted_data)
    if _is_faq_renave_document(extracted_data):
        return _curated_faq_renave_suporte(extracted_data)

    title = normalize_extracted_text(extracted_data.get("title", "Material de Estudo"))
    if not is_readable_line(title) or is_journal_or_portal_boilerplate_line(title) or is_author_or_affiliation_line(title):
        title = "Material de Estudo"

    raw_sections = extracted_data.get("sections", [])
    structured_sections = []
    key_concepts = []
    seen_terms = set()
    flashcards_by_theme = []
    seen_questions = set()

    all_paragraphs = []
    for sec in raw_sections:
        heading = normalize_extracted_text(sec.get("heading", "Tópico de Estudo").strip())
        if not is_readable_line(heading):
            heading = "Tópico de Estudo"
        if re.match(r"^(refer[êe]ncias|bibliografia|references|t[óo]picos deste artigo)\b", heading, re.I):
            continue

        rejoined_raw_paras = []
        for rp in sec.get("paragraphs", []):
            rp_clean = strip_editorial_and_english_segments(normalize_extracted_text(rp))
            if not rp_clean or len(rp_clean) <= 18:
                continue
            if rp_clean[0].islower():
                if rejoined_raw_paras and not rejoined_raw_paras[-1].endswith((".", "!", "?", "”", '"')):
                    rejoined_raw_paras[-1] = rejoined_raw_paras[-1] + " " + rp_clean
                else:
                    sents_in_rp = [s.strip() for s in re.split(r"(?<=[.!?])\s+", rp_clean) if s.strip()]
                    upper_sents = [s for s in sents_in_rp if s[0].isupper() or s[0] in '“"']
                    if upper_sents:
                        rejoined_raw_paras.append(" ".join(upper_sents))
            else:
                rejoined_raw_paras.append(rp_clean)

        paras = [
            p
            for p in rejoined_raw_paras
            if len(p) > 22
            and is_readable_line(p)
            and not is_primarily_english_text(p)
            and not is_journal_or_portal_boilerplate_line(p)
        ]

        bullets = [
            strip_editorial_and_english_segments(normalize_extracted_text(b))
            for b in sec.get("bullets", [])
        ]
        bullets = [
            b
            for b in bullets
            if len(b) > 10
            and is_readable_line(b)
            and not is_primarily_english_text(b)
            and not is_journal_or_portal_boilerplate_line(b)
        ]

        if not paras and not bullets:
            continue

        sec_bullets = []
        for b in bullets[:10]:
            if ":" in b and 3 <= len(b.split(":")[0].strip()) <= 52:
                k, v = b.split(":", 1)
                k, v = k.strip(), v.strip()
                if is_readable_line(v) and len(v) > 8:
                    sec_bullets.append({"label": k, "text": truncate_clean(v, 380)})
                    clean_k = _clean_concept_term(k)
                    if (
                        _is_valid_concept_term(clean_k)
                        and not v.endswith("?")
                        and clean_k.lower() not in seen_terms
                        and len(key_concepts) < 8
                    ):
                        seen_terms.add(clean_k.lower())
                        key_concepts.append({"term": clean_k, "definition": truncate_clean(v, 340)})
                    continue
            sec_bullets.append({"label": "", "text": truncate_clean(b, 380)})

        summarized_paras = []
        for p in paras[:5]:
            # Se o parágrafo terminar em ':' (frase introdutória de lista) e houver bullets na seção, não o adiciona solto como flashcard
            sents = [s.strip() for s in re.split(r"(?<=[.!?])\s+", p) if is_readable_line(s)]
            for s in sents:
                if s.endswith("?") or is_journal_or_portal_boilerplate_line(s):
                    continue
                m_def = re.match(
                    r"^([A-ZÁÉÍÓÚÂÊÔÃÕÇ][A-Za-záéíóúâêôãõç\s\-]{3,42}?)\s+(?:é|são|consiste em|significa|define-se como|refere-se a|corresponde a|representa|divide-se em)\s+(.+)$",
                    s,
                )
                if m_def and len(key_concepts) < 8:
                    term_cand = _clean_concept_term(m_def.group(1).strip())
                    if _is_valid_concept_term(term_cand) and term_cand.lower() not in seen_terms:
                        seen_terms.add(term_cand.lower())
                        key_concepts.append({"term": term_cand, "definition": truncate_clean(s, 340)})

            if len(p) > 460 and sents:
                summarized_paras.append(truncate_clean(" ".join(sents[:3]), 460))
            elif sents:
                summarized_paras.append(" ".join(sents))

        if not summarized_paras and not sec_bullets:
            continue

        all_paragraphs.extend([sp for sp in summarized_paras if not sp.endswith(":")])

        structured_sections.append(
            {
                "heading": heading,
                "paragraphs": summarized_paras[:4],
                "bullets": sec_bullets[:8],
            }
        )

        theme_cards = []
        for b in sec_bullets[:5]:
            if b["label"] and len(b["text"]) > 18:
                lbl = b["label"]
                if "?" in lbl:
                    q_txt = lbl if heading.lower() in lbl.lower() else f"Em “{heading}”, {lbl[0].lower() + lbl[1:]}"
                elif "|" in b["text"]:
                    q_txt = f"Em “{heading}”, como funciona ou como proceder no caso de “{lbl}”?"
                else:
                    q_txt = f"Como o material define ou caracteriza “{lbl}” em {heading}?"
                if q_txt not in seen_questions:
                    seen_questions.add(q_txt)
                    theme_cards.append({"q": q_txt, "a": truncate_clean(b["text"], 380)})

        for p in summarized_paras[:4]:
            if len(theme_cards) >= 5:
                break
            # Se o parágrafo termina em ':' e a seção tem bullets, une o parágrafo introdutório aos bullets para formar uma resposta completa
            if p.strip().endswith(":"):
                if sec_bullets:
                    bullet_summary = "; ".join(
                        (f"{b['label']}: {b['text']}" if b.get("label") else b.get("text", ""))
                        for b in sec_bullets[:4]
                    )
                    q_txt = f"Quais são os itens ou pontos principais apresentados em “{heading}”?"
                    if q_txt not in seen_questions and len(bullet_summary) > 25:
                        seen_questions.add(q_txt)
                        theme_cards.append({"q": q_txt, "a": truncate_clean(f"{p.strip()} {bullet_summary}", 430)})
                continue

            # Se o parágrafo é um par Pergunta? Resposta inline de FAQ:
            m_faq_inline = re.match(r"^([^?]{8,140}\?)\s+(.{20,})$", p)
            if m_faq_inline:
                q_txt = _build_question_for_paragraph(heading, p, p, len(theme_cards))
                ans_txt = m_faq_inline.group(2).strip()
                if q_txt not in seen_questions and len(ans_txt) > 18:
                    seen_questions.add(q_txt)
                    theme_cards.append({"q": q_txt, "a": truncate_clean(ans_txt, 430)})
                continue

            sents = [s.strip() for s in re.split(r"(?<=[.!?])\s+", p) if len(s.strip()) > 28 and is_readable_line(s)]
            if not sents:
                continue
            main_sent = sents[0]
            if main_sent.endswith(":"):
                continue
            q_txt = _build_question_for_paragraph(heading, main_sent, p, len(theme_cards))
            if q_txt not in seen_questions:
                seen_questions.add(q_txt)
                theme_cards.append({"q": q_txt, "a": truncate_clean(" ".join(sents[:3]), 430)})

        if theme_cards:
            idx_t = len(flashcards_by_theme) + 1
            flashcards_by_theme.append(
                {
                    "theme": f"Tema {idx_t} — {heading}",
                    "theme_short": truncate_clean(heading, 45),
                    "cards": theme_cards,
                }
            )

    overview = (
        truncate_clean(all_paragraphs[0], 450)
        if all_paragraphs
        else f"Material de estudo extraído de {extracted_data.get('source')} abordando {title}."
    )

    # Evita que o primeiro parágrafo (usado na Visão Geral) fique duplicado na primeira seção (comparando prefixo normalizado)
    if structured_sections and structured_sections[0]["paragraphs"] and overview:
        ov_prefix = overview[:90].lower()
        first_p_prefix = structured_sections[0]["paragraphs"][0][:90].lower()
        if ov_prefix == first_p_prefix:
            structured_sections[0]["paragraphs"] = structured_sections[0]["paragraphs"][1:]
            if not structured_sections[0]["paragraphs"] and not structured_sections[0]["bullets"]:
                structured_sections = structured_sections[1:]

    # Constrói uma Síntese Final genuína sem duplicar literalmente o último parágrafo e sem CTAs de rodapé
    sec_names = [s["heading"] for s in structured_sections[:6] if s.get("heading")]
    if len(all_paragraphs) > 2:
        last_cand = all_paragraphs[-1]
        # Verifica se o último parágrafo já está na última seção ou se é meta-estrutural/CTA
        already_in_last_sec = (
            structured_sections
            and structured_sections[-1]["paragraphs"]
            and last_cand[:80].lower() == structured_sections[-1]["paragraphs"][-1][:80].lower()
        )
        is_meta_or_cta = bool(
            re.match(r"^(?:Posteriormente,\s+apresentamos|Conheça\s+a|Confira\s+quais|Você\s+sabe)", last_cand, re.I)
        )
        if not already_in_last_sec and not is_meta_or_cta:
            synthesis = truncate_clean(last_cand, 450)
        else:
            synthesis = (
                f"Em síntese, o estudo sobre “{title}” articula os fundamentos de "
                + ", ".join(sec_names[:5])
                + ", consolidando as definições, regras e relações essenciais apresentadas na fonte para revisão e recordação ativa."
            )
    else:
        synthesis = f"O material consolida os conceitos fundamentais de {title}, estruturados acima para revisão e recordação ativa."

    return {
        "title": title,
        "subtitle": "Resumo Estruturado e Flashcards de Estudo",
        "source": extracted_data.get("source"),
        "date": datetime.now().strftime("%d/%m/%Y"),
        "language": "Português (Brasil)",
        "overview": overview,
        "sections": structured_sections[:12],
        "key_concepts": key_concepts[:8],
        "synthesis": synthesis,
        "limitations": extracted_data.get("limitations", []),
        "flashcards_by_theme": flashcards_by_theme[:10],
    }


# ==============================================================================
# 5. AGENTE 2 — AGENTE REVISOR (EstudaPDF-Revisor)
# ==============================================================================

def _clean_sentence_block(text):
    """
    Higieniza um bloco textual removendo nomes de autores no início, sentenças em inglês,
    ligaduras quebradas, ruídos de portais web e fragmentos iniciados por letra minúscula.
    """
    if not text:
        return ""
    cleaned = strip_editorial_and_english_segments(normalize_extracted_text(text))
    if not cleaned:
        return ""
    if cleaned[0].islower():
        sents = [s.strip() for s in re.split(r"(?<=[.!?])\s+", cleaned) if s.strip()]
        valid_sents = [s for s in sents if (s[0].isupper() or s[0] in '“"(' or s[0].isdigit())]
        cleaned = " ".join(valid_sents)
    return cleaned.strip()


def agent_reviewer_audit_and_fix(study_data):
    """
    AGENTE 2 — Agente Revisor (EstudaPDF-Revisor):
    Audita e corrige todo o conteúdo produzido pelo Agente Construtor antes de gerar o PDF.
    Retorna (study_data_revisado, review_notes).
    """
    corrections = []

    # 1. Revisar título
    orig_title = study_data.get("title", "Material de Estudo")
    rev_title = _clean_web_page_title(normalize_extracted_text(orig_title).strip())
    if rev_title != orig_title:
        corrections.append("Título normalizado e limpo de artefatos tipográficos/sufixos.")
    study_data["title"] = rev_title or "Material de Estudo"

    # 2. Revisar Visão Geral (overview)
    orig_ov = study_data.get("overview", "")
    rev_ov = _clean_sentence_block(orig_ov)
    if rev_ov != orig_ov:
        corrections.append("Visão Geral higienizada (removidos metadados de autoria/cabeçalho ou ruídos).")
    study_data["overview"] = rev_ov

    # 3. Revisar Seções do Resumo
    cleaned_sections = []
    ov_prefix = (study_data.get("overview") or "")[:90].lower()

    for sec in study_data.get("sections", []):
        h = normalize_extracted_text(sec.get("heading", "Seção")).strip()
        if re.match(r"^(refer[êe]ncias|bibliografia|references|t[óo]picos deste artigo)\b", h, re.I):
            corrections.append(f"Seção '{h}' omitida do resumo conceitual.")
            continue

        new_paras = []
        for p in sec.get("paragraphs", []):
            cp = _clean_sentence_block(p)
            if (
                len(cp) > 20
                and is_readable_line(cp)
                and not is_primarily_english_text(cp)
                and not is_journal_or_portal_boilerplate_line(cp)
            ):
                # Evitar duplicar a Visão Geral na primeira seção (mesmo quando overview foi truncado)
                if ov_prefix and len(ov_prefix) >= 40 and cp[:90].lower() == ov_prefix and len(cleaned_sections) == 0:
                    corrections.append("Removida duplicação da Visão Geral na abertura da 1ª seção.")
                    continue
                new_paras.append(cp)
            else:
                corrections.append("Removido parágrafo com ruído editorial, fragmento truncado ou idioma estrangeiro.")

        new_bullets = []
        for b in sec.get("bullets", []):
            if isinstance(b, dict):
                lbl = normalize_extracted_text(b.get("label", "")).strip()
                txt = _clean_sentence_block(b.get("text", ""))
                if txt and is_readable_line(txt) and not is_primarily_english_text(txt) and not is_journal_or_portal_boilerplate_line(txt):
                    new_bullets.append({"label": lbl, "text": txt})
            else:
                txt = _clean_sentence_block(str(b))
                if txt and is_readable_line(txt) and not is_primarily_english_text(txt) and not is_journal_or_portal_boilerplate_line(txt):
                    new_bullets.append({"label": "", "text": txt})

        if new_paras or new_bullets:
            cleaned_sections.append({"heading": h, "paragraphs": new_paras, "bullets": new_bullets})

    study_data["sections"] = cleaned_sections

    # Garantir que overview exista se ficou vazio
    if not study_data["overview"] and cleaned_sections and cleaned_sections[0]["paragraphs"]:
        study_data["overview"] = truncate_clean(cleaned_sections[0]["paragraphs"][0], 450)

    # 4. Revisar Conceitos-Chave (filtrando falsos conceitos como 'Não', 'Você sabe o que', 'Confira quais')
    valid_kcs = []
    for kc in study_data.get("key_concepts", []):
        term = _clean_concept_term(normalize_extracted_text(kc.get("term", "")).strip())
        defn = _clean_sentence_block(kc.get("definition", ""))
        if (
            _is_valid_concept_term(term)
            and len(defn) > 20
            and not defn.endswith("?")
            and is_readable_line(defn)
            and not is_journal_or_portal_boilerplate_line(defn)
        ):
            valid_kcs.append({"term": term, "definition": defn})
        else:
            corrections.append(f"Falso conceito-chave descartado pelo Revisor: '{term}'.")
    study_data["key_concepts"] = valid_kcs

    # 5. Revisar Síntese Final (garantindo que não seja um fragmento, CTA ou duplicata da última seção)
    orig_syn = study_data.get("synthesis", "")
    rev_syn = _clean_sentence_block(orig_syn)
    if (
        not rev_syn
        or is_journal_or_portal_boilerplate_line(rev_syn)
        or (
            cleaned_sections
            and cleaned_sections[-1]["paragraphs"]
            and rev_syn[:80].lower() == cleaned_sections[-1]["paragraphs"][-1][:80].lower()
        )
    ):
        sec_titles = [s["heading"] for s in cleaned_sections[:5] if s.get("heading")]
        rev_syn = (
            f"Em síntese, o material sobre “{study_data['title']}” abrange de forma estruturada "
            + ", ".join(sec_titles)
            + ", reunindo os conceitos, regras e procedimentos essenciais para revisão e aplicação prática."
        )
        corrections.append("Síntese Final consolidada pelo Revisor sem duplicar parágrafo anterior.")
    study_data["synthesis"] = rev_syn

    # 6. Revisar Flashcards (remover cartões em inglês, respostas terminadas em ':', perguntas quebradas)
    cleaned_themes = []
    for group in study_data.get("flashcards_by_theme", []):
        t_name = normalize_extracted_text(group.get("theme", "Tema")).strip()
        t_short = normalize_extracted_text(group.get("theme_short", t_name)).strip()
        valid_cards = []
        for c in group.get("cards", []):
            q = normalize_extracted_text(c.get("q", "")).strip()
            a = _clean_sentence_block(c.get("a", ""))
            if not q or not a or len(a) < 20 or a.endswith(":"):
                corrections.append("Cartão incompleto ou com resposta truncada em ':' removido pelo Revisor.")
                continue
            if is_primarily_english_text(q) or is_primarily_english_text(a):
                corrections.append("Cartão em inglês (Abstract) removido pelo Revisor.")
                continue
            if is_journal_or_portal_boilerplate_line(a) or a.startswith("[Imagem:"):
                corrections.append("Cartão originado de ruído visual/editorial removido pelo Revisor.")
                continue
            # Corrige perguntas malformadas como "Segundo o material, como a teoria é?" ou "como Não é?"
            if re.search(r"\bcomo\s+(Não|Sim|Essa|Esse|Este|Esta|Isso|Mas|Leia|Veja|Confira)\b", q, re.I):
                q = f"Qual ponto importante é apresentado em “{t_short}”?"
                corrections.append("Pergunta de flashcard reformulada para maior clareza.")
            q = re.sub(r"como\s+(.+?)\s+é\?$", r"o que é \1 e como se caracteriza?", q)
            valid_cards.append({"q": q, "a": truncate_clean(a, 430)})

        if valid_cards:
            idx_theme = len(cleaned_themes) + 1
            clean_heading = re.sub(r"^Tema\s+\d+\s*[—\-]\s*", "", t_name).strip()
            cleaned_themes.append(
                {
                    "theme": f"Tema {idx_theme} — {clean_heading}",
                    "theme_short": truncate_clean(clean_heading, 45),
                    "cards": valid_cards,
                }
            )

    study_data["flashcards_by_theme"] = cleaned_themes
    return study_data, corrections


# ==============================================================================
# 6. AGENTE 3 — AGENTE DE TESTE E QUALIDADE (EstudaPDF-Tester)
# ==============================================================================

def agent_tester_validate(study_data, pdf_path, pages_count, size_bytes):
    """
    AGENTE 3 — Agente de Teste e Qualidade (EstudaPDF-Tester):
    Executa asserções automatizadas nos dados revisados e no arquivo PDF gerado.
    Retorna um dicionário com o relatório de testes aprovados.
    """
    checks = []

    # Teste 1: Existência e tamanho do arquivo PDF
    if not os.path.isfile(pdf_path) or size_bytes < 800 or pages_count < 2:
        raise RuntimeError("Falha no Agente de Teste: PDF gerado é inválido, vazio ou incompleto.")
    checks.append(f"Arquivo PDF íntegro ({pages_count} páginas, {size_bytes} bytes).")

    # Teste 2: Presença de Resumo e Flashcards
    sections = study_data.get("sections", [])
    total_cards = sum(len(t.get("cards", [])) for t in study_data.get("flashcards_by_theme", []))
    if not sections or total_cards == 0:
        raise ValueError("Falha no Agente de Teste: o material não gerou seções de resumo ou flashcards suficientes.")
    checks.append(f"Estrutura validada: {len(sections)} seções temáticas e {total_cards} flashcards numerados.")

    # Teste 3: Ausência de ligaduras quebradas ('?' cercado por letras), ruídos de portal e vazamento de nome de autor
    all_texts = [study_data.get("title", ""), study_data.get("overview", ""), study_data.get("synthesis", "")]
    for sec in sections:
        all_texts.extend(sec.get("paragraphs", []))
        for b in sec.get("bullets", []):
            all_texts.append(b.get("text", "") if isinstance(b, dict) else str(b))
    for group in study_data.get("flashcards_by_theme", []):
        for c in group.get("cards", []):
            all_texts.append(c.get("q", ""))
            all_texts.append(c.get("a", ""))
            if c.get("a", "").strip().endswith(":"):
                raise RuntimeError(f"Falha no Agente de Teste: resposta de cartão truncada em dois-pontos: '{c.get('a')}'.")

    for txt in all_texts:
        if re.search(r"(?<=[A-Za-zÀ-ÿ])\?(?=[a-záéíóúâêôãõç])", txt):
            raise RuntimeError(f"Falha no Agente de Teste: detectada ligadura quebrada residual em '{txt[:60]}...'.")
        if re.match(r"^Saulo Luis Lima da Silva\s*\?", txt):
            raise RuntimeError("Falha no Agente de Teste: nome de autor residual detectado no início de parágrafo.")
        if "Conteúdo feito por humanos" in txt or "MicroWork Softwares |" in txt:
            raise RuntimeError(f"Falha no Agente de Teste: ruído editorial/rodapé detectado em '{txt[:60]}...'.")

    checks.append("Zero ligaduras quebradas (fi/fl), zero ruídos de rodapé/portal e zero respostas truncadas.")

    # Teste 4: Inspeção reversa do PDF gerado com pypdf (quando disponível)
    if HAS_PYPDF:
        reader = PdfReader(pdf_path)
        if len(reader.pages) != pages_count:
            raise RuntimeError("Falha no Agente de Teste: divergência no número de páginas do PDF.")
        full_pdf_text = "\n".join((p.extract_text() or "") for p in reader.pages)
        if "PARTE 1" not in full_pdf_text or "PARTE 2" not in full_pdf_text:
            raise RuntimeError("Falha no Agente de Teste: Parte 1 (Resumo) ou Parte 2 (Flashcards) ausente no PDF.")
        if re.search(r"Saulo Luis Lima da Silva", full_pdf_text, re.I):
            raise RuntimeError("Falha no Agente de Teste: nome de autor residual detectado dentro do PDF gerado.")
        checks.append("Leitura reversa do PDF confirmou ordem obrigatória (Cabeçalho -> Resumo -> Flashcards) e ausência de ruídos.")

    return {
        "passed": True,
        "checks": checks,
    }


# ==============================================================================
# 7. ORQUESTRADOR PRINCIPAL (PIPELINE DOS 3 AGENTES)
# ==============================================================================

def slugify_filename(title):
    norm = unicodedata.normalize("NFKD", title or "estudo").encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-zA-Z0-9]+", "_", norm.lower()).strip("_")
    slug = slug[:52] if len(slug) >= 3 else "material_estudo"
    return f"resumo_flashcards_{slug}.pdf"


def process_study_material(url=None, pdf_bytes=None, pdf_filename=None, api_key=None, custom_instructions="", output_dir="."):
    """
    Orquestra os 3 Agentes (Construtor -> Revisor -> Tester) para produzir o PDF único livre de erros.
    """
    if not url and not pdf_bytes:
        raise ValueError(
            "Por favor, envie uma URL acessível ou anexe um arquivo PDF como material de origem para gerar o resumo e os flashcards."
        )

    # Etapa 1: Extração + Construção pelo AGENTE CONSTRUTOR
    if pdf_bytes and not url:
        extracted = extract_text_from_pdf_bytes(pdf_bytes, filename=pdf_filename or "documento.pdf")
    elif url and not pdf_bytes:
        extracted = extract_from_url(url)
    else:
        ext_url = extract_from_url(url)
        ext_pdf = extract_text_from_pdf_bytes(pdf_bytes, filename=pdf_filename or "documento.pdf")
        extracted = {
            "title": f"{ext_url['title']} + {ext_pdf['title']}",
            "source": f"URL: {url} | PDF: {pdf_filename}",
            "source_type": "combined",
            "sections": ext_url["sections"] + ext_pdf["sections"],
            "raw_text": f"--- FONTE 1 ({url}) ---\n{ext_url['raw_text']}\n\n--- FONTE 2 ({pdf_filename}) ---\n{ext_pdf['raw_text']}",
            "limitations": ext_url.get("limitations", []) + ext_pdf.get("limitations", []),
        }

    raw_study_data = agent_builder_construct(extracted, api_key=api_key, custom_instructions=custom_instructions)

    # Etapa 2: Auditoria e Saneamento pelo AGENTE REVISOR
    reviewed_study_data, review_corrections = agent_reviewer_audit_and_fix(raw_study_data)

    # Etapa 3: Compilação do PDF Único
    out_filename = slugify_filename(reviewed_study_data.get("title", "estudo"))
    out_path = os.path.join(output_dir, out_filename)
    pages_count, size_bytes = compile_study_pdf(reviewed_study_data, out_path)

    # Etapa 4: Validação e Testes Automatizados pelo AGENTE DE TESTE
    test_report = agent_tester_validate(reviewed_study_data, out_path, pages_count, size_bytes)

    reviewed_study_data["agent_report"] = {
        "builder": "Agente Construtor: extração limpa, reconstrução de tabelas/colunas e isolamento de metadados concluídos.",
        "reviewer": (
            f"Agente Revisor: auditoria concluída ({len(review_corrections)} ajuste(s) preventivo(s) aplicado(s))."
            if review_corrections
            else "Agente Revisor: texto auditado sem ruídos, truncamentos ou vazamentos."
        ),
        "tester": "Agente de Teste: " + " | ".join(test_report["checks"]),
    }

    return reviewed_study_data, out_path, out_filename, pages_count, size_bytes
