# Guia completo

Leitura de referencia do OpenCode Rotator: o problema, a teoria, o que cada arquivo faz, cada opcao de configuracao, cada endpoint, o manual de operacao e onde mexer quando algo mudar.

---

## 1. O problema

**Sintoma relatado:** o opencode atinge o limite diario, o IP nao reseta, resetar na mao nao resolve, e o chat continua travado.

**Por que acontece.** O plano gratuito do provedor que o `opencode serve` usa tem cota por IP de saida. Isso cria tres situacoes distintas que *parecem* a mesma coisa:

| Situacao | O que voce ve | Causa real |
|---|---|---|
| A | "reiniciei o IP e o limite continua" | O WARP devolveu o mesmo endereco. A rotacao foi um no-op. |
| B | "reiniciei o IP e o limite continua" | O trafego nao passa pelo WARP. A cota queima no IP da sua conexao domestica. |
| C | "reiniciei o IP e o limite continua" | A cota e por conta, nao por IP. Nenhuma rotacao resolve. |

Nenhuma dessas tres se resolve com "resetar o IP na mao". Por isso o pacote nao automatiza o reset: **ele automatiza o diagnostico e so afirma sucesso com evidencia.**

## 2. A teoria por tras

### 2.1 Por que trocar IP devolve cota

O provedor contabiliza o uso diario por endereco de saida. Ao trocar o endereco, a contagem recomeca. E por isso que rodar o mesmo workload em dois IPs seguidas da uma sensacao de "cota infinita" — ate o provedor rotacionar de volta para um IP ja usado.

### 2.2 Por que o reset manual falha

`warp-cli disconnect` + `connect` encerra o tunel e cria outro. O provedor pode reatribuir o mesmo endereco logo em seguida, especialmente em reconnect curto. Alem disso:

- o `curl -x` pode continuar respondendo pelo cache da conexao anterior por alguns segundos;
- o `opencode serve` sobe com o env de proxy no momento do start — se ele nasceu sem `HTTPS_PROXY`, ele sai direto e a rotacao do WARP nao tem efeito sobre ele;
- se a cota for por conta, nada muda.

### 2.3 A resposta correta

Rotacionar com **verificacao** e **escalada**:

1. reconnect;
2. se o IP repetiu: re-registro (`registration new`) e reconnect;
3. se ainda repetiu: re-registro com espera maior;
4. em cada degrau, o IP so e aceito se for **diferente do anterior** e **nao estiver queimado**;
5. IP que estourou cota entra na lista de queimados e fica fora por 24h.

O item 5 e o que fecha o problema do Discord: sem ele, o sistema pode rotacionar e voltar exatamente para o endereco que acabou de estourar.

---

## 3. O que sera instalado

| Item | Caminho (Windows) | Caminho (Linux/macOS) |
|---|---|---|
| Pacote | `%LOCALAPPDATA%\opencode-rotator` | `~/.config/opencode-rotator` |
| Gateway | `scripts\bridge.mjs` | `scripts/bridge.mjs` |
| CLI | `scripts\bridgectl.mjs` | `scripts/bridgectl.mjs` |
| Doctor | `scripts\doctor.mjs` | `scripts/doctor.mjs` |
| Config | `config.json` | `config.json` |
| Estado | `state.json` | `state.json` |
| Log | `bridge.log` | `bridge.log` |
| Inicializacao | tarefa agendada `OpenCodeRotator` (logon) | `systemd --user` `opencode-rotator.service` |

O instalador **nao** desinstala nem reverte o WARP: ele muda so o modo (proxy) e a porta. Para desfazer, rode `install.ps1 -Uninstall` e restaure o modo do WARP com `warp-cli --accept-tos mode vpn` (ou `warp-cli --accept-tos disconnect`).

---

## 4. Passo a passo da instalacao manual

```bash
# 1. WARP em modo proxy na porta 40000
warp-cli --accept-tos mode proxy
warp-cli --accept-tos proxy port 40000
warp-cli --accept-tos registration new      # so na primeira vez
warp-cli --accept-tos connect

# 2. conferir que o proxy responde e muda o IP
curl -s https://api.ipify.org
curl -s -x http://127.0.0.1:40000 https://api.ipify.org
# os dois devem ser diferentes

# 3. subir o gateway
node scripts/bridge.mjs

# 4. provar que tudo funciona
node scripts/doctor.mjs --rotate
```

---

## 5. Cada arquivo, em detalhe

### `scripts/bridge.mjs`

O nucleo. Um processo Node sem dependencia externa.

**Descoberta de binarios.** `opencode`: `OPENCODE_BIN` → app desktop do Windows → `~/.opencode/bin/opencode` → PATH. `warp-cli`: `WARP_CLI` → caminhos padrao do Windows/Linux → PATH. `curl`: `curl` no PATH.

**Subida do `opencode serve`.** `spawn(OPENCODE_BIN, ["serve", "--hostname", "127.0.0.1", "--port", N])` com `HTTPS_PROXY`/`HTTP_PROXY` = proxy do WARP (quando o proxy responde) e `NO_PROXY=localhost,127.0.0.1`. A senha que o servidor imprime (`server password <senha>`) e capturada do stdout e usada como Basic auth na API interna. Se o processo morre, ele reinicia em 3s (com backoff em caso de falha).

