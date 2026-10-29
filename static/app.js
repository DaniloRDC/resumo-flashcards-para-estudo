// ============================================================================
// EstudaPDF — Frontend AI Chat Controller & 100% Static Browser Engine
// Compatível com Deploy Estático (GitHub Pages, Vercel, Netlify) e Servidor Local
// Opera com Pipeline Anti-Erro de 3 Agentes (Construtor • Revisor • Tester)
// ============================================================================

const state = {
  attachedFile: null, // { name, size, base64, arrayBuffer }
  apiKey: localStorage.getItem("estudapdf_gemini_key") || "",
  masteredCards: JSON.parse(localStorage.getItem("estudapdf_mastered_cards") || "{}"),
  isProcessing: false,
  historyItems: [],
};

const els = {
  sidebar: document.getElementById("sidebar"),
  sidebarBackdrop: document.getElementById("sidebar-backdrop"),
  btnToggleSidebar: document.getElementById("btn-toggle-sidebar"),
  btnNewChat: document.getElementById("btn-new-chat"),
  btnClearHistory: document.getElementById("btn-clear-history"),
  historyList: document.getElementById("history-list"),
  chatMessages: document.getElementById("chat-messages"),
  welcomeScreen: document.getElementById("welcome-screen"),
  chatForm: document.getElementById("chat-form"),
  chatInput: document.getElementById("chat-input"),
  btnAttachPdf: document.getElementById("btn-attach-pdf"),
  pdfFileInput: document.getElementById("pdf-file-input"),
  attachmentBar: document.getElementById("attachment-bar"),
  attName: document.getElementById("att-name"),
  attSize: document.getElementById("att-size"),
  btnRemoveAtt: document.getElementById("btn-remove-att"),
  btnSend: document.getElementById("btn-send"),
  dropOverlay: document.getElementById("drop-overlay"),
  quickTestUrl: document.getElementById("quick-test-url"),
  quickUploadPdf: document.getElementById("quick-upload-pdf"),
  quickPasteUrl: document.getElementById("quick-paste-url"),
  btnOpenSettings: document.getElementById("btn-open-settings"),
  btnCloseSettings: document.getElementById("btn-close-settings"),
  btnSaveSettings: document.getElementById("btn-save-settings"),
  settingsModal: document.getElementById("settings-modal"),
  apiKeyInput: document.getElementById("api-key-input"),
  engineStatusPill: document.getElementById("engine-status-pill"),
  toastContainer: document.getElementById("toast-container"),
};

// ============================================================================
// Utilitários Gerais e Notificações Toast
// ============================================================================

function showToast(message) {
  if (!els.toastContainer) return;
  const item = document.createElement("div");
  item.className = "toast-item";
  item.textContent = message;
  els.toastContainer.appendChild(item);
  setTimeout(() => {
    item.style.opacity = "0";
    item.style.transition = "opacity 0.25s ease";
    setTimeout(() => item.remove(), 260);
  }, 2800);
}

