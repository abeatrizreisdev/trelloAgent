# 📌 Trello AI Agent: Central Autônoma de Gestão e Execução Pessoal

> Um assistente inteligente full-stack em Node.js integrado à IA generativa do Google (Gemini) e à API REST do Trello, concebido para atuar como central unificada de triagem para a minha rotina — transformando briefings, e-mails, demandas acadêmicas, vagas e editais em cartões acionáveis com prazos, etiquetas e checklists atômicos.

---

## 💡 Por que este projeto existe? (O Sistema Operacional da Minha Rotina)

Eu utilizo o Trello como o cérebro central da minha vida. Tudo o que preciso executar passa por lá:
- **Faculdade & Monitoria:** Prazos de disciplinas, entregas de relatórios, códigos de laboratório e artigos científicos.
- **Carreira & Oportunidades:** Processos seletivos, desafios técnicos, atualização de portfólio e formulários de vagas.
- **Inovação & Editais:** Submissões para premiações nacionais, programas de aceleração, bolsas de pesquisa e hackathons.
- **Projetos de Software:** Estruturação de MVPs, modelagem de arquitetura e backlog de features.
- **Vida Pessoal & Tarefas Operacionais:** Compromissos diários, rotinas administrativas e organização geral.

### O Gargalo
O método Kanban só funciona com fidelidade se for devidamente alimentado. No entanto, **o processo manual de criação de cartões drena o foco e a energia mental de quem precisa executar**:
- Abrir o Trello, clicar em criar cartão e selecionar a lista correspondente;
- Copiar e colar descrições densas de requisitos, e-mails ou regras;
- Decompor mentalmente o objetivo em etapas e cadastrar manualmente de 5 a 10 itens de checklist, um por um;
- Abrir o calendário da interface para selecionar data e horário limite;
- Atribuir manualmente cada etiqueta temática.

Esse atrito operacional repetitivo gerava perda de tempo diária. 

### A Solução
Desenvolvi uma ponte de automação entre a demanda bruta e o quadro Kanban. Não importa a fonte — o print de uma oportunidade, o enunciado de uma atividade acadêmica, uma ideia rápida ou o regulamento de um edital —, o texto bruto é enviado para o assistente local, que decompõe a demanda e realiza o despacho estruturado para a API do Trello.

---

## 🎯 O que o Agente Faz na Prática?

1. **Interpretação Semântica e Triagem:** Processa texto livre e identifica o contexto, as restrições e o núcleo acionável da tarefa.
2. **Decomposição em Checklists Atômicos:** Desmembra demandas abstratas em uma sequência lógica de passos executáveis, eliminando a paralisia inicial de execução.
3. **Parametrização Automática no Kanban:**
   - **Coluna Estratégica:** Define automaticamente a lista adequada (*Esta Semana*, *Próximas Semanas*, *Aguardando*).
   - **Prazos Padronizados (ISO 8601):** Extrai a data e converte para timestamps compatíveis com a API do Trello.
   - **Mapeamento de Etiquetas:** Identifica e associa as labels temáticas já cadastradas no quadro (*Estudo / Leitura*, *Desenvolvimento*, *Acadêmico*, *Geral*).
4. **Human-in-the-Loop:** Gera um preview estruturado antes da persistência no Trello, assegurando supervisão humana para manter o quadro limpo e organizado.

---

## ⚙️ Arquitetura e Engenharia de Resiliência

```
[ Entrada Bruta: Faculdade / Vaga / Projeto / Edital / Rotina ]
                                │
                                ▼
                     [ Chat Web Local (Node.js) ]
                                │
             ┌──────────────────┴──────────────────┐
             ▼                                     ▼
   [ Parser Local (Regex) ]              [ Orquestrador Gemini ]
   • Quando o texto já contém            • Para linguagem natural livre:
     o bloco estruturado `/card`:          extração semântica de datas,
   • Processamento imediato em memória     passos e contexto.
   • Custo Zero de cota/tokens           • Roteamento inteligente com
   • Bypass total de rate limits           fallback dinâmico de modelos:
             │                              - gemini-3.5-flash-lite
             │                              - gemini-3.1-flash-lite
             │                              - gemini-2.5-flash
             │                              - gemini-3.8-flash
             │                                     │
             └──────────────────┬──────────────────┘
                                ▼
               [ Validação e Aprovação do Usuário ]
                                │
                                ▼
                      [ Trello REST API ]
         (Criação de Cards, Listas, Checklists e Labels)
```

