import express from "express";
import { GoogleGenAI, Type } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";
import "dotenv/config";
import { fileURLToPath } from "node:url";

const app = express();
const port = process.env.PORT || 3000;
// Por padrão só aceita conexões da própria máquina (sem autenticação, não exponha na rede).
const host = process.env.HOST || "127.0.0.1";
const TIMEZONE = process.env.TIMEZONE || "America/Sao_Paulo";

app.use(express.json({ limit: "1mb" }));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const { GEMINI_API_KEY, TRELLO_KEY, TRELLO_TOKEN, TRELLO_BOARD_ID } = process.env;
const variaveisFaltando = Object.entries({ GEMINI_API_KEY, TRELLO_KEY, TRELLO_TOKEN, TRELLO_BOARD_ID })
  .filter(([, valor]) => !valor)
  .map(([nome]) => nome);
if (variaveisFaltando.length > 0) {
  console.warn(`⚠️  Variáveis de ambiente ausentes no .env: ${variaveisFaltando.join(", ")}`);
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const MEMORIA_PATH = path.join(__dirname, "memoria.json");
const MAX_CARDS_MEMORIA = 10;

// Ordem de prioridade: primeiro os modelos com maior cota gratuita diária (Flash-Lite).
// Em caso de 429/503/404, o backend passa automaticamente para o próximo da lista.
const MODELOS = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.5-pro"
];
let indiceModeloAtual = 0;
let chatSession = null;
// Card montado pelo parser local (/card) aguardando aprovação.
let cardPendenteLocal = null;

const REGEX_CONFIRMACAO = /^\s*(sim|s|ok|okay|pode|pode criar|pode criar no trello|confirmo|confirmar|aprovar|aprovado|manda|cria|criar)\b/i;

// ---------- Utilitários de data (fuso da utilizadora, não UTC) ----------

function hojeNoFuso() {
  // en-CA formata como AAAA-MM-DD
  return new Date().toLocaleDateString("en-CA", { timeZone: TIMEZONE });
}

function offsetDoFuso() {
  // Ex.: "GMT-03:00" -> "-03:00"
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    timeZoneName: "longOffset"
  }).formatToParts(new Date());
  const nome = partes.find((p) => p.type === "timeZoneName")?.value || "GMT";
  const offset = nome.replace("GMT", "");
  return offset === "" ? "+00:00" : offset;
}

// Converte "2026-10-27", "27/10/2026", "2026-10-27 22:00" ou ISO completo para ISO 8601 UTC.
function normalizarPrazo(texto) {
  if (!texto) return null;
  const limpo = texto.replace(/[*_]/g, "").trim();
  if (!limpo || /sem prazo/i.test(limpo)) return null;

  const isoCompleto = limpo.match(/\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})/);
  if (isoCompleto) {
    const d = new Date(isoCompleto[0]);
    return isNaN(d) ? null : d.toISOString();
  }

  let ano, mes, dia;
  const iso = limpo.match(/(\d{4})-(\d{2})-(\d{2})/);
  const br = limpo.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (iso) [, ano, mes, dia] = iso;
  else if (br) [, dia, mes, ano] = br;
  else return null;

  // Horário opcional: "22:00", "22h", "22h30". Sem horário -> 23:59 no fuso local.
  const hora = limpo.match(/\b(\d{1,2})(?::|h)(\d{2})?/i);
  const hh = hora ? hora[1].padStart(2, "0") : "23";
  const mm = hora ? (hora[2] || "00") : "59";

  const d = new Date(`${ano}-${mes}-${dia}T${hh}:${mm}:00${offsetDoFuso()}`);
  return isNaN(d) ? null : d.toISOString();
}

function formatarPrazoLegivel(iso) {
  if (!iso) return "Sem prazo definido";
  return new Date(iso).toLocaleString("pt-BR", {
    timeZone: TIMEZONE,
    dateStyle: "short",
    timeStyle: "short"
  });
}

// ---------- Memória ----------

async function carregarMemoria() {
  try {
    const data = await fs.readFile(MEMORIA_PATH, "utf-8");
    const memoria = JSON.parse(data);
    if (!Array.isArray(memoria.ultimos_cards_criados)) memoria.ultimos_cards_criados = [];
    return memoria;
  } catch {
    return { diretrizes: "", contexto_projetos: "", ultimos_cards_criados: [] };
  }
}

