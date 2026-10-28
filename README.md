# 🎓 EstudaPDF — Sistema Multiagente de Resumos e Flashcards em PDF Único

O **EstudaPDF** é uma aplicação web com interface estilo **Chat de IA** projetada para transformar materiais de estudo fornecidos pelo usuário (**URL acessível** ou **arquivo PDF**) em um **Resumo Estruturado** seguido de um conjunto de **Flashcards de Pergunta e Resposta**, reunindo ambos, nessa ordem, em **um único arquivo PDF** pronto para leitura, revisão interativa e impressão.

O projeto possui **Arquitetura Híbrida (Página Estática 100% Client-Side + Servidor Python Local)**: pode ser publicado diretamente no **GitHub Pages, Vercel, Netlify ou Cloudflare Pages** como página estática (sem necessidade de backend) ou executado localmente via Python.

---

## ✨ Principais Funcionalidades

- 🛡️ **Arquitetura Anti-Erro com 3 Agentes (`Construtor` • `Revisor` • `Tester`):**
  1. **🛠️ Agente Construtor (`EstudaPDF-Construtor`):** extrai o texto resolvendo mapas de fontes, isola cabeçalhos de periódicos, nomes de autores/afiliações, DOI e referências bibliográficas, reconstrói parágrafos e estrutura o Resumo + Flashcards;
  2. **🔍 Agente Revisor (`EstudaPDF-Revisor`):** audita o idioma, restaura ligaduras tipográficas quebradas (`fi`, `fl`), elimina trechos de *Abstract/Keywords* em inglês e impede truncamentos;
  3. **🧪 Agente de Teste (`EstudaPDF-Tester`):** valida a integridade do arquivo PDF gerado e garante a ordem obrigatória (*Cabeçalho → Parte 1: Resumo → Parte 2: Flashcards*).
- 🎯 **Modo Quiz Interativo nos Flashcards:** filtre cartões por palavra-chave, oculte as respostas com 1 clique (*Modo Quiz*), clique sobre qualquer cartão para revelar a resposta e marque cartões como **✓ Dominado** com barra de progresso em tempo real.
- 🔒 **Histórico Privado Salvo no Navegador (`IndexedDB`):** todos os PDFs gerados ficam salvos localmente no navegador do usuário, permitindo reabrir estudos anteriores no chat (`📖 Ver`), baixar novamente (`⬇ Baixar`), abrir em nova aba (`↗ PDF`) ou limpar o histórico a qualquer momento.
- 📋 **Cópia Rápida de Resumo e Visualizador Embutido:** visualize o PDF paginado diretamente no chat ou copie todo o resumo formatado com 1 clique.

---

## 🌐 Como Fazer Deploy como Página Estática (GitHub Pages / Vercel / Netlify)

O projeto já está 100% pronto para hospedagem estática (possui `index.html` e `.nojekyll` na raiz, além do motor client-side com `PDF.js`, `jsPDF` e `IndexedDB` em `static/app.js`):

1. Suba o repositório para o seu **GitHub** (o arquivo `.gitignore` já impede o envio de PDFs locais e caches);
2. No GitHub, acesse **Settings → Pages**;
3. Em **Build and deployment**, selecione **Deploy from a branch**, escolha a branch `main` e a pasta **`/ (root)`**, e clique em **Save**;
4. Pronto! Sua página estática estará no ar funcionando 100% no navegador do visitante.

*(Alternativamente, basta importar o repositório na **Vercel**, **Netlify** ou **Cloudflare Pages** sem precisar configurar comando de build).*

---

## 💻 Como Executar Localmente com Servidor Python (Opcional)

### Pré-requisitos
- **Python 3.10+** instalado no sistema;
- Biblioteca `pypdf` instalada (`python -m pip install pypdf`).

### Opção 1 — Inicialização Rápida no Windows (1 Clique)
Dê um duplo clique no arquivo:
```text
iniciar_estudapdf.bat
```

### Opção 2 — Via Terminal / PowerShell
```powershell
python server.py 8080
```
Acesse no navegador: 👉 **http://localhost:8080**

---

## 📂 Estrutura do Projeto

```text
resumo-flashcards-para-estudo/
├── .agents/
│   └── skills/
│       └── resumo-flashcards/
│           └── SKILL.md           # Especificação operacional da skill e dos 3 Agentes
├── static/
│   ├── index.html                 # Interface de Chat IA (versão pasta static)
│   ├── styles.css                 # Estilização responsiva (Desktop/Mobile, Modo Quiz, Toasts)
│   └── app.js                     # Controlador híbrido + Motor Client-Side (3 Agentes, PDF.js, jsPDF, IndexedDB)
├── index.html                     # Ponto de entrada raiz para GitHub Pages / Vercel / Netlify
├── .nojekyll                      # Desativa processamento Jekyll no GitHub Pages
├── .gitignore                     # Protege contra envio de PDFs pessoais, caches e segredos ao GitHub
├── pdf_engine.py                  # Motor Python de extração, pipeline de 3 agentes e compilação vetorial de PDF
├── server.py                      # Servidor HTTP local opcional
├── iniciar_estudapdf.bat          # Atalho Windows para iniciar o servidor local
└── README.md                      # Documentação do projeto
```
