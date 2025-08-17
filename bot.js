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
const twilio = require('twilio')
const pino = require('pino')

dotenv.config()

/* ================== KONFIG ================== */
const WA_OWNER  = process.env.WHATSAPP_OWNER
const WA_SOURCE = process.env.WA_SOURCE
const WA_TARGET = process.env.WA_TARGET

const INIT_CODE = process.env.INIT_CODE || ''
const IMG1_PATH = process.env.IMG1_PATH || ''
const IMG2_PATH = process.env.IMG2_PATH || ''

// Telegram
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN
const TELEGRAM_CHAT_ID   = process.env.TELEGRAM_CHAT_ID

// Twilio (SMS alarm)
const TWILIO_ACCOUNT_SID   = process.env.TWILIO_ACCOUNT_SID
const TWILIO_AUTH_TOKEN    = process.env.TWILIO_AUTH_TOKEN
const TWILIO_PHONE_NUMBER  = process.env.TWILIO_PHONE_NUMBER
const TWILIO_RECIPIENT_NUM = process.env.TWILIO_RECIPIENT_NUMBER

// Hi controls
const HI_QUIET_MS    = Number(process.env.HI_QUIET_MS    || 3 * 60 * 1000) // pause 3 menit saat flow aktif
const HI_INTERVAL_MS = Number(process.env.HI_INTERVAL_MS || 60 * 1000)     // ritme kirim "Hi"

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
mustHave('TELEGRAM_BOT_TOKEN', TELEGRAM_BOT_TOKEN)
mustHave('TELEGRAM_CHAT_ID', TELEGRAM_CHAT_ID)
mustHave('INIT_CODE', INIT_CODE)
mustHave('IMG1_PATH', IMG1_PATH)
mustHave('IMG2_PATH', IMG2_PATH)

if (!fs.existsSync(IMG1_PATH)) console.warn('⚠️ IMG1_PATH tidak ditemukan:', IMG1_PATH)
if (!fs.existsSync(IMG2_PATH)) console.warn('⚠️ IMG2_PATH tidak ditemukan:', IMG2_PATH)

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !TWILIO_RECIPIENT_NUM) {
  console.warn('⚠️ Kredensial Twilio belum lengkap. Fitur SMS alarm akan di-skip.')
}

/* ================== CEK FFMPEG ================== */
let HAS_FFMPEG = false
exec('ffmpeg -version', (err) => {
  HAS_FFMPEG = !err
  log('FFmpeg available:', HAS_FFMPEG)
})

/* ================== IMAGE PIPELINE (sharp optional) ================== */
let sharpAvailable = false
try { require.resolve('sharp'); sharpAvailable = true } catch {}

async function maybeCompressImage(inPath) {
  if (!sharpAvailable) return fs.readFileSync(inPath)
  const sharp = require('sharp')
  return await sharp(inPath)
    .rotate()
    .resize({ width: 1280, height: 1280, fit: 'inside' })
    .jpeg({ quality: 80 })
    .toBuffer()
}

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

async function sendImage(sock, jid, filePath, caption = '') {
  const exists = fs.existsSync(filePath)
  log(`sendImage(): path="${filePath}", exists=${exists}, sharp=${sharpAvailable}`)
  if (!exists) throw new Error(`File tidak ditemukan: ${filePath}`)
  const mimetype = mime.lookup(filePath) || 'image/jpeg'
  const buffer = await maybeCompressImage(filePath)
  await sock.sendMessage(jid, { image: buffer, mimetype, caption })
}

/* ================== TELEGRAM ================== */
async function tgSendMessage(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`
  await axios.post(url, { chat_id: Number(TELEGRAM_CHAT_ID), text, parse_mode: 'Markdown' })
}
async function tgSendVoice(filePath, caption = '') {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendVoice`
  const form = new FormData()
  form.append('chat_id', Number(TELEGRAM_CHAT_ID))
  form.append('voice', fs.createReadStream(filePath))
  if (caption) form.append('caption', caption)
  await axios.post(url, form, { headers: form.getHeaders() })
}