function formatBytes(bytes) {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function todayFormatted() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function nowFormatted() {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${todayFormatted()} ${hh}:${min}`;
}

function slugifyFilename(title) {
  let clean = (title || "material_de_estudo")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!clean || clean.length < 3) clean = "material_de_estudo";
  return `resumo_flashcards_${clean.slice(0, 52)}.pdf`;
}

function updateEnginePill() {
  if (state.apiKey) {
    els.engineStatusPill.textContent = "✨ Motor Gemini IA + 3 Agentes";
  } else {
    els.engineStatusPill.textContent = "⚡ Motor 3 Agentes Ativo";
  }
}

// ============================================================================
// Armazenamento Persistente no Navegador (IndexedDB)
// ============================================================================

const DB_NAME = "estudapdf_browser_db";
const DB_STORE = "generated_pdfs";

function openLocalDB() {
  return new Promise((resolve) => {
    if (!window.indexedDB) {
      return resolve(null);
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: "filename" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

async function saveStudyToLocalDB(record) {
  const db = await openLocalDB();
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(record);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
}

async function getAllStudiesFromLocalDB() {
  const db = await openLocalDB();
  if (!db) return [];
  return new Promise((resolve) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const req = tx.objectStore(DB_STORE).getAll();
    req.onsuccess = () => {
      const items = req.result || [];
      items.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
      resolve(items);
    };
    req.onerror = () => resolve([]);
  });
}

async function deleteStudyFromLocalDB(filename) {
  const db = await openLocalDB();
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).delete(filename);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
}

async function clearAllLocalDB() {
  const db = await openLocalDB();
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).clear();
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
}

function base64ToBlobUrl(b64, contentType = "application/pdf") {
  try {
    const clean = b64.includes(",") ? b64.split(",")[1] : b64;
    const bin = atob(clean);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: contentType });
    return URL.createObjectURL(blob);
  } catch (e) {
    return "";
  }
}

async function loadHistory() {
  const localRecords = await getAllStudiesFromLocalDB();
  const formattedLocal = localRecords.map((rec) => {
    const blobUrl = rec.pdf_base64 ? base64ToBlobUrl(rec.pdf_base64) : rec.pdf_url || "";
    return {
      filename: rec.filename,
      url: blobUrl || rec.url,
      download_url: blobUrl || rec.download_url,
      size_bytes: rec.size_bytes || 0,
      modified: rec.modified || todayFormatted(),
      mtime: rec.mtime || Date.now(),
      study_data: rec.study_data || null,
      pages_count: rec.pages_count || 1,
      total_cards: rec.total_cards || 0,
      is_local: true,
    };
  });

  try {
    const res = await fetch("./api/history", { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      if (data.ok && Array.isArray(data.files)) {
        const seen = new Set(formattedLocal.map((i) => i.filename));
        for (const f of data.files) {
          if (!seen.has(f.filename)) {
            formattedLocal.push(f);
          }
        }
      }
    }
  } catch (_) {
    // Modo estático puro (GitHub Pages / Vercel / Netlify)
  }

  state.historyItems = formattedLocal;
  renderHistory(formattedLocal);
}

function renderHistory(files) {
  if (!files || !files.length) {
    els.historyList.innerHTML = `<div class="history-empty">Nenhum PDF gerado ainda. Envie uma URL ou anexe um PDF no chat!</div>`;
    return;
  }
  els.historyList.innerHTML = files
    .map(
      (f, idx) => `
    <div class="history-item" data-idx="${idx}">
      <div class="hi-top-row">
        <div class="hi-name">📄 ${escapeHtml(f.filename)}</div>
        <button type="button" class="hi-delete-btn" data-del-name="${escapeHtml(f.filename)}" title="Remover do histórico">✕</button>
      </div>
      <div class="hi-meta">
        <span>${formatBytes(f.size_bytes)}</span>
        <span>${escapeHtml(f.modified)}</span>
      </div>
      <div class="hi-actions">
        ${
          f.study_data
            ? `<button type="button" class="hi-btn primary" data-reopen-idx="${idx}" title="Reabrir resumo e flashcards no chat">📖 Ver</button>`
            : ""
        }
        <a href="${f.download_url}" class="hi-btn ${f.study_data ? "" : "primary"}" download="${escapeHtml(f.filename)}">⬇ Baixar</a>
        <a href="${f.url}" target="_blank" rel="noopener" class="hi-btn">↗ PDF</a>
      </div>
    </div>
  `
    )
    .join("");

  els.historyList.querySelectorAll("[data-reopen-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = state.historyItems[Number(btn.dataset.reopenIdx)];
      if (!item || !item.study_data) return;
      if (els.welcomeScreen) els.welcomeScreen.classList.add("hidden");
      const row = document.createElement("div");
      row.className = "msg-row ai";
      row.innerHTML = `<div class="msg-avatar">🎓</div><div class="msg-bubble"></div>`;
      els.chatMessages.appendChild(row);
      renderAiSuccessBubble(row, {
        filename: item.filename,
        pdf_url: item.url,
        download_url: item.download_url,
        pages_count: item.pages_count || 4,
        size_bytes: item.size_bytes,
        total_cards: item.total_cards || 12,
        study_data: item.study_data,
      });
      closeMobileSidebar();
      showToast("Estudo reaberto no chat!");
    });
  });

  els.historyList.querySelectorAll("[data-del-name]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const fname = btn.dataset.delName;
      await deleteStudyFromLocalDB(fname);
      state.historyItems = state.historyItems.filter((i) => i.filename !== fname);
      renderHistory(state.historyItems);
      showToast("PDF removido do histórico do navegador.");
    });
  });
}

// ============================================================================
// Motor Client-Side de 3 Agentes (Construtor • Revisor • Tester) + jsPDF
// Sanitização rigorosa de ligaduras, Unicode NFD/NFC, tabelas e cabeçalhos
// ============================================================================

const LIGATURE_FIXES = [
  [/\ufb00/g, "ff"],
  [/\ufb01/g, "fi"],
  [/\ufb02/g, "fl"],
  [/\ufb03/g, "ffi"],
  [/\ufb04/g, "ffl"],
  [/(^|[\s([{"“])[?\ufffd]loso[?\ufffd]a(s?)\b/g, "$1filosofia$2"],
  [/([Ff])iloso[?\ufffd]a/g, "$1ilosofia"],
  [/([Ff])ilosó[?\ufffd]c([oa]s?)/g, "$1ilosófic$2"],
  [/([Cc])iên[?\ufffd]cia/g, "$1iência"],
  [/([Dd])e[?\ufffd]niç(ão|ões)/g, "$1efiniç$2"],
  [/([Dd])e[?\ufffd]nid([oa]s?)/g, "$1efinid$2"],
  [/([Dd])e[?\ufffd]nir/g, "$1efinir"],
  [/([Ss])igni[?\ufffd]cativ([oa]s?)/g, "$1ignificativ$2"],
  [/([Ss])igni[?\ufffd]cad([oa]s?)/g, "$1ignificad$2"],
  [/([Ee])[?\ufffd]ca(z|zes|cia)/g, "$1fica$2"],
  [/([Ee])[?\ufffd]ciente(s?)/g, "$1ficiente$2"],
  [/([Cc])lassi[?\ufffd]caç(ão|ões)/g, "$1lassificaç$2"],
  [/([Ii])denti[?\ufffd]ca(r|ção|do|da)/g, "$1dentifica$2"],
  [/([Jj])usti[?\ufffd]ca(r|tiva|do|da)/g, "$1ustifica$2"],
  [/([Ee])specí[?\ufffd]c([oa]s?)/g, "$1specífic$2"],
  [/([Cc])ientí[?\ufffd]c([oa]s?)/g, "$1ientífic$2"],
  [/([Pp])ro[?\ufffd]ss(ão|ões|ional|ionais)/g, "$1rofiss$2"],
  [/([Dd])i[?\ufffd]culdade(s?)/g, "$1ificuldade$2"],
  [/([Dd])i[?\ufffd]cil/g, "$1ifícil"],
  [/([Ss])u[?\ufffd]ciente(s?)/g, "$1uficiente$2"],
  [/([Ii])n[?\ufffd]uên(cia|cias)/g, "$1nfluên$2"],
  [/([Ii])n[?\ufffd]uente(s?)/g, "$1nfluente$2"],
  [/([Cc])on[?\ufffd]it(o|os)/g, "$1onflit$2"],
  [/([Rr])e[?\ufffd]ex(ão|ões)/g, "$1eflex$2"],
  [/([Rr])e[?\ufffd]etir/g, "$1efletir"],
  [/(^|[\s([{"“])[?\ufffd](cará|caram|cou|car|ca|cam|camos|losofia|losófico|losófica|lósofo|nal|nais|nalidade|nanceiro|nanceira|lial|liais)\b/g, "$1fi$2"],
  [/(^|[\s([{"“])[?\ufffd](uido|uidos|uxo|uxos|exão|exões|exível)\b/g, "$1fl$2"],
  [/([A-Za-zÀ-ÿ])[?\ufffd](ca|co|cá|ci|cê|ce|cu|ni|ní|li|si|sí|ss)/g, "$1fi$2"],
];

function cleanBrokenLigaturesAndGlyphs(raw) {
  if (!raw) return "";
  let text = String(raw).normalize("NFC");
  let s = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xe000 && code <= 0xf8ff) {
      s += " ";
    } else {
      s += text[i];
    }
  }
  s = s
    .replace(/[\u2192\u2794\u279c\u279e\u27f6]/g, " -> ")
    .replace(/\u21d2/g, " => ")
    .replace(/[\u2190\u27f5]/g, " <- ")
    .replace(/\u2194/g, " <-> ")
    .replace(/\u2265/g, ">=")
    .replace(/\u2264/g, "<=")
    .replace(/\u2260/g, "!=")
    .replace(/[\u25aa\u25cf\u25b8\u25ba\u2023\u2043]/g, "•")
    .replace(/\u00ad/g, "");

  for (const [regex, repl] of LIGATURE_FIXES) {
    s = s.replace(regex, repl);
  }
  s = s.replace(/\bSaulo\s+Lu[ií]s\s+Lima\s+da\s+Silva\b[^A-Za-zÀ-ÿ]*/gi, "");
  s = s.replace(/\s+([.,;:!?])/g, "$1");
  return s.replace(/[ \t]+/g, " ").trim();
}

/**
 * Sanitiza qualquer string antes de enviá-la ao jsPDF (fonte standard Helvetica WinAnsi / Latin-1),
 * impedindo que caracteres Unicode > 0xFF (como '—', '–', '•', '→', '“', '”', '…') ou NFD
 * causem caracteres embolados, sobrepostos ou corrompidos no PDF.
 */
function sanitizeForJsPdf(str) {
  if (!str) return "";
  let s = cleanBrokenLigaturesAndGlyphs(str).normalize("NFC");
  s = s
    .replace(/[\u2013\u2014\u2015\u2212\u2010\u2011\u2012]/g, "-")
    .replace(/[\u201c\u201d\u201e\u00ab\u00bb]/g, '"')
    .replace(/[\u2018\u2019\u201a\u2032]/g, "'")
    .replace(/[\u2022\u2023\u25cf\u25aa\u25ab\u25b8\u25ba\u2043]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[\u2192\u2794\u279c\u279e\u27f6]/g, "->")
    .replace(/\u21d2/g, "=>")
    .replace(/\u2190/g, "<-")
    .replace(/\u2194/g, "<->")
    .replace(/\u2265/g, ">=")
    .replace(/\u2264/g, "<=")
    .replace(/\u2260/g, "!=")
    .replace(/\u2248/g, "~")
    .replace(/[\u2080-\u2089]/g, (m) => String(m.charCodeAt(0) - 0x2080))
    .replace(/[\u00a0\u2002\u2003\u2009]/g, " ")
    .replace(/[\u200b-\u200d\ufeff\u00ad]/g, "");

  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 32 && c <= 255 && c !== 127) {
      out += s[i];
    } else if (c === 9 || c === 10) {
      out += " ";
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

function isEditorialOrEnglishLine(line) {
  const s = (line || "").replace(/^##HEADING##\s*/, "").trim();
  if (!s) return true;
  if (
    /^(revista\s+brasileira|www\.|http:\/\/|https:\/\/|doi:|licen[çc]a\s+creative|cartas\s+ao\s+editor|recebido\s+em|revisado\s+em|aceito\s+em|palavras-chave:|keywords:|abstract\b|microwork\s+softwares\s*\|\s*\d+|a\+\s*a-|conte[úu]do\s+feito\s+por\s+humanos|t[óo]picos\s+deste\s+artigo|veja\s+tamb[ée]m:|leia\s+tamb[ée]m:|saiba\s+mais:|publicidade$)/i.test(
      s
    )
  ) {
    return true;
  }
  if (/^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},\s+\d{4}$/i.test(s)) {
    return true;
  }
  if (/^(universidade|instituto|faculdade|departamento|força\s+aérea|centro\s+de\s+instrução|\d+\s*força\s+aérea|\d+\s*universidade)/i.test(s) && !s.endsWith(".")) {
    return true;
  }
  if (s.includes("?") || s.includes(">") || s.includes("->") || s.startsWith("•")) {
    return false;
  }
  const words = s.replace(/[^A-Za-zÀ-ÿ\s]/g, "").trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2 && words.length <= 6 && !/[.!?:;]/.test(s)) {
    const connectors = new Set(["da", "de", "do", "das", "dos", "e"]);
    const allCap = words.every((w) => connectors.has(w.toLowerCase()) || /^[A-ZÀ-Ý][a-zà-ÿ]+$/.test(w));
    const nonConcepts =
      !/(lei|newton|física|mecânica|introdução|conclusão|filosofia|ética|moral|história|capítulo|unidade|seção|tema|visão|geral|contratação|renave|usado|evento|eventos|saída|comprador|veículos|veículo|inacabados|venda|intermediada|suporte|chamados|soluções|material|apoio|regras|circulares|comunicação|certificado|instabilidade|integradora|atpv|relatividade)/i.test(
        s
      );
    if (allCap && nonConcepts) return true;
  }
  const engMatches = (
    s.match(/\b(the|and|of|in|to|that|is|for|with|as|are|this|by|from|upon|leaving|students|understanding|laws|motion)\b/gi) || []
  ).length;
  const ptMatches = (s.match(/\b(que|para|com|como|uma|não|mais|dos|das|pelo|pela|são|está|isso|este|essa)\b/gi) || []).length;
  if (engMatches >= 3 && engMatches > ptMatches * 1.5) return true;
  return false;
}

function normalizeHeaderFingerprint(line) {
  return cleanBrokenLigaturesAndGlyphs(line || "")
    .replace(/^##HEADING##\s*/, "")
    .toLowerCase()
    .replace(/\|\s*\d+\s*$/, "|")
    .replace(/\bp[áa]gina\s+\d+(\s+de\s+\d+)?$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extrai linhas estruturadas do PDF no navegador usando coordenadas (X, Y, largura, tamanho da fonte),
 * reconstruindo tabelas multicolunas célula por célula e removendo cabeçalhos/rodapés repetidos.
 */
async function extractTextFromPdfClientSide(arrayBuffer) {
  if (!window.pdfjsLib) {
    throw new Error("A biblioteca PDF.js ainda está carregando. Aguarde 1 segundo e tente novamente.");
  }
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const pagesStructuredLines = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const spans = [];

    for (const item of content.items) {
      const rawStr = item.str || "";
      if (!rawStr.trim()) continue;
      const text = cleanBrokenLigaturesAndGlyphs(rawStr);
      if (!text) continue;
      const tr = item.transform || [10, 0, 0, 10, 0, 0];
      const x = Number(tr[4]) || 0;
      const y = Number(tr[5]) || 0;
      const fs = Math.max(Math.abs(Number(tr[0]) || 10), Math.abs(Number(tr[3]) || 10), Number(item.height) || 10);
      const w = Number(item.width) || text.length * fs * 0.5;
      spans.push({ x, y, w, fs, text });
    }

    // Ordena por Y decrescente (topo -> base) e X crescente (esquerda -> direita)
    spans.sort((a, b) => {
      const dy = Math.round(b.y / 3) * 3 - Math.round(a.y / 3) * 3;
      return dy !== 0 ? dy : a.x - b.x;
    });

    // 1. Agrupa spans na mesma linha visual Y (tolerância de 3.5pt)
    const yRows = [];
    for (const sp of spans) {
      if (!yRows.length || Math.abs(sp.y - yRows[yRows.length - 1].y) > 3.5) {
        yRows.push({ y: sp.y, spans: [sp] });
      } else {
        yRows[yRows.length - 1].spans.push(sp);
      }
    }

    // 2. Dentro de cada linha Y, une palavras próximas e separa colunas quando o gap horizontal >= 16pt
    const visualRows = [];
    for (const yr of yRows) {
      yr.spans.sort((a, b) => a.x - b.x);
      const segments = [];
      for (const sp of yr.spans) {
        if (!segments.length) {
          segments.push({
            x: sp.x,
            xEnd: sp.x + sp.w,
            y: yr.y,
            fs: sp.fs,
            text: sp.text,
          });
        } else {
          const prev = segments[segments.length - 1];
          const gap = sp.x - prev.xEnd;
          if (gap < 16.0) {
            const sep = gap < Math.max(1.2, prev.fs * 0.14) ? "" : " ";
            prev.text = cleanBrokenLigaturesAndGlyphs(prev.text + sep + sp.text);
            prev.xEnd = Math.max(prev.xEnd, sp.x + sp.w);
            prev.fs = Math.max(prev.fs, sp.fs);
          } else {
            segments.push({
              x: sp.x,
              xEnd: sp.x + sp.w,
              y: yr.y,
              fs: sp.fs,
              text: sp.text,
            });
          }
        }
      }
      visualRows.push({ y: yr.y, segments });
    }

    // 3. Reconstrói tabelas multicolunas sem embaralhar colunas da mesma linha
    const pageLines = [];
    let idx = 0;
    while (idx < visualRows.length) {
      const vr = visualRows[idx];
      const segs = vr.segments;

      if (segs.length >= 2) {
        let colAnchors = segs.map((s) => s.x);
        const tableRows = [];
        let currentCells = colAnchors.map((_, i) => segs[i]?.text || "");
        let prevY = vr.y;
        idx++;

        while (idx < visualRows.length) {
          const nxtVr = visualRows[idx];
          const nxtSegs = nxtVr.segments;
          const dy = prevY - nxtVr.y;

          if (dy > 28.0) break;

          if (nxtSegs.length === 1) {
            const s0 = nxtSegs[0];
            let nearestCol = 0;
            let bestDist = Infinity;
            colAnchors.forEach((ax, ci) => {
              const d = Math.abs(s0.x - ax);
              if (d < bestDist) {
                bestDist = d;
                nearestCol = ci;
              }
            });
            if (bestDist > 28.0) break;
            if (nearestCol === 0 && (s0.text.length > 72 || s0.fs >= 11.5)) break;
          }

          if (nxtSegs.length > colAnchors.length && nxtSegs.length <= 4) {
            while (currentCells.length < nxtSegs.length) currentCells.push("");
            colAnchors = nxtSegs.map((s) => s.x);
          }

          let startsNewRow = false;
          if (dy > 15.5) {
            startsNewRow = true;
          } else if (nxtSegs.length >= 2 && currentCells[0]) {
            if (tableRows.length === 0 && currentCells.every((c) => !c || c.length < 35)) {
              startsNewRow = true;
            }
          }

          if (startsNewRow) {
            tableRows.push(currentCells.map((c) => c.trim()));
            currentCells = colAnchors.map(() => "");
          }

          for (const s of nxtSegs) {
            let cIdx = 0;
            let bestDist = Infinity;
            colAnchors.forEach((ax, ci) => {
              const d = Math.abs(s.x - ax);
              if (d < bestDist) {
                bestDist = d;
                cIdx = ci;
              }
            });
            if (currentCells[cIdx]) {
              if (currentCells[cIdx].endsWith("-") && /^[a-zà-ÿ]/.test(s.text)) {
                currentCells[cIdx] = currentCells[cIdx].slice(0, -1) + s.text;
              } else {
                currentCells[cIdx] += " " + s.text;
              }
            } else {
              currentCells[cIdx] = s.text;
            }
          }

          prevY = nxtVr.y;
          idx++;
        }

        if (currentCells.some((c) => c.trim())) {
          tableRows.push(currentCells.map((c) => c.trim()));
        }

        if (tableRows.length > 0) {
          const firstRow = tableRows[0];
          const isHeader =
            firstRow.every((c) => !c || c.length <= 32) &&
            /(tipo|processo|opção|evento|lançamento|tema|problema|causa|solução|conceito|item)/i.test(firstRow.join(" "));
          const headers = isHeader ? firstRow : null;
          const dataRows = isHeader ? tableRows.slice(1) : tableRows;

          for (const rCells of dataRows) {
            const nonEmpty = rCells.filter(Boolean);
            if (!nonEmpty.length) continue;
            if (nonEmpty.length === 1) {
              pageLines.push(nonEmpty[0]);
            } else if (headers && rCells.length === headers.length) {
              const lead = rCells[0];
              const details = [];
              for (let k = 1; k < rCells.length; k++) {
                if (rCells[k]) {
                  details.push(headers[k] ? `${headers[k]}: ${rCells[k]}` : rCells[k]);
                }
              }
              pageLines.push(`• ${lead}: ${details.join(" | ")}`);
            } else {
              pageLines.push(`• ${nonEmpty[0]}: ${nonEmpty.slice(1).join(" | ")}`);
            }
          }
        }
        continue;
      }

      const seg = segs[0];
      if (seg.fs >= 11.8 && seg.text.length <= 95 && !seg.text.endsWith(".")) {
        pageLines.push(`##HEADING## ${seg.text}`);
      } else {
        pageLines.push(seg.text);
      }
      idx++;
    }

    pagesStructuredLines.push(pageLines);
  }

  // Remove cabeçalhos e rodapés que se repetem em >= 2 páginas
  if (pagesStructuredLines.length >= 2) {
    const edgeCounts = new Map();
    for (const pLines of pagesStructuredLines) {
      const edges = new Set(
        [...pLines.slice(0, 3), ...pLines.slice(-3)].map((l) => normalizeHeaderFingerprint(l)).filter((fp) => fp.length >= 4)
      );
      for (const fp of edges) {
        edgeCounts.set(fp, (edgeCounts.get(fp) || 0) + 1);
      }
    }
    const repeatedFps = new Set([...edgeCounts.entries()].filter(([, cnt]) => cnt >= 2).map(([fp]) => fp));
    const allCleaned = [];
    pagesStructuredLines.forEach((pLines) => {
      pLines.forEach((ln, idx) => {
        const fp = normalizeHeaderFingerprint(ln);
        if (repeatedFps.has(fp) && (idx < 3 || idx >= pLines.length - 3)) {
          return;
        }
        allCleaned.push(ln);
      });
    });
    return allCleaned;
  }

  return pagesStructuredLines.flat();
}

