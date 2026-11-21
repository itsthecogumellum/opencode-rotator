#!/usr/bin/env node
// language: JavaScript (Node 20+) · file: scripts/bridge.mjs
// Gateway OpenAI-compatible na frente do `opencode serve`, com rotacao VERIFICADA de IP WARP ao bater cota free.
// Windows / macOS / Linux · sem dependencia externa (so Node 20+ e curl).
import { createServer } from "node:http"
import { createServer as createTcpServer } from "node:net"
import { spawn, execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs"
import { homedir, platform } from "node:os"
import { join } from "node:path"

const IS_WIN = platform() === "win32"
const APP_DIR =
  process.env.ROTATOR_HOME ??
  (IS_WIN
    ? join(process.env.LOCALAPPDATA || join(homedir(), ".local", "share"), "opencode-rotator")
    : join(homedir(), ".opencode-rotator"))
const STATE_PATH = join(APP_DIR, "state.json")
const CONFIG_PATH = join(APP_DIR, "config.json")

const DEFAULTS = {
  bridgePort: 8787,
  opencodePort: 4097,
  proxyUrl: "http://127.0.0.1:40000",
  defaultModel: "opencode/deepseek-v4.1-flash-free",
  waitMs: 300000,
  requestMaxMs: 360000,
  rotateTries: 4,
  // Quantas trocas de IP o bridge faz ao bater cota free antes de classificar o escopo.
  // 2 basta para provar se a cota e por IP: com 2 enderecos diferentes e o mesmo limite,
  // a cota e por conta e insistir em girar IP so queima saidas.
  limitRotationBudget: 2,
  keepSessions: false,
  authUser: "opencode",
  logFile: join(APP_DIR, "bridge.log"),
  // Quanto tempo um IP continua "queimado" (cota free estourada nele) e nao volta a ser escolhido.
  burnTtlMs: 24 * 60 * 60 * 1000,
  // Segundos de espera entre tentativas de poll do exit IP durante uma rotacao.
  rotatePollMs: 1500,
  // Segundos que uma chamada `warp-cli` pode demorar.
  warpTimeoutMs: 60000,
}

// Arquivos escritos pelo PowerShell (Set-Content -Encoding UTF8) trazem BOM, que quebra o JSON.parse.
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""))
}

function loadConfig() {
  const cfg = { ...DEFAULTS }
  if (existsSync(CONFIG_PATH)) {
    try {
      Object.assign(cfg, readJson(CONFIG_PATH))
    } catch (err) {
      console.error("[rotator] config.json invalido:", err.message)
    }
  }
  if (process.env.BRIDGE_PORT) cfg.bridgePort = Number(process.env.BRIDGE_PORT)
  if (process.env.OPENCODE_PORT) cfg.opencodePort = Number(process.env.OPENCODE_PORT)
  if (process.env.WARP_PROXY) cfg.proxyUrl = process.env.WARP_PROXY
  if (process.env.DEFAULT_MODEL) cfg.defaultModel = process.env.DEFAULT_MODEL
  if (process.env.WAIT_MS) cfg.waitMs = Number(process.env.WAIT_MS)
  if (process.env.REQUEST_MAX_MS) cfg.requestMaxMs = Number(process.env.REQUEST_MAX_MS)
  if (process.env.ROTATE_TRIES) cfg.rotateTries = Number(process.env.ROTATE_TRIES)
  if (process.env.LIMIT_ROTATION_BUDGET) cfg.limitRotationBudget = Number(process.env.LIMIT_ROTATION_BUDGET)
  if (process.env.OPENCODE_BIN) cfg.opencodeBin = process.env.OPENCODE_BIN
  if (process.env.WARP_CLI) cfg.warpCli = process.env.WARP_CLI
  if (process.env.KEEP_SESSIONS === "1") cfg.keepSessions = true
  if (process.env.ROTATOR_LOG) cfg.logFile = process.env.ROTATOR_LOG
  return cfg
}

const CFG = loadConfig()
mkdirSync(APP_DIR, { recursive: true })

