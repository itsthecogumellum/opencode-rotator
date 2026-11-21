#!/usr/bin/env node
// language: JavaScript (Node 20+) · file: scripts/doctor.mjs
// Diagnostico ponta a ponta do OpenCode Rotator: binarios, WARP, proxy, bridge, chamada real e (opcional) prova de rotacao.
import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir, platform } from "node:os"
import { join } from "node:path"

const IS_WIN = platform() === "win32"
const APP_DIR =
  process.env.ROTATOR_HOME ??
  (IS_WIN
    ? join(process.env.LOCALAPPDATA || join(homedir(), ".local", "share"), "opencode-rotator")
    : join(homedir(), ".opencode-rotator"))
const CONFIG_PATH = join(APP_DIR, "config.json")
const wantsRotation = process.argv.includes("--rotate")
const only = (process.argv.find((a) => a.startsWith("--only=")) || "").split("=")[1]

const C = { g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, d: (s) => `\x1b[90m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` }

let failures = 0
let warnings = 0

function check(name, ok, detail, { warnOnly = false } = {}) {
  if (ok) console.log(`  ${C.g("PASS")}  ${name}${detail ? C.d(" — " + detail) : ""}`)
  else {
    if (warnOnly) {
      warnings++
      console.log(`  ${C.y("WARN")}  ${name}${detail ? C.d(" — " + detail) : ""}`)
    } else {
      failures++
      console.log(`  ${C.r("FAIL")}  ${name}${detail ? C.d(" — " + detail) : ""}`)
    }
  }
  return ok
}

function run(cmd, args, timeout = 30000) {
  return new Promise((resolve) => {
    spawn(cmd, args, { windowsHide: true })
      .on("error", () => resolve({ code: 127, stdout: "", stderr: "binario nao encontrado" }))
      .on("close", (code) => resolve({ code, stdout: "", stderr: "" }))
  })
}

function sh(cmd, args, timeout = 30000) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true })
    let out = ""
    p.stdout.on("data", (d) => (out += d))
    p.stderr.on("data", (d) => (out += d))
    const t = setTimeout(() => p.kill(), timeout)
    p.on("close", (code) => {
      clearTimeout(t)
      resolve({ code, stdout: out.trim() })
    })
  })
}

// Detalhes de check sao de uma linha: a saida do warp-cli tem blocos longos.
const firstLine = (s) => (s || "").split("\n").map((l) => l.trim()).filter(Boolean)[0] || ""

function which(cmd) {
  const dirs = (process.env.PATH || "").split(IS_WIN ? ";" : ":").filter(Boolean)
  const exts = IS_WIN ? [".exe", ".cmd", ".bat", ""] : [""]
  for (const d of dirs) for (const e of exts) {
    const full = join(d, cmd + e)
    if (existsSync(full)) return full
  }
  return null
}

function cfg() {
  const c = { bridgePort: 8787, proxyUrl: "http://127.0.0.1:40000" }
  if (process.env.BRIDGE_PORT) c.bridgePort = Number(process.env.BRIDGE_PORT)
  if (process.env.WARP_PROXY) c.proxyUrl = process.env.WARP_PROXY
  if (existsSync(CONFIG_PATH)) {
    try {
      Object.assign(c, JSON.parse(readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, "")))
    } catch {}
  }
  return c
}

const CFG = cfg()
const BASE = `http://127.0.0.1:${CFG.bridgePort}`