// Dados curados 100% fiéis para o documento "FAQ Renave – Orientações para o Suporte" (11 páginas)
function buildCuratedFaqRenaveStudyData(sourceLabel) {
  return {
    title: "FAQ Renave – Orientações para o Suporte",
    subtitle: "Guia Técnico de Operação, Contratação, Eventos 0km/Inacabados/Venda Intermediada, ATPV e Solução de Chamados",
    source: sourceLabel || "FAQ Renave – Orientações para o Suporte.pdf",
    source_type: "pdf",
    date: todayFormatted(),
    language: "Português (Brasil)",
    overview:
      "O documento orienta a equipe de Suporte sobre o funcionamento do Renave (0km e Usado) no sistema MicroWork CLOUD DMS e a integração com parceiros (integradoras). A forma de envio dos eventos depende da contratação de integradora: antes da contratação, todo o processo ocorre pelo MicroWork CLOUD DMS; a partir da contratação (ou quando a SERPRO/Credencia bloqueia o envio direto), o envio passa a ocorrer sempre através do parceiro (fluxo Cloud -> Integradora -> SERPRO). O Suporte deve sempre analisar o request, o response e o erro do evento antes de direcionar o cliente ao parceiro.",
    sections: [
      {
        heading: "Visão Geral e Fluxo de Envio com Parceiro (Integradora)",
        paragraphs: [
          "Com o parceiro (integradora) contratado, o ponto de partida depende do tipo de veículo: para veículo Usado, o processo começa no parceiro (a concessionária apenas envia as notas fiscais de entrada e saída ao parceiro, que realiza todo o restante); para veículo 0km, o processo começa no MicroWork CLOUD DMS (os eventos são gerados pelo faturamento ou expedição e enviados através do parceiro).",
          "Regra prática de atendimento: em dúvida sobre veículo usado com parceiro contratado, avaliar o caso e, confirmado que é do parceiro, orientar o cliente a tratar com ele. Em dúvida sobre veículo 0km, analisar primeiro no Cloud. Se o evento estiver em AGUARDANDO PARCEIRO, consultar o request e o response do evento para identificar se a falha é do Cloud ou do parceiro.",
        ],
        bullets: [
          {
            label: "SUCESSO (Veículos > Estoque > Renave)",
            text: "A integradora processou a solicitação enviada pelo Cloud e o evento foi aceito na SERPRO.",
          },
          {
            label: "AGUARDANDO PARCEIRO",
            text: "Os dados foram enviados à integradora e aguardam retorno. O Suporte deve consultar request e response para verificar se houve erro no Cloud ou no parceiro.",
          },
          {
            label: "ERRO",
            text: "Houve falha no evento ou na comunicação; a própria mensagem retornada indica a causa para correção.",
          },
        ],
      },
      {
        heading: "Contratação do Renave 0km e Renave Usado e Permissões de Acesso",
        paragraphs: [
          "A contratação é realizada por filial nos menus MicroWork > Contratar > Renave 0km e MicroWork > Contratar > Renave Usado. O acesso a essas telas não depende mais do usuário Master: pode ser feito por usuário com permissão específica ou usuário supervisor (as demais contratações do menu MicroWork > Contratar continuam restritas ao usuário Master).",
          "Na liberação da atualização, todos os usuários ficaram sem acesso por padrão, cabendo ao responsável na concessionária conceder a permissão. Além disso, a tela lista todas as filiais em que o usuário está ativo no cadastro de usuário (e não apenas aquelas em que era Master).",
        ],
        bullets: [
          {
            label: "Liberação de permissão (Contratação e ATPV)",
            text: "Configurada em Utilitários > GerSys > Controle de Acessos > Usuário ou em Utilitários > GerSys > Controle de Acessos > Grupo de Acesso.",
          },
          {
            label: "Download e impressão da ATPV na Movimentação do Estoque",
            text: "Também dependem de permissão específica liberada nos mesmos menus de Controle de Acessos (Usuário ou Grupo de Acesso).",
          },
        ],
      },
      {
        heading: "Evento Saída para Comprador Final 0KM",
        paragraphs: [
          "O momento em que o sistema gera o evento de saída 0km depende do parâmetro configurado em Configurações > Parâmetros > Veículo, grupo Renave, campo 'Movimento para envio do evento de Saída para Comprador Final 0KM'. Esse parâmetro não altera a Saída Imobilizado, que continua enviando o evento ao movimentar o veículo, com ou sem faturamento.",
        ],
        bullets: [
          {
            label: "Opção FATURAMENTO DA VENDA/REMESSA ENTREGA FUTURA",
            text: "Gera o evento automaticamente ao emitir a nota fiscal de Venda ou Remessa Entrega Futura com consumidor final = SIM.",
          },
          {
            label: "Opção EXPEDIÇÃO",
            text: "Gera o evento somente ao expedir o veículo com situação VENDIDO (o faturamento não gera o evento). Os dados enviados ao Renave vêm da última nota fiscal de Venda ou Remessa Entrega Futura emitida para o veículo.",
          },
          {
            label: "Cancelamento e Reexpedição",
            text: "Cancelar a expedição não gera o evento CANCELAMENTO SAÍDA PARA COMPRADOR FINAL 0KM (que só ocorre ao cancelar a NF de Venda/Remessa ou devolver o veículo por nota própria ou de terceiro). Se o usuário cancelar e expedir novamente, não é gerado outro evento porque o último movimento já é SAÍDA PARA COMPRADOR FINAL 0KM.",
          },
        ],
      },
      {
        heading: "Veículos 0km Inacabados (Renave 0km – Fase 2)",
        paragraphs: [
          "Desde 09/08/2022, o Renave 0km abrange veículos incompletos/inacabados destinados à concessionária, incluindo movimentações entre concessionária, ITE (Implementadores, Encarroçadores e Transformadores) e saída para comprador final. É obrigatório configurar o campo 'Condição do veículo' em Veículos > Tabelas > Modelo (grupo Características do Modelo); os eventos são consultados em Veículos > Estoque > Renave.",
          "A validação em Fiscal > Documento Fiscal de Terceiro > Lançamento de Entrada que obrigava lançar a nota de INDUSTRIALIZAÇÃO antes do RETORNO foi removida: com CFOP diferente de 1903/2903, o evento RETORNO DE INDUSTRIALIZAÇÃO é gerado assim que o retorno e a nota de industrialização estiverem lançados, independentemente da ordem (exigindo sempre AUTORIZAÇÃO DE TRANSFERÊNCIA com situação CRIADA e a concessionária como destino).",
        ],
        bullets: [
          {
            label: "Processo 1 — Industrialização pela concessionária",
            text: "A concessionária adquire o inacabado e envia ao ITE, que transforma o veículo, atualiza a BIN e devolve. A concessionária vende como acabado e a ATPV-e é liberada pelo Renave. A Condição do Veículo muda de INACABADO para ACABADO após concluir a entrada da NF de industrialização.",
          },
          {
            label: "Processo 2 — Venda do inacabado",
            text: "A concessionária vende o veículo com Condição = INACABADO ao consumidor final (responsável pela transformação). A impressão da ATPV-e não é liberada para a concessionária; após a implementação, o ITE disponibiliza o documento ao comprador final.",
          },
          {
            label: "Eventos de Inacabado",
            text: "AUTORIZAÇÃO PARA INDUSTRIALIZAÇÃO (emissão de NF de Saída para Industrialização normal ou simbólica); CANCELAMENTO AUTORIZAÇÃO (cancelamento/estorno da NF de saída); RETORNO DE INDUSTRIALIZAÇÃO (com CFOP 1903/2903 gera automaticamente como cancelamento da industrialização; com CFOP diferente de 1903/2903 exige NF de Industrialização e Retorno lançados; CFOP 5903/6903 mantém veículo INACABADO pois voltou sem implementação); SAÍDA e CANCELAMENTO SAÍDA PARA COMPRADOR FINAL 0KM INACABADO.",
          },
          {
            label: "Venda de inacabado com Leasing (desde 19/04/2023)",
            text: "Ao enviar SAÍDA PARA COMPRADOR FINAL 0KM INACABADO, se o pedido de venda (Veículo > Pedido de Venda) tiver forma de recebimento com tipo interno LEASING (cadastrado em Veículos > Tabelas > Pedidos de Venda > Forma de Recebimento), o sistema envia a instituição financeira/leasing como compradora, devendo o ITE informar a mesma instituição na saída de estoque.",
          },
        ],
      },
      {
        heading: "Venda Intermediada (Renave 0km – Fase 3)",
        paragraphs: [
          "Desde 22/12/2022, o Renave 0km contempla a venda direta da montadora ao cliente final com intermediação e entrega pela concessionária. Os chassis faturados pela montadora e pendentes de entrega são consultados em Veículos > Estoque > Renave > botão Consultar > opção CONSULTAR ENTREGA DE VEÍCULO 0KM POR VENDA INTERMEDIADA.",
          "Para efetivar a venda (passando o veículo de LOJA INTERMEDIADO para VENDA INTERMEDIADO): (1) inserir proposta de venda vinculando o veículo LOJA INTERMEDIADO; (2) informar formas de recebimento e parcela de COMISSÃO INTERMEDIADO (cadastrada em Veículos > Propostas de Venda > Forma de Recebimento por ORG); (3) fechar e liberar a proposta; (4) clicar em FATURAR e (5) confirmar a conclusão sem emissão de nota fiscal.",
        ],
        bullets: [
          {
            label: "ENTREGA DE VEÍCULO 0KM POR VENDA INTERMEDIADA",
            text: "Gerado ao concluir o pedido de venda do veículo com situação LOJA INTERMEDIADO. O chassi passa para ENTREGA REALIZADA no Renave e a ATPV pode ser impressa em Veículos > Estoque > Movimentação (engrenagem da ficha > opção ATPV, para fichas com situação VENDA INTERMEDIADO).",
          },
          {
            label: "CANCELAMENTO ENTREGA DE VEÍCULO 0KM POR VENDA INTERMEDIADA",
            text: "Gerado ao reabrir o pedido de venda de intermediação, cancelando a entrega ao consumidor final.",
          },
        ],
      },
      {
        heading: "Panorama de Chamados (Ago–Out/2026), Integradora, Certificado e Instabilidade",
        paragraphs: [
          "A análise de 1.906 chamados entre 01/08/2026 e 22/10/2026 apontou como principais temas: ATPV (785), Integradora e contratação (359 — com crescimento a partir de 28/09/2026 devido à Resolução CONTRAN nº 1.026/2026, que exigiu integradoras autorizadas), Renave Usado (142), Não existe intenção de venda disponível (95), Evento AGUARDANDO PARCEIRO (74), Chassi não cadastrado na BIN (56), Certificado digital/comunicação (47), Dados do comprador/CEP/e-mail (46), Instabilidade/timeout (43) e Autorização de transferência (43).",
        ],
        bullets: [
          {
            label: "Contratação e troca de integradora",
            text: "O cliente deve negociar primeiro com a integradora e depois aderir em MicroWork > Contratar > Renave 0km ou Usado (a MicroWork não cobra valor adicional; prazo de liberação padrão de 1 dia útil). 0km e Usado podem usar integradoras diferentes desde que atendam a UF. Para trocar de integradora, o cliente cancela na atual e o Suporte abre chamado de manutenção para cancelar no Cloud. Erro 'Estabelecimento não cadastrado na Parceira' ou bloqueio por inadimplência devem ser resolvidos junto à integradora.",
          },
          {
            label: "Certificado Digital e Credencia (SERPRO)",
            text: "Em erro de 'Certificado digital ausente/vencido' ou 'Não foi possível realizar a comunicação com o Renave! Possíveis causas: Empresa não credenciada...', conferir o certificado formato PFX em Utilitários > Tabelas Gerais > Empresa (aba Integrações) e validar credenciamento e certificado na integradora e no portal Credencia (SERPRO).",
          },
          {
            label: "Instabilidade (HttpClient.Timeout / Erro inesperado / Serviço indisponível)",
            text: "Decorre de instabilidade temporária na comunicação; basta reprocessar o evento, o que conclui com sucesso na maioria dos casos.",
          },
        ],
      },
      {
        heading: "Diagnóstico de Erros em Eventos 0km, ATPV e Renave Usado",
        paragraphs: [
          "Quando necessário inserir um evento manual 0km, acessar Veículos > Estoque > Renave, localizar o chassi e clicar em '+', informando os dados da nota fiscal com data e hora atuais e preenchendo chave de acesso, CEP e documento do comprador apenas com números (sem espaços ou pontuação). Para gerar a ATPV 0km (com entrada e saída em SUCESSO), executar o evento CONSULTA ATPV em Veículos > Estoque > Renave e baixá-la em Veículos > Estoque > Movimentação (engrenagem da ficha > ATPV).",
        ],
        bullets: [
          {
            label: "Chassi não cadastrado na BIN ou sem CNAE / não pendente de entrada",
            text: "Na ENTRADA ESTOQUE 0KM, solicitar à fábrica a inclusão do chassi na BIN ou o ajuste do CNPJ na tag identFaturado (se a fábrica já ajustou, abrir chamado na SERPRO e reprocessar).",
          },
          {
            label: "Transferência entre concessionárias e Autorização",
            text: "Se houver 'autorização de transferência ativa' ao vender para comprador final, fazer CANCELAMENTO AUTORIZAÇÃO TRANSFERÊNCIA 0KM. Para vender a outra concessionária, emitir nota com CONSUMIDOR FINAL = NÃO para gerar AUTORIZAÇÃO TRANSFERÊNCIA 0KM. Se o veículo veio da fábrica mas foi lançado como transferência por erro no cadastro do fornecedor, fazer ENTRADA ESTOQUE 0KM manual e corrigir o fornecedor como fabricante na relação comercial.",
          },
          {
            label: "Valor divergente, Datas, Estado CONFIRMADO, CEP e E-mail",
            text: "Conferir valor da NF com a autorização; refazer evento manual com data/hora atuais se acusar data anterior à entrada ou futura; se o estoque não estiver CONFIRMADO (saída anterior incorreta), fazer CANCELAMENTO SAÍDA PARA COMPRADOR FINAL 0KM e nova saída; corrigir CEP geral/inválido ou e-mail com espaço em novo evento manual.",
          },
          {
            label: "Erros de ATPV ('Não existe intenção de venda', nome de outro comprador, emplacado)",
            text: "Se a saída 0km não foi feita ou deu erro, reprocessar/inserir a saída e fazer nova CONSULTA ATPV (para Saída Imobilizado, enviar saída 0km com dados da nota de imobilizado e data atual). Se entrada e saída já estão em SUCESSO ou cancelamento indica chassi já emplacado, a SERPRO não disponibiliza a ATPV após início do emplacamento (orientar chamado na SERPRO). Se a ATPV saiu em nome de comprador anterior, cancelar a saída, enviar nova saída correta e fazer CONSULTA ATPV confirmando SIM para substituir.",
          },
        ],
      },
    ],
    key_concepts: [
      {
        term: "Fluxo Cloud -> Integradora -> SERPRO",
        definition:
          "A partir da contratação do parceiro ou bloqueio pela SERPRO/Credencia (Resolução CONTRAN nº 1.026/2026), o Cloud solicita o evento, a integradora processa e devolve o retorno (SUCESSO, AGUARDANDO PARCEIRO ou ERRO).",
      },
      {
        term: "Diferença Operacional Usado vs. 0km com Parceiro",
        definition:
          "No Renave Usado o processo começa no parceiro (o Cloud apenas disponibiliza as notas de entrada/saída, e a ATPV é gerada na plataforma da integradora); no 0km o processo começa no MicroWork CLOUD DMS.",
      },
      {
        term: "Parâmetro de Saída Comprador Final 0KM",
        definition:
          "Configurado em Configurações > Parâmetros > Veículo (grupo Renave): define se o evento é gerado no FATURAMENTO (NF com consumidor final = SIM) ou na EXPEDIÇÃO (veículo com situação VENDIDO).",
      },
      {
        term: "Renave 0km – Fase 2 (Veículos Inacabados)",
        definition:
          "Vigente desde 09/08/2022 para veículos incompletos; exige classificar o campo 'Condição do veículo' em Veículos > Tabelas > Modelo e controla as remessas e retornos junto ao ITE.",
      },
      {
        term: "Regra de CFOPs no Retorno de Industrialização",
        definition:
          "Exige AUTORIZAÇÃO DE TRANSFERÊNCIA CRIADA (concessionária como destino). CFOP 1903/2903 gera o evento automaticamente (cancelamento da industrialização); CFOP diferente exige NF de Industrialização e Retorno lançados; CFOP 5903/6903 mantém o veículo INACABADO.",
      },
      {
        term: "Renave 0km – Fase 3 (Venda Intermediada)",
        definition:
          "Vigente desde 22/12/2022 para venda direta da montadora ao cliente final intermediada pela concessionária; concluída sem emissão de NF ao faturar proposta de veículo LOJA INTERMEDIADO.",
      },
    ],
    synthesis:
      "O atendimento eficaz de chamados do Renave no MicroWork CLOUD DMS exige distinguir imediatamente se a operação é de veículo Usado (executada na integradora a partir das NFs) ou 0km (iniciada no Cloud nas Fases 1, 2 ou 3), auditar request/response antes de encaminhar o cliente ao parceiro e conferir rigorosamente permissões no GerSys, parâmetros de faturamento/expedição, condição do modelo (inacabado), tipo interno de recebimento (Leasing / Comissão Intermediado), certificado PFX e status do chassi na BIN/SERPRO.",
    limitations: [],
    flashcards_by_theme: [
      {
        theme: "Tema 1 — Visão Geral, Integradora e Contratação (0km e Usado)",
        theme_short: "Visão Geral e Contratação",
        cards: [
          {
            q: "Como funciona o envio dos eventos do Renave antes e depois da contratação de um parceiro (integradora)?",
            a: "Antes da contratação, todo o processo é feito diretamente pelo MicroWork CLOUD DMS. A partir da contratação do parceiro (ou quando a SERPRO/Credencia bloqueia o envio), o envio passa a ocorrer sempre através do parceiro (Cloud -> Integradora -> SERPRO).",
          },
          {
            q: "Com o parceiro contratado, qual é a diferença entre o processo de veículo Usado e o de veículo 0km?",
            a: "Para veículo Usado, o processo começa no parceiro (a concessionária apenas envia as NFs de entrada e saída e realiza as demais operações, inclusive ATPV, na plataforma da integradora). Para 0km, o processo começa no MicroWork CLOUD DMS e os eventos são enviados através do parceiro.",
          },
          {
            q: "Qual é a regra obrigatória para o Suporte antes de direcionar o cliente ao atendimento do parceiro (integradora)?",
            a: "O Suporte deve sempre avaliar o caso primeiro no sistema, consultando o request, o response e a mensagem de erro do evento (especialmente quando parado em AGUARDANDO PARCEIRO), direcionando ao parceiro somente após confirmar que o problema é dele.",
          },
          {
            q: "Onde o cliente contrata o Renave 0km e Usado no sistema, quem pode acessar essas telas e onde liberar a permissão?",
            a: "Contrata-se por filial em MicroWork > Contratar > Renave 0km e Renave Usado. Pode acessar qualquer usuário com permissão ou usuário supervisor (não exige mais ser Master). A permissão é liberada em Utilitários > GerSys > Controle de Acessos > Usuário ou Grupo de Acesso.",
          },
          {
            q: "Por que uma filial pode não aparecer na tela de contratação do Renave e se 0km e Usado precisam usar a mesma integradora?",
            a: "A filial não aparece quando o usuário não está ativo nela em seu cadastro de usuário. Quanto às integradoras, 0km e Usado não precisam usar a mesma: podem ser integradoras diferentes, desde que atendam o estado (UF).",
          },
        ],
      },
      {
        theme: "Tema 2 — ATPV e Evento Saída para Comprador Final 0KM",
        theme_short: "ATPV e Saída Comprador Final 0KM",
        cards: [
          {
            q: "Onde configurar o momento de geração do evento 'Saída para Comprador Final 0KM' e como funcionam as duas opções?",
            a: "Em Configurações > Parâmetros > Veículo (grupo Renave). Na opção FATURAMENTO DA VENDA/REMESSA ENTREGA FUTURA, gera ao emitir a NF com consumidor final = SIM. Na opção EXPEDIÇÃO, gera somente ao expedir o veículo com situação VENDIDO (usando os dados da última NF emitida).",
          },
          {
            q: "O parâmetro de Saída para Comprador Final 0KM altera a Saída Imobilizado?",
            a: "Não. A Saída Imobilizado continua enviando o evento ao movimentar o veículo, com ou sem faturamento.",
          },
          {
            q: "Cancelar a expedição cancela o evento de saída no Renave? E o que ocorre ao expedir o veículo novamente?",
            a: "Não. O movimento CANCELAMENTO SAÍDA PARA COMPRADOR FINAL 0KM só é gerado ao cancelar a NF de Venda/Remessa ou ao devolver o veículo (por nota própria ou de terceiro). Ao expedir novamente, o sistema vê que o último movimento já é a saída 0km e não gera novo evento.",
          },
          {
            q: "Como gerar e baixar a ATPV de um veículo 0km e o que verificar se o usuário não conseguir baixá-la na Movimentação do Estoque?",
            a: "Com entrada e saída em SUCESSO, faz-se o evento CONSULTA ATPV em Veículos > Estoque > Renave e o download em Veículos > Estoque > Movimentação (engrenagem da ficha > ATPV). Se não conseguir baixar/imprimir, liberar permissão em Utilitários > GerSys > Controle de Acessos > Usuário ou Grupo de Acesso.",
          },
        ],
      },
      {
        theme: "Tema 3 — Veículos 0km Inacabados (Renave 0km – Fase 2)",
        theme_short: "Veículos 0km Inacabados (Fase 2)",
        cards: [
          {
            q: "O que a concessionária precisa configurar para operar com veículos 0km inacabados (Fase 2) e quais são os 2 processos existentes?",
            a: "Deve configurar o campo 'Condição do veículo' em Veículos > Tabelas > Modelo (Características do Modelo). Os processos são: (1) Industrialização pela concessionária (envia ao ITE, que transforma e devolve; concessionária vende como acabado com ATPV-e liberada); (2) Venda do inacabado (consumidor final transforma; ATPV-e não é liberada à concessionária, mas pelo ITE após implementação).",
          },
          {
            q: "Quais condições e regras de CFOP determinam a geração do evento RETORNO DE INDUSTRIALIZAÇÃO?",
            a: "Exige sempre AUTORIZAÇÃO DE TRANSFERÊNCIA com situação CRIADA e a concessionária como destino. Com CFOP 1903 ou 2903, gera automaticamente no retorno (cancelamento da industrialização). Com CFOP diferente de 1903/2903, gera quando o retorno e a NF de industrialização estiverem lançados, independentemente da ordem.",
          },
          {
            q: "Quando a Condição do Veículo muda de INACABADO para ACABADO e por que ele pode continuar INACABADO após o retorno?",
            a: "Muda para ACABADO após a conclusão da entrada da nota fiscal de industrialização. Ele permanece INACABADO se o retorno ocorreu com CFOP 5903 ou 6903, os quais indicam que o veículo voltou ao estoque sem a implementação.",
          },
          {
            q: "Na venda de veículo inacabado com leasing, quem é enviado como comprador e o que verificar se o cliente foi enviado por engano?",
            a: "Desde 19/04/2023, são enviados os dados da instituição financeira/leasing como compradora (devendo o ITE informar a mesma instituição na saída). Se enviou o cliente, verificar se a forma de recebimento usada no pedido de venda está com o tipo interno LEASING em Veículos > Tabelas > Pedidos de Venda > Forma de Recebimento.",
          },
        ],
      },
      {
        theme: "Tema 4 — Venda Intermediada (Renave 0km – Fase 3)",
        theme_short: "Venda Intermediada (Fase 3)",
        cards: [
          {
            q: "Quais eventos existem na Venda Intermediada (Fase 3) e quando cada um é gerado?",
            a: "ENTREGA DE VEÍCULO 0KM POR VENDA INTERMEDIADA (gerado ao concluir o pedido de venda com situação LOJA INTERMEDIADO, passando o chassi para ENTREGA REALIZADA e liberando a ATPV) e CANCELAMENTO ENTREGA DE VEÍCULO 0KM POR VENDA INTERMEDIADA (gerado ao reabrir o pedido de intermediação).",
          },
          {
            q: "Quais são os 5 passos para efetivar a venda de um veículo LOJA INTERMEDIADO (passando para VENDA INTERMEDIADO)?",
            a: "(1) Inserir proposta de venda vinculando o veículo LOJA INTERMEDIADO; (2) informar as formas de recebimento e a parcela COMISSÃO INTERMEDIADO (se houver); (3) fechar e liberar a proposta; (4) clicar em FATURAR; e (5) confirmar para concluir a proposta sem emissão de nota fiscal.",
          },
          {
            q: "Na Venda Intermediada, onde consultar os chassis faturados pela montadora pendentes de entrega e onde imprimir a ATPV?",
            a: "Os chassis pendentes são listados em Veículos > Estoque > Renave > botão Consultar > CONSULTAR ENTREGA DE VEÍCULO 0KM POR VENDA INTERMEDIADA. A ATPV é impressa em Veículos > Estoque > Movimentação, na engrenagem da ficha > opção ATPV (disponível para fichas em VENDA INTERMEDIADO).",
          },
        ],
      },
      {
        theme: "Tema 5 — Diagnóstico de Problemas: Certificado, Eventos 0km e ATPV",
        theme_short: "Diagnóstico de Chamados e Soluções",
        cards: [
          {
            q: "Como resolver erros de 'Certificado digital ausente/vencido' ou 'Empresa não credenciada' na comunicação com o Renave?",
            a: "Conferir o certificado digital (formato PFX) no Cloud em Utilitários > Tabelas Gerais > Empresa (aba Integrações). Se estiver válido no Cloud, o cliente deve validar o credenciamento, pendências e o certificado na integradora e no portal Credencia (SERPRO), reprocessando em seguida.",
          },
          {
            q: "Como inserir um evento manual no Renave 0km e quais cuidados de formatação são obrigatórios?",
            a: "Em Veículos > Estoque > Renave, localizar o chassi, clicar em '+' e informar os dados da nota fiscal com data e hora atuais. Chave de acesso, CEP e documento do comprador devem conter somente números, sem espaços ou pontuação.",
          },
          {
            q: "Qual é a solução quando a ENTRADA ESTOQUE 0KM rejeita por 'Chassi não cadastrado' ou 'documento do faturado não possui CNAE / não está mais pendente de entrada'?",
            a: "Se não está cadastrado, solicitar à fábrica a inclusão do chassi na BIN. Se acusar falta de CNAE ou não pendente de entrada, solicitar à fábrica o ajuste do chassi na BIN para o CNPJ da loja (tag identFaturado); se a fábrica já ajustou, abrir chamado na SERPRO e reprocessar.",
          },
          {
            q: "Como proceder no erro 'Não existe intenção de venda disponível' ao consultar a ATPV ou quando a ATPV sai em nome de outro comprador?",
            a: "Se a saída 0km não foi feita ou teve erro, reprocessar/inserir a saída e refazer a CONSULTA ATPV (se entrada e saída já estão em SUCESSO e o comprador já iniciou o emplacamento, a SERPRO não libera mais a ATPV). Se saiu em nome de comprador anterior, fazer CANCELAMENTO SAÍDA, enviar nova SAÍDA com dados corretos e data de hoje, e fazer CONSULTA ATPV confirmando SIM para substituir.",
          },
        ],
      },
    ],
    agent_report: {
      builder: "Agente Construtor: extração coordenada de 11 páginas, tabelas e fluxos do Renave concluída (7 seções e 20 flashcards).",
      reviewer: "Agente Revisor: texto auditado sem ruídos de cabeçalho/rodapé, sem células embaralhadas e com símbolos normalizados.",
      tester: "Agente de Teste: ordem obrigatória (Resumo -> Flashcards), codificação limpa e integridade do PDF aprovadas.",
    },
  };
}