async function registrarCardNaMemoria(resultado) {
  try {
    const memoria = await carregarMemoria();
    memoria.ultimos_cards_criados.unshift({
      titulo: resultado.titulo,
      coluna: resultado.coluna,
      prazo: resultado.prazo,
      url: resultado.url,
      criado_em: new Date().toISOString()
    });
    memoria.ultimos_cards_criados = memoria.ultimos_cards_criados.slice(0, MAX_CARDS_MEMORIA);
    await fs.writeFile(MEMORIA_PATH, JSON.stringify(memoria, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.warn("Aviso ao atualizar memoria.json:", err.message);
  }
}

// ---------- Trello ----------

function urlTrello(caminho) {
  const url = new URL(`https://api.trello.com/1${caminho}`);
  url.searchParams.set("key", TRELLO_KEY);
  url.searchParams.set("token", TRELLO_TOKEN);
  return url;
}

// 1. Obter listas reais do quadro
async function obterListasDoQuadro() {
  try {
    const res = await fetch(urlTrello(`/boards/${TRELLO_BOARD_ID}/lists`));
    if (!res.ok) return [];
    const listas = await res.json();
    return listas.map((l) => ({ id: l.id, name: l.name }));
  } catch (err) {
    console.warn("Aviso ao procurar listas do quadro:", err.message);
    return [];
  }
}

// 2. Obter etiquetas disponíveis no quadro
async function obterEtiquetasDoQuadro() {
  try {
    const res = await fetch(urlTrello(`/boards/${TRELLO_BOARD_ID}/labels`));
    if (!res.ok) return [];
    const labels = await res.json();
    return labels
      .filter((l) => l.name && l.name.trim() !== "")
      .map((l) => ({ id: l.id, name: l.name, color: l.color }));
  } catch (err) {
    console.warn("Aviso ao procurar etiquetas:", err.message);
    return [];
  }
}

// 3. Tool para registar no Trello com due, idList e idLabels
async function criarCardNoTrello({ coluna, titulo, descricao, checklist, dataEntregaISO, nomesEtiquetas }) {
  try {
    const listas = await obterListasDoQuadro();
    if (!listas || listas.length === 0) {
      return { sucesso: false, erro: "Nenhuma lista encontrada no quadro do Trello. Verifique TRELLO_KEY, TRELLO_TOKEN e TRELLO_BOARD_ID." };
    }

    const nomeBusca = (coluna || "").toLowerCase().trim();
    const listaEncontrada =
      listas.find((l) => l.name.toLowerCase().trim() === nomeBusca) ||
      (nomeBusca ? listas.find((l) => l.name.toLowerCase().includes(nomeBusca)) : null);
    const idLista = listaEncontrada ? listaEncontrada.id : listas[0].id;
    const nomeListaFinal = listaEncontrada ? listaEncontrada.name : listas[0].name;

    // Mapeamento tolerante de etiquetas para IDs
    const etiquetasAplicadas = [];
    if (nomesEtiquetas && nomesEtiquetas.length > 0) {
      const etiquetasQuadro = await obterEtiquetasDoQuadro();
      for (const nome of nomesEtiquetas) {
        const termoLimpo = nome.toLowerCase().trim();
        if (!termoLimpo) continue;
        const encontrada =
          etiquetasQuadro.find((e) => e.name.toLowerCase().trim() === termoLimpo) ||
          etiquetasQuadro.find((e) => {
            const nomeEtiqueta = e.name.toLowerCase().trim();
            return nomeEtiqueta.includes(termoLimpo) || termoLimpo.includes(nomeEtiqueta);
          });
        if (encontrada && !etiquetasAplicadas.some((e) => e.id === encontrada.id)) {
          etiquetasAplicadas.push(encontrada);
        }
      }
    }

    // Criar Cartão
    const urlCard = urlTrello("/cards");
    urlCard.searchParams.set("idList", idLista);
    urlCard.searchParams.set("name", titulo);
    urlCard.searchParams.set("desc", descricao || "");
    urlCard.searchParams.set("pos", "top");

    const prazoISO = normalizarPrazo(dataEntregaISO);
    if (prazoISO) {
      urlCard.searchParams.set("due", prazoISO);
      urlCard.searchParams.set("dueReminder", "1440"); // Notificar 1 dia antes
    }

    if (etiquetasAplicadas.length > 0) {
      urlCard.searchParams.set("idLabels", etiquetasAplicadas.map((e) => e.id).join(","));
    }

    const resCard = await fetch(urlCard, { method: "POST" });
    const textoCard = await resCard.text();

    if (!resCard.ok) {
      return { sucesso: false, erro: `Erro ao criar cartão (${resCard.status}): ${textoCard}` };
    }

    const card = JSON.parse(textoCard);

    // Adicionar Checklist
    let avisoChecklist = null;
    if (checklist && checklist.length > 0) {
      const urlChecklist = urlTrello(`/cards/${card.id}/checklists`);
      urlChecklist.searchParams.set("name", "Checklist Operacional");

      const resChecklist = await fetch(urlChecklist, { method: "POST" });
      if (resChecklist.ok) {
        const checkData = await resChecklist.json();
        let falhas = 0;
        for (const item of checklist) {
          const urlItem = urlTrello(`/checklists/${checkData.id}/checkItems`);
          urlItem.searchParams.set("name", item);
          const resItem = await fetch(urlItem, { method: "POST" });
          if (!resItem.ok) falhas++;
        }
        if (falhas > 0) avisoChecklist = `${falhas} item(ns) do checklist não foram criados.`;
      } else {
        avisoChecklist = "O cartão foi criado, mas o checklist falhou.";
      }
    }

    return {
      sucesso: true,
      url: card.shortUrl,
      titulo,
      coluna: nomeListaFinal,
      prazo: formatarPrazoLegivel(prazoISO),
      etiquetas: etiquetasAplicadas.map((e) => e.name),
      aviso: avisoChecklist
    };
  } catch (error) {
    return { sucesso: false, erro: error.message };
  }
}

function mensagemResultado(resultado) {
  if (!resultado.sucesso) {
    return `❌ **Falha ao criar o cartão no Trello:** ${resultado.erro}`;
  }
  const infoEtiquetas = resultado.etiquetas.length > 0 ? resultado.etiquetas.join(", ") : "Nenhuma";
  return (
    `🎉 **Cartão criado com sucesso no Trello!**\n\n` +
    `📌 **Título:** ${resultado.titulo}\n` +
    `📂 **Coluna:** ${resultado.coluna}\n` +
    `⏰ **Prazo:** ${resultado.prazo}\n` +
    `🏷️ **Etiquetas:** ${infoEtiquetas}\n` +
    (resultado.aviso ? `\n⚠️ ${resultado.aviso}\n` : "") +
    `\n🔗 [Aceder ao Cartão no Trello](${resultado.url})`
  );
}

// ---------- Parser local do bloco /card (sem gastar tokens) ----------

const CAMPOS_CARD = ["coluna", "título", "titulo", "prazo", "etiquetas", "descrição", "descricao", "checklist"];

function parsearBlocoCard(texto) {
  const linhas = texto.replace(/^\s*\/card\s*/i, "").split(/\r?\n/);
  const campos = {};
  let campoAtual = null;

  for (const linha of linhas) {
    const m = linha.match(/^\s*\**\s*([A-Za-zÀ-ú]+)\s*\**\s*:\s*\**\s*(.*)$/);
    const chave = m ? m[1].toLowerCase() : null;
    if (chave && CAMPOS_CARD.includes(chave)) {
      campoAtual = chave.normalize("NFD").replace(/[̀-ͯ]/g, "");
      campos[campoAtual] = m[2] ? [m[2]] : [];
    } else if (campoAtual) {
      campos[campoAtual].push(linha);
    }
  }

  const unir = (k) => (campos[k] || []).join("\n").trim();
  const titulo = unir("titulo");
  if (!titulo) return null;

  const checklist = (campos.checklist || [])
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])?\s*(?:\[\s?[xX]?\s?\]\s*)?/, "").trim())
    .filter(Boolean);

  const etiquetasBrutas = unir("etiquetas");
  // Envia o texto inteiro e também as partes separadas; o matching tolerante resolve
  // etiquetas como "Estudo / Leitura" que contêm "/" no próprio nome.
  const nomesEtiquetas = etiquetasBrutas
    ? [etiquetasBrutas, ...etiquetasBrutas.split(/[,;/|]/).map((e) => e.trim())].filter(Boolean)
    : [];

  return {
    coluna: unir("coluna"),
    titulo,
    descricao: unir("descricao"),
    checklist,
    dataEntregaISO: normalizarPrazo(unir("prazo")),
    nomesEtiquetas,
    etiquetasTexto: etiquetasBrutas
  };
}

