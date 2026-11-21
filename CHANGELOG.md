# Changelog

Todas as mudancas relevantes deste projeto.

## [1.1.0] - 2026-11-21

### Adicionado
- **Auto-recuperacao de `ECONNRESET` e quedas de socket**: `bridge.mjs` agora intercepta erros transitorios de rede (`ECONNRESET`, `socket connection was closed`, `Proxy CONNECT aborted`, `fetch failed`, `EPIPE`, `ETIMEDOUT`) e retenta automaticamente ate 3x (`netRetries`) com backoff progressivo e auto-cura do WARP antes de falhar.
- **Auto-cura de registro do WARP (`ensureWarpReady`)**: se o WARP perder o registro (`Registration Missing` / `Unable`) ou desconectar, o bridge recria o registro, reaplica `mode proxy` + porta e reconecta sozinho.
- **Cooldown por conta + fallback automatico de modelos free**: quando um modelo bate cota por conta (`scope=account`), o bridge guarda o cooldown (`accountCooldowns` em `state.json`) para nao desperdiçar rotacoes nas chamadas seguintes e tenta automaticamente outro modelo `*-free` livre (`autoFallbackFree`, `fallbackModels`, `maxFallbackModels`), devolvendo `bridge.model_used` e `bridge.fallback_from`.
- Novo endpoint `POST /admin/clear-cooldowns` e comando `bridgectl clear-cooldowns`.
- Endpoint `https://1.1.1.1/cdn-cgi/trace` adicionado como probe primario de exit IP (nativo na borda Cloudflare WARP, mais rapido e estavel).

### Corrigido
- `exitCache.value` nao era atualizado logo apos uma rotacao: a segunda rotacao queimava o IP antigo de novo e comparava contra o endereco errado. Agora atualiza imediatamente e aguarda 800ms de estabilizacao de socket antes do retry.
- Watchdog do proxy reiniciava o `opencode serve` numa unica piscada de 8s (gerando `ECONNRESET` em cadeia) e podia rodar no meio de uma rotacao. Agora exige 2 falhas seguidas (`proxyFailThreshold`), tenta auto-cura do WARP antes de desligar o proxy e pausa durante rotacoes (`rotationInProgress`).
- `proxyProbe` usava `-o NUL` em todos os sistemas (criando arquivo `NUL` no Linux/macOS); corrigido para `NUL` no Windows e `/dev/null` em Unix.
- `bridgectl stop` no Windows usava filtro de titulo de janela (`WINDOWTITLE eq *bridge*`) que nao casa com processo oculto; corrigido para encerrar exatamente o PID do `opencode-rotator`.

## [1.0.0] - 2026-11-21