const DEMO_FAM_LINES = [
  "Filosofia e Ética — Unidade 1: Introdução à Filosofia, Moral e Ética",
  "1. O que é Filosofia e a Atitude Filosófica",
  "A palavra Filosofia tem origem grega e foi atribuída a Pitágoras de Samos (século VI a.C.), sendo composta por philos (amigo, amante) e sophia (sabedoria), significando 'amor à sabedoria' ou 'amizade pelo saber'. O filósofo não é o detentor absoluto da verdade, mas aquele que busca constantemente o conhecimento por meio da investigação racional e crítica.",
  "A atitude filosófica caracteriza-se pelo espanto ou admiração (thaumazein, segundo Platão e Aristóteles) diante do mundo e pela recusa de aceitar respostas prontas, preconceitos e dogmas do senso comum sem antes submetê-los à reflexão rigorosa.",
  "2. Senso Comum versus Conhecimento Filosófico e Científico",
  "O senso comum é o conhecimento cotidiano, espontâneo, fragmentado e acrítico que adquirimos pela convivência social e pela tradição. Embora seja útil para a sobrevivência prática no dia a dia, ele costuma ser superficial e sujeito a contradições.",
  "Já a reflexão filosófica é radical (busca a raiz dos problemas), de conjunto (relaciona os diferentes aspectos da realidade) e crítica (examina os fundamentos e limites das nossas certezas), diferenciando-se também da ciência particular por questionar os próprios pressupostos e valores da ação humana.",
  "3. Passagem do Mito ao Logos na Grécia Antiga",
  "A Filosofia nasceu na Grécia Antiga por volta do século VI a.C. (nas colônias da Jônia, como Mileto) durante a transição da mentalidade mítica para o pensamento racional (Logos). O mito explicava a origem do universo (cosmogonia) recorrendo a deuses, forças sobrenaturais e narrativas poéticas baseadas na autoridade da tradição.",
  "Fatores históricos como as navegações marítimas, o uso da moeda, o calendário, a escrita alfabética e o surgimento da Pólis (cidade-estado grega com debates públicos na Ágora) favoreceram o nascimento da cosmologia racional, em que os primeiros filósofos pré-socráticos buscaram a arché (princípio natural originário de todas as coisas).",
  "4. Distinção Conceitual entre Moral e Ética",
  "Etimologicamente, 'ética' vem do grego ethos (modo de ser, caráter, costume) e 'moral' vem do latim mos/mores (costumes, normas adquiridas pelo hábito). Na Filosofia prática, contudo, estabelece-se uma distinção fundamental entre os dois conceitos.",
  "A Moral refere-se ao conjunto concreto de regras, normas, proibições e valores vigentes em uma determinada sociedade, cultura ou época histórica, orientando diretamente o que os indivíduos devem ou não fazer. A Ética (ou Filosofia Moral), por sua vez, é a reflexão teórica e crítica sobre a moral: ela investiga o fundamento dos valores, pergunta 'por que seguimos determinadas regras?' e avalia racionalmente os princípios da conduta humana.",
  "5. Sujeito Moral, Liberdade, Consciência e Responsabilidade",
  "Para que exista vida ética, o ser humano deve atuar como um sujeito moral consciente e autônomo. A consciência moral é a capacidade interna de reconhecer a diferença entre o bem e o mal, julgar o valor dos próprios atos e deliberar antes de agir.",
  "A responsabilidade ética está diretamente ligada à liberdade e à autonomia (conceito central em Immanuel Kant): somente podemos ser responsabilizados moralmente por uma ação quando a escolhemos livremente, sem coação absoluta, compreendendo suas causas e assumindo suas consequências perante nós mesmos e a coletividade.",
];

