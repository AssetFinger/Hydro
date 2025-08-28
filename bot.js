/* ================== IMPORTS ================== */
const fs = require('fs')
const path = require('path')
const qrcode = require('qrcode-terminal')
const axios = require('axios')
const FormData = require('form-data')
const googleTTS = require('google-tts-api')
const { exec, execFile } = require('child_process')
const dotenv = require('dotenv')
const mime = require('mime-types')
const makeWASocket = require('@whiskeysockets/baileys').default
const { useMultiFileAuthState, DisconnectReason, delay } = require('@whiskeysockets/baileys')
const { Boom } = require('@hapi/boom')
const pino = require('pino')

dotenv.config()

/* ================== KONFIG ================== */
const WA_OWNER  = process.env.WHATSAPP_OWNER
const WA_SOURCE = process.env.WA_SOURCE
const WA_TARGET = process.env.WA_TARGET

let INIT_CODE  = process.env.INIT_CODE  || ''   // bisa diubah via owner command
let INIT_CODE2 = process.env.INIT_CODE2 || ''   // bisa diubah via owner command
const IMG1_PATH = process.env.IMG1_PATH || ''
const IMG2_PATH = process.env.IMG2_PATH || ''

// Hi loop (ritme & jendela AKTIF setelah SOURCE balas)
const HI_INTERVAL_MS       = Number(process.env.HI_INTERVAL_MS       || 60 * 1000)       // kirim "Hi" tiap 1 menit
const HI_ACTIVE_WINDOW_MS  = Number(process.env.HI_ACTIVE_WINDOW_MS  || 5 * 60 * 1000)   // Hi AKTIF selama 5 menit setelah SOURCE terakhir balas
const HI_LOOP_DEFAULT      = String(process.env.HI_LOOP_DEFAULT || 'on').toLowerCase() === 'on' // default ON

/* ================== STORAGE ================== */
const DATA_DIR = path.resolve('./data')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
const TRIGGER_STORE = path.join(DATA_DIR, 'last_trigger.txt')

/* ================== VALIDASI ENV ================== */
function jidFromDigits(num) {
  if (!num) return null
  const digits = String(num).replace(/\D/g, '')
  if (!digits) return null
  return `${digits}@s.whatsapp.net`
}
const OWNER_JID  = jidFromDigits(WA_OWNER)
const SOURCE_JID = jidFromDigits(WA_SOURCE)
const TARGET_JID = jidFromDigits(WA_TARGET)

function mustHave(name, val) {
  if (!val) { console.error(`❌ Env ${name} kosong/tidak valid`); process.exit(1) }
}
mustHave('WHATSAPP_OWNER', WA_OWNER)
mustHave('WA_SOURCE', WA_SOURCE)
mustHave('WA_TARGET', WA_TARGET)
mustHave('INIT_CODE', INIT_CODE)
mustHave('INIT_CODE2', INIT_CODE2)
mustHave('IMG1_PATH', IMG1_PATH)
mustHave('IMG2_PATH', IMG2_PATH)

/* ================== UTIL ================== */
function log(...args) { console.log(`[${new Date().toISOString()}]`, ...args) }
function saveLastTrigger(text) { try { fs.writeFileSync(TRIGGER_STORE, text, 'utf-8') } catch {} }

function extractTextFromMessage(msg) {
  if (!msg?.message) return ''
  const m = msg.message
  if (m.conversation) return m.conversation
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text
  if (m.imageMessage?.caption) return m.imageMessage.caption
  if (m.videoMessage?.caption) return m.videoMessage.caption
  if (m.buttonsResponseMessage?.selectedButtonId) return m.buttonsResponseMessage.selectedButtonId
  if (m.listResponseMessage?.singleSelectReply?.selectedRowId) return m.listResponseMessage.singleSelectReply.selectedRowId
  return ''
}
function norm(s = '') {
  return String(s).toLowerCase().replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n+/g, '\n').trim()
}

/* ================== DETECTION: 3 PESAN STANDAR ================== */
// 1
const std1 = /selamat datang di akun whatsapp resmi hydroplus/i
// 2
const std2 = /yuk coba lagi dengan kode unik yang lain di dalam tutup botol hydroplus untuk dapatkan hadiahnya/i
// 3 (penutup – mengandung Ketik "Hi" untuk memulai chatting kembali)
const std3 = /terima kasih telah berpartisipasi dalam program hydroplus nonstop miliaran🤗[\s\S]*ketik\s*["“]?hi["”]?\s*untuk\s*memulai chatting kembali/i

