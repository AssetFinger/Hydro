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
const INIT_CODE2 = process.env.INIT_CODE2 || ''   // Kode tahap-2
const IMG1_PATH  = process.env.IMG1_PATH || ''
const IMG2_PATH  = process.env.IMG2_PATH || ''

// Telegram (AKTIF)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID

// Hi interval
const HI_INTERVAL_MS = Number(process.env.HI_INTERVAL_MS || 60 * 1000) // default 1 menit

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

async function sendTelegram(msg) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: msg
    })
  } catch (e) {
    console.error('⚠️ Gagal kirim Telegram:', e?.message)
  }
}

function extractTextFromMessage(msg) {
  if (!msg?.message) return ''
  const m = msg.message
  if (m.conversation) return m.conversation
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text
  if (m.imageMessage?.caption) return m.imageMessage.caption
  if (m.videoMessage?.caption) return m.videoMessage.caption
  return ''
}
function norm(s = '') {
  return String(s).toLowerCase().replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n+/g, '\n').trim()
}

/* ================== DETECTION PATTERNS ================== */
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
  // “Terima kasih … 3x24 Jam …”
  return /terima\s*kasih/.test(t) && /3x24\s*jam/.test(t)
}
function isCodeValidNotice(text) {
  const t = norm(text)
  return /kode\s*unik/.test(t) && /valid/.test(t)
}
/* Pesan penutup Hydro: aktifkan kembali hi-loop */
function isClosingHydro(text) {
  const t = norm(text)
  // "Ketik "Hi" untuk memulai chatting kembali"
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
// Default semua JID: tahap-1. Setelah “Sukses” tahap-1 → pindah ke tahap-2.
const stageByJid = new Map() // jid -> 1 | 2
function getStage(jid) { return stageByJid.get(jid) || 1 }
function setStage(jid, s) { stageByJid.set(jid, s); const msg = `🔀 Stage untuk ${jid} => tahap-${s}`; log(msg); sendTelegram(msg) }
function getActiveCodeFor(jid) { return getStage(jid) === 2 ? (INIT_CODE2 || INIT_CODE) : INIT_CODE }

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
        const m = `✅ Hi terkirim ke ${WA_TARGET}`
        log(m); sendTelegram(m)
      } catch (e) {
        const m = `❌ Gagal kirim Hi: ${e.message}`
        log(m); sendTelegram(m)
      }
    }
    await delay(5000)
  }
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
      sendTelegram('📱 QR baru: silakan scan untuk login.')
    }
    if (connection === 'open') {
      const m = `✅ Bot tersambung sebagai: ${sock.user?.id}`
      log(m); sendTelegram(m)
      hiLoop(sock).catch(e => log('hiLoop error:', e))
    } else if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        && lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
      const m = `❌ Koneksi tertutup. Reconnect: ${shouldReconnect}`
      log(m); sendTelegram(m)
      if (shouldReconnect) {
        await delay(5_000)
        startBot().catch(e => log('Gagal restart:', e))
      } else {
        sendTelegram('⚠️ Logout permanen.')
        log('⚠️ Logout permanen.')
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    const msg = messages[0]
    if (!msg?.message) return

    const from = msg.key.remoteJid
    const text = extractTextFromMessage(msg).trim()
    if (!text) return

    // kirim ringkas ke Telegram agar bisa dipantau
    if (from === SOURCE_JID || from === TARGET_JID) {
      sendTelegram(`📩 Dari ${from}: ${text}`)
    }

    /* ===== OWNER: perintah reset tahap (opsional) ===== */
    if (from === OWNER_JID) {
      const t = norm(text)
      if (t === 'reset tahap source') { setStage(SOURCE_JID, 1); return }
      if (t === 'reset tahap target') { setStage(TARGET_JID, 1); return }
    }

    /* ===== SOURCE_JID ===== */
    if (from === SOURCE_JID) {
      // Kontrol hi-loop
      if (isHydroFlow(text)) {
        if (hiLoopEnabled) log('⏸️ Hi loop dihentikan (SOURCE Hydro flow).')
        hiLoopEnabled = false
      }
      if (isClosingHydro(text)) {
        if (!hiLoopEnabled) log('▶️ Closing Hydro (SOURCE) → Hi loop dilanjutkan.')
        hiLoopEnabled = true
        lastHiAt = 0 // agar segera kirim Hi pada interval berikutnya
      }

      // 1) selesai → naik tahap bila masih tahap-1
      if (isDoneFlow(text)) {
        const st = getStage(SOURCE_JID)
        if (st === 1) {
          const m = '🎉 Bot telah Sukses (SOURCE) — tahap-1 selesai, lanjut ke tahap-2.'
          log(m); sendTelegram(m)
          setStage(SOURCE_JID, 2)
        } else {
          const m = '🎉 Bot telah Sukses (SOURCE) — tahap-2.'
          log(m); sendTelegram(m)
        }
        return
      }

      // 2) foto kode unik → IMG1
      if (isAskImgCode(text)) {
        try {
          await sendImage(sock, SOURCE_JID, IMG1_PATH)
          const m = '📤 [SOURCE] Kirim gambar1 (bukti foto kode unik).'
          log(m); sendTelegram(m)
        } catch (e) {
          const m = `⚠️ [SOURCE] Gagal kirim gambar1: ${e?.message || e}`
          log(m); sendTelegram(m)
        }
        return
      }

      // 3) foto KTP → IMG2
      if (isAskKTP(text)) {
        try {
          await sendImage(sock, SOURCE_JID, IMG2_PATH)
          const m = '📤 [SOURCE] Kirim gambar2 (foto KTP).'
          log(m); sendTelegram(m)
        } catch (e) {
          const m = `⚠️ [SOURCE] Gagal kirim gambar2: ${e?.message || e}`
          log(m); sendTelegram(m)
        }
        return
      }

      // 4) minta kode unik → kirim sesuai tahap; skip bila notice 'valid'
      if (isAskCode(text)) {
        if (isCodeValidNotice(text)) {
          const m = 'ℹ️ [SOURCE] "kode unik valid" terdeteksi → skip kirim kode.'
          log(m); sendTelegram(m)
          return
        }
        const code = getActiveCodeFor(SOURCE_JID)
        try {
          await sock.sendMessage(SOURCE_JID, { text: code })
          const m = `📤 [SOURCE] Kirim kode tahap-${getStage(SOURCE_JID)}.`
          log(m); sendTelegram(m)
        } catch (e) {
          const m = `⚠️ [SOURCE] Gagal kirim kode: ${e?.message || e}`
          log(m); sendTelegram(m)
        }
        return
      }

      // Lainnya → catat sebagai trigger (opsional)
      saveLastTrigger(text)
      return
    }

    /* ===== TARGET_JID ===== */
    if (from === TARGET_JID) {
      // Kontrol hi-loop
      if (isHydroFlow(text)) {
        if (hiLoopEnabled) log('⏸️ Hi loop dihentikan (TARGET Hydro flow).')
        hiLoopEnabled = false
      }
      if (isClosingHydro(text)) {
        if (!hiLoopEnabled) log('▶️ Closing Hydro (TARGET) → Hi loop dilanjutkan.')
        hiLoopEnabled = true
        lastHiAt = 0
      }

      // 1) selesai → naik tahap bila masih tahap-1
      if (isDoneFlow(text)) {
        try { await sock.sendMessage(TARGET_JID, { react: { text: '✅', key: msg.key } }) } catch {}
        const st = getStage(TARGET_JID)
        if (st === 1) {
          const m = '🎉 Bot telah Sukses (TARGET) — tahap-1 selesai, lanjut ke tahap-2.'
          log(m); sendTelegram(m)
          setStage(TARGET_JID, 2)
        } else {
          const m = '🎉 Bot telah Sukses (TARGET) — tahap-2.'
          log(m); sendTelegram(m)
        }
        return
      }

      // 2) foto kode unik → IMG1
      if (isAskImgCode(text)) {
        try {
          await sendImage(sock, TARGET_JID, IMG1_PATH)
          const m = '📤 [TARGET] Kirim gambar1 (bukti foto kode unik).'
          log(m); sendTelegram(m)
        } catch (e) {
          const m = `⚠️ [TARGET] Gagal kirim gambar1: ${e?.message || e}`
          log(m); sendTelegram(m)
        }
        return
      }

      // 3) foto KTP → IMG2
      if (isAskKTP(text)) {
        try {
          await sendImage(sock, TARGET_JID, IMG2_PATH)
          const m = '📤 [TARGET] Kirim gambar2 (foto KTP).'
          log(m); sendTelegram(m)
        } catch (e) {
          const m = `⚠️ [TARGET] Gagal kirim gambar2: ${e?.message || e}`
          log(m); sendTelegram(m)
        }
        return
      }

      // 4) minta kode unik → kirim sesuai tahap; skip bila notice 'valid'
      if (isAskCode(text)) {
        if (isCodeValidNotice(text)) {
          const m = 'ℹ️ [TARGET] "kode unik valid" terdeteksi → skip kirim kode.'
          log(m); sendTelegram(m)
          return
        }
        const code = getActiveCodeFor(TARGET_JID)
        try {
          await sock.sendMessage(TARGET_JID, { text: code })
          const m = `📤 [TARGET] Kirim kode tahap-${getStage(TARGET_JID)}.`
          log(m); sendTelegram(m)
        } catch (e) {
          const m = `⚠️ [TARGET] Gagal kirim kode: ${e?.message || e}`
          log(m); sendTelegram(m)
        }
        return
      }
      return
    }
  })
}

/* ================== GRACEFUL SHUTDOWN ================== */
const clean = () => { 
  log('🛑 Shutdown…') 
  sendTelegram('🛑 Bot Shutdown.')
  process.exit(0) 
}
process.on('SIGINT', clean)
process.on('SIGTERM', clean)
process.on('unhandledRejection', (r) => log('🔥 UnhandledRejection:', r))
process.on('uncaughtException', (e) => log('🔥 UncaughtException:', e))

startBot().catch(e => { 
  log('❌ Fatal error:', e) 
  sendTelegram(`❌ Fatal: ${e?.message || e}`)
})