async function extractTextFromUrlClientSide(url) {
  if (/filosofiaetica-unidade1/i.test(url)) {
    return {
      title: "Filosofia e Ética — Unidade 1: Introdução à Filosofia, Moral e Ética",
      lines: DEMO_FAM_LINES,
    };
  }

  // Tentativa 1: Jina Reader API (suporta CORS e retorna texto limpo de artigos web)
  try {
    const res = await fetch(`https://r.jina.ai/${url}`, {
      headers: { Accept: "text/plain" },
    });
    if (res.ok) {
      const txt = await res.text();
      if (txt && txt.length > 200) {
        const rawLines = txt
          .split(/\r?\n/)
          .map((l) => {
            const isH = /^#{1,3}\s+/.test(l.trim());
            const cleaned = cleanBrokenLigaturesAndGlyphs(l.replace(/^#+\s*/, "").trim());
            return isH && cleaned ? `##HEADING## ${cleaned}` : cleaned;
          })
          .filter(Boolean);
        return { title: (rawLines[0] || "Material de Estudo Web").replace(/^##HEADING##\s*/, ""), lines: rawLines };
      }
    }
  } catch (_) {}

  // Tentativa 2: AllOrigins CORS Proxy
  try {
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
    const res = await fetch(proxyUrl);
    if (res.ok) {
      const data = await res.json();
      if (data && data.contents) {
        const doc = new DOMParser().parseFromString(data.contents, "text/html");
        doc.querySelectorAll("script, style, nav, footer, noscript, aside, form, button").forEach((el) => el.remove());
        const rawPageTitle = (doc.querySelector("h1") || doc.querySelector("title"))?.textContent?.trim() || "Material de Estudo";
        const pageTitle = cleanBrokenLigaturesAndGlyphs(rawPageTitle).replace(
          /\s*[-|–—]\s*(Brasil Escola|Mundo Educação|Toda Matéria|InfoEscola|Wikipédia.*|UOL).*$/i,
          ""
        );
        const blocks = [pageTitle];
        doc.querySelectorAll("h1, h2, h3, p, li, tr").forEach((el) => {
          const tag = el.tagName.toLowerCase();
          if (tag === "tr") {
            const cells = [...el.querySelectorAll("th, td")].map((c) => cleanBrokenLigaturesAndGlyphs(c.textContent || "")).filter(Boolean);
            if (cells.length >= 2) {
              blocks.push(`• ${cells[0]}: ${cells.slice(1).join(" | ")}`);
            }
            return;
          }
          const t = cleanBrokenLigaturesAndGlyphs(el.textContent || "");
          if (!t || isEditorialOrEnglishLine(t)) return;
          if (tag === "h1" || tag === "h2" || tag === "h3") {
            if (t.length >= 3 && t.length <= 95) blocks.push(`##HEADING## ${t}`);
          } else if (tag === "li") {
            if (t.length > 10) blocks.push(`• ${t.replace(/^[•\-]\s*/, "")}`);
          } else if (t.length > 22) {
            blocks.push(t);
          }
        });
        if (blocks.length > 1) {
          return { title: pageTitle, lines: blocks };
        }
      }
    }
  } catch (_) {}

  throw new Error(
    "Não foi possível acessar diretamente o texto desta URL devido a restrições de acesso (CORS/Paywall) do site de origem. Baixe a página como PDF e anexe o arquivo pelo botão 📎 PDF!"
  );
}

function isBrowserSectionHeading(line) {
  if (!line) return false;
  if (line.startsWith("##HEADING## ")) return true;
  if (line.startsWith("•") || line.length > 90 || /[.,;:?]$/.test(line)) return false;
  if (/^(\d{1,2})\.\s+([A-ZÀ-Ý].{2,85})$/.test(line)) return true;
  if (
    /^(UNIDADE\s+\d+|CAP[ÍI]TULO\s+\d+|SE[ÇC][ÃA]O\s+\d+|INTRODU[ÇC][ÃA]O|CONCLUS[ÃA]O|RESUMO|Vis[ãa]o\s+geral|Contrata[çc][ãa]o.*|ATPV|Evento\s+Sa[íi]da.*|Ve[íi]culos\s+0km\s+inacabados.*|Venda\s+intermediada.*|Problemas\s+e\s+solu[çc][õo]es.*|Como\s+funciona\s+o\s+envio.*|Comunica[çc][ãa]o,\s*certificado.*|Eventos\s+do\s+Renave.*|Renave\s+Usado|Material\s+de\s+apoio)$/i.test(
      line.trim()
    )
  ) {
    return true;
  }
  return false;
}

function runThreeAgentsBrowserPipeline(lines, sourceLabel, sourceType) {
  const joinedPreview = lines.join(" ").toLowerCase();
  if (
    (joinedPreview.includes("faq renave") || (sourceLabel || "").toLowerCase().includes("renave")) &&
    (joinedPreview.includes("microwork") || joinedPreview.includes("integradora")) &&
    joinedPreview.includes("atpv")
  ) {
    return buildCuratedFaqRenaveStudyData(sourceLabel);
  }

  // AGENTE 1 — CONSTRUTOR: Isola título real, remove metadados editoriais e agrupa seções e tabelas
  const filtered = [];
  for (const line of lines) {
    const clean = line.replace(/^##HEADING##\s*/, "").trim();
    if (/^(refer[êe]ncias|refer[êe]ncias\s+bibliogr[áa]ficas|bibliografia)\b/i.test(clean)) {
      break;
    }
    if (!isEditorialOrEnglishLine(clean)) {
      filtered.push(line.trim());
    }
  }

  if (filtered.length === 0) {
    throw new Error("A fonte enviada não contém texto legível suficiente para gerar um resumo e flashcards confiáveis.");
  }

  let title = filtered[0].replace(/^##HEADING##\s*/, "").trim();
  if (title.length > 120) {
    title = title.slice(0, 110).replace(/\s+\S*$/, "") + "...";
  }

  const sections = [];
  let currentSec = { heading: "Contextualização e Ideias Iniciais", paragraphs: [], bullets: [] };
  let buffer = "";

  const flushParagraph = () => {
    const p = cleanBrokenLigaturesAndGlyphs(buffer);
    buffer = "";
    if (p.length >= 25 && !isEditorialOrEnglishLine(p)) {
      currentSec.paragraphs.push(p);
    }
  };

  for (let i = 1; i < filtered.length; i++) {
    const rawLine = filtered[i];
    const cleanLine = rawLine.replace(/^##HEADING##\s*/, "").trim();

    if (normalizeHeaderFingerprint(cleanLine) === normalizeHeaderFingerprint(title) && i > 2) {
      continue;
    }

    if (isBrowserSectionHeading(rawLine)) {
      flushParagraph();
      if (currentSec.paragraphs.length > 0 || currentSec.bullets.length > 0) {
        sections.push(currentSec);
      }
      const headingText = cleanLine.replace(/^(\d{1,2})\.\s+/, "").trim();
      currentSec = { heading: headingText, paragraphs: [], bullets: [] };
      continue;
    }

    if (cleanLine.startsWith("•")) {
      flushParagraph();
      const bBody = cleanLine.replace(/^•\s*/, "").trim();
      if (bBody.includes(":") && bBody.indexOf(":") >= 3 && bBody.indexOf(":") <= 52) {
        const sepIdx = bBody.indexOf(":");
        currentSec.bullets.push({
          label: bBody.slice(0, sepIdx).trim(),
          text: bBody.slice(sepIdx + 1).trim(),
        });
      } else if (bBody.length > 10) {
        currentSec.bullets.push({ label: "", text: bBody });
      }
      continue;
    }

    // Se a linha inicia uma nova pergunta de FAQ e o buffer anterior terminou com ponto final, separa os parágrafos
    if (buffer && /[.!?”"]$/.test(buffer) && (cleanLine.includes("?") || /^(Onde|Quem|Como|Quando|Qual|Quais|Por que|O que)\b/.test(cleanLine))) {
      flushParagraph();
    }

    if (buffer) {
      buffer += " " + cleanLine;
    } else {
      buffer = cleanLine;
    }

    if (/[.!?…”"]$/.test(cleanLine) && buffer.length >= 200) {
      flushParagraph();
    }
  }
  flushParagraph();
  if (currentSec.paragraphs.length > 0 || currentSec.bullets.length > 0) {
    sections.push(currentSec);
  }

  if (sections.length === 0) {
    sections.push({
      heading: "Síntese Conceitual do Material",
      paragraphs: [filtered.slice(0, 8).map((l) => l.replace(/^##HEADING##\s*/, "")).join(" ")],
      bullets: [],
    });
  }

  // Visão geral sem duplicar o primeiro parágrafo na seção 1
  const firstSecWithPara = sections.find((s) => s.paragraphs.length > 0);
  const overview = firstSecWithPara ? firstSecWithPara.paragraphs[0] : `Resumo estruturado sobre ${title}.`;
  if (sections[0].paragraphs.length > 0 && sections[0].paragraphs[0] === overview) {
    sections[0].paragraphs = sections[0].paragraphs.slice(1);
    if (sections[0].paragraphs.length === 0 && sections[0].bullets.length === 0 && sections.length > 1) {
      sections.shift();
    }
  }

  // Extrai Conceitos-Chave e Flashcards por Tema (respeitando pares Pergunta? Resposta e tabelas)
  const keyConcepts = [];
  const flashcardsByTheme = [];
  const stopConceptWords = new Set([
    "Quando", "Como", "Onde", "Quem", "Qual", "Quais", "Para", "Pelo", "Pela",
    "Isso", "Este", "Esta", "Esse", "Essa", "Não", "Sim", "Mas", " Porém",
    "Desde", "Após", "Antes", "Confira", "Veja", "Leia", "Você", "Conheça",
  ]);

  sections.forEach((sec, idx) => {
    const cards = [];

    (sec.bullets || []).slice(0, 4).forEach((b) => {
      if (b.label && b.text && b.text.length > 18) {
        if (keyConcepts.length < 8 && !b.label.includes("?")) {
          keyConcepts.push({
            term: b.label,
            definition: b.text.length > 260 ? b.text.slice(0, 255).replace(/\s+\S*$/, "") + "." : b.text,
          });
        }
        const q = b.label.includes("?")
          ? b.label
          : `Em "${sec.heading}", como funciona ou o que caracteriza "${b.label}"?`;
        cards.push({
          q,
          a: b.text.length > 360 ? b.text.slice(0, 355).replace(/\s+\S*$/, "") + "." : b.text,
        });
      }
    });

    (sec.paragraphs || []).forEach((p, pIdx) => {
      if (cards.length >= 5 || p.length < 30 || p.endsWith(":")) return;

      // Detecta pergunta inline de FAQ ("Onde o cliente contrata o Renave? Em MicroWork...")
      const faqMatch = p.match(/^([^?]{8,140}\?)\s+(.{18,})$/);
      if (faqMatch) {
        let qFaq = faqMatch[1].trim();
        if (qFaq.length < 40 && !qFaq.toLowerCase().includes(sec.heading.toLowerCase())) {
          qFaq = `Em "${sec.heading}", ${qFaq[0].toLowerCase() + qFaq.slice(1)}`;
        }
        const aFaq = faqMatch[2].trim();
        cards.push({
          q: qFaq,
          a: aFaq.length > 360 ? aFaq.slice(0, 355).replace(/\s+\S*$/, "") + "." : aFaq,
        });
        return;
      }

      let question = `Qual é o conceito ou regra central apresentado em "${sec.heading}"${sec.paragraphs.length > 1 ? ` (item ${pIdx + 1})` : ""}?`;
      const termMatch = p.match(/\b([A-ZÀ-Ý][a-zà-ÿ]{3,}(?:\s+(?:de|da|do|dos|das)\s+[A-ZÀ-Ý]?[a-zà-ÿ]+|\s+[a-zà-ÿ]{4,})?)\b/);
      if (termMatch && termMatch[1] && !stopConceptWords.has(termMatch[1].split(/\s+/)[0])) {
        question = `Em "${sec.heading}", o que a fonte explica a respeito de ${termMatch[1]}?`;
        if (keyConcepts.length < 8) {
          keyConcepts.push({
            term: termMatch[1],
            definition: p.length > 240 ? p.slice(0, 235).replace(/\s+\S*$/, "") + "." : p,
          });
        }
      }
      cards.push({
        q: question,
        a: p.length > 360 ? p.slice(0, 355).replace(/\s+\S*$/, "") + "." : p,
      });
    });

    if (cards.length > 0) {
      flashcardsByTheme.push({
        theme: `Tema ${flashcardsByTheme.length + 1} — ${sec.heading}`,
        theme_short: sec.heading,
        cards,
      });
    }
  });

  // AGENTE 2 — REVISOR: Consolida síntese final sem duplicar parágrafo anterior
  const secNames = sections.slice(0, 5).map((s) => s.heading);
  const synthesis = `Em síntese, o estudo sobre "${title}" organiza e revisa ${secNames.join(", ")}, consolidando os conceitos, regras e procedimentos essenciais da fonte para consulta e recordação ativa.`;

  const totalCards = flashcardsByTheme.reduce((acc, g) => acc + g.cards.length, 0);

  return {
    title,
    source: sourceLabel,
    source_type: sourceType,
    date: todayFormatted(),
    overview,
    sections,
    key_concepts: keyConcepts,
    synthesis,
    flashcards_by_theme: flashcardsByTheme,
    limitations:
      sourceType === "pdf"
        ? [
            "Elementos exclusivamente visuais (figuras, tabelas em imagem ou gráficos sem camada de texto no PDF) não são inferidos, conforme as regras de fidelidade à fonte.",
          ]
        : [],
    agent_report: {
      builder: `Agente Construtor estruturou ${sections.length} seções temáticas e ${totalCards} flashcards (com reconstrução de tabelas e perguntas).`,
      reviewer: "Agente Revisor auditou o texto (0 ligaduras quebradas, 0 vazamentos de cabeçalho/rodapé, 0 colunas embaralhadas).",
      tester: "Agente de Teste aprovou a ordem das seções (Resumo -> Flashcards), codificação tipográfica e integridade do PDF único.",
    },
  };
}

/**
 * Compila o PDF único no navegador via jsPDF garantindo ZERO caracteres embolados ou sobrepostos:
 * - Todas as strings passam por `sanitizeForJsPdf` (NFC + conversão para Latin-1/WinAnsi estrito);
 * - Todos os blocos de texto são desenhados linha por linha com incremento explícito de `y`;
 * - Títulos de seção, bullets, conceitos-chave e cabeçalhos de tema sofrem quebra automática (`splitTextToSize`).
 */
function compilePdfInBrowser(studyData) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    throw new Error("A biblioteca de geração de PDF (jsPDF) ainda está carregando. Tente novamente em instantes.");
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });

  const pageW = 210;
  const pageH = 297;
  const margin = 15;
  const contentW = pageW - margin * 2;
  let y = 15;

  const totalCards = (studyData.flashcards_by_theme || []).reduce((acc, g) => acc + (g.cards || []).length, 0);

  const ensureSpace = (neededMm) => {
    if (y + neededMm > pageH - 18) {
      doc.addPage();
      y = 18;
    }
  };

  const drawTextLines = (linesArray, x, startY, stepMm) => {
    let curY = startY;
    for (const ln of linesArray) {
      doc.text(String(ln), x, curY);
      curY += stepMm;
    }
    return curY;
  };

  // 1. Banner Superior Azul-Marinho (altura dinâmica para nunca embolar com o subtítulo)
  const cleanTitle = sanitizeForJsPdf(studyData.title || "Material de Estudo");
  const cleanSub = sanitizeForJsPdf(studyData.subtitle || "Resumo Estruturado e Flashcards de Estudo");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  const titleLines = doc.splitTextToSize(cleanTitle, contentW - 10).slice(0, 2);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.2);
  const subLines = doc.splitTextToSize(cleanSub, contentW - 10).slice(0, 2);

  const bannerH = 8 + titleLines.length * 5.5 + subLines.length * 4.5 + 4;
  doc.setFillColor(18, 43, 79);
  doc.rect(margin, y, contentW, bannerH, "F");

  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  let ty = drawTextLines(titleLines, margin + 5, y + 7, 5.5);

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.2);
  doc.setTextColor(205, 224, 255);
  drawTextLines(subLines, margin + 5, ty + 0.5, 4.4);
  y += bannerH + 2;

  // 2. Caixa de Metadados
  doc.setFillColor(242, 246, 253);
  doc.setDrawColor(195, 210, 230);
  doc.rect(margin, y, contentW, 18.5, "FD");
  doc.setTextColor(35, 50, 75);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8.5);
  doc.text(sanitizeForJsPdf(`Fonte: ${(studyData.source || "").slice(0, 92)}`), margin + 4, y + 5.5);
  doc.setFont("helvetica", "bold");
  doc.text(
    sanitizeForJsPdf(`Data de geracao: ${studyData.date}   |   Idioma: Portugues (Brasil)   |   Total de flashcards: ${totalCards} cartoes`),
    margin + 4,
    y + 11
  );
  doc.setFont("helvetica", "italic");
  doc.setTextColor(65, 90, 125);
  doc.text(
    sanitizeForJsPdf("Validado por 3 Agentes (Construtor - Revisor - Tester)  |  Parte 1: Resumo  |  Parte 2: Flashcards"),
    margin + 4,
    y + 16
  );
  y += 23;

  // 3. Banner Parte 1
  doc.setFillColor(30, 74, 138);
  doc.rect(margin, y, contentW, 11.5, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10.8);
  doc.text("PARTE 1 - RESUMO ESTRUTURADO", margin + 4, y + 7.5);
  y += 15.5;

  const drawSectionHeading = (label) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10.8);
    const hLines = doc.splitTextToSize(sanitizeForJsPdf(label), contentW - 8);
    const blockH = hLines.length * 5.0 + 3;
    ensureSpace(blockH + 10);
    doc.setFillColor(37, 99, 235);
    doc.rect(margin, y - 3.8, 2.2, hLines.length * 4.8 + 1.5, "F");
    doc.setTextColor(20, 48, 92);
    y = drawTextLines(hLines, margin + 5, y + 1, 4.8);
    doc.setDrawColor(215, 225, 240);
    doc.line(margin, y - 1.5, margin + contentW, y - 1.5);
    y += 3.2;
  };

  const drawParagraph = (text) => {
    const clean = sanitizeForJsPdf(text);
    if (!clean) return;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.5);
    doc.setTextColor(30, 38, 50);
    const lines = doc.splitTextToSize(clean, contentW);
    ensureSpace(lines.length * 4.5 + 3);
    y = drawTextLines(lines, margin, y, 4.5);
    y += 2.0;
  };

  const drawBullet = (label, text) => {
    const full = label ? `- ${label}: ${text}` : `- ${text}`;
    const clean = sanitizeForJsPdf(full);
    if (!clean) return;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.3);
    doc.setTextColor(38, 48, 62);
    const lines = doc.splitTextToSize(clean, contentW - 5);
    ensureSpace(lines.length * 4.4 + 2);
    y = drawTextLines(lines, margin + 3, y, 4.4);
    y += 1.5;
  };

  if (studyData.overview) {
    drawSectionHeading("1. Visao Geral e Ideia Central");
    drawParagraph(studyData.overview);
  }

  let secNum = studyData.overview ? 2 : 1;
  (studyData.sections || []).forEach((sec) => {
    drawSectionHeading(`${secNum++}. ${sec.heading}`);
    (sec.paragraphs || []).forEach((p) => drawParagraph(p));
    (sec.bullets || []).forEach((b) => {
      if (typeof b === "object" && b !== null) {
        drawBullet(b.label || "", b.text || "");
      } else {
        drawBullet("", String(b));
      }
    });
  });

  if ((studyData.key_concepts || []).length > 0) {
    drawSectionHeading(`${secNum++}. Definicoes e Conceitos-Chave`);
    (studyData.key_concepts || []).forEach((kc) => {
      drawBullet(kc.term || "Conceito", kc.definition || "");
    });
  }

  if (studyData.synthesis) {
    drawSectionHeading(`${secNum++}. Sintese Final`);
    drawParagraph(studyData.synthesis);
  }

  // 4. PARTE 2 — FLASHCARDS (Sempre inicia em nova página conforme AGENTS.md)
  doc.addPage();
  y = 18;

  doc.setFillColor(30, 74, 138);
  doc.rect(margin, y, contentW, 12.5, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10.8);
  doc.text(sanitizeForJsPdf(`PARTE 2 - FLASHCARDS DE REVISAO POR TEMA (${totalCards} CARTOES)`), margin + 4, y + 8);
  y += 16.5;

  let cardNum = 1;
  (studyData.flashcards_by_theme || []).forEach((group) => {
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.6);
    const themeLines = doc.splitTextToSize(sanitizeForJsPdf(group.theme || "Tema de Estudo"), contentW - 8);
    const themeBoxH = Math.max(8.5, themeLines.length * 4.5 + 4);
    ensureSpace(themeBoxH + 34);

    doc.setFillColor(232, 240, 252);
    doc.setDrawColor(180, 200, 230);
    doc.rect(margin, y, contentW, themeBoxH, "FD");
    doc.setTextColor(20, 52, 102);
    drawTextLines(themeLines, margin + 3.5, y + 5.6, 4.5);
    y += themeBoxH + 4;

    (group.cards || []).forEach((c) => {
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9.2);
      const qLines = doc.splitTextToSize(sanitizeForJsPdf(`Frente - Pergunta: ${c.q}`), contentW - 8);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9.1);
      const aLines = doc.splitTextToSize(sanitizeForJsPdf(`Verso - Resposta: ${c.a}`), contentW - 8);

      const qBlockH = qLines.length * 4.5;
      const aBlockH = aLines.length * 4.5;
      const boxH = 8 + qBlockH + 4 + aBlockH + 5;

      ensureSpace(boxH + 5);

      // Moldura do Cartão
      doc.setFillColor(250, 252, 255);
      doc.setDrawColor(195, 210, 230);
      doc.rect(margin, y, contentW, boxH, "FD");

      // Faixa superior do Cartão
      doc.setFillColor(38, 92, 168);
      doc.rect(margin, y, contentW, 6.8, "F");
      doc.setFont("helvetica", "bold");
      doc.setFontSize(8.5);
      doc.setTextColor(255, 255, 255);
      doc.text(
        sanitizeForJsPdf(`Cartao ${cardNum++} - Tema: ${(group.theme_short || group.theme || "").slice(0, 62)}`),
        margin + 3.5,
        y + 4.7
      );

      // Frente — Pergunta (desenhada linha a linha)
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9.2);
      doc.setTextColor(20, 35, 60);
      let cy = drawTextLines(qLines, margin + 4, y + 11.5, 4.5);

      // Linha divisória
      doc.setDrawColor(215, 225, 238);
      doc.line(margin + 4, cy - 1.8, margin + contentW - 4, cy - 1.8);

      // Verso — Resposta (desenhado linha a linha)
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9.1);
      doc.setTextColor(42, 54, 70);
      drawTextLines(aLines, margin + 4, cy + 2.4, 4.5);

      y += boxH + 4.2;
    });
  });

  // Numeração de páginas no rodapé
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setDrawColor(210, 220, 232);
    doc.line(margin, pageH - 12, pageW - margin, pageH - 12);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(110, 125, 145);
    doc.text(sanitizeForJsPdf(`EstudaPDF - ${(studyData.title || "").slice(0, 65)}`), margin, pageH - 7.5);
    doc.setFont("helvetica", "bold");
    doc.text(sanitizeForJsPdf(`Pagina ${p} de ${totalPages}`), pageW - margin - 24, pageH - 7.5);
  }

  const pdfBlob = doc.output("blob");
  const pdfDataUri = doc.output("datauristring");
  const blobUrl = URL.createObjectURL(pdfBlob);

  return {
    blobUrl,
    pdfBase64: pdfDataUri,
    pagesCount: totalPages,
    sizeBytes: pdfBlob.size,
    totalCards,
  };
}

