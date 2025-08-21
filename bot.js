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

// Telegram (aktif)
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID

// Hi loop
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

/* ================== TELEGRAM ================== */
async function tgSendMessage(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`
  await axios.post(url, { chat_id: Number(TELEGRAM_CHAT_ID), text, parse_mode: 'Markdown' })
}

/* ================== TTS (opsional) ================== */
let HAS_FFMPEG = false
exec('ffmpeg -version', (err) => { HAS_FFMPEG = !err; log('FFmpeg available:', HAS_FFMPEG) })
async function downloadToFile(url, filePath) {
  const writer = fs.createWriteStream(filePath)
  const res = await axios({ url, method: 'GET', responseType: 'stream' })
  await new Promise((resolve, reject) => {
    res.data.pipe(writer)
    writer.on('finish', resolve)
    writer.on('error', reject)
  })
}
async function createVoiceNoteOgg(text, outPath) {
  const url = await googleTTS.getAudioUrl(text, { lang: 'id', slow: false, host: 'https://translate.google.com' })
  const tmpMp3 = outPath + '.mp3'
  await downloadToFile(url, tmpMp3)
  await new Promise((resolve, reject) => {
    execFile('ffmpeg', ['-y', '-i', tmpMp3, '-c:a', 'libopus', '-b:a', '32k', outPath], (err) => {
      try { fs.unlinkSync(tmpMp3) } catch {}
      if (err) return reject(err)
      resolve()
    })
  })
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

/* ================== DETECTION PATTERNS ================== */
// Pesan standar HYDRO — harus diabaikan total
const STD_HYDRO_1 = /selamat datang di akun whatsapp resmi hydroplus/i
const STD_HYDRO_2 = /yuk coba lagi dengan kode unik yang lain di dalam tutup botol hydroplus untuk dapatkan hadiahnya/i
const STD_HYDRO_3 = /terima kasih telah berpartisipasi dalam program hydroplus nonstop miliaran[\s\S]*ketik\s*["“]?hi["”]?\s*untuk\s*memulai\s*chatting\s*kembali/i
function isStandardHydro(text = '') {
  const t = norm(text)
  return STD_HYDRO_1.test(t) || STD_HYDRO_2.test(t) || STD_HYDRO_3.test(t)
}

// Flow detektor
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
// Penutup (aktifkan hi loop)
function isClosingHydro(text) {
  const t = norm(text)
  return /ketik\s*["“]?hi["”]?\s*untuk\s*memulai/.test(t)
}
// Flow umum (untuk pause hi loop saat aktif)
function isHydroFlow(text) {
  const t = norm(text)
  return /(kode\s*unik|bukti\s*foto|foto\s*ktp|verifikasi\s*data)/.test(t)
}

// TRIGGER yang harus di-notif ke Telegram (hanya dari SOURCE)
const TRIGGER_1 = /promo\s*\*?hydroplus\s*nonstop\s*miliaran/i
const TRIGGER_2 = /silakan\s*tuliskan\s*kode\s*unik[\s\S]*pastikan\s*kode\s*unik\s*berjumlah\s*9\s*karakter/i
function isTriggerFromSource(text) {
  const t = norm(text)
  return TRIGGER_1.test(t) || TRIGGER_2.test(t)
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
        log('❌ Gagal kirim Hi:', e.message)
      }
    }
    await delay(5000)
  }
}

/* ================== MAIN + AUTORECONNECT ================== */
async function startBot(backoffMs = 0) {
  if (backoffMs > 0) {
    log(`⏳ Menunggu ${Math.round(backoffMs/1000)}s sebelum reconnect…`)
    await delay(backoffMs)
  }

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
      log('✅ Bot tersambung sebagai:', sock.user?.id)
      hiLoop(sock).catch(e => log('hiLoop error:', e))
    } else if (connection === 'close') {
      const isBoom = lastDisconnect?.error instanceof Boom
      const statusCode = isBoom ? lastDisconnect.error.output.statusCode : undefined
      const loggedOut = statusCode === DisconnectReason.loggedOut
      log('❌ Koneksi tertutup. code=', statusCode, 'loggedOut=', loggedOut)

      if (!loggedOut) {
        const nextBackoff = Math.min(backoffMs ? backoffMs * 2 : 3000, 60_000)
        try { sock?.end?.() } catch {}
        // Recurse with backoff
        startBot(nextBackoff).catch(e => log('Gagal restart:', e))
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
      // Abaikan total jika pesan standar HYDRO
      if (isStandardHydro(text)) {
        log('… [SOURCE] Pesan standar HYDRO — diabaikan (no reply).')
        if (isClosingHydro(text)) {
          if (!hiLoopEnabled) log('▶️ Closing Hydro (SOURCE) → Hi loop dilanjutkan.')
          hiLoopEnabled = true
        }
        return
      }

      // Kontrol hi-loop untuk flow
      if (isHydroFlow(text)) {
        if (hiLoopEnabled) log('⏸️ Hi loop dihentikan (SOURCE Hydro flow).')
        hiLoopEnabled = false
      }
      if (isClosingHydro(text)) {
        if (!hiLoopEnabled) log('▶️ Pesan closing Hydro (SOURCE) → Hi loop dilanjutkan.')
        hiLoopEnabled = true
      }

      // Kirim NOTIF TELEGRAM hanya jika TRIGGER (dua pesan yang kamu sebut)
      if (isTriggerFromSource(text)) {
        saveLastTrigger(text)
        try {
          await tgSendMessage(`📣 *TRIGGER dari SOURCE*\n\n${text}`)
          log('➡️ Trigger dikirim ke Telegram.')
        } catch (e) {
          log('⚠️ Gagal kirim trigger ke Telegram:', e?.message || e)
        }
      }

      // 1) selesai → naik tahap jika masih tahap-1
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

      // 4) minta kode unik → kirim sesuai tahap; skip bila notice 'valid'
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

      // Catat selain itu (opsional)
      return
    }

    /* ===== TARGET_JID ===== */
    if (from === TARGET_JID) {
      // Abaikan total jika pesan standar HYDRO
      if (isStandardHydro(text)) {
        log('… [TARGET] Pesan standar HYDRO — diabaikan (no reply).')
        if (isClosingHydro(text)) {
          if (!hiLoopEnabled) log('▶️ Closing Hydro (TARGET) → Hi loop dilanjutkan.')
          hiLoopEnabled = true
        }
        return
      }

      // Kontrol hi-loop untuk flow
      if (isHydroFlow(text)) {
        if (hiLoopEnabled) log('⏸️ Hi loop dihentikan (TARGET Hydro flow).')
        hiLoopEnabled = false
      }
      if (isClosingHydro(text)) {
        if (!hiLoopEnabled) log('▶️ Pesan closing Hydro (TARGET) → Hi loop dilanjutkan.')
        hiLoopEnabled = true
      }

      // 1) selesai → naik tahap jika masih tahap-1
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

  return sock
}

/* ================== GRACEFUL SHUTDOWN ================== */
const clean = () => { log('🛑 Shutdown…'); process.exit(0) }
process.on('SIGINT', clean)
process.on('SIGTERM', clean)
process.on('unhandledRejection', (r) => log('🔥 UnhandledRejection:', r))
process.on('uncaughtException', (e) => log('🔥 UncaughtException:', e))

startBot().catch(e => log('❌ Fatal error:', e))
