#!/usr/bin/env node
// language: JavaScript (Node 20+) · file: scripts/bridgectl.mjs
// CLI de controle do OpenCode Rotator: status, rotate, test, models, state, logs, start, stop.
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir, platform } from "node:os"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const IS_WIN = platform() === "win32"
const HERE = dirname(fileURLToPath(import.meta.url))
const APP_DIR =
  process.env.ROTATOR_HOME ??
  (IS_WIN
    ? join(process.env.LOCALAPPDATA || join(homedir(), ".local", "share"), "opencode-rotator")
    : join(homedir(), ".opencode-rotator"))
const CONFIG_PATH = join(APP_DIR, "config.json")
const LOG_PATH = process.env.ROTATOR_LOG || join(APP_DIR, "bridge.log")

function port() {
  if (process.env.BRIDGE_PORT) return Number(process.env.BRIDGE_PORT)
  if (existsSync(CONFIG_PATH)) {
    try {
      return Number(JSON.parse(readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, "")).bridgePort) || 8787
    } catch {}
  }
  return 8787
}

const BASE = `http://127.0.0.1:${port()}`

const C = {
  g: (s) => `\x1b[32m${s}\x1b[0m`,
  y: (s) => `\x1b[33m${s}\x1b[0m`,
  r: (s) => `\x1b[31m${s}\x1b[0m`,
  d: (s) => `\x1b[90m${s}\x1b[0m`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
}

async function j(path, opts) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts?.headers || {}) },
    signal: AbortSignal.timeout(opts?.timeout ?? 20000),
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {}
  return { status: res.status, json, text }
}

const cmd = process.argv[2] || "status"
const flags = new Set(process.argv.slice(3).filter((a) => a.startsWith("--")))
const positional = process.argv.slice(3).filter((a) => !a.startsWith("--"))

function fatal(msg, code = 1) {
  console.error(C.r("ERRO: ") + msg)
  process.exit(code)
}

async function status() {
  const r = await j("/healthz")
  if (r.status !== 200) fatal(`bridge nao responde em ${BASE} (HTTP ${r.status}). Rode: node scripts/bridge.mjs`)
  const h = r.json
  const line = (k, v) => console.log(`  ${C.d(k.padEnd(16))} ${v}`)
  console.log(C.b("\nOpenCode Rotator — status\n"))
  line("bridge", `${BASE} ${h.ok ? C.g("OK") : C.r("SEM SENHA")}`)
  line("proxy WARP", h.proxy ? C.g("ON") : C.y("OFF (sem rotacao de IP)"))
  line("exit IP", h.exit_ip || C.d("(desconhecido)"))
  line("modelo padrao", h.default_model)
  line("rotacoes", String(h.rotations ?? 0))
  line("IPs queimados", String(h.burned_ips ?? 0))
  line("chamadas ativas", String(h.active ?? 0))
  line("uptime", `${Math.round((h.uptime_ms ?? 0) / 1000)}s`)
  if (h.last_error) line("ultimo erro", C.y(h.last_error))
  console.log()
}

async function rotate() {
  const reasonIndex = process.argv.indexOf("--reason")
  const reason = reasonIndex > -1 ? process.argv[reasonIndex + 1] : "manual"
  const before = (await j("/healthz")).json?.exit_ip
  console.log(C.d(`exit IP antes: ${before ?? "?"} — rotacionando (${reason})...`))
  const r = await j("/admin/rotate", { method: "POST", body: JSON.stringify({ reason }), timeout: 180000 })
  if (r.status !== 200) fatal(`rotacao falhou: ${r.text}`)
  const m = r.json
  if (!m.ok) {
    console.error(C.r("Rotacao falhou: ") + "nenhum exit IP novo obtido apos a escada de recuperacao.")
    console.error(C.d("Causa provavel: WARP sem rede, ou o provedor reatribui o mesmo IP queimado. Rode `node scripts/doctor.mjs --rotate` para o diagnostico completo."))
    process.exit(1)
  }
  console.log(C.g(`Rotacao OK: ${m.before ?? "?"} -> ${m.after}`) + C.d(` (degrau ${m.step})`))
}

async function test(text) {
  const r = await j("/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({
      model: process.env.DEFAULT_MODEL || undefined,
      messages: [{ role: "user", content: text || "responda apenas: ok" }],
      stream: false,
    }),
    timeout: 180000,
  })
  if (r.status !== 200) {
    const e = r.json?.error
    if (e?.type === "free_limit") {
      console.error(C.r("COTA FREE") + ` escopo=${e.scope ?? "?"} | rotacoes=${e.rotations ?? 0} | ips=${(e.ips_tried ?? []).join(", ") || "?"}`)
      if (e.retry_after_ms) console.error(C.d(`  volta em ~${(e.retry_after_ms / 3600000).toFixed(1)}h (retry_after_ms=${e.retry_after_ms})`))
      if (e.hint) console.error(C.y(`  ${e.hint}`))
    } else {
      fatal(`HTTP ${r.status}: ${r.text.slice(0, 300)}`)
    }
    process.exit(1)
  }
  const b = r.json
  console.log(C.g("resposta: ") + (b.choices?.[0]?.message?.content ?? "").trim())
  console.log(C.d(`tokens: ${JSON.stringify(b.usage)} · exit_ip: ${b.bridge?.exit_ip} · rotacoes: ${b.bridge?.rotations}`))
}

async function models() {
  const r = await j("/v1/models")
  if (r.status !== 200) fatal(`HTTP ${r.status}`)
  for (const m of r.json?.data ?? []) console.log(`  ${m.id}`)
}

async function state() {
  const r = await j("/admin/state")
  if (r.status !== 200) fatal(`HTTP ${r.status}`)
  console.log(C.b("\nstate.json\n"))
  console.log(JSON.stringify(r.json, null, 2))
}

async function logs(n) {
  if (!existsSync(LOG_PATH)) fatal(`sem log em ${LOG_PATH}`)
  const lines = readFileSync(LOG_PATH, "utf8").split("\n").filter(Boolean)
  const count = Number(n) || 40
  for (const l of lines.slice(-count)) console.log(l)
}

function start() {
  const child = spawn(process.execPath, [join(HERE, "bridge.mjs")], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  })
  child.unref()
  console.log(C.g(`bridge iniciado (pid ${child.pid}). Logs: ${LOG_PATH}`))
}

function stop() {
  const r = spawn("taskkill", ["/F", "/IM", "node.exe", "/FI", `WINDOWTITLE eq *bridge*`], { windowsHide: true })
  r.on("exit", () => {})
  if (!IS_WIN) {
    spawn("pkill", ["-f", "bridge.mjs"], { detached: false })
  }
  console.log(C.y("Se o bridge nao parou: feche o processo node que roda scripts/bridge.mjs (ou a tarefa agendada OpenCodeRotator)."))
}

const table = {
  status: () => status(),
  rotate: () => rotate(),
  test: () => test(positional[0]),
  models: () => models(),
  state: () => state(),
  logs: () => logs(positional[0]),
  start: () => start(),
  stop: () => stop(),
}

if (!table[cmd]) {
  console.log(`uso: bridgectl <comando>

  status              situacao do bridge, proxy, exit IP e rotacoes
  rotate [--reason X] rotaciona o IP agora (escada completa, com verificacao)
  test [texto]        chamada real de chat (prova que o caminho inteiro funciona)
  models              lista de modelos expostos
  state               estado persistido (IPs queimados, rotacoes, ultimo erro)
  logs [N]            ultimas N linhas do log
  start | stop        sobe/derruba o bridge em background
`)
  process.exit(0)
}

table[cmd]().catch((err) => fatal(err.message))