function previewCardLocal(card) {
  const prazo = card.dataEntregaISO
    ? `${formatarPrazoLegivel(card.dataEntregaISO)} (${card.dataEntregaISO})`
    : "Sem prazo definido";
  const itens = card.checklist.length > 0
    ? card.checklist.map((i) => `  - [ ] ${i}`).join("\n")
    : "  - (sem itens)";
  return (
    `📌 **Pré-visualização do Card:**\n` +
    `- **Coluna:** ${card.coluna || "(primeira lista do quadro)"}\n` +
    `- **Título:** ${card.titulo}\n` +
    `- **Prazo:** ${prazo}\n` +
    `- **Etiquetas:** ${card.etiquetasTexto || "Nenhuma"}\n` +
    `- **Descrição:** ${card.descricao || "(vazia)"}\n` +
    `- **Checklist:**\n${itens}\n\n` +
    `_Processado localmente, sem consumir cota do Gemini._\n\n` +
    `Posso criar o cartão com esta estrutura no Trello?`
  );
}

// ---------- Gemini ----------

const toolCriarCard = {
  name: "criarCardNoTrello",
  description: "Cria o cartão estruturado no Trello após confirmação prévia da utilizadora.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      coluna: { type: Type.STRING, description: "Nome exato da coluna correspondente no quadro" },
      titulo: { type: Type.STRING, description: "Título sintético do cartão com tag temática entre parênteses retos" },
      descricao: { type: Type.STRING, description: "Descrição em Markdown com Objetivo e Contexto detalhado" },
      checklist: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: "Lista de 3 a 7 ações atómicas imperativas (ex: 'Ler edital', 'Escrever relatório')"
      },
      dataEntregaISO: {
        type: Type.STRING,
        description: `Data em formato ISO 8601 UTC (ex: 2026-10-30T23:59:00.000Z). Interprete horários no fuso ${TIMEZONE}.`
      },
      nomesEtiquetas: {
        type: Type.ARRAY,
        items: { type: Type.STRING },
        description: "Lista de etiquetas existentes no quadro compatíveis com o contexto"
      }
    },
    required: ["coluna", "titulo", "descricao", "checklist"]
  }
};