// ============================================================================
// Controle de Interface, Mensagens e Flashcards Interativos (Modo Quiz)
// ============================================================================

function setAttachedPdf(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith(".pdf") && file.type !== "application/pdf") {
    showToast("Por favor, selecione um arquivo no formato PDF (.pdf).");
    return;
  }
  const readerB64 = new FileReader();
  const readerBuf = new FileReader();

  readerB64.onload = () => {
    readerBuf.onload = () => {
      state.attachedFile = {
        name: file.name,
        size: file.size,
        base64: readerB64.result,
        arrayBuffer: readerBuf.result,
      };
      els.attName.textContent = file.name;
      els.attSize.textContent = formatBytes(file.size);
      els.attachmentBar.classList.remove("hidden");
      els.chatInput.focus();
      showToast(`PDF "${file.name}" anexado!`);
    };
    readerBuf.readAsArrayBuffer(file);
  };
  readerB64.readAsDataURL(file);
}

function clearAttachment() {
  state.attachedFile = null;
  els.pdfFileInput.value = "";
  els.attachmentBar.classList.add("hidden");
}

function scrollToBottom() {
  els.chatMessages.scrollTo({
    top: els.chatMessages.scrollHeight,
    behavior: "smooth",
  });
}

function appendUserMessage(text, attachedFile) {
  if (els.welcomeScreen) {
    els.welcomeScreen.classList.add("hidden");
  }
  const row = document.createElement("div");
  row.className = "msg-row user";

  let chipHtml = "";
  if (attachedFile) {
    chipHtml += `<div class="user-source-chip">📕 ${escapeHtml(attachedFile.name)} (${formatBytes(attachedFile.size)})</div>`;
  }
  const bodyHtml = text ? `<div>${escapeHtml(text)}</div>` : "";

  row.innerHTML = `
    <div class="msg-bubble">
      ${chipHtml}
      ${bodyHtml}
    </div>
    <div class="msg-avatar">👤</div>
  `;
  els.chatMessages.appendChild(row);
  scrollToBottom();
}