/* ================== TTS (OGG/Opus) ================== */
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

/* ================== POLA ================== */
const part1 = /Selamat datang di akun Whatsapp Resmi HYDROPLUS/i
const part2 = /Yuk coba lagi dengan kode unik yang lain di dalam tutup botol HYDROPLUS untuk dapatkan hadiahnya/i
const part3 = /Terima kasih telah berpartisipasi dalam program HYDROPLUS Nonstop Miliaran🤗[\s\S]*Ketik "Hi" untuk memulai chatting kembali/i

function norm(s = '') {
  return String(s).toLowerCase().replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n+/g, '\n').trim()
}
const TRIGGERS = {
  askCode: [
    'silakan tuliskan kode unik yang ada di balik tutup botol hydroplus',
    'pastikan kode unik berjumlah 9 karakter'
  ],
  askImg1: [
    'mohon kirimkan bukti foto kode unik di balik tutup botol hydroplus',
    'pastikan kode unik pada foto terbaca dengan jelas'
  ],
  askImg2: [
    'untuk verifikasi lebih lanjut mohon kirimkan foto ktp kamu',
    'pastikan foto ktp kamu terbaca dengan jelas'
  ],
  doneMsg: [
    'terima kasih, ktp dan kode unik kamu berhasil diproses',
    'mohon kesediaannya menunggu konfirmasi dalam waktu 3x24 jam'
  ]
}
function matchAny(text, patterns) {
  const t = norm(text)
  return patterns.some(p => t.includes(norm(p)))
}
function isAskCode(text) {
  const t = norm(text)
  if (!/kode\s*unik/.test(t)) return false
  if (/(foto|ktp)/.test(t)) return false
  const hints = [
    /silakan|tolong|harap|mohon|kirim|tuliskan|masukkan/,
    /9\s*karakter|sembilan\s*karakter|9karakter/,
    /huruf\s*kapital/,
    /contoh:\s*[a-z0-9]{1,3}\s*[a-z0-9]{6,}/i
  ]
  return hints.some((re) => re.test(t))
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
  return /terima\s*kasih/.test(t) && /berhasil/.test(t) && /3x24\s*jam/.test(t)
}

/* 👉 NEW: deteksi pesan konfirmasi "kode unik valid" agar TIDAK kirim kode lagi */
function isCodeValidNotice(text = '') {
  const t = norm(text)
  return /kode\s*unik/.test(t) && /valid/.test(t)
}

/* ====== 6 PESAN HYDRO (yang mem-Pause "Hi") ====== */
const HYDRO_FLOW_PATTERNS = [
  /promo[\s\S]*hydroplus[\s\S]*nonstop[\s\S]*miliaran[\s\S]*unggah[\s\S]*kode[\s\S]*unik|syarat\s+dan\s+ketentuan/i,
  /silakan[\s\S]*kode\s*unik[\s\S]*contoh[\s\S]*f\d{3}[a-z0-9]{5}[\s\S]*9\s*karakter[\s\S]*huruf\s*kapital/i,
  /kode\s*unik[\s\S]*valid/i,
  /bukti\s*foto[\s\S]*kode\s*unik[\s\S]*terbaca[\s\S]*(sama|sesuai)[\s\S]*simpan\s*tutup\s*botol/i,
  /verifikasi[\s\S]*foto\s*ktp[\s\S]*terbaca/i,
  /terima\s*kasih[\s\S]*ktp[\s\S]*kode\s*unik[\s\S]*berhasil[\s\S]*3x24\s*jam/i
]
function isHydroFlow(text = '') {
  const t = norm(text)
  return HYDRO_FLOW_PATTERNS.some(re => re.test(t))
}