// ---------------------------------------------------------------- estado persistente
const state = {
  burned: [], // { ip, at, reason }
  rotations: 0,
  lastExitIp: null,
  lastError: null,
  startedAt: Date.now(),
  ...(existsSync(STATE_PATH) ? readJson(STATE_PATH) : {}),
}
state.burned = Array.isArray(state.burned) ? state.burned : []

function saveState() {
  try {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2))
  } catch (err) {
    console.error("[rotator] falha ao gravar state:", err.message)
  }
}

function burnIp(ip, reason) {
  if (!ip) return
  if (state.burned.some((b) => b.ip === ip)) return
  state.burned.push({ ip, at: Date.now(), reason })
  saveState()
  log(`IP queimado: ${ip} (${reason})`)
}

function burnedSet() {
  const cutoff = Date.now() - CFG.burnTtlMs
  state.burned = state.burned.filter((b) => b.at > cutoff)
  return new Set(state.burned.map((b) => b.ip))
}

// ---------------------------------------------------------------- binarios
function which(cmd) {
  const dirs = (process.env.PATH || "").split(IS_WIN ? ";" : ":").filter(Boolean)
  const exts = IS_WIN ? [".exe", ".cmd", ".bat", ""] : [""]
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = join(dir, cmd + ext)
      if (existsSync(full)) return full
    }
  }
  return null
}

function findOpencode() {
  if (CFG.opencodeBin && existsSync(CFG.opencodeBin)) return CFG.opencodeBin
  const candidates = IS_WIN
    ? [
        join(process.env.LOCALAPPDATA || "", "Programs", "ai.opencode.desktop", "resources", "opencode-cli.exe"),
        join(process.env.LOCALAPPDATA || "", "Programs", "opencode", "opencode.exe"),
      ]
    : [join(homedir(), ".opencode", "bin", "opencode"), "/usr/local/bin/opencode", "/usr/bin/opencode"]
  for (const c of candidates) if (c && existsSync(c)) return c
  return which("opencode") || which("opencode-cli")
}

function findWarpCli() {
  if (CFG.warpCli && existsSync(CFG.warpCli)) return CFG.warpCli
  const candidates = IS_WIN
    ? [
        "C:\\Program Files\\Cloudflare\\Cloudflare WARP\\warp-cli.exe",
        "C:\\Program Files (x86)\\Cloudflare\\Cloudflare WARP\\warp-cli.exe",
      ]
    : ["/usr/bin/warp-cli", "/usr/local/bin/warp-cli"]
  for (const c of candidates) if (existsSync(c)) return c
  return which("warp-cli")
}

const OPENCODE_BIN = findOpencode()
const WARP_CLI = findWarpCli()
const CURL = which("curl") || (IS_WIN ? "curl.exe" : "curl")

// ---------------------------------------------------------------- log
function log(...args) {
  const line = [new Date().toISOString(), ...args].join(" ")
  console.log(line)
  try {
    mkdirSync(APP_DIR, { recursive: true })
    appendFileSync(CFG.logFile, line + "\n")
  } catch {}
}

// ---------------------------------------------------------------- exec helpers
function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout ?? 30000, windowsHide: true, maxBuffer: 4 << 20, ...opts }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout: (stdout || "").trim(), stderr: (stderr || "").trim() })
    })
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- WARP
// Endpoints de IP: ifconfig.me responde pelo proxy WARP; ipify e o fallback
// (em algumas redes o ipify nao responde via proxy e devolve 000).
const IP_ENDPOINTS = ["https://ifconfig.me/ip", "https://api.ipify.org"]

async function exitIpViaProxy() {
  if (!CURL) return null
  for (const url of IP_ENDPOINTS) {
    const r = await run(CURL, ["-s", "-x", CFG.proxyUrl, "--max-time", "15", url], { timeout: 20000 })
    const ip = (r.stdout || "").trim().split("\n")[0].trim()
    if (/^[0-9a-fA-F:.]{3,45}$/.test(ip) && ip !== "null") return ip
  }
  return null
}

async function proxyProbe() {
  if (!CURL) return false
  for (const url of IP_ENDPOINTS) {
    const r = await run(CURL, ["-s", "-o", "NUL", "-w", "%{http_code}", "-x", CFG.proxyUrl, "--max-time", "8", url], { timeout: 12000 })
    if (r.stdout.trim() === "200") return true
  }
  return false
}

