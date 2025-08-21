/* ================== IMPORTS ================== */
const fs = require('fs')
const path = require('path')
const qrcode = require('qrcode-terminal')
const axios = require('axios')
const FormData = require('form-data')
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
const INIT_CODE2 = process.env.INIT_CODE2 || ''   // kode tahap-2
const IMG1_PATH  = process.env.IMG1_PATH || ''
const IMG2_PATH  = process.env.IMG2_PATH || ''

// Telegram (opsional, untuk notifikasi online/offline)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID

// Ritme Hi
const HI_INTERVAL_MS = Number(process.env.HI_INTERVAL_MS || 60 * 1000) // default 1 menit

/* ================== STORAGE ================== */
const DATA_DIR = path.resolve('./data')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })

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
const stageByJid = new Map() // jid -> 1 | 2
function getStage(jid) { return stageByJid.get(jid) || 1 }
function setStage(jid, s) { stageByJid.set(jid, s); log(`🔀 Stage untuk ${jid} => tahap-${s}`) }
function getActiveCodeFor(jid) {
  const stage = getStage(jid)
  return stage === 2 ? (INIT_CODE2 || INIT_CODE) : INIT_CODE
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

/* ================== TELEGRAM (opsional) ================== */
async function tgSendMessage(text) {
  try {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`
    await axios.post(url, { chat_id: Number(TELEGRAM_CHAT_ID), text })
  } catch (e) {
    log('⚠️ Gagal kirim Telegram:', e?.message || e)
  }
}

/* ================== HANDLER PESAN ================== */
async function onMessages(sock, { messages, type }) {
  if (type !== 'notify') return
  const msg = messages[0]
  if (!msg?.message) return

  const from = msg.key.remoteJid
  const text = extractTextFromMessage(msg).trim()
  if (!text) return

  /* ===== OWNER reset perintah (opsional) ===== */
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
      if (!hiLoopEnabled) log('▶️ Pesan closing Hydro (SOURCE) → Hi loop dilanjutkan.')
      hiLoopEnabled = true
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
      if (!hiLoopEnabled) log('▶️ Pesan closing Hydro (TARGET) → Hi loop dilanjutkan.')
      hiLoopEnabled = true
    }

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

    // 4) minta kode unik → kirim sesuai tahap; skip bila ada notice 'valid'
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
}

/* ================== MAIN (Auto-Reconnect + Watchdog) ================== */
async function startBot(retryCount = 0) {
  const backoff = Math.min(30_000, 2_000 * Math.pow(1.6, retryCount)) // max 30s
  const { state, saveCreds } = await useMultiFileAuthState(path.join(DATA_DIR, 'auth_info'))

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'error' }),
    keepAliveIntervalMs: 15_000,
    connectTimeoutMs: 45_000,
  })

  // — Health watchdog —
  let lastHealthyAt = Date.now()
  const markHealthy = () => (lastHealthyAt = Date.now())
  const watchdog = setInterval(() => {
    const silentMs = Date.now() - lastHealthyAt
    if (silentMs > 180_000) {
      log(`🩺 Watchdog: tidak ada aktivitas ${Math.round(silentMs/1000)}s → restart socket…`)
      try { sock?.end?.() } catch {}
    }
  }, 45_000)

  // simpan creds
  sock.ev.on('creds.update', saveCreds)

  // event untuk menandai sehat
  sock.ev.on('messages.upsert', () => markHealthy())
  sock.ev.on('presence.update', () => markHealthy())
  sock.ev.on('contacts.update', () => markHealthy())

  // hubungkan handler pesan utama
  sock.ev.on('messages.upsert', async (payload) => {
    try { await onMessages(sock, payload) } catch (e) {
      log('⚠️ Handler messages error:', e?.message || e)
    }
  })

  // lifecycle koneksi
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update

    if (qr) {
      console.clear()
      console.log('📱 Scan QR berikut (Linked Devices):')
      qrcode.generate(qr, { small: true })
    }

    if (connection === 'open') {
      log('✅ Bot tersambung sebagai:', sock.user?.id)
      markHealthy()
      hiLoop(sock).catch(e => log('hiLoop error:', e))
      tgSendMessage('✅ Bot HYDROPLUS ONLINE').catch(()=>{})
    }

    if (connection === 'close') {
      clearInterval(watchdog)

      const status = new Boom(lastDisconnect?.error)?.output?.statusCode
      const isLoggedOut = status === DisconnectReason.loggedOut

      log('🔌 Koneksi tertutup.',
          'status =', status,
          'loggedOut =', isLoggedOut,
          'retryCount =', retryCount)

      if (isLoggedOut) {
        tgSendMessage('⛔ Bot HYDROPLUS LOGGED OUT. Hapus data/auth_info dan login ulang.').catch(()=>{})
        log('⛔ Ter-logout. Hapus folder ./data/auth_info jika ingin login ulang.')
        return
      }

      const recoverable = [
        DisconnectReason.connectionClosed,
        DisconnectReason.connectionLost,
        DisconnectReason.timedOut,
        DisconnectReason.restartRequired,
        DisconnectReason.badSession,
        undefined,
      ].includes(status)

      if (recoverable) {
        const wait = backoff
        tgSendMessage(`♻️ Reconnect otomatis dalam ${Math.round(wait/1000)}s…`).catch(()=>{})
        log(`♻️ Reconnect otomatis dalam ${Math.round(wait / 1000)}s…`)
        setTimeout(() => startBot(Math.min(retryCount + 1, 20)).catch(e => log('Gagal start ulang:', e)), wait)
      } else {
        tgSendMessage('❗ Koneksi putus dan tidak dapat dipulihkan otomatis. Proses berhenti.').catch(()=>{})
        log('❗ Alasan putus tidak dikenal/tidak bisa dipulihkan. Proses dibiarkan berhenti.')
      }
    }

    if (update?.isOnline === true) markHealthy()
    if (update?.isNewLogin === true) markHealthy()
    if (update?.receivedPendingNotifications === true) markHealthy()
  })
}

/* ================== GRACEFUL SHUTDOWN ================== */
const clean = () => { log('🛑 Shutdown…'); process.exit(0) }
process.on('SIGINT', clean)
process.on('SIGTERM', clean)
process.on('unhandledRejection', (r) => log('🔥 UnhandledRejection:', r))
process.on('uncaughtException', (e) => log('🔥 UncaughtException:', e))

startBot().catch(e => log('❌ Fatal error:', e))
