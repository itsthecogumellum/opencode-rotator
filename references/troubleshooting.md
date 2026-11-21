# Troubleshooting

Sintoma → causa real → comando. Sem adivinhação.

## "resetar o IP na mão e continua com limite"

Esse é o caso principal e tem **três causas distintas**. Identifique qual é antes de mexer em qualquer coisa.

### 1. A rotação devolveu o mesmo IP

O WARP reconectou, mas o provedor reatribuiu o mesmo endereço. A.reset manual "parece" funcionar porque o `warp-cli connect` retorna sucesso.

```bash
node scripts/bridgectl.mjs status   # anote exit_ip
node scripts/bridgectl.mjs rotate
# repete ate 4x: o IP anterior e o novo sao diferentes?
```

O que o rotator faz sozinho: degrau 1 (reconnect), degrau 2 (`registration new` + reconnect), degrau 3 (re-registro com espera maior). Se os tres falharem, o problema **não** é a rotação.

### 2. O IP mudou, mas a cota continua

A cota é **por conta**, não por IP. Rotacionar não resolve. Sinal disso: `doctor.mjs --rotate` reporta `exit IP mudou de verdade: PASS` e mesmo assim a chamada real volta 429.

O bridge classifica isso sozinho: a resposta 429 vem com `scope: "account"`, `rotations: 2` e a lista `ips_tried` com os endereços testados. Ver:

```bash
node scripts/bridgectl.mjs test "responda ok"   # imprime escopo, IPs e o tempo de reset
```

O que fazer: mudar de conta, usar outro provedor/modelo, ou subir a escada de modelos (T0 → T1 → T2 → T3). Ver `references/limites-e-cota.md`.

### 2b. "girar IP não resolve mesmo com IP novo"

Confirmado em medição real: quatro IPs de saída distintos, mesmo limite, com `retryAfterMs` de ~5,8h. Nesse regime a cota free é por conta/dia e o único caminho é esperar o reset ou trocar de conta/modelo. Girar IP continua sendo necessário no regime "por IP" — por isso o pacote classifica em vez de insistir.

### 3. O IP mudou, mas o tráfego não passou pelo proxy

O `opencode serve` nasceu **sem** `HTTPS_PROXY` e está saindo direto. Aí a cota queima no IP de saída da sua conexão, não no do WARP.

```bash
curl -s https://ifconfig.me/ip                 # IP direto
curl -s -x http://127.0.0.1:40000 https://ifconfig.me/ip   # IP do proxy
# se forem iguais, o proxy nao esta sendo usado
```

O bridge injeta `HTTPS_PROXY`/`HTTP_PROXY` no ambiente do `opencode serve`. Se os dois IPs forem iguais, o WARP esta em modo **VPN**, não **proxy** — corrija:

```bash
warp-cli --accept-tos mode proxy
warp-cli --accept-tos proxy port 40000
warp-cli --accept-tos connect
```

Depois reinicie o bridge (o `opencode serve` precisa nascer com o env novo).

## "a cota estourou e o chat travou sem resposta"

O bridge detecta o limite e rotaciona sozinho (até `ROTATE_TRIES`). Se o chat travou de vez, o limite nao veio do texto — confira se o padrao bateu:

```
used today's free messages | daily limit reached | free limit reached |
free usage limit reached | FreeUsageLimit | rate limit exceeded |
too many requests | quota exceeded | limit reached
```

Padroes novos que aparecerem no upstream: edite `LIMIT_PATTERNS` em `scripts/bridge.mjs` e acrescente a expressao.

## "a rotação demora muito"

Cada degrau faz poll do exit IP. Tempos típicos: reconnect 15–30s, `registration new` 30–60s, degrau 3 até 90s. Atrasos vem de: WARP sem rede, DNS lento no `api.ipify.org`, ou filtro de firewall no `curl -x`.

Teste o proxy isolado:

```bash
curl -s -x http://127.0.0.1:40000 --max-time 15 https://api.ipify.org
```

## "o WARP cai sozinho"

O bridge tem watchdog de 60s: se o proxy deixar de responder, ele reinicia o `opencode serve` sem o proxy (para não travar tudo) e volta a religar quando o WARP responde. O log mostra `proxy caiu` / `proxy voltou`.

Se o WARP cai sozinho com frequencia: `warp-cli --accept-tos registration new` reconecta o tunel do zero.

## "opencode serve não sobe"

```bash
tail -50 "$HOME/.config/opencode-rotator/bridge.log"   # linux/macOS
Get-Content "$env:LOCALAPPDATA\opencode-rotator\bridge.log" -Tail 50   # windows
```

Causas frequentes: `opencode serve` nao existe nessa versao do opencode (use `opencode-cli.exe serve` do app desktop), porta 4097 ocupada, ou o binario nao está no PATH (configure `opencodeBin` no `config.json`).

## "porta 8787 ocupada"

Outro processo (geralmente o proprio bridge antigo) esta escutando. Encerre e suba de novo:

```powershell
Get-NetTCPConnection -LocalPort 8787 | Select-Object OwningProcess
Stop-Process -Id <pid> -Force
```

Ou mude a porta no `config.json` (`bridgePort`) e rode o instalador de novo com `-Port 8790`.

## "o WARP instala mas `warp-cli` nao e encontrado"

O `warp-cli` fica em `C:\Program Files\Cloudflare\Cloudflare WARP\warp-cli.exe`. O PATH do sistema normalmente nao inclui essa pasta. O instalador grava o caminho absoluto em `config.json` (`warpCli`), entao o bridge acha sozinho. Se rodar manualmente, use o caminho completo ou adicione a pasta ao PATH.

## "a chamada devolveu 429 com retry_after_ms"

O limite persiste mesmo depois de rotacionar. Respeite o `Retry-After`. Enquanto isso, use o `doctor` para saber se o problema e quota por conta (secao 2 acima) e mova o trafego para outro modelo ou conta.