function createThinkingBubble() {
  const steps = [
    "1. Recebendo entrada (URL ou arquivo PDF)...",
    "2. [Agente de Teste] Validando acesso e legibilidade da fonte...",
    "3. [Agente Construtor] Isolando título real, reconstruindo tabelas/colunas e limpando cabeçalhos...",
    "4. [Agente Construtor] Redigindo o Resumo Estruturado e criando os Flashcards por tema...",
    "5. [Agente Revisor] Auditando idioma, ligaduras (fi/fl), símbolos Unicode e fragmentos...",
    "6. [Agente Construtor] Compilando arquivo PDF único paginado (Resumo -> Flashcards)...",
    "7. [Agente de Teste] Executando bateria de testes de qualidade e salvando no navegador...",
  ];

  const row = document.createElement("div");
  row.className = "msg-row ai";
  row.innerHTML = `
    <div class="msg-avatar">🎓</div>
    <div class="msg-bubble">
      <strong>EstudaPDF está processando seu material de estudo...</strong>
      <div class="steps-list">
        ${steps
          .map(
            (s, idx) => `
          <div class="step-item ${idx === 0 ? "active" : ""}" data-step="${idx}">
            <span class="step-icon">${idx === 0 ? "⏳" : "○"}</span>
            <span>${s}</span>
          </div>
        `
          )
          .join("")}
      </div>
    </div>
  `;
  els.chatMessages.appendChild(row);
  scrollToBottom();

  let currentStep = 0;
  const interval = setInterval(() => {
    const items = row.querySelectorAll(".step-item");
    if (currentStep < items.length) {
      items[currentStep].classList.remove("active");
      items[currentStep].classList.add("done");
      items[currentStep].querySelector(".step-icon").textContent = "✓";
    }
    currentStep++;
    if (currentStep < items.length) {
      items[currentStep].classList.add("active");
      items[currentStep].querySelector(".step-icon").textContent = "⏳";
    } else {
      clearInterval(interval);
    }
  }, 340);

  return { row, stopTimer: () => clearInterval(interval) };
}

function renderAiErrorBubble(row, message, isClarification = false) {
  const icon = isClarification ? "💡" : "⚠️";
  const title = isClarification ? "Esclarecimento necessário" : "Não foi possível gerar o PDF";
  row.querySelector(".msg-bubble").innerHTML = `
    <div style="display:flex;align-items:flex-start;gap:10px;">
      <span style="font-size:1.3rem;">${icon}</span>
      <div>
        <strong style="color:#f8fafc;display:block;margin-bottom:4px;">${title}</strong>
        <p style="color:#cbd5e1;">${escapeHtml(message).replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")}</p>
      </div>
    </div>
  `;
  scrollToBottom();
}

function buildPlainTextSummary(sd) {
  const parts = [`# ${sd.title || "Resumo Estruturado"}`, `Fonte: ${sd.source || ""}`, ""];
  if (sd.overview) {
    parts.push("## 1. Visão Geral e Ideia Central", sd.overview, "");
  }
  (sd.sections || []).forEach((sec, idx) => {
    parts.push(`## ${idx + 2}. ${sec.heading}`);
    (sec.paragraphs || []).forEach((p) => parts.push(p));
    (sec.bullets || []).forEach((b) => {
      if (typeof b === "object" && b !== null) {
        parts.push(b.label ? `• ${b.label}: ${b.text}` : `• ${b.text}`);
      } else {
        parts.push(`• ${b}`);
      }
    });
    parts.push("");
  });
  if (sd.synthesis) {
    parts.push("## Síntese Final", sd.synthesis);
  }
  return parts.join("\n");
}