function isStandardMessage(text = '') {
  const t = text
  return std1.test(t) || std2.test(t) || std3.test(t)
}
function isClosingHydro(text = '') {
  return std3.test(text)
}

/* ================== DETECTION: FLOW / GUARD ================== */
// Promo intro – JANGAN balas kode walau ada kata “kode unik”
function isPromoIntro(text = '') {
  const t = norm(text)
  return /promo[\s\S]*hydroplus[\s\S]*nonstop[\s\S]*miliaran/i.test(t)
      && /(unggah|mengunggah)\s*kode\s*unik/i.test(t)
}
function isAskCode(text = '') {
  const t = norm(text)
  if (isPromoIntro(t)) return false
  return /kode\s*unik/.test(t) && !/foto|ktp/.test(t)
}
function isAskImgCode(text = '') {
  const t = norm(text)
  return /(foto|bukti)/.test(t) && /kode\s*unik/.test(t)
}
function isAskKTP(text = '') {
  const t = norm(text)
  return /foto/.test(t) && /(ktp|kartu tanda penduduk)/.test(t)
}
function isDoneFlow(text = '') {
  const t = norm(text)
  return /terima\s*kasih/.test(t) && /3x24\s*jam/.test(t)
}
function isCodeValidNotice(text = '') {
  const t = norm(text)
  return /kode\s*unik/.test(t) && /valid/.test(t)
}
function isHydroFlow(text = '') {
  const t = norm(text)
  return /(kode\s*unik|bukti\s*foto|foto\s*ktp|verifikasi\s*data)/.test(t)
}

/* ================== TRIGGER RULE ================== */
// SEMUA pesan dianggap TRIGGER KECUALI 3 pesan standar (std1/std2/std3).
function isTrigger(text = '') {
  return !isStandardMessage(text)
}

/* ================== IMAGE SEND ================== */
async function sendImage(sock, jid, filePath, caption = '') {
  const exists = fs.existsSync(filePath)
  log(`sendImage(): path="${filePath}", exists=${exists}`)
  if (!exists) throw new Error(`File tidak ditemukan: ${filePath}`)
  const mimetype = mime.lookup(filePath) || 'image/jpeg'
  const buffer = fs.readFileSync(filePath)
  await sock.sendMessage(jid, { image: buffer, mimetype, caption })
}

/* ================== STAGE STATE (dua tahap kode) ================== */
const stageByJid = new Map() // jid -> 1 | 2
function getStage(jid) {
  return stageByJid.get(jid) || 1
}
function setStage(jid, s) {
  stageByJid.set(jid, s)
  log(`🔀 Stage untuk ${jid} => tahap-${s}`)
}
function getActiveCodeFor(jid) {
  const stage = getStage(jid)
  return stage === 2 ? (INIT_CODE2 || INIT_CODE) : INIT_CODE
}

/* ================== HI LOOP (Active Window sejak SOURCE balas) ================== */
let hiManualEnabled = HI_LOOP_DEFAULT        // Owner: "hi on"/"hi off"
let lastHiAt        = 0                      // ritme pengiriman Hi
let lastSourceAt    = 0                      // timestamp pesan terakhir dari SOURCE (0 = belum ada)

function hiActiveWindowOpen() {
  // Hi AKTIF bila kita masih berada dalam X menit SETELAH pesan terakhir dari SOURCE
  return lastSourceAt > 0 && (Date.now() - lastSourceAt) <= HI_ACTIVE_WINDOW_MS
}
function hiIsEnabledNow() {
  // Manual harus ON, dan masih dalam jendela aktif
  return hiManualEnabled && hiActiveWindowOpen()
}

async function hiLoop(sock) {
  log('▶️ Hi loop dimulai')
  log(`ℹ️ Hi manual: ${hiManualEnabled ? 'ON' : 'OFF'} | Active window: ${Math.round(HI_ACTIVE_WINDOW_MS/60000)} menit setelah SOURCE balas`)
  while (sock?.user) {
    try {
      if (hiIsEnabledNow() && Date.now() - lastHiAt > HI_INTERVAL_MS) {
        await sock.sendMessage(TARGET_JID, { text: 'Hi' })
        lastHiAt = Date.now()
        log(`✅ Hi terkirim ke ${WA_TARGET}`)
      }
    } catch (e) {
      log('❌ Gagal kirim Hi:', e.message)
    }
    await delay(5000)
  }
}