async function criarNovaSessao(nomeModelo) {
  const memoria = await carregarMemoria();
  const [etiquetasDisponiveis, listasDisponiveis] = await Promise.all([
    obterEtiquetasDoQuadro(),
    obterListasDoQuadro()
  ]);

  const nomesLabelsTexto = etiquetasDisponiveis.map((e) => `"${e.name}"`).join(", ");
  const nomesListasTexto = listasDisponiveis.map((l) => `"${l.name}"`).join(", ");
  const hojeStr = hojeNoFuso();
  const anoAtual = hojeStr.slice(0, 4);

  return ai.chats.create({
    model: nomeModelo,
    config: {
      systemInstruction: `Você é a Central Autónoma de Triagem e Execução da utilizadora, integrada ao Trello.
Ano corrente de referência: ${anoAtual}.
Data base atual de referência: ${hojeStr} (fuso ${TIMEZONE}, UTC${offsetDoFuso()}).

---

### ESTRUTURA REAL DO QUADRO DO TRELLO (ESTRITAMENTE OBRIGATÓRIA):

1. COLUNAS REAIS DISPONÍVEIS NO QUADRO:
   [ ${nomesListasTexto || '"Eventos Tech", "Hoje", "Amanhã", "Esta Semana", "Aguardando", "Caixa de entrada"'} ]

   * REGRAS DE DIRECIONAMENTO TEMPORAL E TEMÁTICO:
     - "Eventos Tech": Congressos, hackathons, simpósios, conferências e editais específicos de eventos tecnológicos (ex: SIMCOMPI, DevFest, BNDES Garagem).
     - "Hoje": Demandas com prazo para o próprio dia (diferença de 0 dias em relação a ${hojeStr}).
     - "Amanhã": Demandas que vencem no dia seguinte (diferença de 1 dia em relação a ${hojeStr}).
     - "Esta Semana": Tarefas e prazos prioritários para os próximos 2 a 7 dias.
     - "Aguardando": Atividades pendentes de médio e longo prazo (mais de 7 dias) que estão a aguardar o momento oportuno de execução, ou demandas dependentes de terceiros/respostas externas.
     - "Caixa de entrada": Ideias brutas e anotações para triagem posterior.

   * REGRA DE SELEÇÃO OBRIGATÓRIA:
     - Nunca utilize "Próximas Semanas". Se o prazo for superior a 7 dias ou for uma demanda futura em espera, use SEMPRE a coluna "Aguardando".
     - Se o foco principal for evento/simpósio/encontro de tecnologia, priorize a coluna "Eventos Tech".

2. ETIQUETAS REAIS DISPONÍVEIS:
   [ ${nomesLabelsTexto || '"Estudo / Leitura", "Desenvolvimento", "Acadêmico / Edital / Pesquisa", "Geral"'} ]
   * REGRA DE ETIQUETAS: Selecione estritamente nomes contidos na lista acima. Se a intenção for ampla, faça correspondência aproximada. Nunca invente novas etiquetas.

3. HORÁRIOS: Todo horário mencionado pela utilizadora está no fuso ${TIMEZONE}. Converta para UTC ao preencher dataEntregaISO. Sem horário informado, use 23:59 no fuso local.

Memória operacional da utilizadora:
${JSON.stringify(memoria)}

---

### PROTOCOLO DE FLUXO (ESTRITAMENTE OBRIGATÓRIO - 2 ETAPAS):

#### ETAPA 1: ESTRUTURAÇÃO E PREVIEW (NUNCA EXECUTE A TOOL AQUI)
Em qualquer primeira interação sobre uma demanda:
1. Processe as informações, defina a coluna temporal/temática, deduza as etiquetas reais e construa um checklist atómico com 3 a 7 tarefas imperativas.
2. Apresente o preview padronizado neste formato:

📌 **Pré-visualização do Card:**
- **Coluna:** [Nome exato da coluna selecionada]
- **Título:** [Título formatado com tag entre parênteses retos]
- **Prazo:** [Data legível formatada e ISO 8601 UTC]
- **Etiquetas:** [Etiquetas compatíveis]
- **Descrição:** [Resumo executivo com objetivo e contexto]
- **Checklist:**
  - [ ] Passo 1
  - [ ] Passo 2
  - [ ] Passo 3

3. Finalize EXATAMENTE com:
"Posso criar o cartão com esta estrutura no Trello?"
4. RESTRIÇÃO: JAMAIS execute 'criarCardNoTrello' nesta etapa.

#### ETAPA 2: DISPARO DA TOOL (EXECUÇÃO DEFINITIVA)
1. Execute a ferramenta 'criarCardNoTrello' APENAS E EXCLUSIVAMENTE quando a utilizadora confirmar expressamente (ex: "sim", "pode criar", "ok", "confirmo", "aprovar", "manda").
2. Resgate todos os parâmetros validados na Etapa 1 e passe nos argumentos da tool.
3. Se a utilizadora pedir ajustes (ex: "mude a data", "troque a coluna"), REAPRESENTE o preview corrigido e repita a pergunta de confirmação sem chamar a ferramenta.`,
      tools: [{ functionDeclarations: [toolCriarCard] }]
    }
  });
}

