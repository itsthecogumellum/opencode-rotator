#!/usr/bin/env bash
# language: Bash · file: scripts/install.sh
# Instalador de um comando do OpenCode Rotator para macOS e Linux.
# uso: curl -fsSL https://raw.githubusercontent.com/itsthecogumellum/opencode-rotator/main/scripts/install.sh | bash
set -uo pipefail

REPO_OWNER="itsthecogumellum"
REPO_NAME="opencode-rotator"
TASK_NAME="opencode-rotator"
BRIDGE_PORT="${BRIDGE_PORT:-8787}"
OPENCODE_PORT="${OPENCODE_PORT:-4097}"
PROXY_PORT="${PROXY_PORT:-40000}"
DEFAULT_MODEL="${DEFAULT_MODEL:-opencode/deepseek-v4.1-flash-free}"
SKIP_WARP=0
UNINSTALL=0

for arg in "$@"; do
  case "$arg" in
    --skip-warp) SKIP_WARP=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --port=*) BRIDGE_PORT="${arg#*=}" ;;
    --proxy-port=*) PROXY_PORT="${arg#*=}" ;;
  esac
done

BOLD=$'\e[1m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RED=$'\e[31m'; DIM=$'\e[90m'; RESET=$'\e[0m'
step() { printf "\n%s==>%s %s\n" "$YELLOW" "$RESET" "$1"; }
ok()   { printf "%s[OK]%s   %s\n" "$GREEN" "$RESET" "$1"; }
warn() { printf "%s[AVISO]%s %s\n" "$YELLOW" "$RESET" "$1"; }
die()  { printf "%s[FALHA]%s %s\n" "$RED" "$RESET" "$1"; exit 1; }

APP_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/opencode-rotator"

if [ "$UNINSTALL" = "1" ]; then
  step "Removendo o OpenCode Rotator"
  command -v systemctl >/dev/null && systemctl --user disable --now "$TASK_NAME" 2>/dev/null && ok "servico systemd removido" || warn "servico systemd nao estava ativo"
  pkill -f "bridge.mjs" 2>/dev/null && ok "bridge encerrado" || true
  rm -rf "$APP_DIR" && ok "pasta $APP_DIR removida"
  echo -e "\n${GREEN}Desinstalado.${RESET}\n"
  exit 0
fi

printf "\n%sOpenCode Rotator — instalador%s\n" "$BOLD" "$RESET"

# ---------------------------------------------------------------- 1. origina
SOURCE_DIR=""
if [ -f "$(dirname "$0")/../SKILL.md" ]; then
  SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
else
  step "Baixando o $REPO_NAME"
  TMP="$(mktemp -d)"
  if curl -fsSL "https://github.com/$REPO_OWNER/$REPO_NAME/archive/refs/heads/main.tar.gz" -o "$TMP/repo.tgz"; then
    tar -xzf "$TMP/repo.tgz" -C "$TMP"
    SOURCE_DIR="$(find "$TMP" -maxdepth 1 -type d -name "${REPO_NAME}-*" | head -1)"
  fi
fi
[ -n "$SOURCE_DIR" ] && [ -d "$SOURCE_DIR" ] || die "nao consegui obter os arquivos do repo"

# ---------------------------------------------------------------- 2. node
step "1/5 Node.js"
if command -v node >/dev/null; then
  MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$MAJOR" -ge 20 ] && ok "Node $(node --version)" || die "Node $MAJOR e antigo demais (precisa 20+)"
else
  warn "Node nao encontrado. Instale Node 20+ (https://nodejs.org) e rode de novo."
  exit 1
fi

# ---------------------------------------------------------------- 3. opencode
step "2/5 opencode"
if command -v opencode >/dev/null; then
  ok "opencode: $(command -v opencode)"
elif command -v npm >/dev/null; then
  echo "  instalando opencode via npm..."
  npm install -g opencode-ai >/dev/null 2>&1
  command -v opencode >/dev/null && ok "opencode instalado" || warn "npm install falhou; instale o app desktop"
else
  warn "opencode nao encontrado e npm indisponivel"
fi

# ---------------------------------------------------------------- 4. warp
step "3/5 Cloudflare WARP"
if [ "$SKIP_WARP" = "1" ]; then
  warn "pulando WARP (--skip-warp): rotacao de IP desativada"
elif command -v warp-cli >/dev/null; then
  warp-cli --accept-tos mode proxy >/dev/null 2>&1
  warp-cli --accept-tos proxy port "$PROXY_PORT" >/dev/null 2>&1
  if ! warp-cli --accept-tos status 2>&1 | grep -qi "registered"; then
    warp-cli --accept-tos registration new >/dev/null 2>&1
  fi
  warp-cli --accept-tos connect >/dev/null 2>&1
  sleep 4
  warp-cli --accept-tos status 2>&1 | grep -qi "connected" && ok "WARP conectado em modo proxy (:$PROXY_PORT)" || warn "WARP nao conectou"
else
  warn "warp-cli nao encontrado (instale o cliente Linux da Cloudflare). O bridge roda sem rotacao."
fi

# ---------------------------------------------------------------- 5. arquivos + config
step "4/5 arquivos e configuracao em $APP_DIR"
mkdir -p "$APP_DIR"
for d in scripts templates references prompts; do
  [ -d "$SOURCE_DIR/$d" ] && cp -r "$SOURCE_DIR/$d" "$APP_DIR/" 2>/dev/null
done
for f in SKILL.md README.md GUIA-COMPLETO.md LICENSE; do
  [ -f "$SOURCE_DIR/$f" ] && cp "$SOURCE_DIR/$f" "$APP_DIR/" 2>/dev/null
done
cat > "$APP_DIR/config.json" <<EOF
{
  "bridgePort": $BRIDGE_PORT,
  "opencodePort": $OPENCODE_PORT,
  "proxyUrl": "http://127.0.0.1:$PROXY_PORT",
  "defaultModel": "$DEFAULT_MODEL",
  "keepSessions": false
}
EOF
ok "config.json gravado"

# ---------------------------------------------------------------- 6. servico
step "5/5 inicializacao automatica"
if command -v systemctl >/dev/null; then
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/$TASK_NAME.service" <<EOF
[Unit]
Description=OpenCode Rotator - gateway OpenAI-compatible com rotacao de IP
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=ROTATOR_HOME=$APP_DIR
ExecStart=$(command -v node) $APP_DIR/scripts/bridge.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "$TASK_NAME" && ok "servico systemd --user ativo" || warn "nao consegui ativar o systemd --user"
else
  nohup node "$APP_DIR/scripts/bridge.mjs" > "$APP_DIR/bridge.log" 2>&1 &
  ok "bridge iniciado em background (sem systemd)"
fi

sleep 3
if curl -fsS "http://127.0.0.1:$BRIDGE_PORT/healthz" >/dev/null 2>&1; then
  ok "bridge respondendo em http://127.0.0.1:$BRIDGE_PORT"
else
  warn "bridge ainda nao respondeu; veja $APP_DIR/bridge.log"
fi

node "$APP_DIR/scripts/doctor.mjs"
DOCTOR=$?

printf "\n%sInstalado.%s\n" "$GREEN" "$RESET"
printf "  uso:        node \"%s/scripts/bridgectl.mjs\" status\n" "$APP_DIR"
printf "  rotacionar: node \"%s/scripts/bridgectl.mjs\" rotate\n" "$APP_DIR"
printf "  log:        %s/bridge.log\n\n" "$APP_DIR"
exit $DOCTOR