/* ================== TELEGRAM RATE LIMIT ================== */
const triggerCountMap = new Map()
const RESET_MS = 5 * 60 * 1000
setInterval(() => {
  const now = Date.now()
  for (const [text, info] of triggerCountMap.entries()) {
    if (now - info.lastSeen > RESET_MS) triggerCountMap.delete(text)
  }
}, 60_000)

/* ================== SMS ALARM (auto-disable) ================== */
const MAX_ALARM_SMS = 3
const SMS_COOLDOWN_MS = 5 * 60 * 1000
let alarmSmsState = { count: 0, lastSent: 0, isTriggered: false }
let alarmDisabled = false

setInterval(async () => {
  if (alarmDisabled) return
  if (!alarmSmsState.isTriggered) return

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !TWILIO_RECIPIENT_NUM) {
    log('⚠️ Twilio belum lengkap, menonaktifkan alarm SMS.')
    alarmDisabled = true
    alarmSmsState.isTriggered = false
    return
  }

  const now = Date.now()
  if (alarmSmsState.count < MAX_ALARM_SMS && (now - alarmSmsState.lastSent) > SMS_COOLDOWN_MS) {
    try {
      const twClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
      await twClient.messages.create({
        body: `‼️ ALARM: Ada pesan tidak terduga dari ${WA_SOURCE}.`,
        to: TWILIO_RECIPIENT_NUM,
        from: TWILIO_PHONE_NUMBER,
      })
      alarmSmsState.count += 1
      alarmSmsState.lastSent = now
      log(`✉️ SMS alarm terkirim (${alarmSmsState.count}/${MAX_ALARM_SMS})`)
    } catch (e) {
      const msg = e?.message || String(e)
      log('❌ Gagal kirim SMS alarm:', msg)
      if (/auth/i.test(msg) || /invalid/i.test(msg) || /unauthori[sz]ed/i.test(msg)) {
        alarmDisabled = true
        alarmSmsState.isTriggered = false
        log('⛔ Alarm SMS dinonaktifkan karena kredensial Twilio error.')
      }
    }
  } else if (alarmSmsState.count >= MAX_ALARM_SMS) {
    alarmSmsState.isTriggered = false
    log('⚠️ Batas SMS tercapai, alarm dimatikan.')
  }
}, 10_000)

/* ================== HI CONTROL ================== */
let quietUntil = 0
let lastHiAt   = 0
function suppressHi(reason) {
  quietUntil = Date.now() + HI_QUIET_MS
  log(`⏸️ Pause "Hi" karena: ${reason}. Sampai ${new Date(quietUntil).toLocaleTimeString()}.`)
}
function canSendHi() {
  const now = Date.now()
  const quietOver   = now >= quietUntil
  const intervalDue = now - lastHiAt >= HI_INTERVAL_MS
  return quietOver && intervalDue
}

/* ================== HI LOOP ke TARGET ================== */
let hiLoopController = { running: false }
async function hiLoop(sock) {
  if (hiLoopController.running) return
  hiLoopController.running = true
  log('▶️ Mulai loop kirim "Hi" (tiap 1 menit saat tidak dipause)')
  while (sock?.user) {
    try {
      if (canSendHi()) {
        await sock.sendMessage(TARGET_JID, { text: 'Hi' })
        lastHiAt = Date.now()
        log(`✅ "Hi" terkirim ke ${WA_TARGET}`)
      }
    } catch (e) {
      log('❌ Gagal kirim "Hi":', e?.message || e)
    }
    await delay(5_000)
  }
  hiLoopController.running = false
}

