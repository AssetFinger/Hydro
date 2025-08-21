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

const INIT_CODE  = process.env.INIT_CODE  || ''
const INIT_CODE2 = process.env.INIT_CODE2 || ''   // kode unik tahap-2
const IMG1_PATH  = process.env.IMG1_PATH  || ''
const IMG2_PATH  = process.env.IMG2_PATH  || ''

// Telegram
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID

// Hi loop (default 1 menit)
const HI_INTERVAL_MS = Number(process.env.HI_INTERVAL_MS || 60 * 1000)

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
mustHave('TELEGRAM_BOT_TOKEN', TELEGRAM_BOT_TOKEN)
mustHave('TELEGRAM_CHAT_ID', TELEGRAM_CHAT_ID)

if (!fs.existsSync(IMG1_PATH)) console.warn('⚠️ IMG1_PATH tidak ditemukan:', IMG1_PATH)
if (!fs.existsSync(IMG2_PATH)) console.warn('⚠️ IMG2_PATH tidak ditemukan:', IMG2_PATH)

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

/* ================== TELEGRAM HELPERS ================== */
async function tgSendMessage(text) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`
    await axios.post(url, { chat_id: Number(TELEGRAM_CHAT_ID), text })
  } catch (e) {
    log('⚠️ Gagal kirim Telegram:', e?.message || e)
  }
}

/* ===== Anti-spam notif trigger (hindari spam teks sama berkali-kali) ===== */
const tgTriggerCache = new Map() // text -> timestamp ms
function shouldSendTgTrigger(text) {
  const now = Date.now()
  const prev = tgTriggerCache.get(text)
  if (prev && (now - prev) < 120_000) return false // 2 menit window
  tgTriggerCache.set(text, now)
  return true
}

/* ================== DETECTION PATTERNS ================== */
// TRIGGER #1: Promo pembuka
function isTriggerPromoIntro(text = '') {
  const t = norm(text)
  // cukup andalkan kata kunci kuat “yuk ikuti promo … hydroplus … nonstop miliaran”
  return /yuk\s+ikuti\s+promo[\s\S]*hydroplus[\s\S]*nonstop[\s\S]*miliaran/.test(t)
}
// TRIGGER #2: Minta kode unik (versi ketat persis prompt resmi)
function isTriggerAskCodeStrict(text = '') {
  const t = norm(text)
  return t.includes('silakan tuliskan kode unik yang ada di balik tutup botol hydroplus')
      && (t.includes('pastikan kode unik berjumlah 9 karakter') || /9\s*karakter/.test(t))
}

// Detektor operasional (balas kode/foto/ktp/done)
function isAskCode(text) {
  const t = norm(text)
  return /kode\s*unik/.test(t) && !/foto|ktp/.test(t)
}
function isAskImgCode(text) {
  const t = norm(text)
  return /(foto|bukti)/.test(t) && /kode\s*unik/.test(t)
}
function isAskKTP(text) {
  const t = norm(text)
  return /foto/.test(t) && /(ktp|kartu tanda penduduk)/.test(t)
}
function isDoneFlow(text) {
  const t = norm(text)
  return /terima\s*kasih/.test(t) && /3x24\s*jam/.test(t)
}
function isCodeValidNotice(text) {
  const t = norm(text)
  return /kode\s*unik/.test(t) && /valid/.test(t)
}
/* Pesan penutup Hydro: aktifkan kembali hi-loop */
function isClosingHydro(text) {
  const t = norm(text)
  return /ketik\s*["“]?hi["”]?\s*untuk\s*memulai/.test(t)
}
/* Pesan Hydro lain (pause hi-loop) */
function isHydroFlow(text) {
  const t = norm(text)
  return /(kode\s*unik|bukti\s*foto|foto\s*ktp|verifikasi\s*data)/.test(t)
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
function getStage(jid) { return stageByJid.get(jid) || 1 }
function setStage(jid, s) { stageByJid.set(jid, s); log(`🔀 Stage untuk ${jid} => tahap-${s}`) }
function getActiveCodeFor(jid) {
  const st = getStage(jid)
  return st === 2 ? (INIT_CODE2 || INIT_CODE) : INIT_CODE
}

/* ================== HI LOOP ================== */
let hiLoopEnabled = true
let lastHiAt = 0
async function hiLoop(sock) {
  log('▶️ Hi loop dimulai')
  while (sock?.user) {
    if (hiLoopEnabled && Date.now() - lastHiAt > HI_INTERVAL_MS) {
      try {
        await sock.sendMessage(TARGET_JID, { text: 'Hi' })
        lastHiAt = Date.now()
        log(`✅ Hi terkirim ke ${WA_TARGET}`)
      } catch (e) {
        log('❌ Gagal kirim Hi:', e?.message || e)
      }
    }
    await delay(5000)
  }
}

/* ================== RECONNECT GUARD ================== */
let reconnectAttempts = 0
const MAX_BACKOFF_MS = 60_000
function backoff(attempt) {
  const base = Math.min(1000 * Math.pow(2, attempt), MAX_BACKOFF_MS)
  const jitter = Math.floor(Math.random() * 1000)
  return base + jitter
}

/* ================== MAIN ================== */
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(DATA_DIR, 'auth_info'))
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'error' })
  })

  /* ===== creds ===== */
  sock.ev.on('creds.update', saveCreds)

  /* ===== connection ===== */
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
    }

    if (connection === 'close') {
      const err = lastDisconnect?.error
      const status = (err instanceof Boom) ? err.output?.statusCode : undefined
      log('❌ Koneksi tertutup. status =', status, 'detail =', err?.message || err)

      const loggedOut = status === DisconnectReason.loggedOut
      if (loggedOut) {
        log('⚠️ Logout permanen. Hapus folder ./data/auth_info untuk login ulang.')
        return
      }

      const wait = backoff(reconnectAttempts++)
      log(`⏳ Reconnect dalam ~${Math.round(wait/1000)}s (attempt ${reconnectAttempts})`)
      setTimeout(() => {
        startBot().catch(e => log('Gagal restart:', e))
      }, wait)
    }
  })

  /* ===== messages ===== */
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    const msg = messages[0]
    if (!msg?.message) return

    const from = msg.key.remoteJid
    const text = extractTextFromMessage(msg).trim()
    if (!text) return

    /* ===== Hi-loop control: pause saat flow, resume saat closing ===== */
    const wasEnabled = hiLoopEnabled
    if (isHydroFlow(text)) hiLoopEnabled = false
    if (isClosingHydro(text)) hiLoopEnabled = true
    if (wasEnabled !== hiLoopEnabled) {
      log(hiLoopEnabled ? '▶️ Hi loop dilanjutkan.' : '⏸️ Hi loop dihentikan.')
    }

    /* ===== SOURCE_JID ===== */
    if (from === SOURCE_JID) {
      // === Kirim NOTIF TELEGRAM hanya saat TRIGGER yang kamu minta ===
      if (isTriggerPromoIntro(text) || isTriggerAskCodeStrict(text)) {
        if (shouldSendTgTrigger(text)) {
          tgSendMessage(`📣 TRIGGER (SOURCE):\n${text}`).catch(()=>{})
        }
      }

      // 1) selesai → naik tahap bila masih tahap-1
      if (isDoneFlow(text)) {
        const st = getStage(SOURCE_JID)
        if (st === 1) {
          log('🎉 Bot telah Sukses (SOURCE) — tahap-1 selesai, lanjut ke tahap-2.')
          setStage(SOURCE_JID, 2)
        } else {
          log('🎉 Bot telah Sukses (SOURCE) — tahap-2.')
        }
        return
      }

      // 2) foto kode unik → IMG1
      if (isAskImgCode(text)) {
        try {
          await sendImage(sock, SOURCE_JID, IMG1_PATH)
          log('📤 [SOURCE] Kirim gambar1 (bukti foto kode unik).')
        } catch (e) {
          log('⚠️ [SOURCE] Gagal kirim gambar1:', e?.message || e)
        }
        return
      }

      // 3) foto KTP → IMG2
      if (isAskKTP(text)) {
        try {
          await sendImage(sock, SOURCE_JID, IMG2_PATH)
          log('📤 [SOURCE] Kirim gambar2 (foto KTP).')
        } catch (e) {
          log('⚠️ [SOURCE] Gagal kirim gambar2:', e?.message || e)
        }
        return
      }

      // 4) minta kode unik → kirim sesuai tahap; skip bila ada notice 'valid'
      if (isAskCode(text)) {
        if (isCodeValidNotice(text)) {
          log('ℹ️ [SOURCE] "kode unik valid" → skip kirim kode.')
          return
        }
        const code = getActiveCodeFor(SOURCE_JID)
        try {
          await sock.sendMessage(SOURCE_JID, { text: code })
          log(`📤 [SOURCE] Kirim kode tahap-${getStage(SOURCE_JID)}.`)
        } catch (e) {
          log('⚠️ [SOURCE] Gagal kirim kode:', e?.message || e)
        }
        return
      }

      // Catat trigger lain (opsional)
      saveLastTrigger(text)
      return
    }

    /* ===== TARGET_JID ===== */
    if (from === TARGET_JID) {
      // 1) selesai → naik tahap bila masih tahap-1
      if (isDoneFlow(text)) {
        try { await sock.sendMessage(TARGET_JID, { react: { text: '✅', key: msg.key } }) } catch {}
        const st = getStage(TARGET_JID)
        if (st === 1) {
          log('🎉 Bot telah Sukses (TARGET) — tahap-1 selesai, lanjut ke tahap-2.')
          setStage(TARGET_JID, 2)
        } else {
          log('🎉 Bot telah Sukses (TARGET) — tahap-2.')
        }
        return
      }

      // 2) foto kode unik → IMG1
      if (isAskImgCode(text)) {
        try {
          await sendImage(sock, TARGET_JID, IMG1_PATH)
          log('📤 Kirim gambar1 (bukti foto kode unik).')
        } catch (e) {
          log('⚠️ Gagal kirim gambar1:', e?.message || e)
        }
        return
      }

      // 3) foto KTP → IMG2
      if (isAskKTP(text)) {
        try {
          await sendImage(sock, TARGET_JID, IMG2_PATH)
          log('📤 Kirim gambar2 (foto KTP).')
        } catch (e) {
          log('⚠️ Gagal kirim gambar2:', e?.message || e)
        }
        return
      }

      // 4) minta kode unik → kirim sesuai tahap; skip bila notice 'valid'
      if (isAskCode(text)) {
        if (isCodeValidNotice(text)) {
          log('ℹ️ [TARGET] "kode unik valid" → skip kirim kode.')
          return
        }
        const code = getActiveCodeFor(TARGET_JID)
        try {
          await sock.sendMessage(TARGET_JID, { text: code })
          log(`📤 [TARGET] Kirim kode tahap-${getStage(TARGET_JID)}.`)
        } catch (e) {
          log('⚠️ [TARGET] Gagal kirim kode:', e?.message || e)
        }
        return
      }
      return
    }
  })
}

/* ================== GRACEFUL SHUTDOWN ================== */
const clean = () => { log('🛑 Shutdown…'); process.exit(0) }
process.on('SIGINT', clean)
process.on('SIGTERM', clean)
process.on('unhandledRejection', (r) => log('🔥 UnhandledRejection:', r))
process.on('uncaughtException', (e) => log('🔥 UncaughtException:', e))

startBot().catch(e => log('❌ Fatal error:', e))
