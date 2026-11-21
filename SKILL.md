---
name: opencode-rotator
description: Recupera o OpenCode quando a cota free acaba e o IP nao reseta. Diagnostica o limite, rotaciona a saida do Cloudflare WARP com verificacao real de que o IP mudou, queima o IP usado, classifica se a cota e por IP ou por conta, sobe um gateway OpenAI-compatible local (127.0.0.1:8787) para os agentes usarem modelos gratuitos sem travar e roda o doctor. Use quando alguem disser que o opencode atingiu o limite, que resetou o IP na mao e continuou com limite, que o chat travou com "used today's free messages", "daily limit reached", "FreeUsageLimit", "429", "rate limit", "free limit", ou pedir para rotacionar IP, configurar WARP em modo proxy, criar escada de modelos (ollama -> gateway -> API paga) ou instalar este pacote de um comando.
---

# OpenCode Rotator

Quando o OpenCode trava por cota, o sintoma quase nunca e "falta cota" — e **cotaFree acabada num escopo que precisa ser identificado**: por IP de saida (trocar IP resolve) ou por conta (trocar IP nao resolve, e o provider devolve um `retryAfterMs` que diz quando volta).

Este pacote resolve a parte chata, com prova:

1. **Bridge** — gateway OpenAI-compatible em `127.0.0.1:8787` na frente do `opencode serve`, que detecta o limite, rotaciona o IP e repete a chamada.
2. **Rotacao verificada** — escada de recuperacao que so aceita o IP novo depois de comparar com o anterior e com a lista de IPs queimados.
3. **Classificacao de escopo** — depois de duas rotacoes em IPs diferentes, se o limite persiste, a cota e **por conta**: o pacote para de girar e diz isso, em vez de despejar IP.
4. **Doctor** — um comando que prova o sistema inteiro, incluindo que o IP mudou.

`$R` = raiz deste pacote (a pasta que contem `SKILL.md`).

## 0. Regra de ouro

**Nao diga que o IP foi resetado sem provar.** O sintoma "resetei na mao e continua com limite" e exatamente o caso em que a rotacao parece ter funcionado e nao funcionou. Toda afirmacao de sucesso precisa do par: IP anterior, IP posterior, e a prova de que sao diferentes.

**Nao gire IP infinitamente.** Se duas rotacoes em IPs diferentes deram no mesmo limite, o problema nao e IP. Mais rotacao so queima saidas.

## 1. Triagem (30 segundos)

```bash
node "$R/scripts/doctor.mjs"
```

| Falha | Causa | Acao |
|---|---|---|
| `warp-cli` ausente | WARP nao instalado | `winget install --id Cloudflare.CloudflareWARP -e` (Windows) ou cliente Linux da Cloudflare |
| `WARP em modo proxy` WARN | modo errado | `warp-cli --accept-tos mode proxy` + `proxy port 40000` |
| `proxy responde` WARN | WARP desconectado | `warp-cli --accept-tos connect` |
| `exit IP do proxy diferente do direto` WARN | trafego nao passa pelo WARP | o `opencode serve` precisa nascer com `HTTPS_PROXY`; o bridge ja faz isso |
| `chamada real de chat` FAIL 429 escopo=account | cota por conta | esperar o reset (veja `retry_after_ms`) ou trocar de conta/modelo. **Rotacionar IP nao resolve.** |
| `chamada real de chat` FAIL 429 escopo=ip | a rotacao nao entregou IP novo | reconecte o WARP (`warp-cli --accept-tos disconnect` + `connect`) e rode `rotate` de novo |
| `lista de modelos` FAIL | `opencode serve` nao subiu | veja `bridge.log` |

## 2. Rotacao manual verificada

```bash
node "$R/scripts/bridgectl.mjs" rotate --reason "limite free"
```

O que o comando faz, em ordem, e para em cada degrau so quando **o IP realmente mudou**:

1. `warp-cli disconnect` + `connect`, poll do exit IP ate 12 vezes.
2. Se o exit IP repetiu: `warp-cli registration new` (gera tunel novo) + `connect`.
3. Se ainda repetiu: re-registro com espera maior.
4. Se o IP novo estiver na lista de IPs queimados: continua escalando.

Saida boa:

```
[OK] Rotacao OK: 2a09:bac5:...::49a -> 2a09:bac1:1100:30::3b8:10 (degrau reconnect)
```

Saida ruim:

```
[ERRO] Rotacao falhou: nenhum exit IP novo obtido apos a escada de recuperacao
```

Quando isso acontece, **nao repita a mesma rotacao**. Causas e o que fazer:

- WARP sem rede → `warp-cli --accept-tos connect`, espere `status` mostrar `Connected`.
- Proxy nao e a rota real do trafego → confira `warp-cli --accept-tos settings` (tem que dizer `Mode: WarpProxy on port 40000`) e se o `opencode serve` nasceu com `HTTPS_PROXY`.
- O limite nao e por IP → se o `doctor` acusa que o IP mudou mas a chamada continua dando 429, a cota e **por conta**. Ver o proximo item.

## 3. Classificacao do escopo da cota (o caso do Discord)