/* ================== OWNER CONTROL ================== */
// Owner dapat pause/resume bot, set code1/code2, dan hi on/off
let PAUSED = false
function pausedGuard(from) {
  return PAUSED && from !== OWNER_JID
}
async function handleOwnerCommands(sock, text) {
  const t = norm(text)

  if (t === 'pause bot' || t === 'jeda bot') {
    PAUSED = true
    await sock.sendMessage(OWNER_JID, { text: '⏸️ Bot dijeda.' })
    log('⏸️ Bot dijeda oleh owner.')
    return true
  }
  if (t === 'resume bot' || t === 'lanjut bot') {
    PAUSED = false
    await sock.sendMessage(OWNER_JID, { text: '▶️ Bot dilanjutkan.' })
    log('▶️ Bot dilanjutkan oleh owner.')
    return true
  }
  if (t.startsWith('set code1 ')) {
    const code = text.slice(9).trim()
    if (code) {
      INIT_CODE = code
      await sock.sendMessage(OWNER_JID, { text: `✅ INIT_CODE diperbarui: ${INIT_CODE}` })
      log('INIT_CODE di-set owner:', INIT_CODE)
    } else {
      await sock.sendMessage(OWNER_JID, { text: '❌ Format: set code1 F123ABCDE' })
    }
    return true
  }
  if (t.startsWith('set code2 ')) {
    const code = text.slice(9).trim()
    if (code) {
      INIT_CODE2 = code
      await sock.sendMessage(OWNER_JID, { text: `✅ INIT_CODE2 diperbarui: ${INIT_CODE2}` })
      log('INIT_CODE2 di-set owner:', INIT_CODE2)
    } else {
      await sock.sendMessage(OWNER_JID, { text: '❌ Format: set code2 F123ABCDE' })
    }
    return true
  }
  if (t === 'hi on') {
    hiManualEnabled = true
    await sock.sendMessage(OWNER_JID, { text: `✅ Hi-loop: ON (aktif SELAMA ${Math.round(HI_ACTIVE_WINDOW_MS/60000)} menit SETELAH SOURCE balas)` })
    return true
  }
  if (t === 'hi off') {
    hiManualEnabled = false
    await sock.sendMessage(OWNER_JID, { text: '⏸️ Hi-loop: OFF' })
    return true
  }
  if (t === 'status bot') {
    const sinceMin = lastSourceAt ? ((Date.now() - lastSourceAt)/60000).toFixed(1) : '–'
    const lines = [
      `🧠 Status Bot:`,
      `• Paused: ${PAUSED}`,
      `• Hi Manual: ${hiManualEnabled ? 'ON' : 'OFF'}`,
      `• Active Window: ${Math.round(HI_ACTIVE_WINDOW_MS/60000)} menit (sejak SOURCE balas: ${sinceMin} m)`,
      `• Stage SOURCE: ${getStage(SOURCE_JID)}`,
      `• Stage TARGET: ${getStage(TARGET_JID)}`,
      `• INIT_CODE: ${INIT_CODE}`,
      `• INIT_CODE2: ${INIT_CODE2}`
    ]
    await sock.sendMessage(OWNER_JID, { text: lines.join('\n') })
    return true
  }
  return false
}

/* ================== RECONNECT BACKOFF ================== */
let reconnectAttempts = 0
async function scheduleReconnect(fn) {
  reconnectAttempts++
  const wait = Math.min(30000, 1000 * Math.pow(2, reconnectAttempts)) // 1s,2s,4s,... max 30s
  log(`⏳ Jadwalkan reconnect dalam ${Math.round(wait/1000)}s (attempt ${reconnectAttempts})`)
  await delay(wait)
  fn().catch(e => log('Gagal restart:', e))
}