**Traducao de chamada.** `POST /v1/chat/completions` vira:
```
POST /api/session                      -> id da sessao
POST /api/session/<id>/prompt          -> id do prompt
POST /api/experimental/session/<id>/wait-> espera o turno
GET  /api/session/<id>/message         -> mensagens
DELETE /api/session/<id>               -> limpa (a menos que keepSessions)
```
O texto e montado com `system`/`assistant`/`user` separados por linha em branco. A resposta volta no formato OpenAI, com `usage` derivado dos tokens do turno e um bloco extra:

```json
"bridge": { "exit_ip": "2a09:...", "rotations": 2, "rotation_step": "reregister" }
```

**Deteccao de cota.** `LIMIT_PATTERNS` casa o texto **e** o objeto de erro do assistant. Quando casa: queima o IP atual, rotaciona (com lock, para rotacoes concorrentes nao brigarem pelo tunel), repete a chamada. Ate `ROTATE_TRIES` vezes. Se ainda faltar, responde `429` com `type: "free_limit"` e `retry_after_ms` quando o upstream informa.

**`/healthz` nunca bloqueia.** Devolve o ultimo exit IP conhecido e dispara a sondagem em background. Isso importa: um health check que trava quando o WARP esta fora e pior que nenhum.

**Watchdog do WARP (60s).** Sondagem do proxy. Se o estado mudou (caiu ou voltou), reinicia o `opencode serve` com o env correto — sem proxy quando caiu, com proxy quando voltou. Se ha chamada em andamento ha mais de 6 minutos, o watchdog espera.

### `scripts/bridgectl.mjs`

Fala com `/healthz` e `/admin/*`. Nao duplica logica de rotacao — a CLI e so um cliente do bridge, entao o que a CLI mostra e o que o bridge real mente.

| Comando | O que faz |
|---|---|
| `status` | bridge no ar, proxy on/off, exit IP, rotacoes, IPs queimados, chamada ativa, ultimo erro |
| `rotate [--reason X]` | rotacao verificada; imprime `antes -> depois` e o degrau usado; sai com codigo 1 se falhar |
| `test [texto]` | chamada real de chat; mostra texto, `usage`, `exit_ip` e `rotations` |
| `models` | modelos expostos |
| `state` | `state.json` completo |
| `logs [N]` | ultimas N linhas do log |
| `start` / `stop` | sobe/derruba em background |

### `scripts/doctor.mjs`

Quatro blocos: ambiente, rede, bridge, modelos+chamada real (+ `--rotate`). Cada check imprime `PASS`, `WARN` (nao bloqueia) ou `FAIL` (conta para o codigo de saida). O codigo de saida e o gate do instalador: se algo critico falhar, o instalador sai != 0.

O check mais importante e o de rede:

```
PASS  exit IP do proxy diferente do direto — proxy=2a09:...::49a:20 direto=189.x.x.x
```

Se os dois forem iguais, todo o resto e decoracao: a cota vai queimar no IP direto.

### `scripts/install.ps1` / `scripts/install.sh`

Resolvem a origem dos arquivos de dois jeitos: se o script roda de dentro de um checkout, usam a pasta local; se vem por pipe (`iwr | iex`), baixam o tarball/zip do GitHub. Depois fazem a mesma sequencia: node → opencode → WARP → arquivos → config → servico → doctor.

---

## 6. Configuracao

`config.json` na pasta do app:

```json
{
  "bridgePort": 8787,
  "opencodePort": 4097,
  "proxyUrl": "http://127.0.0.1:40000",
  "defaultModel": "opencode/deepseek-v4.1-flash-free",
  "opencodeBin": "C:\\...\\opencode-cli.exe",
  "warpCli": "C:\\Program Files\\Cloudflare\\Cloudflare WARP\\warp-cli.exe",
  "keepSessions": false,
  "logFile": "C:\\Users\\...\\bridge.log",
  "burnTtlMs": 86400000,
  "rotatePollMs": 1500,
  "warpTimeoutMs": 60000
}
```

| Chave | Padrao | Efeito |
|---|---|---|
| `bridgePort` | 8787 | porta do gateway |
| `opencodePort` | 4097 | porta do `opencode serve` interno |
| `proxyUrl` | `http://127.0.0.1:40000` | proxy do WARP |
| `defaultModel` | `opencode/deepseek-v4.1-flash-free` | modelo quando o pedido nao especifica |
| `keepSessions` | false | mantem as sessoes no servidor em vez de apagar |
| `burnTtlMs` | 24h | quanto tempo um IP queimado fica bloqueado |
| `limitRotationBudget` | 2 | quantas trocas de IP ao bater cota free antes de classificar o escopo |
| `rotatePollMs` | 1500 | intervalo do poll do exit IP |
| `warpTimeoutMs` | 60000 | timeout de uma chamada `warp-cli` |

