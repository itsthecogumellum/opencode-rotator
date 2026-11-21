<p align="center">
  <b>OpenCode Rotator</b><br>
  <i>Gateway local com rotacao <b>verificada</b> de IP. O opencode bate cota, o rotator troca o IP, a chamada segue.</i>
</p>

# OpenCode Rotator

> "Atingiu o limite e nao resetou o IP. Resetei na mao e ainda continua com limite."

Esse e o bug que este pacote existe para matar.

O plano free do provedor usado pelo `opencode serve` queima cota **por IP de saida ou por conta** — e o regime muda. Trocar o IP devolve a cota no primeiro caso; no segundo, nao devolve nada e o provider devolve um `retryAfterMs` dizendo quando volta. Nos dois, "resetar o IP na mao" parece funcionar e nao resolve.

O OpenCode Rotator faz a parte chata por voce, com prova:

- **rotacao verificada** — so aceita o IP novo depois de comparar com o anterior e com a lista de IPs queimados;
- **escada de recuperacao** — `reconnect` → `registration new` → re-registro com espera maior;
- **IP queimado** — o endereco que estourou a cota fica fora da lista por 24h, entao o sistema nao volta para ele;
- **auto-recuperacao** — o gateway detecta o limite, rotaciona e repete a chamada sozinho;
- **classificacao de escopo** — depois de 2 rotacoes em IPs diferentes, se o limite persiste, o pacote diz que a cota e **por conta** e para de girar IP;
- **doctor** — um comando que prova o sistema inteiro, incluindo que o IP mudou.

## Instalar em um comando

**Windows (PowerShell)**

```powershell
iwr https://raw.githubusercontent.com/itsthecogumellum/opencode-rotator/main/scripts/install.ps1 | iex
```

**Linux / macOS**

```bash
curl -fsSL https://raw.githubusercontent.com/itsthecogumellum/opencode-rotator/main/scripts/install.sh | bash
```

O instalador checa Node 20+, opencode e Cloudflare WARP; coloca o WARP em modo proxy na porta 40000; registra a inicializacao automatica (tarefa agendada no Windows, `systemd --user` no Linux); sobe o gateway e roda o doctor.

> O WARP muda o IP de saida da sua maquina. O instalador avisa antes.

Se a porta 8787 ja estiver ocupada por outro gateway, o instalador para e diz exatamente quem esta usando. Para migrar de um gateway antigo para este, rode com `-TakeOver`:

```powershell
iwr https://raw.githubusercontent.com/itsthecogumellum/opencode-rotator/main/scripts/install.ps1 | iex -UseBasicParsing
# ou, ja com o script baixado:
.\install.ps1 -TakeOver
```

## Provar que funciona

```bash
node scripts/doctor.mjs --rotate
```

Saida real do doctor (medida em 21/11/2026 neste ambiente):

```
  PASS  Node.js >= 20 — v26.13.0
  PASS  binario do opencode — .../opencode-cli.exe
  PASS  warp-cli instalado — C:\Program Files\Cloudflare\Cloudflare WARP\warp-cli.exe
  PASS  WARP conectado — Status update: Connected
  PASS  WARP em modo proxy — (user set)  Mode: WarpProxy on port 40000
  PASS  proxy na porta 40000 — (user set)  Mode: WarpProxy on port 40000
  PASS  proxy responde — 2a09:bac1:1140:30::3a9:2c
  PASS  exit IP do proxy diferente do direto — proxy=2a09:bac1:1140:30::3a9:2c direto=45.235.69.94
  PASS  bridge responde em /healthz — porta 8787
  PASS  opencode serve autenticado — senha capturada
  PASS  proxy ativo no bridge — rotacao habilitada
  PASS  lista de modelos nao vazia — 11 modelos
  PASS  chamada real de chat — HTTP 200 em 9.0s - "ok"
  PASS  usage devolvido — {"prompt_tokens":124,"completion_tokens":3,"total_tokens":127}
  PASS  rotacao executada — degrau reconnect
  PASS  exit IP mudou de verdade — 2a09:bac1:1140:30::3a9:2c -> 2a09:bac1:1120:30::3a9:6
```

