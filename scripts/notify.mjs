// Telegram 發訊（單一來源）
//
// 三支腳本都要發訊——雲端備援接手（cloud-fallback.mjs）、心跳告警（heartbeat-alert.mjs）、
// 發布自我檢查（publish.mjs）——所以只寫一次，避免三份各自漂移。
//
// ⚠️ 憑證一律走環境變數：這些腳本會同步進**公開** repo，不寫死收訊對象。
//    沒有 token／chat id 時回 { skipped: true }，呼叫端自己決定要不要只印不送。
const TG = 'https://api.telegram.org';

export function telegramConfigured() {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

/** 送出訊息；永遠不丟例外（發訊失敗不該讓主流程掛掉） */
export async function sendTelegram(text, opts = {}) {
  const token = opts.token || process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId = opts.chatId || process.env.TELEGRAM_CHAT_ID || '';
  if (opts.dryRun) return { ok: false, skipped: true, error: 'dry-run' };
  if (!token || !chatId) return { ok: false, skipped: true, error: 'no-token-or-chat-id' };
  try {
    const r = await fetch(`${TG}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text).slice(0, 3800),
        disable_web_page_preview: true,
      }),
    });
    const j = await r.json();
    return j.ok ? { ok: true, messageId: j.result?.message_id } : { ok: false, error: j.description };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 給 CLI 用的一行式回報 */
export function reportSend(log, res) {
  if (res.skipped) log(res.error === 'dry-run' ? '--dry-run：不送。' : '⚠️ 沒有 TELEGRAM_BOT_TOKEN／TELEGRAM_CHAT_ID → 只印不送。');
  else if (res.ok) log(`✅ Telegram 已送出（message_id ${res.messageId}）`);
  else log(`❌ Telegram 失敗：${res.error}`);
}