### Destaques Técnicos de Implementação:
* **Mecanismo Híbrido Anti-Rate Limit (HTTP 429):** APIs em camadas gratuitas possuem limites estritos de requisições por dia (RPD) e por minuto (RPM). O sistema conta com um parser local determinístico via Express/Node.js que intercepta blocos estruturados (`/card`) e realiza a chamada REST direta para o Trello, sem consumir tokens do modelo.
* **Pool Resiliente de Modelos:** O backend orquestra chamadas com cascata de contingência, priorizando modelos com cotas de centenas de chamadas diárias (*Flash-Lite series*).
* **Execução Atômica via REST:** O backend consome os endpoints oficiais da Atlassian/Trello para criar o cartão, injetar a descrição formatada em Markdown, associar etiquetas e disparar a criação de checklists associados em cadeia.

---

## 🛠️ Tecnologias Utilizadas

- **Runtime:** Node.js (ES Modules - `server.mjs`)
- **Backend:** Express.js
- **Inteligência Artificial:** Google GenAI SDK (Gemini Series) com suporte a Function Calling
- **Integração Externa:** Trello REST API (endpoints de `/cards`, `/checklists`, `/labels`)
- **Frontend:** Interface conversacional responsiva em HTML5, CSS3 moderno e Vanilla JavaScript

---

## 📦 Como Instalar e Rodar Localmente

### 1. Pré-requisitos
* Node.js v18 ou superior instalado;
* Chave de API do Google AI Studio;
* API Key e Token de Desenvolvedor do Trello;
* ID do Quadro (Board ID) do Trello.

### 2. Clonando o Repositório
```bash
git clone https://github.com/seu-usuario/trello-ai-agent.git
cd trello-ai-agent
```

### 3. Instalando as Dependências
```bash
npm install
```

### 4. Configurando as Variáveis de Ambiente
Crie um arquivo `.env` na raiz do projeto baseado no `.env.example`:
```bash
cp .env.example .env
```

Abra o arquivo `.env` e preencha com as suas chaves:
```ini
PORT=3000
GEMINI_API_KEY=sua_chave_do_google_ai_studio
TRELLO_API_KEY=sua_trello_api_key
TRELLO_TOKEN=sua_trello_token
TRELLO_BOARD_ID=id_do_seu_quadro_no_trello
```

### 5. Iniciando o Servidor
```bash
node server.mjs
```
Acesse `http://localhost:3000` no seu navegador.

---

## 📋 Exemplos de Uso na Rotina

### 1. Tarefa Acadêmica / Faculdade
> **Input:** *"Preciso enviar o relatório final de banco de dados no portal acadêmico até quinta-feira às 22h, incluindo script SQL e diagrama ER."*  
> **Ação:** Criação do card na coluna *Esta Semana*, com prazo formatado, etiqueta *Estudo / Leitura* e checklist detalhando modelagem ER, revisão do script e upload.

### 2. Vaga / Processo Seletivo
> **Input:** *"Vaga aberta de estágio em backend Node.js. Inscrições vão até dia 10 e pedem envio de currículo, LinkedIn e resolução de um teste técnico no GitHub."*  
> **Ação:** Card com prazo exato, etiqueta *Desenvolvimento*, resumo das tecnologias exigidas e checklist cobrindo atualização de CV, solução do desafio e submissão.

### 3. Projeto Pessoal / Demanda Geral
> **Input:** *"Configurar pipeline de CI/CD com GitHub Actions para rodar testes e lint antes do merge da branch main."*  
> **Ação:** Card estruturado na coluna de desenvolvimento, com checklist técnico focado na criação do arquivo YAML de workflow e validação dos triggers.

---

## 🛡️ Licença
Distribuído sob a licença MIT. Consulte o arquivo `LICENSE` para mais detalhes.