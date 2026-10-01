// 單發一則 Telegram 訊息給使用者（例：node tg.mjs "訊息內容"）
// 用途：驗收告警通道、或維護者想主動 ping 他一下。發訊邏輯共用 notify.mjs（單一來源）。
import { sendTelegram } from './notify.mjs';

const text = process.argv.slice(2).join(' ').trim();
if (!text) { console.error('用法: node tg.mjs "訊息內容"'); process.exit(2); }

const res = await sendTelegram(text);
if (res.skipped) { console.error('⚠️ 沒有 TELEGRAM_BOT_TOKEN／TELEGRAM_CHAT_ID → 沒送出去。'); process.exit(1); }
console.log(res.ok ? `✅ 已送出（message_id ${res.messageId}）` : `❌ 送出失敗：${res.error}`);
process.exit(res.ok ? 0 : 1);