## Quando a cota e por conta (e nao por IP)

Medido aqui: quatro IPs de saida distintos, o mesmo limite em todos, e o provider avisando o tempo de reset.

```
COTA FREE escopo=account | rotacoes=2 | ips=2a09:bac1:1120:30::3a9:6, 2a09:bac5:5a9:24be::3a9:6, 2a09:bac5:5a9:878::d8:1fa
  volta em ~5.8h (retry_after_ms=21039000)
  cota free por conta: trocar IP nao resolve. Use outro modelo/conta ou espere o reset (retry_after_ms).
```

Nesse regime o pacote **para de girar IP** e devolve o `scope` no corpo do 429 (`account`, `ip` ou `unknown`), com os IPs testados e o `retry_after_ms`. O proximo passo e trocar de modelo/conta ou esperar — nao girar mais.

## Usar nos seus agentes

O gateway e OpenAI-compatible. Qualquer agente aponta para ele:

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="local")
reply = client.chat.completions.create(
    model="opencode/deepseek-v4.1-flash-free",
    messages=[{"role": "user", "content": "responda apenas: ok"}],
)
print(reply.choices[0].message.content)
```

```bash
curl -s http://127.0.0.1:8787/v1/models
```

Resposta traz `usage` e um bloco `bridge` com `exit_ip` e `rotations` — o `exit_ip` e a prova de por onde a chamada saiu.

## Operar

```bash
node scripts/bridgectl.mjs status              # bridge, proxy, exit IP, rotacoes, IPs queimados
node scripts/bridgectl.mjs rotate              # rotacao manual verificada
node scripts/bridgectl.mjs test "responda ok"  # chamada real
node scripts/bridgectl.mjs logs 100            # ultimas linhas
node scripts/doctor.mjs                        # diagnostico completo
```

## A skill

O `SKILL.md` deste repo e uma skill que ensina qualquer agente (OpenCode, Claude Code, Codex, Cursor) a diagnosticar e recuperar do limite de cota sozinho — com a regra de nunca afirmar que o IP foi resetado sem antes mostrar o IP anterior e o posterior.

Copie `SKILL.md` para a pasta de skills do seu agente, ou use o prompt pronto em [`prompts/INSTALL-LLM.md`](prompts/INSTALL-LLM.md).

## Mapa do repo

```
scripts/bridge.mjs      gateway OpenAI-compatible + rotacao verificada (o nucleo)
scripts/bridgectl.mjs   CLI: status, rotate, test, models, state, logs
scripts/doctor.mjs      prova executavel de que o sistema inteiro funciona
scripts/install.ps1     instalador de um comando (Windows)
scripts/install.sh      instalador de um comando (Linux/macOS)
SKILL.md                a skill para os agentes
prompts/INSTALL-LLM.md  prompt pronto de instalacao
references/             troubleshooting, limites, arquitetura, instalacao
templates/              config.json, unidade systemd, tarefa agendada
GUIA-COMPLETO.md        explicacao detalhe a detalhe de tudo
```

## Documentacao

- [GUIA-COMPLETO.md](GUIA-COMPLETO.md) — como funciona por dentro, cada arquivo, cada opcao.
- [references/troubleshooting.md](references/troubleshooting.md) — sintoma → causa → comando.
- [references/limites-e-cota.md](references/limites-e-cota.md) — como a cota free se comporta e quando rotacionar nao resolve.
- [references/arquitetura.md](references/arquitetura.md) — diagramas e fluxos.
- [references/instalacao.md](references/instalacao.md) — instalacao manual, flags, skill nos agentes.

## Requisitos

- Node.js 20+ (testado no 26)
- `opencode` (app desktop ou `npm i -g opencode-ai`)
- Cloudflare WARP em modo proxy (Windows, Linux, macOS)
- `curl` no PATH

## Licenca

MIT. Ver [LICENSE](LICENSE).