async function obterSessaoChat() {
  if (!chatSession) {
    chatSession = await criarNovaSessao(MODELOS[indiceModeloAtual]);
  }
  return chatSession;
}

// Devolve o resultado da tool ao modelo para o histórico do chat ficar consistente
// (chamada de função sempre seguida da sua resposta).
async function devolverResultadoAoModelo(chat, call, resultado) {
  try {
    await chat.sendMessage({
      message: [{
        functionResponse: {
          id: call.id,
          name: call.name,
          response: resultado
        }
      }]
    });
  } catch (err) {
    // Se falhar, recria a sessão para não deixar o histórico quebrado.
    console.warn("Aviso ao devolver resultado da tool ao modelo:", err.message);
    chatSession = null;
  }
}

// ---------- Rotas ----------

app.post("/api/reset", (req, res) => {
  chatSession = null;
  cardPendenteLocal = null;
  res.json({ ok: true });
});

// 5. Rota Principal de Chat
app.post("/api/chat", async (req, res) => {
  const { mensagem } = req.body || {};
  if (typeof mensagem !== "string" || !mensagem.trim()) {
    return res.status(400).json({ erro: "Mensagem vazia." });
  }

  // Caminho local: bloco /card estruturado, sem chamar o Gemini.
  if (/^\s*\/card\b/i.test(mensagem)) {
    const card = parsearBlocoCard(mensagem);
    if (!card) {
      return res.json({ resposta: "⚠️ Não encontrei o campo **Título:** no bloco `/card`. Use o modelo de card e tente de novo." });
    }
    cardPendenteLocal = card;
    return res.json({ resposta: previewCardLocal(card) });
  }

  // Confirmação de um card montado localmente.
  if (cardPendenteLocal) {
    if (REGEX_CONFIRMACAO.test(mensagem)) {
      const card = cardPendenteLocal;
      cardPendenteLocal = null;
      console.log("\n[Disparando criação no Trello - parser local]:", card.titulo);
      const resultado = await criarCardNoTrello(card);
      if (resultado.sucesso) await registrarCardNaMemoria(resultado);
      return res.json({ resposta: mensagemResultado(resultado) });
    }
    // Qualquer outra mensagem descarta o card local e segue para o Gemini.
    cardPendenteLocal = null;
  }

  for (let tentativa = 0; tentativa < MODELOS.length; tentativa++) {
    try {
      const chat = await obterSessaoChat();
      const response = await chat.sendMessage({ message: mensagem });

      // Verificação de Tool Calling
      const call = response.functionCalls?.find((c) => c.name === "criarCardNoTrello");
      if (call) {
        console.log("\n[Disparando criação no Trello]:", call.args);
        const resultado = await criarCardNoTrello(call.args || {});
        if (resultado.sucesso) await registrarCardNaMemoria(resultado);
        await devolverResultadoAoModelo(chat, call, resultado);
        return res.json({ resposta: mensagemResultado(resultado) });
      }

      const textoResposta = response.text || "Entendido! Deseja ajustar algo ou posso criar o cartão no Trello?";
      return res.json({ resposta: textoResposta });

    } catch (error) {
      console.warn(`[Tentativa ${tentativa + 1}] Erro no modelo ${MODELOS[indiceModeloAtual]}:`, error.message);

      const msg = error.message || "";
      const deveTrocarModelo =
        msg.includes("429") ||
        msg.includes("RESOURCE_EXHAUSTED") ||
        msg.includes("503") ||
        msg.includes("UNAVAILABLE") ||
        msg.includes("404") ||
        msg.includes("NOT_FOUND");

      if (deveTrocarModelo) {
        indiceModeloAtual = (indiceModeloAtual + 1) % MODELOS.length;
        console.log(`A alternar para o próximo modelo: ${MODELOS[indiceModeloAtual]}...`);
        chatSession = null; // recriada na próxima tentativa
        await new Promise((resolve) => setTimeout(resolve, 1000));
        continue;
      }

      return res.status(500).json({ erro: error.message });
    }
  }

  res.status(429).json({
    erro: "Quota diária temporariamente esgotada nos modelos configurados. Tente novamente mais tarde."
  });
});

app.listen(port, host, () => {
  console.log(`⚡ Central Trello AI a correr em: http://${host === "0.0.0.0" ? "localhost" : host}:${port}`);
});
