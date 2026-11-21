# Arquitetura

## Visão geral

```
   agente (OpenCode / Claude Code / Codex / Cursor)
        |  OpenAI-compatible: POST /v1/chat/completions
        v
   +-------------------------------------------------------+
   |  bridge  127.0.0.1:8787        (scripts/bridge.mjs)    |
   |  - le /v1/chat/completions                               |
   |  - cria sessao no opencode e espera o turno              |
   |  - detecta padrao de cota free                           |
   |  - queima o IP atual -> rotaciona -> repete              |
   +---------+----------------------+------------------------+
             |                      |
             | sessao/prompt        | warp-cli disconnect/connect
             v                      v
   +---------------------+   +-----------------------------+
   | opencode serve      |   | Cloudflare WARP (proxy)   |
   | 127.0.0.1:4097      |   | 127.0.0.1:40000           |
   | HTTPS_PROXY=40000   |-->| saida = IP rotacionavel    |
   +---------------------+   +-----------------------------+
```

## Componentes

### `scripts/bridge.mjs`

O processo unico que faz tudo. Sem dependencias externas: so Node 20+ e `curl`.

- **Sobe o `opencode serve`** como filho, com `HTTPS_PROXY`/`HTTP_PROXY` apontando para o WARP quando o proxy responde. Captura a senha que o `opencode serve` imprime no stdout (`server password <senha>`) e usa Basic auth na API interna.
- **Expõe a API OpenAI-compatible** em `127.0.0.1:8787`:
  - `GET /healthz` — estado, sem bloquear no WARP (devolve o ultimo exit IP conhecido e refresca em background).
  - `GET /v1/models` — modelos do provedor `opencode`, com cache de 60s.
  - `POST /v1/chat/completions` — traduz para `session.create` + `session.prompt` + `session.wait`, e volta no formato OpenAI (`choices`, `usage`) mais um bloco `bridge` com `exit_ip` e `rotations`.
  - `POST /admin/rotate` — rotacao manual verificada.
  - `GET /admin/state` — estado persistido.
  - `POST /admin/burn` — queima um IP na mao.
- **Rotaciona** quando o texto da resposta casa com `LIMIT_PATTERNS`. O fluxo: queimar IP → esc ladder → repetir a chamada → se ainda assim faltar, responder `429` com `type: "free_limit"` e `retry_after_ms`.
- **Watchdog de 60s** do WARP: se o proxy cair, reinicia o `opencode serve` sem proxy (nao trava tudo); quando volta, religa com o proxy.
- **Serializa rotacoes** com um lock (`rotationLock`): duas rotacoes simultaneas brigariam pelo mesmo tunel do WARP.

### `scripts/bridgectl.mjs`

CLI de operacao. `status`, `rotate`, `test`, `models`, `state`, `logs`, `start`, `stop`. Fala com os endpoints `/healthz` e `/admin/*` do bridge — mesma fonte de verdade, sem duplicar logica.

### `scripts/doctor.mjs`

Prova executavel de que o sistema esta inteiro: binarios, WARP em modo proxy, proxy respondendo, exit IP do proxy diferente do direto, bridge no ar, lista de modelos, chamada real de chat com `usage`, e (com `--rotate`) a mudanca de IP verificada antes/depois. Sai com codigo != 0 se algo critico falhar, entao serve de gate de instalacao.

### `scripts/install.ps1` / `scripts/install.sh`

Instalador de um comando. Resolve a origem dos arquivos (checkout local ou download do GitHub), instala o que falta, configura o WARP, grava `config.json`, registra a inicializacao automatica e roda o doctor.

### Estado persistido (`state.json`)

Fica em `%LOCALAPPDATA%\opencode-rotator` (Windows) ou `~/.config/opencode-rotator` (Linux/macOS).

```json
{
  "burned": [{ "ip": "2a09:...", "at": 1795280000000, "reason": "free limit" }],
  "rotations": 7,
  "lastExitIp": "2a09:...",
  "lastError": null,
  "startedAt": 1795279000000
}
```

`burned` e a lista de IPs queimados. E o que impede o sistema de voltar para um IP sem cota — exatamente o caso "resetar na mao e continuar com limite".

## Fluxo de uma chamada com cota

```
1. POST /v1/chat/completions  { model, messages }
2. bridge cria sessao no opencode (session.create) e envia o prompt (session.prompt)
3. session.wait espera o turno terminar
4. a resposta do assistant traz texto ou error
5. se o texto/error casa com LIMIT_PATTERNS:
     a. queima o exit IP atual
     b. esc ladder: reconnect -> registration new -> re-registro com espera
        (so aceita o IP se for diferente do anterior E nao estiver queimado)
     c. repete do passo 2
     d. ate ROTATE_TRIES vezes
6. se ainda faltar -> HTTP 429 { type: "free_limit", retry_after_ms }
7. senao -> HTTP 200 { choices, usage, bridge: { exit_ip, rotations } }
```

## Fluxo de uma rotacao

```
1. before = exit IP atual
2. degrau 1: warp-cli disconnect -> sleep 1.2s -> connect -> poll ate 12x (1.5s)
   se ip != before e ip nao queimado -> sucesso
3. degrau 2: warp-cli registration new -> connect -> poll
   se ip != before e ip nao queimado -> sucesso
4. degrau 3: re-registro com espera maior
5. sem sucesso: devolve { ok: false } e registra lastError
```

## Onde mexer

| Mudanca | Arquivo |
|---|---|
| novo padrao de cota free | `scripts/bridge.mjs` → `LIMIT_PATTERNS` |
| porta / modelo / caminho do opencode | `config.json` na pasta do app (ou `$R/scripts/doctor.mjs` para diagnostico) |
| degrais da rotacao | `scripts/bridge.mjs` → `rotationLadder()` |
| tempo que um IP fica queimado | `config.json` → `burnTtlMs` |
| mensagem da skill para o agente | `SKILL.md` |