Variaveis de ambiente tem prioridade sobre o arquivo: `BRIDGE_PORT`, `OPENCODE_PORT`, `WARP_PROXY`, `DEFAULT_MODEL`, `WAIT_MS`, `REQUEST_MAX_MS`, `ROTATE_TRIES`, `LIMIT_ROTATION_BUDGET`, `OPENCODE_BIN`, `WARP_CLI`, `KEEP_SESSIONS=1`, `ROTATOR_HOME`, `ROTATOR_LOG`.

| Variavel | Padrao | Efeito |
|---|---|---|
| `WAIT_MS` | 300000 | quanto tempo espera o turno do modelo |
| `REQUEST_MAX_MS` | 360000 | teto duro de uma chamada (estourou, vira 504) |
| `ROTATE_TRIES` | 4 | tentativas da escada **manual** (`bridgectl rotate`) |
| `LIMIT_ROTATION_BUDGET` | 2 | rotacoes automaticas ao bater cota free |

---

## 7. Referencia de endpoints

| Metodo | Rota | Resposta |
|---|---|---|
| GET | `/healthz` | `{ ok, port, proxy, exit_ip, proxy_ticks, proxy_last, active, active_since, rotations, burned_ips, uptime_ms, opencode_bin, warp_cli, default_model, last_error }` |
| GET | `/v1/models` | `{ object: "list", data: [{ id, object, created, owned_by }] }` |
| POST | `/v1/chat/completions` | `{ id, object, created, model, choices[], usage, bridge: { exit_ip, rotations, rotation_step } }` |
| POST | `/admin/rotate` | `{ ok, before, after, step }` |
| GET | `/admin/state` | estado persistido |
| POST | `/admin/burn` | `{ ok, ip }` |

Erros:

```json
{
  "error": {
    "message": "...Free usage limit reached...",
    "type": "free_limit",
    "scope": "account",
    "retry_after_ms": 21039000,
    "rotations": 2,
    "ips_tried": ["2a09:bac1:1120:30::3a9:6", "2a09:bac5:5a9:24be::3a9:6"],
    "exit_ip": "2a09:bac5:5a9:878::d8:1fa",
    "hint": "cota free por conta: trocar IP nao resolve. Use outro modelo/conta ou espere o reset (retry_after_ms)."
  }
}
```

O `scope` diz o que fazer:

| scope | Significado | Acao |
|---|---|---|
| `account` | IPs diferentes, mesmo limite | esperar o reset / trocar de conta ou modelo. **Nao girar mais.** |
| `ip` | a rotacao nao entregou IP novo | reconectar o WARP e rotacionar de novo |
| `unknown` | nem houve rotacao | proxy off: habilitar o WARP |

```json
{ "error": { "message": "...", "type": "bridge_error" } }
{ "error": { "message": "...", "type": "timeout" } }
```

---

## 8. Manual de operacao

**Diaria:** nada. O bridge sobe com o login e faz o resto.

**Quando o opencode trava por cota:**

```bash
node scripts/bridgectl.mjs status
node scripts/bridgectl.mjs rotate
node scripts/bridgectl.mjs test "responda ok"
```

Se `rotate` falhar: nao repita. Va para `references/troubleshooting.md`, secao "rotacao devolveu o mesmo IP".

**Toda semana (opcional):** olhe `state.json`. Se a lista de queimados cresce rapido, a cota esta apertada de verdade: suba de nivel na escada de modelos.

**Atualizar o pacote:**

```bash
cd ~/opencode-rotator && git pull
node scripts/doctor.mjs
```

---

## 9. Escada de modelos

| Nivel | Motor | Custo | Quando |
|---|---|---|---|
| T0 | Ollama local | zero | tarefa que cabe no modelo local |
| T1 | gateway (`opencode/*-free`) | zero | tarefa comum — o gateway ja gerencia cota e rotacao |
| T2 | API paga barata (DeepSeek) | baixo | qualidade importa e T1 nao resolve |
| T3 | Sonnet/Haiku | alto | reserva final |

O gateway expoe todos os modelos free do provedor `opencode` em `/v1/models`. Trocar de nivel e trocar o `model` no pedido.

---

## 10. Seguranca

- O gateway escuta **apenas** em `127.0.0.1`. Nao expoe porta na rede.
- Sem autenticacao: e local. Nao puts o `8787` para fora de proposito.
- A senha do `opencode serve` fica em memoria, nunca em disco nem no log.
- `state.json` guarda IPs publicos queimados. Sem credencial.
- O log registra rotacoes, IPs de saida e mensagens de erro — sem conteudo de prompt.

---

## 11. Adaptando

**Novo padrao de cota:** edite `LIMIT_PATTERNS` em `scripts/bridge.mjs`.

**Novo degrau de rotacao:** edite `rotationLadder()`.

**Rodar sem WARP:** `install.ps1 -SkipWarp`. O bridge sobe, o gateway funciona, mas a rotacao fica desligada e o `/healthz` mostra `proxy: false`.

**Portas diferentes:** `install.ps1 -Port 8790 -ProxyPort 40100`.

**Varios gates em uma maquina:** copie a pasta do app e mude `bridgePort`, `opencodePort` e `proxyUrl`. Cada instancia tem seu proprio `state.json` e seu proprio `opencode serve`.