Medido em 21/11/2026 neste ambiente: 4 rotacoes, 4 IPs de saida diferentes, e o limite free permaneceu identico em todos:

```
cota free: escopo=account | IPs testados: 2a09:bac5:5ae:2555::3b8:10,
                                        2a09:bac1:1100:30::3b8:10,
                                        2a09:bac5:5a9:2555::3b8:25,
                                        2a09:bac1:1120:30::3a9:6
volta em ~5.8h (retry_after_ms=21039000)
```

Ou seja: **o provider conta a cota por conta/dia e devolve um timer de reset**. Girar IP nao devolve cota nesse regime — mas continua sendo necessario no regime "por IP", e o pacote classifica qual dos dois e o seu caso.

Respostas do bridge nesse caso:

```json
{
  "error": {
    "type": "free_limit",
    "scope": "account",
    "retry_after_ms": 21039000,
    "rotations": 2,
    "ips_tried": ["2a09:...", "2a09:..."],
    "exit_ip": "2a09:...",
    "hint": "cota free por conta: trocar IP nao resolve. Use outro modelo/conta ou espere o reset (retry_after_ms)."
  }
}
```

`scope` tem tres valores:

| scope | Significado | O que fazer |
|---|---|---|
| `account` | varios IPs, mesmo limite | esperar o reset, trocar de conta, ou subir de nivel na escada de modelos |
| `ip` | a rotacao nao entregou endereco novo | reconectar o WARP e rotacionar de novo |
| `unknown` | nem chegou a rotacionar | o proxy estava off; habilite o WARP |

**Regra de decisao:** se `scope: "account"`, pare de girar IP. Diga o tempo de reset que veio do provider e ofereca a escada de modelos. Se `scope: "ip"`, o problema e do WARP e a rotacao ainda vai resolver.

## 4. Prova de rotacao ponta a ponta

```bash
node "$R/scripts/doctor.mjs" --rotate
```

Esse e o unico comando que prova o sistema inteiro: ambiente, rede, bridge, modelos, chamada real e a mudanca de IP.

## 5. Modo automatico (o que o agente instala)

O modo automatico e o **bridge**: ele fica na frente do `opencode serve`, intercepta cada chamada, e quando a resposta contem padrao de cota free:

```
used today's free messages | daily limit reached | free limit reached |
free usage limit reached | FreeUsageLimit | rate limit exceeded |
too many requests | quota exceeded | limit reached
```

ele:

1. queima o IP de saida atual (nao volta a escolher aquele IP por 24h),
2. rotaciona pela escada verificada,
3. repete a mesma chamada no IP novo,
4. repete ate **2 rotacoes** (orcamento `limitRotationBudget`) — o suficiente para provar o escopo,
5. se ainda faltar, devolve `429` com `scope`, `retry_after_ms`, `rotations` e `ips_tried`.

Instalacao de um comando:

```powershell
iwr https://raw.githubusercontent.com/itsthecogumellum/opencode-rotator/main/scripts/install.ps1 | iex
```

```bash
curl -fsSL https://raw.githubusercontent.com/itsthecogumellum/opencode-rotator/main/scripts/install.sh | bash
```

## 6. Usar o gateway nos agentes

```bash
curl -s -H "Content-Type: application/json" \
  -d '{"model":"opencode/deepseek-v4.1-flash-free","messages":[{"role":"user","content":"responda apenas: ok"}]}' \
  http://127.0.0.1:8787/v1/chat/completions
```

Base `http://127.0.0.1:8787/v1`, sem autenticacao, timeout 180s, uma repeticao em HTTP 502/503. A resposta traz `usage` e um bloco `bridge` com `exit_ip` e `rotations` — sempre registre esse `exit_ip` no relatorio: e a prova de que a chamada saiu pelo caminho certo.

Modelos: `GET http://127.0.0.1:8787/v1/models` (prefixo `opencode/`). Padrao: `opencode/deepseek-v4.1-flash-free`.

## 7. Escada de modelos (quando a cota acaba de vez)

| Nivel | Motor | Quando |
|---|---|---|
| T0 | Ollama local | tarefa que cabe no modelo local |
| T1 | gateway (deepseek/glm/hy4 free) | tarefa comum — o gateway ja gerencia cota e rotacao |
| T2 | API paga barata (DeepSeek) | qualidade importa e T1 nao resolve |
| T3 | Sonnet/Haiku | reserva final |

Quando `scope: "account"`, essa escada e a resposta certa: nao ha IP novo que salve a cota.

## 8. Regras de operacao

- Nao altere o WARP do usuario sem avisar que o IP vai mudar.
- Nao reinicie o `opencode serve` com chamada em andamento: o bridge ja espera `active == 0`.
- Nao apague `state.json` sem motivo: e o registro de IPs queimados e evita voltar para um IP sem cota.
- Toda conclusao precisa de comando rodado: `node "$R/scripts/bridgectl.mjs" status` e `node "$R/scripts/doctor.mjs"` sao as provas.
- Se algo falhar, diga qual item e o proximo passo. Nao "funcionando" sem saida real.

Referencia completa: `GUIA-COMPLETO.md`. Troubleshooting passo a passo: `references/troubleshooting.md`. Comportamento da cota: `references/limites-e-cota.md`.