async function warp(args, timeout) {
  if (!WARP_CLI) return { code: 127, stdout: "", stderr: "warp-cli nao encontrado" }
  return run(WARP_CLI, ["--accept-tos", ...args], { timeout: timeout ?? CFG.warpTimeoutMs })
}

// Um ciclo de reconnect. Retorna o exit IP se conseguir ler, senao null.
async function warpReconnect() {
  await warp(["disconnect"], 30000)
  await sleep(1200)
  await warp(["connect"])
  for (let i = 0; i < 12; i++) {
    await sleep(CFG.rotatePollMs)
    const ip = await exitIpViaProxy()
    if (ip) return ip
  }
  return null
}

// Escada de recuperacao: cada degrau e mais pesado que o anterior.
//  1. reconnect simples
//  2. re-registro (gera tunel novo) + reconnect
//  3. re-registro + espera longa ate sair um IP novo
async function rotationLadder(before, burned) {
  const steps = ["reconnect", "reregister", "reregister-wait"]
  for (const step of steps) {
    log(`rotacao: degrau ${step}`)
    if (step === "reregister" || step === "reregister-wait") {
      await warp(["registration", "new"], 90000)
      await sleep(1500)
    }
    const ip = await warpReconnect()
    if (!ip) continue
    if (ip === before) {
      log(`degrau ${step}: exit IP repetiu (${ip})`)
      continue
    }
    if (burned.has(ip)) {
      log(`degrau ${step}: exit IP ${ip} ja estava queimado, continuando`)
      continue
    }
    return { ip, step }
  }
  return null
}

let rotationLock = Promise.resolve()
function queueRotation(before, reason) {
  const next = rotationLock.then(
    () => performRotation(before, reason),
    () => performRotation(before, reason),
  )
  rotationLock = next.catch(() => {})
  return next
}

async function performRotation(before, reason) {
  const burned = burnedSet()
  const result = await rotationLadder(before, burned)
  state.rotations = (state.rotations || 0) + 1
  state.lastExitIp = result?.ip ?? state.lastExitIp
  saveState()
  if (!result) {
    state.lastError = `rotacao falhou (${reason}): nenhum exit IP novo`
    saveState()
    log(`rotacao falhou (${reason})`)
    return { ok: false, before, after: null }
  }
  log(`rotacao ok (${reason}): ${before ?? "?"} -> ${result.ip} via ${result.step}`)
  return { ok: true, before, after: result.ip, step: result.step }
}

// ---------------------------------------------------------------- portas
function portFree(port) {
  return new Promise((resolve) => {
    const srv = createTcpServer()
    srv.once("error", () => resolve(false))
    srv.once("listening", () => srv.close(() => resolve(true)))
    srv.listen(port, "127.0.0.1")
  })
}

// A porta do opencode serve e interna e pode estar ocupada por outra instancia (ou pelo
// opencode serve de outro gateway). Em vez de morrer, o bridge procura a proxima livre.
async function resolveOpencodePort() {
  if (await portFree(CFG.opencodePort)) return CFG.opencodePort
  for (let p = CFG.opencodePort + 1; p < CFG.opencodePort + 100; p++) {
    if (await portFree(p)) {
      log(`porta ${CFG.opencodePort} ocupada; o opencode serve usara ${p}`)
      return p
    }
  }
  throw new Error(`nenhuma porta livre para o opencode serve (${CFG.opencodePort}+)`)
}

// ---------------------------------------------------------------- opencode serve
let serverChild = null
let serverPassword = null
let shuttingDown = false
let restartTimer = null
let proxyActive = false
let activeRequests = 0
let oldestActiveAt = 0
let exitCache = { at: 0, value: null }
let exitProbeBusy = false
let proxyTicks = 0
let proxyLastProbe = null
let modelCache = { at: 0, data: null }
const base = () => `http://127.0.0.1:${CFG.opencodePort}`
const basic = () => "Basic " + Buffer.from(`${CFG.authUser}:${serverPassword}`).toString("base64")

