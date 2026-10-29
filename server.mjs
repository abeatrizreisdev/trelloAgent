import express from "express";
import { GoogleGenAI, Type } from "@google/genai";
import fs from "node:fs/promises";
import path from "node:path";
import "dotenv/config";
import { fileURLToPath } from "node:url";

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const { TRELLO_KEY, TRELLO_TOKEN, TRELLO_BOARD_ID } = process.env;
const MEMORIA_PATH = path.resolve("./memoria.json");

const MODELOS = [
  "gemini-2.5-flash",
  "gemini-2.5-pro"
];
let indiceModeloAtual = 0;
let chatSession = null;

async function carregarMemoria() {
  try {
    const data = await fs.readFile(MEMORIA_PATH, "utf-8");
    return JSON.parse(data);
  } catch {
    return { diretrizes: "", ultimos_cards_criados: [] };
  }
}

// 1. Obter listas reais do quadro
async function obterListasDoQuadro() {
  try {
    const url = `https://api.trello.com/1/boards/${TRELLO_BOARD_ID}/lists?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
    const res = await fetch(url);
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
    const url = `https://api.trello.com/1/boards/${TRELLO_BOARD_ID}/labels?key=${TRELLO_KEY}&token=${TRELLO_TOKEN}`;
    const res = await fetch(url);
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
      return { sucesso: false, erro: "Nenhuma lista encontrada no quadro do Trello." };
    }

    const nomeBusca = (coluna || "").toLowerCase().trim();
    const listaEncontrada = listas.find((l) => l.name.toLowerCase().includes(nomeBusca));
    const idLista = listaEncontrada ? listaEncontrada.id : listas[0].id;
    const nomeListaFinal = listaEncontrada ? listaEncontrada.name : listas[0].name;

    // Mapeamento tolerante de etiquetas para IDs
    let idLabelsParaEnviar = [];
    if (nomesEtiquetas && nomesEtiquetas.length > 0) {
      const etiquetasQuadro = await obterEtiquetasDoQuadro();
      for (const nome of nomesEtiquetas) {
        const termoLimpo = nome.toLowerCase().trim();
        const encontrada = etiquetasQuadro.find((e) => {
          const nomeEtiqueta = e.name.toLowerCase();
          return nomeEtiqueta.includes(termoLimpo) || termoLimpo.includes(nomeEtiqueta);
        });
        if (encontrada && !idLabelsParaEnviar.includes(encontrada.id)) {
          idLabelsParaEnviar.push(encontrada.id);
        }
      }
    }

    // Criar Cartão
    const urlCard = new URL("https://api.trello.com/1/cards");
    urlCard.searchParams.set("key", TRELLO_KEY);
    urlCard.searchParams.set("token", TRELLO_TOKEN);
    urlCard.searchParams.set("idList", idLista);
    urlCard.searchParams.set("name", titulo);
    urlCard.searchParams.set("desc", descricao);
    urlCard.searchParams.set("pos", "top");

    if (dataEntregaISO) {
      urlCard.searchParams.set("due", dataEntregaISO);
      urlCard.searchParams.set("dueReminder", "1440"); // Notificar 1 dia antes
    }

    if (idLabelsParaEnviar.length > 0) {
      urlCard.searchParams.set("idLabels", idLabelsParaEnviar.join(","));
    }

    const resCard = await fetch(urlCard.toString(), { method: "POST" });
    const textoCard = await resCard.text();

    if (!resCard.ok) {
      return { sucesso: false, erro: `Erro ao criar cartão (${resCard.status}): ${textoCard}` };
    }

    const card = JSON.parse(textoCard);

    // Adicionar Checklist
    if (checklist && checklist.length > 0) {
      const urlChecklist = new URL(`https://api.trello.com/1/cards/${card.id}/checklists`);
      urlChecklist.searchParams.set("key", TRELLO_KEY);
      urlChecklist.searchParams.set("token", TRELLO_TOKEN);
      urlChecklist.searchParams.set("name", "Checklist Operacional");

      const resChecklist = await fetch(urlChecklist.toString(), { method: "POST" });
      if (resChecklist.ok) {
        const checkData = await resChecklist.json();
        for (const item of checklist) {
          const urlItem = new URL(`https://api.trello.com/1/checklists/${checkData.id}/checkItems`);
          urlItem.searchParams.set("key", TRELLO_KEY);
          urlItem.searchParams.set("token", TRELLO_TOKEN);
          urlItem.searchParams.set("name", item);
          await fetch(urlItem.toString(), { method: "POST" });
        }
      }
    }

    return {
      sucesso: true,
      url: card.shortUrl,
      titulo,
      coluna: nomeListaFinal,
      prazo: dataEntregaISO || "Sem prazo definido",
      etiquetas: nomesEtiquetas || []
    };
  } catch (error) {
    return { sucesso: false, erro: error.message };
  }
}

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
        description: "Data em formato ISO 8601 UTC (ex: 2026-10-30T23:59:00.000Z). O ano corrente é 2026."
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
  const hojeStr = new Date().toISOString().split("T")[0];

  return ai.chats.create({
    model: nomeModelo,
    config: {
      systemInstruction: `Você é a Central Autónoma de Triagem e Execução da utilizadora, integrada ao Trello.
Ano corrente de referência: 2026.
Data base atual de referência: ${hojeStr}.

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

Memória operacional da utilizadora:
${JSON.stringify(memoria)}

---

### PROTOCOLO DE FLUXO (ESTRITAMENTE OBRIGATÓRIO - 2 ETAPAS):

#### ETAPA 1: ESTRUTURAÇÃO E PREVIEW (NUNCA EXECUTE A TOOL AQUI)
Em qualquer primeira interação sobre uma demanda (seja via comando '/card' ou conversa livre):
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

// 5. Rota Principal de Chat
app.post("/api/chat", async (req, res) => {
  const { mensagem } = req.body;
  if (!mensagem || !mensagem.trim()) {
    return res.status(400).json({ erro: "Mensagem vazia." });
  }

  for (let tentativa = 0; tentativa < MODELOS.length; tentativa++) {
    try {
      let chat = await obterSessaoChat();
      let response = await chat.sendMessage({ message: mensagem });

      // Verificação de Tool Calling
      if (response.functionCalls && response.functionCalls.length > 0) {
        for (const call of response.functionCalls) {
          if (call.name === "criarCardNoTrello") {
            console.log("\n[Disparando criação no Trello]:", call.args);
            const resultado = await criarCardNoTrello(call.args);

            if (resultado.sucesso) {
              const infoEtiquetas = resultado.etiquetas.length > 0 ? resultado.etiquetas.join(", ") : "Nenhuma";
              return res.json({
                resposta: `🎉 **Cartão criado com sucesso no Trello!**\n\n` +
                          `📌 **Título:** ${resultado.titulo}\n` +
                          `📂 **Coluna:** ${resultado.coluna}\n` +
                          `⏰ **Prazo:** ${resultado.prazo}\n` +
                          `🏷️ **Etiquetas:** ${infoEtiquetas}\n\n` +
                          `🔗 [Aceder ao Cartão no Trello](${resultado.url})`
              });
            } else {
              return res.json({
                resposta: `❌ **Falha ao criar o cartão no Trello:** ${resultado.erro}`
              });
            }
          }
        }
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
        chatSession = await criarNovaSessao(MODELOS[indiceModeloAtual]);
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

app.listen(port, () => {
  console.log(`⚡ Central Trello AI a correr em: http://localhost:${port}`);
});