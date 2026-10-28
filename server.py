# -*- coding: utf-8 -*-
"""
Servidor HTTP do EstudaPDF — Interface de Chat IA para Resumos e Flashcards em PDF.
"""

import base64
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
import re
import urllib.parse

from pdf_engine import process_study_material

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
OUTPUT_DIR = BASE_DIR  # Salva os PDFs na pasta do projeto para fácil acesso


def list_generated_pdfs():
    items = []
    for fname in os.listdir(OUTPUT_DIR):
        if fname.lower().endswith(".pdf"):
            fpath = os.path.join(OUTPUT_DIR, fname)
            if os.path.isfile(fpath):
                st = os.stat(fpath)
                items.append(
                    {
                        "filename": fname,
                        "url": f"/files/{urllib.parse.quote(fname)}",
                        "download_url": f"/files/{urllib.parse.quote(fname)}?download=1",
                        "size_bytes": st.st_size,
                        "modified": datetime.fromtimestamp(st.st_mtime).strftime("%d/%m/%Y %H:%M"),
                        "mtime": st.st_mtime,
                    }
                )
    items.sort(key=lambda x: x["mtime"], reverse=True)
    return items


class EstudaPDFHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        # Log conciso no terminal
        print(f"[EstudaPDF] {self.address_string()} - {fmt % args}")

    def _send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _serve_file(self, filepath, content_type=None, as_download=False, download_name=None):
        if not os.path.isfile(filepath):
            self.send_error(404, "Arquivo não encontrado")
            return
        with open(filepath, "rb") as f:
            data = f.read()
        if not content_type:
            content_type, _ = mimetypes.guess_type(filepath)
            content_type = content_type or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        if as_download:
            dname = download_name or os.path.basename(filepath)
            self.send_header("Content-Disposition", f'attachment; filename="{dname}"')
        else:
            self.send_header("Content-Disposition", "inline")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = urllib.parse.unquote(parsed.path)
        query = urllib.parse.parse_qs(parsed.query)

        if path in ("/", "/index.html", "/static/", "/static/index.html"):
            return self._serve_file(os.path.join(STATIC_DIR, "index.html"), "text/html; charset=utf-8")
        if path in ("/styles.css", "/static/styles.css"):
            return self._serve_file(os.path.join(STATIC_DIR, "styles.css"), "text/css; charset=utf-8")
        if path in ("/app.js", "/static/app.js"):
            return self._serve_file(os.path.join(STATIC_DIR, "app.js"), "application/javascript; charset=utf-8")
        if path == "/api/history":
            return self._send_json({"ok": True, "files": list_generated_pdfs()})
        if path.startswith("/files/"):
            fname = os.path.basename(path[len("/files/") :])
            if not fname.lower().endswith(".pdf"):
                self.send_error(403, "Apenas arquivos PDF são permitidos")
                return
            fpath = os.path.join(OUTPUT_DIR, fname)
            is_dl = query.get("download", ["0"])[0] == "1"
            return self._serve_file(fpath, "application/pdf", as_download=is_dl, download_name=fname)

        self.send_error(404, "Rota não encontrada")

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/api/process":
            self.send_error(404, "Endpoint não encontrado")
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(length) if length > 0 else b"{}"
            payload = json.loads(raw_body.decode("utf-8"))
        except Exception as e:
            return self._send_json({"ok": False, "error": f"Requisição JSON inválida: {e}"}, status=400)

        message_text = (payload.get("message") or "").strip()
        url_input = (payload.get("url") or "").strip()
        pdf_b64 = payload.get("pdf_base64") or ""
        pdf_name = (payload.get("pdf_name") or "").strip()
        api_key = (payload.get("api_key") or "").strip()
        combine_confirmed = bool(payload.get("combine_confirmed", False))

        # Extrair URL do texto da mensagem se o usuário colou o link no chat
        if not url_input and message_text:
            urls_found = re.findall(r"https?://[^\s<>\"']+", message_text)
            if len(urls_found) > 1 and not combine_confirmed:
                return self._send_json(
                    {
                        "ok": False,
                        "needs_clarification": True,
                        "error": (
                            f"Você informou {len(urls_found)} URLs na mesma mensagem. "
                            "Conforme as regras do EstudaPDF, informe qual delas deseja processar primeiro ou confirme que deseja combiná-las em um único PDF."
                        ),
                    },
                    status=200,
                )
            elif len(urls_found) == 1:
                url_input = urls_found[0]

        pdf_bytes = None
        if pdf_b64:
            try:
                if "," in pdf_b64:
                    pdf_b64 = pdf_b64.split(",", 1)[1]
                pdf_bytes = base64.b64decode(pdf_b64)
            except Exception:
                return self._send_json(
                    {"ok": False, "error": "Não foi possível decodificar o arquivo PDF enviado."},
                    status=400,
                )

        # Regra 2 do AGENTS.md / SKILL.md: Se não houver URL nem PDF, pedir que o usuário envie um deles
        if not url_input and not pdf_bytes:
            return self._send_json(
                {
                    "ok": False,
                    "needs_source": True,
                    "error": (
                        "Para iniciar a produção, preciso de um material de origem. "
                        "Por favor, cole uma **URL acessível** no chat ou anexe um **arquivo PDF** usando o botão de clipe (📎)."
                    ),
                },
                status=200,
            )

        # Regra 2: Se o usuário fornecer URL + PDF ao mesmo tempo sem explicitar combinação
        if url_input and pdf_bytes and not combine_confirmed:
            if not any(w in message_text.lower() for w in ("junto", "combin", "ambos", "duas", "dois", "unir", "todas")):
                return self._send_json(
                    {
                        "ok": False,
                        "needs_clarification": True,
                        "error": (
                            f"Você enviou tanto uma URL ({url_input}) quanto o arquivo PDF ({pdf_name}). "
                            "Deseja processar apenas um deles ou gerar um único PDF combinando ambas as fontes?"
                        ),
                    },
                    status=200,
                )

        try:
            study_data, out_path, out_filename, pages_count, size_bytes = process_study_material(
                url=url_input,
                pdf_bytes=pdf_bytes,
                pdf_filename=pdf_name,
                api_key=api_key,
                custom_instructions=message_text,
                output_dir=OUTPUT_DIR,
            )
            total_cards = sum(len(t.get("cards", [])) for t in study_data.get("flashcards_by_theme", []))
            return self._send_json(
                {
                    "ok": True,
                    "filename": out_filename,
                    "pdf_url": f"/files/{urllib.parse.quote(out_filename)}",
                    "download_url": f"/files/{urllib.parse.quote(out_filename)}?download=1",
                    "pages_count": pages_count,
                    "size_bytes": size_bytes,
                    "total_cards": total_cards,
                    "study_data": study_data,
                    "history": list_generated_pdfs(),
                }
            )
        except ValueError as ve:
            return self._send_json({"ok": False, "error": str(ve)}, status=200)
        except Exception as exc:
            return self._send_json(
                {"ok": False, "error": f"Erro ao processar o material: {exc}"},
                status=500,
            )


def run_server(host="127.0.0.1", port=8080):
    os.makedirs(STATIC_DIR, exist_ok=True)
    server = ThreadingHTTPServer((host, port), EstudaPDFHandler)
    print(f"============================================================")
    print(f" EstudaPDF — Chat IA de Resumos e Flashcards em PDF")
    print(f" Acesse no navegador: http://{host}:{port}")
    print(f"============================================================")
    server.serve_forever()


if __name__ == "__main__":
    import sys

    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    run_server(port=port)