async function startOpencode(useProxy = proxyActive) {
  serverPassword = null
  if (!OPENCODE_BIN) throw new Error("opencode nao encontrado (defina OPENCODE_BIN)")
  const env = { ...process.env, NO_PROXY: "localhost,127.0.0.1" }
  if (useProxy) {
    env.HTTPS_PROXY = CFG.proxyUrl
    env.HTTP_PROXY = CFG.proxyUrl
  } else {
    for (const key of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) delete env[key]
  }
  const child = spawn(OPENCODE_BIN, ["serve", "--hostname", "127.0.0.1", "--port", String(CFG.opencodePort)], {
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  serverChild = child

  // A senha chega no stdout; o stderr fica num buffer curto para explicar a morte do processo.
  let resolvePwd
  let rejectPwd
  const pwd = new Promise((res, rej) => {
    resolvePwd = res
    rejectPwd = rej
  })
  const errTail = []
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString()
    const m = text.match(/server password\s+(\S+)/)
    if (m && !serverPassword) {
      serverPassword = m[1]
      resolvePwd(m[1])
    }
    if (process.env.DEBUG) process.stdout.write(text)
  })
  child.stderr.on("data", (d) => {
    errTail.push(d.toString())
    if (errTail.length > 20) errTail.shift()
    if (process.env.DEBUG) process.stderr.write(d)
  })
  child.on("exit", (code, signal) => {
    const why = errTail.join("").trim().split("\n").slice(-3).join(" | ")
    if (!serverPassword) rejectPwd(new Error(`opencode serve saiu com codigo ${code} (${why || "sem stderr"})`))
    if (shuttingDown || serverChild !== child) return
    log(`opencode serve saiu (code=${code} signal=${signal}${why ? " :: " + why : ""}); reiniciando`)
    serverPassword = null
    scheduleRestart()
  })

  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("opencode serve nao imprimiu a senha a tempo")), 30000))
  await Promise.race([pwd, timeout])
}

function scheduleRestart() {
  if (shuttingDown || restartTimer) return
  restartTimer = setTimeout(async () => {
    restartTimer = null
    try {
      await startOpencode()
      log(`opencode serve reiniciado (pid ${serverChild?.pid})`)
    } catch (err) {
      log("reinicio falhou:", err.message)
      scheduleRestart()
    }
  }, 3000)
}

