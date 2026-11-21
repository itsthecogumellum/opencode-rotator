# Instalação

## Windows (um comando)

```powershell
iwr https://raw.githubusercontent.com/itsthecogumellum/opencode-rotator/main/scripts/install.ps1 | iex
```

Se a execucao de script estiver bloqueada:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

Opcoes:

```powershell
.\install.ps1 -Port 8787 -ProxyPort 40000 -SkipWarp -SkipService
.\install.ps1 -Uninstall
```

| Flag | Efeito |
|---|---|
| `-Port` | porta do gateway (padrao 8787) |
| `-OpenCodePort` | porta do `opencode serve` (padrao 4097) |
| `-ProxyPort` | porta do proxy WARP (padrao 40000) |
| `-DefaultModel` | modelo padrao do gateway |
| `-SkipWarp` | nao instala nem configura o WARP (roda sem rotacao) |
| `-SkipService` | nao registra a inicializacao automatica |
| `-Uninstall` | remove tudo que este pacote instalou |

## Linux / macOS (um comando)

```bash
curl -fsSL https://raw.githubusercontent.com/itsthecogumellum/opencode-rotator/main/scripts/install.sh | bash
```

Flags: `--skip-warp`, `--uninstall`, `--port=`, `--proxy-port=`.

## O que o instalador faz

1. **Node.js 20+** — verifica; se faltar, instala o LTS via `winget` (Windows).
2. **opencode** — procura no app desktop (`%LOCALAPPDATA%\Programs\ai.opencode.desktop\resources\opencode-cli.exe`) e no PATH; se faltar, instala via `npm i -g opencode-ai`.
3. **Cloudflare WARP** — instala via `winget` se faltar; coloca em **modo proxy** na porta 40000; registra (sem conta) se preciso; conecta. O WARP muda o IP da maquina: o instalador avisa antes.
4. **Arquivos** — copia `scripts/`, `templates/`, `references/`, `prompts/` e a documentacao para `%LOCALAPPDATA%\opencode-rotator` (ou `~/.config/opencode-rotator`).
5. **config.json** — porta, proxy, modelo padrao e caminhos dos binarios.
6. **Inicializacao automatica** — Windows: tarefa agendada `OpenCodeRotator` no logon, com reinicio automatico a cada 1 minuto se morrer. Linux/macOS: `systemd --user` com `Restart=always`.
7. **Bridge no ar** — sobe e espera `/healthz` responder.
8. **Doctor** — roda a verificacao completa e devolve o codigo de saida.

## Instalacao manual (sem rodar o script)

```powershell
git clone https://github.com/itsthecogumellum/opencode-rotator.git
cd opencode-rotator
node scripts\doctor.mjs
```

Depois:

```powershell
warp-cli --accept-tos mode proxy
warp-cli --accept-tos proxy port 40000
warp-cli --accept-tos registration new
warp-cli --accept-tos connect
node scripts\bridge.mjs
```

## Instalar a skill no seu agente

A skill e um `SKILL.md`. Copie para a pasta de skills do agente:

| Agente | Caminho |
|---|---|
| OpenCode | `~/.config/opencode/skill/<nome>/SKILL.md` |
| Claude Code | `~/.claude/skills/<nome>/SKILL.md` |
| Codex | `~/.codex/skills/<nome>/SKILL.md` |
| Qualquer agente | a pasta deste repo (abra o agente dentro dela) |

Prompt pronto: `prompts/INSTALL-LLM.md`.

## Como confirmar que installou

```bash
node scripts/doctor.mjs
```

Esperado: todos os itens em `PASS` (ou `WARN` apenas em WARP, se voce escolheu `-SkipWarp`), e a saida final `Tudo verde. O sistema esta pronto para uso.`

Prova de rotacao de verdade:

```bash
node scripts/doctor.mjs --rotate
```

Esse e o unico teste que fecha o ciclo: ambiente + rede + bridge + modelos + chamada real + mudanca de IP verificada.