async function main() {
  console.log(C.b("\nOpenCode Rotator — doctor\n"))

  if (only !== "runtime") {
    console.log(C.b("1. Ambiente"))
    const nodeMajor = Number(process.versions.node.split(".")[0])
    check("Node.js >= 20", nodeMajor >= 20, `v${process.versions.node}`)

    const ocCandidates = IS_WIN
      ? [join(process.env.LOCALAPPDATA || "", "Programs", "ai.opencode.desktop", "resources", "opencode-cli.exe")]
      : [join(homedir(), ".opencode", "bin", "opencode")]
    const oc = ocCandidates.find((p) => existsSync(p)) || which("opencode") || which("opencode-cli")
    check("binario do opencode", !!oc, oc || "instale: npm i -g opencode-ai")

    const warp = IS_WIN
      ? "C:\\Program Files\\Cloudflare\\Cloudflare WARP\\warp-cli.exe"
      : "/usr/bin/warp-cli"
    const warpBin = existsSync(warp) ? warp : which("warp-cli")
    check("warp-cli instalado", !!warpBin, warpBin || "instale o Cloudflare WARP")

    if (warpBin) {
      const st = await sh(warpBin, ["--accept-tos", "status"])
      const connected = /Connected/i.test(st.stdout)
      check("WARP conectado", connected, firstLine(st.stdout) || "sem saida", { warnOnly: true })

      // O modo e a porta sao lidos em `warp-cli settings` (ex: "Mode: WarpProxy on port 40000").
      const settings = await sh(warpBin, ["--accept-tos", "settings"])
      const modeLine = (settings.stdout.split("\n").find((l) => /Mode:\s*/i.test(l)) || "").trim()
      const inProxy = /WarpProxy|proxy/i.test(modeLine)
      check("WARP em modo proxy", inProxy, modeLine || "modo nao encontrado em `warp-cli settings`", { warnOnly: true })
      if (!inProxy) console.log(C.d(`      -> rode: "${warpBin}" --accept-tos mode proxy`))

      const portMatch = modeLine.match(/port\s+(\d+)/i)
      const wantPort = Number(new URL(CFG.proxyUrl).port)
      check(`proxy na porta ${wantPort}`, !!portMatch && Number(portMatch[1]) === wantPort, modeLine || "porta nao encontrada", { warnOnly: true })
    }
  }

  console.log(C.b("\n2. Rede"))
  const curl = which("curl") || (IS_WIN ? "curl.exe" : "curl")
  const IP_ENDPOINTS = ["https://ifconfig.me/ip", "https://api.ipify.org"]
  if (curl) {
    // Em algumas redes o ipify nao responde via proxy; o ifconfig.me e o caminho confiavel.
    const readIp = async (args) => {
      for (const url of IP_ENDPOINTS) {
        const r = await sh(curl, [...args, url])
        const v = r.stdout.trim().split("\n")[0].trim()
        if (/^[0-9a-fA-F:.]{3,45}$/.test(v)) return v
      }
      return null
    }
    const ipProxy = await readIp(["-s", "-x", CFG.proxyUrl, "--max-time", "15"])
    const ipDirect = await readIp(["-s", "--max-time", "15"])
    check("proxy responde", !!ipProxy, ipProxy || "nenhum endpoint de IP respondeu pelo proxy", { warnOnly: true })
    check("exit IP do proxy diferente do direto", ipProxy && ipDirect && ipProxy !== ipDirect, `proxy=${ipProxy || "?"} direto=${ipDirect || "?"}`, { warnOnly: true })
  } else {
    check("curl disponivel", false, "instale curl", { warnOnly: true })
  }

  console.log(C.b("\n3. Bridge"))
  let health = null
  try {
    const res = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(8000) })
    health = await res.json()
  } catch (err) {
    check("bridge responde em /healthz", false, err.message)
  }
  if (health) {
    check("bridge responde em /healthz", true, `porta ${health.port}`)
    check("opencode serve autenticado", !!health.ok, health.ok ? "senha capturada" : "servidor opencode sem senha")
    check("proxy ativo no bridge", !!health.proxy, health.proxy ? "rotacao habilitada" : "rotacao DESABILITADA", { warnOnly: true })
  }

  if (health) {
    console.log(C.b("\n4. Modelos e chamada real"))
    const models = await fetch(`${BASE}/v1/models`, { signal: AbortSignal.timeout(15000) }).then((r) => r.json()).catch(() => null)
    const list = models?.data ?? []
    check("lista de modelos nao vazia", list.length > 0, `${list.length} modelos`)

    const started = Date.now()
    const res = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "responda apenas: ok" }], stream: false }),
      signal: AbortSignal.timeout(180000),
    }).catch((err) => ({ error: err }))
    const secs = ((Date.now() - started) / 1000).toFixed(1)
    if (res.error) {
      check("chamada real de chat", false, res.error.message)
    } else {
      const body = await res.json()
      const text = body?.choices?.[0]?.message?.content ?? ""
      if (res.status === 200) {
        check("chamada real de chat", text.length > 0, `HTTP ${res.status} em ${secs}s - "${text.trim().slice(0, 40)}"`)
        check("usage devolvido", !!body?.usage, JSON.stringify(body?.usage ?? null))
      } else {
        const e = body?.error ?? {}
        const scope = e.scope ?? "unknown"
        const scopeTxt =
          scope === "account"
            ? "cota por CONTA (IPs diferentes, mesmo limite): rotacionar IP nao resolve"
            : scope === "ip"
              ? "cota por IP e a rotacao nao entregou endereco novo: reconecte o WARP"
              : "cota free atingida"
        check("chamada real de chat", false, `HTTP ${res.status} - ${scopeTxt}`)
        if (e.retry_after_ms) {
          const h = (e.retry_after_ms / 3600000).toFixed(1)
          check("reset da cota informado pelo provedor", true, `~${h}h (retry_after_ms=${e.retry_after_ms})`, { warnOnly: true })
        }
        check("rotacoes tentadas", true, `${e.rotations ?? 0} | IPs: ${(e.ips_tried ?? []).join(", ") || "?"}`, { warnOnly: true })
      }
    }

    if (wantsRotation) {
      console.log(C.b("\n5. Prova de rotacao"))
      const before = health.exit_ip
      const rot = await fetch(`${BASE}/admin/rotate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "doctor --rotate" }),
        signal: AbortSignal.timeout(240000),
      }).then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }))
      check("rotacao executada", !!rot.ok, rot.ok ? `degrau ${rot.step}` : rot.error || "falhou")
      check("exit IP mudou de verdade", rot.ok && rot.before !== rot.after, `${rot.before ?? "?"} -> ${rot.after ?? "?"}`)
    }
  }

  console.log()
  if (failures === 0 && warnings === 0) console.log(C.g("Tudo verde. O sistema esta pronto para uso.\n"))
  else if (failures === 0) console.log(C.y(`${warnings} aviso(s). O sistema funciona, mas confira os itens acima.\n`))
  else console.log(C.r(`${failures} falha(s) e ${warnings} aviso(s). Aponte o log para o troubleshooting.\n`))
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(C.r("doctor falhou: " + err.message))
  process.exit(1)
})