// ---------------------------------------------------------------- opencode API
async function api(path, { method = "GET", body, timeout = 60000, signal } = {}) {
  const timeoutSignal = AbortSignal.timeout(timeout)
  const res = await fetch(base() + path, {
    method,
    headers: { Authorization: basic(), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {}
  return { status: res.status, json, text }
}

function modelRef(input) {
  const raw = (input || CFG.defaultModel).trim()
  const slash = raw.indexOf("/")
  return slash > 0 ? { providerID: raw.slice(0, slash), id: raw.slice(slash + 1) } : { providerID: "opencode", id: raw }
}

function contentText(content) {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((p) => (typeof p === "string" ? p : p?.text ?? "")).filter(Boolean).join("\n")
  return ""
}

const flattenMessages = (messages) =>
  messages
    .map((m) => `${m.role === "system" ? "system" : m.role === "assistant" ? "assistant" : "user"}: ${contentText(m.content)}`)
    .join("\n\n")

function assistantText(list, afterId) {
  const idx = list.findIndex((m) => m.id === afterId)
  const relevant = idx >= 0 ? list.slice(0, idx) : list
  const assistants = relevant
    .filter((m) => m.type === "assistant")
    .sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0))
  const last = assistants.at(-1)
  if (!last) return { text: "", tokens: null, error: "no assistant message" }
  const text = (last.content ?? []).filter((p) => p.type === "text").map((p) => p.text).join("").trim()
  return { text, tokens: last.tokens ?? null, error: last.error ?? null }
}

async function oneTurn({ text, model, signal }) {
  const created = await api("/api/session", { method: "POST", body: { title: "bridge", model: modelRef(model) }, signal })
  if (created.status !== 200 || !created.json?.data?.id) {
    throw new Error(`session.create falhou: ${created.status} ${created.text.slice(0, 200)}`)
  }
  const sessionId = created.json.data.id
  const prompted = await api(`/api/session/${sessionId}/prompt`, { method: "POST", body: { text, metadata: {} }, signal })
  if (prompted.status !== 200 || !prompted.json?.data?.id) {
    throw new Error(`session.prompt falhou: ${prompted.status} ${prompted.text.slice(0, 200)}`)
  }
  const promptId = prompted.json.data.id
  const waited = await api(`/api/experimental/session/${sessionId}/wait`, { method: "POST", timeout: CFG.waitMs, signal })
  if (waited.status === 408 || waited.status === 504) {
    await api(`/api/session/${sessionId}/interrupt`, { method: "POST" }).catch(() => {})
    throw new Error("session.wait estourou o tempo")
  }
  const messages = await api(`/api/session/${sessionId}/message`, { signal })
  const result = assistantText(messages.json?.data ?? [], promptId)
  if (!CFG.keepSessions) await api(`/api/session/${sessionId}`, { method: "DELETE" }).catch(() => {})
  return result
}

// ---------------------------------------------------------------- deteccao de cota free
const LIMIT_PATTERNS = [
  /used today'?s free messages/i,
  /daily limit reached/i,
  /free limit reached/i,
  /free usage limit reached/i,
  /free limit/i,
  /FreeUsageLimit/i,
  /rate limit exceeded/i,
  /too many requests/i,
  /quota exceeded/i,
  /limit reached/i,
]
const isLimit = (blob) => LIMIT_PATTERNS.some((re) => re.test(blob || ""))

async function chatCompletion({ model, messages, signal }) {
  const text = flattenMessages(messages)
  let rotation = { rotations: 0 }
  let result = await oneTurn({ text, model, signal })
  const blob = () => (result.text || "") + " " + JSON.stringify(result.error ?? "")

  // Rotacionar IP so ajuda quando a cota e por IP. Se a cota for por conta, girar IP e
  // desperdicio: o limite volta identico em cada endereco novo. Por isso o orcamento de
  // rotacoes e pequeno, e o resultado e CLASSIFICADO (escopo ip / conta) em vez de insistir.
  const triedIps = new Set()
  const burnCurrent = () => {
    const before = exitCache.value
    if (before) {
      triedIps.add(before)
      burnIp(before, "free limit")
    }
    return before
  }

  for (let attempt = 0; attempt < CFG.limitRotationBudget && proxyActive && isLimit(blob()); attempt++) {
    if (signal?.aborted) throw signal.reason
    const before = burnCurrent()
    log(`cota free atingida (rotacao ${attempt + 1}/${CFG.limitRotationBudget}) — queimando IP e trocando saida`)
    const moved = await queueRotation(before, "free limit")
    rotation = {
      rotations: (rotation.rotations ?? 0) + 1,
      ipBefore: moved.before,
      ipAfter: moved.after,
      rotationStep: moved.step ?? null,
    }
    if (moved.after) triedIps.add(moved.after)
    if (!moved.ok) break
    result = await oneTurn({ text, model, signal })
  }

  if (!result.text && result.error) {
    const msg = typeof result.error === "string" ? result.error : JSON.stringify(result.error)
    if (isLimit(msg)) {
      const m = msg.match(/retryAfterMs\\?"?\s*:\s*(\d+)/)
      const err = new Error(msg)
      err.statusCode = 429
      err.retryAfterMs = m ? Number(m[1]) : null
      // Escopo: so um endereco.testado => a rotacao nao entregou IP novo (problema de WARP).
      // Varios enderecos com o mesmo limite => a cota e por conta, nao por IP.
      const scope = rotation.rotations === 0 ? "unknown" : triedIps.size > 1 ? "account" : "ip"
      err.limitScope = scope
      err.ipsTried = [...triedIps]
      err.rotations = rotation.rotations ?? 0
      err.exitIp = rotation.ipAfter ?? exitCache.value
      const scopeMsg =
        scope === "account"
          ? "cota free por conta: IPs diferentes, mesmo limite. Rotacionar nao resolve."
          : scope === "ip"
            ? "cota free por IP: a rotacao nao entregou um endereco novo (WARP devolveu o mesmo)."
            : "cota free atingida; nenhuma rotacao foi tentada."
      log(`cota free: escopo=${scope} | ${scopeMsg}`)
      state.lastError = `cota free (escopo ${scope}): ${scopeMsg}`
      saveState()
      throw err
    }
    throw new Error(msg)
  }
  return { text: result.text, tokens: result.tokens, rotation }
}

function openaiBody({ text, tokens, rotation }, model) {
  return {
    id: "chatcmpl-" + randomUUID().replaceAll("-", ""),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: tokens?.input ?? 0,
      completion_tokens: tokens?.output ?? 0,
      total_tokens: (tokens?.input ?? 0) + (tokens?.output ?? 0),
    },
    bridge: {
      exit_ip: rotation.ipAfter ?? exitCache.value,
      rotations: rotation.rotations ?? 0,
      rotation_step: rotation.rotationStep ?? null,
    },
  }
}

function send(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString("utf8")
  return raw ? JSON.parse(raw) : {}
}

// ---------------------------------------------------------------- servidor
const http = createServer(async (req, res) => {
  let counted = false
  let requestDeadline = null
  try {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`)
    const path = url.pathname

    if (req.method === "GET" && path === "/healthz") {
      scheduleExitProbe()
      return send(res, 200, {
        ok: !!serverPassword,
        port: CFG.bridgePort,
        proxy: proxyActive,
        exit_ip: exitCache.value,
        proxy_ticks: proxyTicks,
        proxy_last: proxyLastProbe,
        active: activeRequests,
        active_since: oldestActiveAt || null,
        rotations: state.rotations || 0,
        burned_ips: state.burned.length,
        uptime_ms: Date.now() - (state.startedAt || Date.now()),
        opencode_bin: OPENCODE_BIN,
        opencode_port: CFG.opencodePort,
        warp_cli: WARP_CLI,
        default_model: CFG.defaultModel,
        last_error: state.lastError ?? null,
      })
    }

    if (req.method === "GET" && path === "/v1/models") {
      if (!modelCache.data || Date.now() - modelCache.at > 60000) {
        const listed = await api("/api/model")
        const models = (listed.json?.data ?? [])
          .filter((m) => m.providerID === "opencode")
          .map((m) => ({ id: m.id, object: "model", created: 0, owned_by: m.providerID }))
        modelCache = { at: Date.now(), data: models }
      }
      return send(res, 200, { object: "list", data: modelCache.data })
    }

    if (req.method === "POST" && path === "/admin/rotate") {
      const body = await readBody(req)
      const before = exitCache.value ?? (await exitIpViaProxy())
      const moved = await queueRotation(before, body.reason || "manual")
      return send(res, moved.ok ? 200 : 502, moved)
    }

    if (req.method === "GET" && path === "/admin/state") {
      return send(res, 200, { ...state, burned_ips: state.burned.length })
    }

    if (req.method === "POST" && path === "/admin/burn") {
      const body = await readBody(req)
      const ip = body.ip || exitCache.value
      burnIp(ip, body.reason || "manual")
      return send(res, 200, { ok: true, ip })
    }

    if (req.method === "POST" && path === "/v1/chat/completions") {
      const body = await readBody(req)
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return send(res, 400, { error: { message: "messages[] e obrigatorio", type: "invalid_request_error" } })
      }
      activeRequests++
      if (activeRequests === 1) oldestActiveAt = Date.now()
      counted = true
      const controller = new AbortController()
      requestDeadline = setTimeout(() => controller.abort(new Error("request deadline exceeded")), CFG.requestMaxMs)
      const model = body.model ?? CFG.defaultModel
      const result = await chatCompletion({ model, messages: body.messages, signal: controller.signal })
      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
        const chunk = {
          id: "chatcmpl-" + randomUUID().replaceAll("-", ""),
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: { role: "assistant", content: result.text }, finish_reason: "stop" }],
        }
        res.write(`data: ${JSON.stringify(chunk)}\n\n`)
        res.write("data: [DONE]\n\n")
        return res.end()
      }
      return send(res, 200, openaiBody(result, model))
    }

    send(res, 404, { error: { message: "not found", type: "invalid_request_error" } })
  } catch (err) {
    log("request falhou:", err.message)
    if (err.statusCode === 429) {
      if (err.retryAfterMs) res.setHeader("Retry-After", Math.ceil(err.retryAfterMs / 1000))
      return send(res, 429, {
        error: {
          message: err.message,
          type: "free_limit",
          scope: err.limitScope ?? "unknown",
          retry_after_ms: err.retryAfterMs ?? null,
          rotations: err.rotations ?? 0,
          ips_tried: err.ipsTried ?? [],
          exit_ip: err.exitIp ?? exitCache.value,
          hint:
            err.limitScope === "account"
              ? "cota free por conta: trocar IP nao resolve. Use outro modelo/conta ou espere o reset (retry_after_ms)."
              : err.limitScope === "ip"
                ? "rotacao nao entregou IP novo: o WARP devolveu o mesmo endereco. Tente `bridgectl rotate` de novo ou reconecte o WARP."
                : "cota free atingida. Rotate o IP ou troque de modelo.",
        },
      })
    }
    if (err.name === "AbortError" || err.name === "TimeoutError" || /timed out|deadline exceeded|aborted/i.test(err.message)) {
      return send(res, 504, { error: { message: err.message || "upstream timeout", type: "timeout" } })
    }
    send(res, 502, { error: { message: err.message, type: "bridge_error" } })
  } finally {
    if (requestDeadline) clearTimeout(requestDeadline)
    if (counted) {
      activeRequests--
      if (activeRequests === 0) oldestActiveAt = 0
    }
  }
})

// healthz nunca pode bloquear no WARP: devolve o ultimo exit conhecido e refresca em background.
function scheduleExitProbe() {
  if (exitProbeBusy) return
  exitProbeBusy = true
  exitIpViaProxy()
    .then((ip) => {
      if (ip) exitCache = { at: Date.now(), value: ip }
    })
    .finally(() => {
      exitProbeBusy = false
    })
}

// ---------------------------------------------------------------- boot
async function boot() {
  if (!OPENCODE_BIN) {
    log("ERRO: opencode nao encontrado. Instale com `npm i -g opencode-ai` ou defina OPENCODE_BIN.")
    process.exit(2)
  }
  if (!(await portFree(CFG.bridgePort))) {
    log(`ERRO: a porta ${CFG.bridgePort} ja esta em uso. Outro gateway esta rodando? Use outra porta em config.json (bridgePort).`)
    process.exit(3)
  }
  CFG.opencodePort = await resolveOpencodePort()
  if (!WARP_CLI) log("AVISO: warp-cli nao encontrado — rodando sem rotacao de IP.")

  proxyActive = WARP_CLI ? await proxyProbe() : false
  if (!proxyActive) log("AVISO: WARP proxy nao responde em " + CFG.proxyUrl + " — opencode direto, rotacao desativada")

  await startOpencode(proxyActive)
  const probe = await api("/api/model")
  if (probe.status !== 200) throw new Error(`API do opencode nao responde: ${probe.status}`)

  scheduleExitProbe()
  http.listen(CFG.bridgePort, "127.0.0.1", () => {
    log(`bridge pronto em http://127.0.0.1:${CFG.bridgePort} (modelo padrao: ${CFG.defaultModel}, proxy: ${proxyActive ? "on" : "off"})`)
  })

  // WARP oscila: quando ele cai ou volta, reinicia o opencode com o env de proxy correto.
  const proxyTimer = setInterval(async () => {
    proxyTicks++
    if (activeRequests > 0 && Date.now() - oldestActiveAt < 360000) return
    const alive = await proxyProbe()
    proxyLastProbe = { at: new Date().toISOString(), alive }
    if (alive === proxyActive) return
    proxyActive = alive
    log(`proxy ${alive ? "voltou" : "caiu"} — reiniciando opencode ${alive ? "com" : "sem"} proxy`)
    const old = serverChild
    serverChild = null
    old?.kill()
    try {
      await startOpencode(alive)
    } catch (err) {
      log("falha ao trocar de estado do proxy:", err.message)
      scheduleRestart()
    }
  }, 60000)
  proxyTimer.unref?.()

  const shutdown = () => {
    shuttingDown = true
    serverChild?.kill()
    process.exit(0)
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
}

boot().catch((err) => {
  log("FALHA NO BOOT:", err.message)
  process.exit(1)
})