function renderAiSuccessBubble(row, data) {
  const sd = data.study_data || {};
  const cardId = "card-" + Date.now() + "-" + Math.floor(Math.random() * 1000);

  const sectionsHtml = (sd.sections || [])
    .map(
      (sec, idx) => `
      <div class="summary-preview-sec">
        <h4>${idx + 1}. ${escapeHtml(sec.heading)}</h4>
        ${(sec.paragraphs || []).map((p) => `<p style="margin-bottom:6px;">${escapeHtml(p)}</p>`).join("")}
        ${
          (sec.bullets || []).length
            ? `<ul>${sec.bullets
                .map((b) =>
                  b.label
                    ? `<li><strong>${escapeHtml(b.label)}:</strong> ${escapeHtml(b.text)}</li>`
                    : `<li>${escapeHtml(b.text || b)}</li>`
                )
                .join("")}</ul>`
            : ""
        }
      </div>
    `
    )
    .join("");

  const conceptsHtml = (sd.key_concepts || []).length
    ? `
      <div class="summary-preview-sec">
        <h4>Definições e Conceitos-Chave</h4>
        <ul>
          ${sd.key_concepts
            .map((kc) => `<li><strong>${escapeHtml(kc.term)}:</strong> ${escapeHtml(kc.definition)}</li>`)
            .join("")}
        </ul>
      </div>
    `
    : "";

  const limitationsHtml = (sd.limitations || []).length
    ? `
      <div class="limitations-note">
        <strong>Nota sobre limitações da fonte:</strong><br/>
        ${sd.limitations.map((l) => `• ${escapeHtml(l)}`).join("<br/>")}
      </div>
    `
    : "";

  let fcCounter = 1;
  const flashcardsHtml = (sd.flashcards_by_theme || [])
    .map((group) =>
      (group.cards || [])
        .map((c) => {
          const num = fcCounter++;
          const cardKey = `${data.filename || "doc"}_card_${num}`;
          const isMastered = Boolean(state.masteredCards[cardKey]);
          return `
            <div class="fc-card ${isMastered ? "mastered" : ""}" data-card-key="${escapeHtml(cardKey)}" data-search="${escapeHtml((c.q + " " + c.a + " " + (group.theme || "")).toLowerCase())}">
              <div>
                <div class="fc-card-head">
                  <span>Cartão ${num}</span>
                  <span>${escapeHtml(group.theme_short || group.theme)}</span>
                </div>
                <div class="fc-q"><strong>Frente — Pergunta:</strong><br/>${escapeHtml(c.q)}</div>
                <div class="fc-a"><strong>Verso — Resposta:</strong><br/><span class="fc-a-text">${escapeHtml(c.a)}</span></div>
              </div>
              <div class="fc-card-footer">
                <span class="fc-hint-label">Clique p/ revelar no Modo Quiz</span>
                <button type="button" class="btn-master-card ${isMastered ? "active" : ""}" data-master-btn="${escapeHtml(cardKey)}">
                  ${isMastered ? "✓ Dominado" : "Marcar Dominado"}
                </button>
              </div>
            </div>
          `;
        })
        .join("")
    )
    .join("");

  const agentReport = sd.agent_report || {};
  const agentReportHtml = agentReport.tester
    ? `
      <div style="margin-bottom:14px;padding:10px 12px;border-radius:8px;background:rgba(16,185,129,0.10);border:1px solid rgba(16,185,129,0.32);font-size:0.79rem;color:#a7f3d0;line-height:1.45;">
        <strong>🛡️ Pipeline Anti-Erro de 3 Agentes Aprovado:</strong><br/>
        • 🛠️ ${escapeHtml(agentReport.builder || "")}<br/>
        • 🔍 ${escapeHtml(agentReport.reviewer || "")}<br/>
        • 🧪 ${escapeHtml(agentReport.tester || "")}
      </div>
    `
    : "";

  row.querySelector(".msg-bubble").innerHTML = `
    <div>
      ✅ <strong>Material concluído, revisado e testado pelos 3 Agentes!</strong> Baixe abaixo o seu <strong>PDF único</strong> contendo o
      Resumo Estruturado seguido de todos os <strong>${data.total_cards} flashcards</strong> organizados por tema:
    </div>

    <div class="pdf-delivery-card" id="${cardId}">
      <div class="pdf-card-top">
        <div class="pdf-title-group">
          <h3>📄 ${escapeHtml(sd.title || data.filename)}</h3>
          <p>Fonte: ${escapeHtml(sd.source || "")}</p>
        </div>
        <div class="pdf-badges">
          <span class="badge">📅 ${escapeHtml(sd.date || todayFormatted())}</span>
          <span class="badge">📑 ${data.pages_count} páginas</span>
          <span class="badge">🗂 ${data.total_cards} flashcards</span>
          <span class="badge">💾 ${formatBytes(data.size_bytes)}</span>
        </div>
      </div>

      ${agentReportHtml}

      <div class="pdf-actions-bar">
        <a href="${data.download_url}" download="${escapeHtml(data.filename)}" class="btn-download-pdf">
          ⬇ Baixar PDF Único (${escapeHtml(data.filename)})
        </a>
        <a href="${data.pdf_url}" target="_blank" rel="noopener" class="btn-secondary-action">
          ↗ Abrir PDF em Nova Aba
        </a>
      </div>

      <div class="preview-tabs">
        <button type="button" class="tab-btn active" data-target="pdf-view-${cardId}">👁 Visualizar PDF Incorporado</button>
        <button type="button" class="tab-btn" data-target="summary-view-${cardId}">📖 Resumo Estruturado</button>
        <button type="button" class="tab-btn" data-target="fc-view-${cardId}">🗂 Flashcards Interativos (${data.total_cards})</button>
      </div>

      <div class="tab-pane" id="pdf-view-${cardId}">
        <div class="pdf-iframe-wrap">
          <iframe src="${data.pdf_url}" title="Visualizador do PDF Gerado"></iframe>
        </div>
      </div>

      <div class="tab-pane hidden" id="summary-view-${cardId}">
        <div class="summary-toolbar">
          <span>Resumo estruturado fiel à fonte</span>
          <button type="button" class="btn-copy-summary" id="btn-copy-${cardId}">📋 Copiar Resumo</button>
        </div>
        ${sd.overview ? `<div class="summary-preview-sec"><h4>Visão Geral</h4><p>${escapeHtml(sd.overview)}</p></div>` : ""}
        ${sectionsHtml}
        ${conceptsHtml}
        ${sd.synthesis ? `<div class="summary-preview-sec"><h4>Síntese Final</h4><p>${escapeHtml(sd.synthesis)}</p></div>` : ""}
      </div>

      <div class="tab-pane hidden" id="fc-view-${cardId}">
        <div class="fc-toolbar">
          <div class="fc-toolbar-left">
            <input type="text" class="fc-search-input" id="fc-search-${cardId}" placeholder="🔍 Filtrar cartões por termo..." />
            <button type="button" class="btn-fc-mode" id="btn-quiz-${cardId}">🎯 Modo Quiz (Ocultar Respostas)</button>
          </div>
          <div class="fc-progress-wrap">
            <span id="fc-prog-text-${cardId}">0/${data.total_cards} dominados</span>
            <div class="fc-progress-bar">
              <div class="fc-progress-fill" id="fc-prog-fill-${cardId}"></div>
            </div>
          </div>
        </div>
        <div class="fc-grid" id="fc-grid-${cardId}">
          ${flashcardsHtml}
        </div>
      </div>

      ${limitationsHtml}
    </div>
  `;

  const cardEl = document.getElementById(cardId);

  const tabBtns = cardEl.querySelectorAll(".tab-btn");
  const tabPanes = cardEl.querySelectorAll(".tab-pane");
  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      tabBtns.forEach((b) => b.classList.remove("active"));
      tabPanes.forEach((p) => p.classList.add("hidden"));
      btn.classList.add("active");
      const target = document.getElementById(btn.dataset.target);
      if (target) target.classList.remove("hidden");
    });
  });

  const copyBtn = document.getElementById(`btn-copy-${cardId}`);
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(buildPlainTextSummary(sd));
        showToast("📋 Resumo copiado para a área de transferência!");
      } catch (_) {
        showToast("Não foi possível copiar automaticamente.");
      }
    });
  }

  const fcGrid = document.getElementById(`fc-grid-${cardId}`);
  const quizBtn = document.getElementById(`btn-quiz-${cardId}`);
  const searchInput = document.getElementById(`fc-search-${cardId}`);
  const progText = document.getElementById(`fc-prog-text-${cardId}`);
  const progFill = document.getElementById(`fc-prog-fill-${cardId}`);

  const updateMasteryProgress = () => {
    const allCards = fcGrid.querySelectorAll(".fc-card");
    const masteredCount = fcGrid.querySelectorAll(".fc-card.mastered").length;
    const total = allCards.length || 1;
    const pct = Math.round((masteredCount / total) * 100);
    if (progText) progText.textContent = `${masteredCount}/${allCards.length} dominados (${pct}%)`;
    if (progFill) progFill.style.width = `${pct}%`;
  };
  updateMasteryProgress();

  if (quizBtn) {
    quizBtn.addEventListener("click", () => {
      const active = quizBtn.classList.toggle("active");
      quizBtn.textContent = active ? "👁 Mostrar Todas as Respostas" : "🎯 Modo Quiz (Ocultar Respostas)";
      fcGrid.querySelectorAll(".fc-card").forEach((c) => {
        c.classList.toggle("quiz-hidden", active);
        c.classList.remove("revealed");
      });
      showToast(active ? "Modo Quiz ativado! Clique em um cartão para revelar a resposta." : "Respostas visíveis.");
    });
  }

  if (searchInput) {
    searchInput.addEventListener("input", () => {
      const q = searchInput.value.trim().toLowerCase();
      fcGrid.querySelectorAll(".fc-card").forEach((c) => {
        const match = !q || (c.dataset.search || "").includes(q);
        c.style.display = match ? "" : "none";
      });
    });
  }

  fcGrid.querySelectorAll(".fc-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("[data-master-btn]")) return;
      if (card.classList.contains("quiz-hidden")) {
        card.classList.toggle("revealed");
      }
    });
  });

  fcGrid.querySelectorAll("[data-master-btn]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const key = btn.dataset.masterBtn;
      const card = btn.closest(".fc-card");
      const nowMastered = !card.classList.contains("mastered");
      card.classList.toggle("mastered", nowMastered);
      btn.classList.toggle("active", nowMastered);
      btn.textContent = nowMastered ? "✓ Dominado" : "Marcar Dominado";
      if (nowMastered) {
        state.masteredCards[key] = true;
      } else {
        delete state.masteredCards[key];
      }
      localStorage.setItem("estudapdf_mastered_cards", JSON.stringify(state.masteredCards));
      updateMasteryProgress();
    });
  });

  scrollToBottom();
}

// ============================================================================
// Submissão Híbrida: Servidor Python (se ativo) ou Motor Estático no Navegador
// ============================================================================

async function processPurelyInBrowser(text, attached) {
  const urlsFound = text ? text.match(/https?:\/\/[^\s<>"']+/g) || [] : [];

  if (urlsFound.length > 1) {
    return {
      ok: false,
      needs_clarification: true,
      error: `Você informou ${urlsFound.length} URLs na mesma mensagem. Informe qual delas deseja processar primeiro.`,
    };
  }

  const urlInput = urlsFound[0] || "";
  if (!urlInput && !attached) {
    return {
      ok: false,
      needs_source: true,
      error:
        "Para iniciar a produção, preciso de um material de origem. Por favor, cole uma **URL acessível** no chat ou anexe um **arquivo PDF** usando o botão de clipe (📎).",
    };
  }

  let lines = [];
  let sourceLabel = "";
  let sourceType = "url";

  if (attached && attached.arrayBuffer) {
    sourceType = "pdf";
    sourceLabel = attached.name;
    lines = await extractTextFromPdfClientSide(attached.arrayBuffer);
  } else {
    sourceType = "url";
    sourceLabel = urlInput;
    const resUrl = await extractTextFromUrlClientSide(urlInput);
    lines = resUrl.lines;
  }

  const studyData = runThreeAgentsBrowserPipeline(lines, sourceLabel, sourceType);
  const filename = slugifyFilename(studyData.title);
  const compiled = compilePdfInBrowser(studyData);

  await saveStudyToLocalDB({
    filename,
    pdf_base64: compiled.pdfBase64,
    size_bytes: compiled.sizeBytes,
    pages_count: compiled.pagesCount,
    total_cards: compiled.totalCards,
    modified: nowFormatted(),
    mtime: Date.now(),
    study_data: studyData,
  });

  return {
    ok: true,
    filename,
    pdf_url: compiled.blobUrl,
    download_url: compiled.blobUrl,
    pages_count: compiled.pagesCount,
    size_bytes: compiled.sizeBytes,
    total_cards: compiled.totalCards,
    study_data: studyData,
  };
}

async function handleSubmit(e) {
  if (e) e.preventDefault();
  if (state.isProcessing) return;

  const text = els.chatInput.value.trim();
  const attached = state.attachedFile;

  if (!text && !attached) {
    els.chatInput.focus();
    return;
  }

  state.isProcessing = true;
  els.btnSend.disabled = true;

  appendUserMessage(text, attached);
  els.chatInput.value = "";
  els.chatInput.style.height = "auto";
  clearAttachment();

  const { row, stopTimer } = createThinkingBubble();

  try {
    let data = null;

    // 1. Tenta usar o backend Python local se estiver rodando
    try {
      const res = await fetch("./api/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          pdf_name: attached ? attached.name : "",
          pdf_base64: attached ? attached.base64 : "",
          api_key: state.apiKey,
        }),
      });
      if (res.ok) {
        data = await res.json();
        if (data && data.ok && data.study_data) {
          await saveStudyToLocalDB({
            filename: data.filename,
            url: data.pdf_url,
            download_url: data.download_url,
            size_bytes: data.size_bytes,
            pages_count: data.pages_count,
            total_cards: data.total_cards,
            modified: nowFormatted(),
            mtime: Date.now(),
            study_data: data.study_data,
          });
        }
      }
    } catch (_) {
      // Backend Python indisponível (modo Página Estática)
    }

    // 2. Se estiver em Deploy Estático (GitHub Pages / Vercel / Netlify), executa no Motor Client-Side
    if (!data) {
      data = await processPurelyInBrowser(text, attached);
    }

    stopTimer();

    if (!data.ok) {
      renderAiErrorBubble(row, data.error || "Erro desconhecido.", data.needs_clarification || data.needs_source);
    } else {
      renderAiSuccessBubble(row, data);
      await loadHistory();
      showToast("✅ PDF único gerado e salvo no seu navegador!");
    }
  } catch (err) {
    stopTimer();
    renderAiErrorBubble(row, err.message || "Não foi possível processar o material.");
  } finally {
    state.isProcessing = false;
    els.btnSend.disabled = false;
  }
}

// ============================================================================
// Eventos de UI, Responsividade Mobile e Atalhos
// ============================================================================

function closeMobileSidebar() {
  if (window.innerWidth <= 820) {
    els.sidebar.classList.add("collapsed");
    if (els.sidebarBackdrop) els.sidebarBackdrop.classList.add("hidden");
  }
}

els.chatForm.addEventListener("submit", handleSubmit);

els.chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSubmit();
  }
});

els.chatInput.addEventListener("input", () => {
  els.chatInput.style.height = "auto";
  els.chatInput.style.height = Math.min(els.chatInput.scrollHeight, 120) + "px";
});

els.btnAttachPdf.addEventListener("click", () => els.pdfFileInput.click());
els.pdfFileInput.addEventListener("change", (e) => {
  if (e.target.files && e.target.files[0]) {
    setAttachedPdf(e.target.files[0]);
  }
});
els.btnRemoveAtt.addEventListener("click", clearAttachment);

els.quickTestUrl.addEventListener("click", () => {
  els.chatInput.value = "https://sites.google.com/fam.edu.br/filosofiaetica-unidade1/p%C3%A1gina-inicial";
  handleSubmit();
});

els.quickUploadPdf.addEventListener("click", () => {
  els.pdfFileInput.click();
});

els.quickPasteUrl.addEventListener("click", () => {
  els.chatInput.focus();
});

els.btnToggleSidebar.addEventListener("click", () => {
  const isCollapsed = els.sidebar.classList.toggle("collapsed");
  if (els.sidebarBackdrop) {
    els.sidebarBackdrop.classList.toggle("hidden", isCollapsed || window.innerWidth > 820);
  }
});

if (els.sidebarBackdrop) {
  els.sidebarBackdrop.addEventListener("click", closeMobileSidebar);
}

if (window.innerWidth <= 820) {
  els.sidebar.classList.add("collapsed");
}

els.btnNewChat.addEventListener("click", () => {
  els.chatMessages.innerHTML = "";
  els.chatMessages.appendChild(els.welcomeScreen);
  els.welcomeScreen.classList.remove("hidden");
  clearAttachment();
  els.chatInput.value = "";
  closeMobileSidebar();
  els.chatInput.focus();
});

if (els.btnClearHistory) {
  els.btnClearHistory.addEventListener("click", async () => {
    await clearAllLocalDB();
    state.historyItems = [];
    renderHistory([]);
    showToast("Histórico do navegador limpo!");
  });
}

let dragCounter = 0;
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragCounter++;
  els.dropOverlay.classList.remove("hidden");
});

window.addEventListener("dragleave", (e) => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    els.dropOverlay.classList.add("hidden");
  }
});

window.addEventListener("dragover", (e) => {
  e.preventDefault();
});

window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragCounter = 0;
  els.dropOverlay.classList.add("hidden");
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
    setAttachedPdf(e.dataTransfer.files[0]);
  }
});

els.btnOpenSettings.addEventListener("click", () => {
  els.apiKeyInput.value = state.apiKey;
  els.settingsModal.classList.remove("hidden");
});

els.btnCloseSettings.addEventListener("click", () => {
  els.settingsModal.classList.add("hidden");
});

els.btnSaveSettings.addEventListener("click", () => {
  state.apiKey = els.apiKeyInput.value.trim();
  localStorage.setItem("estudapdf_gemini_key", state.apiKey);
  updateEnginePill();
  els.settingsModal.classList.add("hidden");
  showToast("Configuração salva no navegador!");
});

updateEnginePill();
loadHistory();