/* ================== MAIN ================== */
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(DATA_DIR, 'auth_info'))
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'error' }) // redam warning Baileys
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
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        && lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
      log('❌ Koneksi tertutup. Reconnect:', shouldReconnect)
      if (shouldReconnect) {
        await delay(5_000)
        startBot().catch(e => log('Gagal restart:', e))
      } else {
        log('⚠️ Logout permanen.')
      }
    }
  })

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    const msg = messages[0]
    if (!msg?.message) return

    const fromJid = msg.key.remoteJid
    const text = extractTextFromMessage(msg).trim()
    const ts = msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000).toISOString() : new Date().toISOString()

    /* ===== SOURCE_JID ===== */
    if (fromJid === SOURCE_JID && text) {
      if (isHydroFlow(text)) suppressHi('HYDRO flow (SOURCE)')

      // 1) selesai
      if (isDoneFlow(text) || matchAny(text, TRIGGERS.doneMsg)) {
        log('🎉 Bot telah Sukses (pesan selesai dari SOURCE).')
        return
      }

      // 2) foto kode unik → IMG1
      if (isAskImgCode(text) || matchAny(text, TRIGGERS.askImg1)) {
        try {
          await sendImage(sock, SOURCE_JID, IMG1_PATH)
          log('📤 [SOURCE] Kirim gambar1 (bukti foto kode unik).')
        } catch (e) {
          log('⚠️ [SOURCE] Gagal kirim gambar1:', e?.message || e)
          await sock.sendMessage(SOURCE_JID, { text: 'Maaf, file gambar1 tidak ditemukan/ tidak bisa dikirim.' })
        }
        return
      }

      // 3) foto KTP → IMG2
      if (isAskKTP(text) || matchAny(text, TRIGGERS.askImg2)) {
        try {
          await sendImage(sock, SOURCE_JID, IMG2_PATH)
          log('📤 [SOURCE] Kirim gambar2 (foto KTP).')
        } catch (e) {
          log('⚠️ [SOURCE] Gagal kirim gambar2:', e?.message || e)
          await sock.sendMessage(SOURCE_JID, { text: 'Maaf, file gambar2 tidak ditemukan/ tidak bisa dikirim.' })
        }
        return
      }

      // 4) minta kode unik → INIT_CODE (dengan guard "kode unik valid")
      if (isAskCode(text) || matchAny(text, TRIGGERS.askCode)) {
        if (isCodeValidNotice(text)) {
          log('ℹ️ [SOURCE] Konfirmasi "kode unik valid" terdeteksi → tidak kirim kode lagi.')
          return
        }
        try {
          await sock.sendMessage(SOURCE_JID, { text: INIT_CODE || '(kode belum di-set)' })
          log('📤 [SOURCE] Diminta kode unik → mengirim kode.')
        } catch (e) {
          log('⚠️ [SOURCE] Gagal kirim kode:', e?.message || e)
        }
        return
      }

      // trigger tak standar → forward owner/telegram
      const has1 = part1.test(text), has2 = part2.test(text), has3 = part3.test(text)
      if (!has1 && !has2 && !has3) {
        saveLastTrigger(text)
        alarmSmsState.isTriggered = true

        if (HAS_FFMPEG) {
          try {
            const tmpOggWA = path.join(DATA_DIR, 'bot_on_owner.ogg')
            await createVoiceNoteOgg('Bot sudah on!', tmpOggWA)
            const audioBuf = fs.readFileSync(tmpOggWA)
            await sock.sendMessage(OWNER_JID, { audio: audioBuf, ptt: true })
            fs.unlinkSync(tmpOggWA)
            log('🎙️ Voice note dikirim ke owner.')
          } catch {
            await sock.sendMessage(OWNER_JID, { text: 'BOT SUDAH ON!' })
            log('ℹ️ Voice gagal, fallback teks ke owner.')
          }
        } else {
          await sock.sendMessage(OWNER_JID, { text: 'BOT SUDAH ON!' })
          log('ℹ️ FFmpeg tidak tersedia, kirim teks ke owner.')
        }

        await sock.sendMessage(OWNER_JID, { text: `📣 [TRIGGER dari ${WA_SOURCE}]\n${text}` })
        log('➡️ Forward TRIGGER ke owner.')

        const now = Date.now()
        const entry = triggerCountMap.get(text) || { count: 0, lastSeen: now }
        entry.lastSeen = now
        if (entry.count < 2) {
          try {
            await tgSendMessage('BOT SUDAH ON!')
            await tgSendMessage(`📣 [TRIGGER] ${text}`)
            if (HAS_FFMPEG) {
              const tmpOggTG = path.join(DATA_DIR, 'bot_on_tg.ogg')
              await createVoiceNoteOgg('Bot sudah on!', tmpOggTG)
              await tgSendVoice(tmpOggTG, 'BOT SUDAH ON!')
              fs.unlinkSync(tmpOggTG)
              log('🎙️ Voice + teks dikirim ke Telegram.')
            } else {
              log('ℹ️ FFmpeg tidak tersedia, kirim teks Telegram saja.')
            }
          } catch (e) {
            log('⚠️ Gagal kirim ke Telegram:', e?.message || e)
          }
          entry.count += 1
          triggerCountMap.set(text, entry)
        } else {
          log('ℹ️ Trigger yg sama sudah dikirim 2x ke Telegram (skip).')
        }
      } else {
        log('… Pesan standar dari SOURCE, diabaikan (tidak di-forward).')
      }
      return
    }

    /* ===== TARGET_JID ===== */
    if (fromJid === TARGET_JID) {
      console.log(`📩 [${ts}] Pesan dari target (${WA_TARGET}):\n${text || '(non-teks)'}`)

      if (text && isHydroFlow(text)) suppressHi('HYDRO flow (TARGET)')

      // 1) selesai
      if (text && (isDoneFlow(text) || matchAny(text, TRIGGERS.doneMsg))) {
        try { await sock.sendMessage(TARGET_JID, { react: { text: '✅', key: msg.key } }) } catch {}
        log('🎉 Bot telah Sukses')
        return
      }

      // 2) foto kode unik → IMG1
      if (text && (isAskImgCode(text) || matchAny(text, TRIGGERS.askImg1))) {
        try {
          await sendImage(sock, TARGET_JID, IMG1_PATH)
          log('📤 Kirim gambar1 (bukti foto kode unik).')
        } catch (e) {
          log('⚠️ Gagal kirim gambar1:', e?.message || e)
          await sock.sendMessage(TARGET_JID, { text: 'Maaf, file gambar1 tidak ditemukan/ tidak bisa dikirim.' })
        }
        return
      }

      // 3) foto KTP → IMG2
      if (text && (isAskKTP(text) || matchAny(text, TRIGGERS.askImg2))) {
        try {
          await sendImage(sock, TARGET_JID, IMG2_PATH)
          log('📤 Kirim gambar2 (foto KTP).')
        } catch (e) {
          log('⚠️ Gagal kirim gambar2:', e?.message || e)
          await sock.sendMessage(TARGET_JID, { text: 'Maaf, file gambar2 tidak ditemukan/ tidak bisa dikirim.' })
        }
        return
      }

      // 4) kode unik → INIT_CODE (dengan guard "kode unik valid")
      if (text && (isAskCode(text) || matchAny(text, TRIGGERS.askCode))) {
        if (isCodeValidNotice(text)) {
          log('ℹ️ [TARGET] Konfirmasi "kode unik valid" terdeteksi → tidak kirim kode lagi.')
          return
        }
        try {
          await sock.sendMessage(TARGET_JID, { text: INIT_CODE || '(kode belum di-set)' })
          log('📤 [TARGET] Diminta kode unik → mengirim kode.')
        } catch (e) {
          log('⚠️ [TARGET] Gagal kirim kode:', e?.message || e)
        }
        return
      }

      log('… Pesan lain dari target, menunggu yang sesuai trigger.')
      return
    }
  })

  // graceful shutdown
  const clean = () => { log('🛑 Shutdown…'); process.exit(0) }
  process.on('SIGINT', clean)
  process.on('SIGTERM', clean)
  process.on('unhandledRejection', (r) => log('🔥 UnhandledRejection:', r))
  process.on('uncaughtException', (e) => log('🔥 UncaughtException:', e))
}

startBot().catch(e => log('❌ Fatal error:', e))