### Adicionado
- `scripts/bridge.mjs`: gateway OpenAI-compatible (`/v1/models`, `/v1/chat/completions`) na frente do `opencode serve`, com `usage`, `stream` opcional e bloco `bridge` (`exit_ip`, `rotations`, `rotation_step`).
- Rotacao **verificada** de IP: so aceita o exit IP novo quando ele difere do anterior e nao esta na lista de IPs queimados.
- Escada de recuperacao em tres degraus: `reconnect` -> `registration new` -> re-registro com espera maior.
- Lista de IPs queimados persistida em `state.json` (`burnTtlMs`, 24h por padrao).
- Deteccao de cota free por padrao (`LIMIT_PATTERNS`) com rotacao e repeticao automaticas da chamada.
- **Classificacao do escopo da cota**: apos 2 rotacoes em IPs diferentes (`limitRotationBudget`), o 429 volta com `scope` (`account` / `ip` / `unknown`), `rotations`, `ips_tried`, `exit_ip` e `retry_after_ms` — o pacote para de girar IP quando a cota e por conta.
- Resposta `429` com `type: "free_limit"`, `scope`, `retry_after_ms` e `hint` quando a cota persiste.
- Watchdog do WARP (60s): reinicia o `opencode serve` com ou sem proxy conforme o estado real do tunel.
- Endpoints de operacao: `/healthz`, `/admin/rotate`, `/admin/state`, `/admin/burn`.
- `scripts/bridgectl.mjs`: CLI com `status`, `rotate`, `test`, `models`, `state`, `logs`, `start`, `stop`. O `test` mostra o escopo da cota e o tempo de reset.
- `scripts/doctor.mjs`: verificacao ponta a ponta (ambiente, rede, bridge, modelos, chamada real) e `--rotate` para provar a mudanca de IP. Le o modo e a porta do WARP em `warp-cli settings`.
- `scripts/install.ps1` e `scripts/install.sh`: instalacao de um comando, com registro de inicializacao automatica (tarefa agendada no Windows, `systemd --user` no Linux/macOS).
- `SKILL.md`: skill para agentes Orquestrarem diagnostico e rotacao sozinhos, com a regra de nunca afirmar sucesso sem o par de IPs.
- `prompts/INSTALL-LLM.md`: prompt pronto de instalacao.
- `references/`: troubleshooting, limites e cota, arquitetura e instalacao.
- `templates/`: `config.example.json`, unidade systemd, tarefa agendada em XML.
- `GUIA-COMPLETO.md`: explicacao detalhe a detalhe.

### Corrigido
- `config.json` gravado pelo PowerShell vinha com BOM e derrubava o `JSON.parse` do bridge (caia nos ports padrao e colidia com outra instancia). O leitor agora remove o BOM e o instalador grava sem BOM.
- `opencode serve` que saia com codigo 1 nao deixava rastro: o stderr agora e guardado num buffer curto e aparece no log.
- Vazamento de listeners no stdout do `opencode serve` (o polling antigo adicionava um listener por ciclo).
- Endpoints de IP: em algumas redes o `api.ipify.org` nao responde via proxy WARP (curl devolve `000`). O codigo testa `ifconfig.me` primeiro e o `api.ipify.org` como fallback.
- Leitura do modo e da porta do WARP: `warp-cli mode` e `warp-cli proxy port` sem argumento sao erro de uso; a leitura correta e `warp-cli settings` (`Mode: WarpProxy on port 40000`).
- O instalador nao re-registra o WARP quando ele ja esta registrado (registrar de novo troca o device e o IP).
- O instalador nao encerra mais **qualquer** `node` com `bridge.mjs` na linha de comando (matava o bridge de outro projeto). Agora so encerra o que pertence a esta pasta.
- `Register-ScheduledTask` exige administrador e derrubava o instalador no meio. Agora ha fallback: atalho na pasta de Inicializar do usuario, sem admin.
- Cores do instalador: o escape ANSI `` `e `` nao existe no PowerShell 5.1 (saida literais). O codigo ANSI e montado com `[char]27`.
- Porta do `opencode serve` ocupada por outra instancia: o bridge agora escolhe a proxima porta livre em runtime, em vez de morrer com `EADDRINUSE`.
- Porta do gateway ocupada: o bridge falha com mensagem clara em vez de um erro cru de `listen`.
- Cota free esgotada e estado da conta, nao defeito da instalacao: o doctor reporta como aviso e o instalador termina com codigo 0.

### Adicionado (pos-correcoes)
- `-TakeOver`: o instalador encerra o processo que ocupa a porta do gateway e assume, para migrar de um gateway antigo.

### Notas
- Medido em 21/11/2026: a cota free do provedor em uso nesta maquina e **por conta/dia** — 4 IPs de saida diferentes deram o mesmo limite, com `retryAfterMs` de ~5,8h. O regime pode mudar; o pacote classifica em vez de assumir.
- O gateway escuta apenas em `127.0.0.1` e nao usa autenticacao (escopo local).
- A senha do `opencode serve` fica em memoria; nunca e gravada em disco nem no log.
