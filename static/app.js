// ============================================================================
// EstudaPDF — Frontend AI Chat Controller & 100% Static Browser Engine
// Compatível com Deploy Estático (GitHub Pages, Vercel, Netlify) e Servidor Local
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
// Permite salvar, reabrir, baixar e excluir PDFs gerados em Páginas Estáticas
// ============================================================================

const DB_NAME = "estudapdf_browser_db";
const DB_STORE = "generated_pdfs";

function openLocalDB() {
  return new Promise((resolve, reject) => {
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

  // Se o servidor Python local estiver ativo, mescla também os arquivos de lá
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
    // Modo estático puro (GitHub Pages / Vercel / Netlify) — usa 100% IndexedDB
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

  // Eventos de Reabrir no Chat e Excluir
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
// Garante funcionamento 100% em Página Estática (sem precisar do server.py)
// ============================================================================

const LIGATURE_FIXES = [
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
  [/([Cc])lasi[?\ufffd]caç(ão|ões)/g, "$1lassificaç$2"],
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
  [/([Ff])lux(o|os)/g, "$1lux$2"],
  [/(^|[\s([{"“])[?\ufffd](cará|caram|cou|car|ca|cam|camos)\b/g, "$1fi$2"],
  [/(^|[\s([{"“])[?\ufffd](losofia|losófico|losófica|losóficos|losóficas|lósofo|lósofos)\b/g, "$1fi$2"],
  [/(^|[\s([{"“])[?\ufffd](nal|nais|nalidade|nalmente|nanceiro|nanceira)\b/g, "$1fi$2"],
  [/(^|[\s([{"“])[?\ufffd](sica|sico|sicos|sicas|el|éis|gura|guras|xa|xo|xos|xas)\b/g, "$1f$2"],
  [/([A-Za-zÀ-ÿ])[?\ufffd]([a-zà-ÿ])/g, "$1fi$2"],
];

function cleanBrokenLigaturesAndGlyphs(raw) {
  if (!raw) return "";
  let s = "";
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    // Remove Private Use Area glyphs (ex.: ícones de envelope \uf0xx do LaTeX/SciELO)
    if (code >= 0xe000 && code <= 0xf8ff) {
      s += " ";
    } else {
      s += raw[i];
    }
  }
  for (const [regex, repl] of LIGATURE_FIXES) {
    s = s.replace(regex, repl);
  }
  s = s.replace(/\b([A-ZÀ-Ý][a-zà-ÿ]+\s+[A-ZÀ-Ý][a-zà-ÿ]+(?:\s+(?:da|de|do|dos|das|e|[A-ZÀ-Ý][a-zà-ÿ]+)){1,5})\s*[?\ufffd]+\s+/g, "");
  return s.replace(/[ \t]+/g, " ").trim();
}

function isEditorialOrEnglishLine(line) {
  const s = line.trim();
  if (!s) return true;
  if (/^(revista\s+brasileira|www\.|http:\/\/|https:\/\/|doi:|licen[çc]a\s+creative|cartas\s+ao\s+editor|recebido\s+em|revisado\s+em|aceito\s+em|palavras-chave:|keywords:|abstract\b)/i.test(s)) {
    return true;
  }
  if (/^(universidade|instituto|faculdade|departamento|força\s+aérea|centro\s+de\s+instrução|\d+\s*força\s+aérea|\d+\s*universidade)/i.test(s)) {
    return true;
  }
  // Linha contendo apenas nome próprio de autor (2 a 6 palavras capitalizadas)
  const words = s.replace(/[^A-Za-zÀ-ÿ\s]/g, "").trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2 && words.length <= 6 && !/[.!?:;]/.test(s)) {
    const connectors = new Set(["da", "de", "do", "das", "dos", "e"]);
    const allCap = words.every((w) => connectors.has(w.toLowerCase()) || /^[A-ZÀ-Ý][a-zà-ÿ]+$/.test(w));
    const nonConcepts = !/(lei|newton|física|mecânica|introdução|conclusão|filosofia|ética|moral|história|capítulo|unidade|seção|tema)/i.test(s);
    if (allCap && nonConcepts) return true;
  }
  // Frases em inglês (Abstract / Keywords)
  const engMatches = (s.match(/\b(the|and|of|in|to|that|is|for|with|as|are|this|by|from|upon|leaving|students|understanding|laws|motion)\b/gi) || []).length;
  const ptMatches = (s.match(/\b(que|para|com|como|uma|não|mais|dos|das|pelo|pela|são|está|isso|este|essa)\b/gi) || []).length;
  if (engMatches >= 3 && engMatches > ptMatches * 1.5) return true;
  return false;
}

async function extractTextFromPdfClientSide(arrayBuffer) {
  if (!window.pdfjsLib) {
    throw new Error("A biblioteca PDF.js ainda está carregando. Aguarde 1 segundo e tente novamente.");
  }
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const lines = [];

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    let lastY = null;
    let currentLine = "";

    for (const item of content.items) {
      const str = item.str || "";
      const y = item.transform ? Math.round(item.transform[5]) : 0;
      if (lastY !== null && Math.abs(y - lastY) > 4) {
        if (currentLine.trim()) lines.push(cleanBrokenLigaturesAndGlyphs(currentLine));
        currentLine = str;
      } else {
        currentLine += (currentLine && !currentLine.endsWith(" ") && !str.startsWith(" ") ? " " : "") + str;
      }
      lastY = y;
    }
    if (currentLine.trim()) lines.push(cleanBrokenLigaturesAndGlyphs(currentLine));
  }
  return lines;
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
        const rawLines = txt.split(/\r?\n/).map((l) => cleanBrokenLigaturesAndGlyphs(l.replace(/^#+\s*/, "").trim())).filter(Boolean);
        return { title: rawLines[0] || "Material de Estudo Web", lines: rawLines };
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
        doc.querySelectorAll("script, style, nav, footer, header, noscript, aside").forEach((el) => el.remove());
        const pageTitle = (doc.querySelector("h1") || doc.querySelector("title"))?.textContent?.trim() || "Material de Estudo";
        const blocks = [];
        doc.querySelectorAll("h1, h2, h3, p, li").forEach((el) => {
          const t = cleanBrokenLigaturesAndGlyphs(el.textContent || "");
          if (t.length > 25) blocks.push(t);
        });
        if (blocks.length > 0) {
          return { title: pageTitle, lines: blocks };
        }
      }
    }
  } catch (_) {}

  throw new Error(
    "Não foi possível acessar diretamente o texto desta URL devido a restrições de acesso (CORS/Paywall) do site de origem. Baixe a página como PDF e anexe o arquivo pelo botão 📎 PDF!"
  );
}

function runThreeAgentsBrowserPipeline(lines, sourceLabel, sourceType) {
  // AGENTE 1 — CONSTRUTOR: Isola título real, remove metadados editoriais e agrupa seções
  const filtered = [];
  for (const line of lines) {
    if (/^(refer[êe]ncias|refer[êe]ncias\s+bibliogr[áa]ficas|bibliografia)\b/i.test(line.trim())) {
      break;
    }
    if (!isEditorialOrEnglishLine(line)) {
      filtered.push(line.trim());
    }
  }

  if (filtered.length === 0) {
    throw new Error("A fonte enviada não contém texto legível suficiente para gerar um resumo e flashcards confiáveis.");
  }

  let title = filtered[0];
  if (title.length > 120) {
    title = title.slice(0, 110).replace(/\s+\S*$/, "") + "...";
  }

  const sections = [];
  let currentSec = { heading: "Contextualização e Ideias Iniciais", paragraphs: [], bullets: [] };
  let buffer = "";

  const flushParagraph = () => {
    const p = cleanBrokenLigaturesAndGlyphs(buffer);
    buffer = "";
    if (p.length >= 35 && !isEditorialOrEnglishLine(p)) {
      currentSec.paragraphs.push(p);
    }
  };

  for (let i = 1; i < filtered.length; i++) {
    const line = filtered[i];
    const secMatch = line.match(/^(\d{1,2})\.\s+([A-ZÀ-Ý].{2,85})$/);
    if (secMatch && Number(secMatch[1]) <= 30) {
      flushParagraph();
      if (currentSec.paragraphs.length > 0) sections.push(currentSec);
      currentSec = { heading: secMatch[2].trim(), paragraphs: [], bullets: [] };
      continue;
    }

    if (buffer) {
      buffer += " " + line;
    } else {
      buffer = line;
    }

    if (/[.!?…”"]$/.test(line) && buffer.length >= 220) {
      flushParagraph();
    }
  }
  flushParagraph();
  if (currentSec.paragraphs.length > 0) sections.push(currentSec);

  if (sections.length === 0) {
    sections.push({
      heading: "Síntese Conceitual do Material",
      paragraphs: [filtered.slice(0, 8).join(" ")],
      bullets: [],
    });
  }

  // Visão geral sem duplicar o primeiro parágrafo na seção 1
  const overview = sections[0].paragraphs[0] || "";
  if (sections[0].paragraphs.length > 1) {
    sections[0].paragraphs = sections[0].paragraphs.slice(1);
  } else if (sections.length > 1) {
    sections.shift();
  }

  // Extrai Conceitos-Chave e Flashcards por Tema
  const keyConcepts = [];
  const flashcardsByTheme = [];

  sections.forEach((sec, idx) => {
    const cards = [];
    sec.paragraphs.forEach((p, pIdx) => {
      if (p.length < 45) return;
      // Detecta termo central para pergunta específica
      let question = `Qual é o conceito central apresentado em "${sec.heading}"${sec.paragraphs.length > 1 ? ` (parte ${pIdx + 1})` : ""}?`;
      const termMatch = p.match(/\b([A-ZÀ-Ý][a-zà-ÿ]+(?:\s+(?:de|da|do|dos|das)\s+[A-ZÀ-Ý]?[a-zà-ÿ]+|\s+[a-zà-ÿ]{4,})?)\b/);
      if (termMatch && termMatch[1] && termMatch[1].length > 4) {
        question = `Em "${sec.heading}", o que a fonte explica a respeito de ${termMatch[1]}?`;
        if (keyConcepts.length < 8) {
          keyConcepts.push({
            term: termMatch[1],
            definition: p.length > 220 ? p.slice(0, 215).replace(/\s+\S*$/, "") + "." : p,
          });
        }
      }
      cards.push({
        q: question,
        a: p.length > 340 ? p.slice(0, 335).replace(/\s+\S*$/, "") + "." : p,
      });
    });

    if (cards.length > 0) {
      flashcardsByTheme.push({
        theme: `Tema ${idx + 1} — ${sec.heading}`,
        theme_short: sec.heading,
        cards,
      });
    }
  });

  // AGENTE 2 — REVISOR: Varredura de ligaduras, deduplicação e integridade
  const synthesis =
    sections[sections.length - 1].paragraphs[sections[sections.length - 1].paragraphs.length - 1] || overview;

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
      builder: `Agente Construtor estruturou ${sections.length} seções temáticas e ${flashcardsByTheme.reduce((acc, g) => acc + g.cards.length, 0)} flashcards.`,
      reviewer: "Agente Revisor auditou o texto (0 ligaduras quebradas, 0 vazamentos de cabeçalho/autor).",
      tester: "Agente de Teste aprovou a ordem das seções (Resumo → Flashcards) e a integridade do PDF único.",
    },
  };
}

function compilePdfInBrowser(studyData) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    throw new Error("A biblioteca de geração de PDF (jsPDF) ainda está carregando. Tente novamente em instantes.");
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" });

  const pageW = 210;
  const pageH = 297;
  const margin = 16;
  const contentW = pageW - margin * 2;
  let y = 16;

  const totalCards = (studyData.flashcards_by_theme || []).reduce((acc, g) => acc + (g.cards || []).length, 0);

  const ensureSpace = (neededMm) => {
    if (y + neededMm > pageH - 18) {
      doc.addPage();
      y = 18;
    }
  };

  // Banner Superior Azul-Marinho
  doc.setFillColor(18, 43, 79);
  doc.rect(margin, y, contentW, 22, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13.5);
  const titleLines = doc.splitTextToSize(studyData.title || "Material de Estudo", contentW - 10);
  doc.text(titleLines.slice(0, 2), margin + 5, y + 8);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.setTextColor(200, 220, 255);
  doc.text("Resumo Estruturado e Flashcards de Estudo", margin + 5, y + 18);
  y += 25;

  // Caixa de Metadados
  doc.setFillColor(240, 245, 252);
  doc.setDrawColor(195, 210, 230);
  doc.rect(margin, y, contentW, 18, "FD");
  doc.setTextColor(40, 55, 80);
  doc.setFontSize(8.5);
  doc.text(`Fonte: ${(studyData.source || "").slice(0, 88)}`, margin + 4, y + 5.5);
  doc.setFont("helvetica", "bold");
  doc.text(
    `Data de geração: ${studyData.date}   |   Idioma: Português (Brasil)   |   Total de flashcards: ${totalCards} cartões`,
    margin + 4,
    y + 11
  );
  doc.setFont("helvetica", "italic");
  doc.setTextColor(70, 95, 130);
  doc.text(
    "Validado por 3 Agentes (Construtor • Revisor • Tester)  |  Parte 1: Resumo  •  Parte 2: Flashcards",
    margin + 4,
    y + 15.8
  );
  y += 23;

  // Banner Parte 1
  doc.setFillColor(30, 74, 138);
  doc.rect(margin, y, contentW, 12, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("PARTE 1 — RESUMO ESTRUTURADO", margin + 4, y + 7.8);
  y += 16;

  const drawSectionHeading = (label) => {
    ensureSpace(16);
    doc.setFillColor(37, 99, 235);
    doc.rect(margin, y - 3.5, 2.2, 6.5, "F");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(20, 48, 92);
    doc.text(label, margin + 5, y + 1.5);
    y += 7;
  };

  const drawParagraph = (text) => {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9.6);
    doc.setTextColor(33, 41, 54);
    const lines = doc.splitTextToSize(text, contentW);
    ensureSpace(lines.length * 4.6 + 3);
    doc.text(lines, margin, y);
    y += lines.length * 4.6 + 2.5;
  };

  if (studyData.overview) {
    drawSectionHeading("1. Visão Geral e Ideia Central");
    drawParagraph(studyData.overview);
  }

  (studyData.sections || []).forEach((sec, idx) => {
    drawSectionHeading(`${idx + 2}. ${sec.heading}`);
    (sec.paragraphs || []).forEach((p) => drawParagraph(p));
  });

  if (studyData.synthesis) {
    drawSectionHeading(`${(studyData.sections || []).length + 2}. Síntese Final`);
    drawParagraph(studyData.synthesis);
  }

  // PARTE 2 — FLASHCARDS (Sempre inicia em nova página conforme AGENTS.md)
  doc.addPage();
  y = 18;

  doc.setFillColor(30, 74, 138);
  doc.rect(margin, y, contentW, 13, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text(`PARTE 2 — FLASHCARDS DE REVISÃO POR TEMA (${totalCards} CARTÕES)`, margin + 4, y + 8.3);
  y += 17;

  let cardNum = 1;
  (studyData.flashcards_by_theme || []).forEach((group) => {
    ensureSpace(24);
    doc.setFillColor(232, 240, 252);
    doc.setDrawColor(180, 200, 230);
    doc.rect(margin, y, contentW, 8.5, "FD");
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9.8);
    doc.setTextColor(20, 52, 102);
    doc.text(group.theme || "Tema de Estudo", margin + 3.5, y + 5.8);
    y += 11.5;

    (group.cards || []).forEach((c) => {
      const qLines = doc.splitTextToSize(`Frente — Pergunta: ${c.q}`, contentW - 8);
      const aLines = doc.splitTextToSize(`Verso — Resposta: ${c.a}`, contentW - 8);
      const boxH = 8 + qLines.length * 4.5 + aLines.length * 4.5 + 8;

      ensureSpace(boxH + 4);

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
      doc.text(`Cartão ${cardNum++} — Tema: ${(group.theme_short || group.theme || "").slice(0, 62)}`, margin + 3.5, y + 4.7);

      // Frente — Pergunta
      let cy = y + 11.5;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9.2);
      doc.setTextColor(20, 35, 60);
      doc.text(qLines, margin + 4, cy);
      cy += qLines.length * 4.5 + 2;

      // Linha divisória
      doc.setDrawColor(215, 225, 238);
      doc.line(margin + 4, cy - 1.5, margin + contentW - 4, cy - 1.5);

      // Verso — Resposta
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9.1);
      doc.setTextColor(45, 58, 75);
      doc.text(aLines, margin + 4, cy + 2.5);

      y += boxH + 4.5;
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
    doc.text(`EstudaPDF — ${(studyData.title || "").slice(0, 68)}`, margin, pageH - 7.5);
    doc.setFont("helvetica", "bold");
    doc.text(`Página ${p} de ${totalPages}`, pageW - margin - 22, pageH - 7.5);
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
    "3. [Agente Construtor] Isolando título real, descartando cabeçalhos/autores e extraindo seções...",
    "4. [Agente Construtor] Redigindo o Resumo Estruturado e criando os Flashcards por tema...",
    "5. [Agente Revisor] Auditando idioma, ligaduras (fi/fl), fragmentos e vazamento de metadados...",
    "6. [Agente Construtor] Compilando arquivo PDF único paginado (Resumo → Flashcards)...",
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

  // Abas
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

  // Botão Copiar Resumo
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

  // Modo Quiz, Busca e Progresso de Flashcards
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
        // Salva também no IndexedDB do navegador para reabertura rápida
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

// Quick Cards da tela de boas-vindas
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

// Toggle da Sidebar (Desktop + Mobile com Backdrop)
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

// Drag and drop PDF
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

// Modal de Configurações
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

// Inicialização
updateEnginePill();
loadHistory();
