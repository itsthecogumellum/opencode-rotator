# Prompt de instalacao — cole como primeira mensagem do seu agente

> Este prompt instala o OpenCode Rotator: gateway local OpenAI-compatible na frente do `opencode serve`, com rotacao **verificada** de IP do Cloudflare WARP quando a cota free acaba — o problema de "resetar o IP na mao e continuar com limite".
>
> Cole o texto abaixo inteiro como a primeira mensagem do agente (Claude Code, OpenCode, Codex, Cursor).

---

Leia o `SKILL.md` desta pasta e instale o OpenCode Rotator aqui.

Passos, nesta ordem:

1. Rode `node scripts/doctor.mjs` e me mostre o resultado **inteiro**, sem resumir. Quero ver PASS/WARN/FAIL de cada item: node, opencode, warp-cli, WARP conectado, WARP em modo proxy, proxy responde, exit IP, bridge, modelos e chamada real.
2. Para cada WARN ou FAIL, diga em uma linha: causa e comando exato que corrige.
3. Se faltar o WARP ou ele nao estiver em modo proxy, instale/configure (Windows: `winget install --id Cloudflare.CloudflareWARP -e`, depois `warp-cli --accept-tos mode proxy` e `warp-cli --accept-tos proxy port 40000`; Linux/macOS: cliente da Cloudflare). Avise antes de mudar o IP da minha maquina.
4. Instale o pacote em `%LOCALAPPDATA%\opencode-rotator` (Windows) ou `~/.config/opencode-rotator` (Linux/macOS): copie `scripts/`, `templates/`, `references/`, `SKILL.md`, grave `config.json` e registre a inicializacao automatica (Windows: tarefa agendada `OpenCodeRotator` no logon; Linux/macOS: `systemd --user`).
5. Suba o bridge e rode `node scripts/doctor.mjs --rotate` para provar, com saida real, que: (a) o caminho de chamada funciona e (b) o exit IP **mudou** depois da rotacao.
6. Me mostre o `exit_ip` antes e depois, e o numero de rotacoes. Nao diga que funcionou sem os dois valores.
7. No final, me diga qual URL e modelo os meus agentes devem usar e como checar o log.

Nao invente resultado: se um passo falhar, diga qual e por que, e siga com o resto. Nao pare o trabalho inteiro por causa de um item.

---

Depois da instalacao, este e o prompt do dia a dia:

```
Instalei o OpenCode Rotator. Leia o SKILL.md e, a partir de agora, quando eu disser que o
opencode travou por limite, siga o fluxo de triagem e rotacao verificada do arquivo.
```