/* ================== MAIN ================== */
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(DATA_DIR, 'auth_info'))
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'error' })
  })

  sock.ev.on('creds.update', saveCreds)
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) {
      console.clear()
      console.log('📱 Scan QR berikut (Linked Devices):')
      qrcode.generate(qr, { small: true })
    }
    if (connection === 'open') {
      reconnectAttempts = 0
      log('✅ Bot tersambung sebagai:', sock.user?.id)
      hiLoop(sock).catch(e => log('hiLoop error:', e))
    } else if (connection === 'close') {
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode
        : undefined
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      log('❌ Koneksi tertutup. code=', statusCode, 'shouldReconnect=', shouldReconnect)
      if (shouldReconnect) {
        await scheduleReconnect(startBot)
      } else {
        log('⚠️ Logout permanen. Hapus folder data/auth_info untuk login ulang.')
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    const msg = messages[0]
    if (!msg?.message) return

    const from = msg.key.remoteJid

    // === Penting: update lastSourceAt seketika, WALAU tidak ada teks ===
    if (from === SOURCE_JID) {
      const prev = lastSourceAt
      lastSourceAt = Date.now()
      if (prev && lastSourceAt - prev > 1000) {
        const gap = ((lastSourceAt - prev)/1000).toFixed(1)
        log(`⏱️ Source activity detected (gap ${gap}s) → reset active window.`)
      } else {
        log(`⏱️ Source activity detected → reset active window.`)
      }
    }

    const text = extractTextFromMessage(msg).trim()

    // ===== OWNER COMMANDS =====
    if (from === OWNER_JID && text) {
      const handled = await handleOwnerCommands(sock, text)
      if (handled) return
    }

    // Jika bot dijeda & pengirim bukan owner → abaikan total
    if (pausedGuard(from)) return

    // ===== Abaikan 3 pesan standar (bukan trigger, tidak balas apa pun) =====
    if (text && isStandardMessage(text)) {
      log('ℹ️ Pesan standar terdeteksi → diabaikan.')
      // (Tidak perlu toggle Hi-loop; kini berbasis jendela aktif setelah SOURCE balas)
      return
    }

    // ===== Semua selain 3 standar = TRIGGER → forward ke OWNER (kalau ada teks) =====
    if (text && isTrigger(text)) {
      try {
        const label = (from === SOURCE_JID) ? 'SOURCE' : (from === TARGET_JID) ? 'TARGET' : from
        await sock.sendMessage(OWNER_JID, { text: `📣 [TRIGGER dari ${label}]\n${text}` })
        log('➡️ Trigger (teks) diforward ke owner.')
      } catch (e) {
        log('⚠️ Gagal forward trigger ke owner:', e?.message || e)
      }
      saveLastTrigger(text)
    }

    // ====== AUTO-FLOW (opsional) hanya kalau ada teks ======
    if (!text) return

    // Promo intro → jangan balas apapun
    if (isPromoIntro(text)) {
      log('ℹ️ Promo intro terdeteksi → tidak balas.')
      return
    }

    // Selesai → naik tahap jika masih tahap-1
    if (isDoneFlow(text)) {
      const st = getStage(from)
      if (st === 1) {
        log(`🎉 Bot telah Sukses (${from}) — tahap-1 selesai, lanjut ke tahap-2.`)
        setStage(from, 2)
      } else {
        log(`🎉 Bot telah Sukses (${from}) — tahap-2.`)
      }
      return
    }

    // Foto kode unik → IMG1
    if (isAskImgCode(text)) {
      try {
        await sendImage(sock, from, IMG1_PATH)
        log(`📤 [${from}] Kirim gambar1 (bukti foto kode unik).`)
      } catch (e) {
        log(`⚠️ [${from}] Gagal kirim gambar1:`, e?.message || e)
      }
      return
    }

    // Foto KTP → IMG2
    if (isAskKTP(text)) {
      try {
        await sendImage(sock, from, IMG2_PATH)
        log(`📤 [${from}] Kirim gambar2 (foto KTP).`)
      } catch (e) {
        log(`⚠️ [${from}] Gagal kirim gambar2:`, e?.message || e)
      }
      return
    }

    // Minta kode unik → kirim sesuai tahap; skip bila notice 'valid'
    if (isAskCode(text)) {
      if (isCodeValidNotice(text)) {
        log(`ℹ️ [${from}] "kode unik valid" → skip kirim kode.`)
        return
      }
      const code = getActiveCodeFor(from)
      try {
        await sock.sendMessage(from, { text: code })
        log(`📤 [${from}] Kirim kode tahap-${getStage(from)}.`)
      } catch (e) {
        log(`⚠️ [${from}] Gagal kirim kode:`, e?.message || e)
      }
      return
    }

    // Jika tidak cocok auto-flow apapun → cukup sudah (trigger sudah diforward jika ada teks)
  })
}

/* ================== GRACEFUL SHUTDOWN ================== */
const clean = () => { log('🛑 Shutdown…'); process.exit(0) }
process.on('SIGINT', clean)
process.on('SIGTERM', clean)
process.on('unhandledRejection', (r) => log('🔥 UnhandledRejection:', r))
process.on('uncaughtException', (e) => log('🔥 UncaughtException:', e))

startBot().catch(e => log('❌ Fatal error:', e))
