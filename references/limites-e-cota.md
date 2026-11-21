# Limite free: o que realmente acontece

## O mecanismo (medido, nao achado)

O plano gratuito do provedor usado pelo `opencode serve` tem cota que pode ser contabilizada de duas formas, e o regime **muda**:

- **por IP de saida** — trocar o endereco devolve a cota imediatamente;
- **por conta/dia** — trocar o endereco nao devolve nada, e o provider devolve `retryAfterMs` com o tempo de reset.

Medicao real neste ambiente (21/11/2026), uma unica chamada com a cota estourada:

```
cota free atingida (rotacao 1/2) - queimando IP e trocando saida
rotacao ok (free limit): 2a09:bac5:5ae:2555::3b8:10 -> 2a09:bac1:1100:30::3b8:10 via reconnect
cota free atingida (rotacao 2/2) - queimando IP e trocando saida
rotacao ok (free limit): 2a09:bac5:5ae:2555::3b8:10 -> 2a09:bac5:5a9:2555::3b8:25 via reconnect
cota free: escopo=account | cota free por conta: IPs diferentes, mesmo limite. Rotacionar nao resolve.
```

Tres IPs de saida distintos, o mesmo limite, e o provider	info `retryAfterMs=21039000` (~5,8h). Conclusao: **no regime atual a cota free e por conta**. A crenca antiga de que "trocar o IP devolve cota" funcionou em outra data, mas nao e garantida.

Por isso o rotator nao insiste: duas rotacoes bastam para provar o escopo, e o resto e desperdicio de saida.

## As tres causas do sintoma "resetei na mao e continua"

| Situacao | O que voce ve | Causa real | Diagnostico |
|---|---|---|---|
| A | "reiniciei o IP e o limite continua" | o WARP devolveu o mesmo endereco | `scope: "ip"` — a escada so aceitou um IP novo em um degrau |
| B | "reiniciei o IP e o limite continua" | o trafego nao passa pelo WARP | `curl` direto e via proxy devolvem o mesmo IP |
| C | "reiniciei o IP e o limite continua" | a cota e por conta | `scope: "account"` — varios IPs, mesmo limite |

Nenhuma se resolve com "resetar o IP na mao". Por isso o pacote nao automatiza o reset: **ele automatiza o diagnostico e so afirma sucesso com evidencia.**

## A escada de recuperacao

| Degrau | Acao | Custo | Quando entra |
|---|---|---|---|
| 1 | `disconnect` + `connect`, poll do exit IP ate 12x | ~5–15s | primeiro sintoma de limite |
| 2 | `registration new` + `connect` | ~30–60s | o degrau 1 devolveu o mesmo IP |
| 3 | re-registro com espera maior | ~60–90s | os dois anteriores devolveram IP inutil |

Se os tres falharem, o rotator **para** e diz que parou. Nao faz loop infinito: trocar IP sem parar queima cota dos outros IPs sem resolver a causa.

## Classificacao do escopo

O budget de rotacoes automaticas e `limitRotationBudget` (padrao 2). Ao fim:

| IPs testados | `scope` | Leitura |
|---|---|---|
| 1 (rotacao nao entregou endereco novo) | `ip` | problema do WARP: reconecte e rotacione de novo |
| 2 ou mais, mesmo limite | `account` | a cota nao e por IP: esperar o reset, trocar de conta/modelo |
| nenhuma rotacao | `unknown` | proxy off: habilite o WARP |

Resposta do bridge:

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

O header `Retry-After` tambem vem preenchido (em segundos).

## Como o proxy e a cota interagem

O `opencode serve` recebe `HTTPS_PROXY=http://127.0.0.1:40000` no ambiente. Todo o trafego dele sai pelo WARP. Sem essa variavel, a cota queima no IP da sua conexao domestica e nenhuma rotacao do WARP muda nada — e o sintoma e exatamente "resetar o IP na mao e continuar com limite".

Por isso o `doctor` compara o IP direto com o IP do proxy. Se forem iguais, o proxy nao esta no caminho.

## Detalhe do endpoint de IP

Em algumas redes `api.ipify.org` nao responde **atraves** do proxy WARP (curl devolve `000`) enquanto `ifconfig.me` responde `200`. O rotator testa os dois, nessa ordem, e o doctor tambem — por isso ele nunca trava num endpoint morto.

## Limites operacionais

| Parametro | Padrao | Efeito |
|---|---|---|
| `limitRotationBudget` | 2 | quantas trocas de IP ao bater cota free antes de classificar |
| `rotateTries` | 4 | tentativas da escada **manual** (`bridgectl rotate`) |
| `burnTtlMs` | 24h | quanto tempo um IP queimado fica fora da lista de aceitaveis |
| `REQUEST_MAX_MS` | 360s | teto de uma chamada; estourando vira 504, nao 429 |
| `WAIT_MS` | 300s | quanto tempo o bridge espera o turno do modelo |

Ajustes ficam em `config.json` (em `%LOCALAPPDATA%\opencode-rotator` ou `~/.config/opencode-rotator`) e podem ser sobrescritos por variavel de ambiente com o mesmo nome em maiusculas (`LIMIT_ROTATION_BUDGET`, `ROTATE_TRIES`, `WAIT_MS`, `REQUEST_MAX_MS`, `BRIDGE_PORT`, `OPENCODE_PORT`, `WARP_PROXY`, `DEFAULT_MODEL`, `OPENCODE_BIN`, `WARP_CLI`, `KEEP_SESSIONS=1`).
