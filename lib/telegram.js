const TELEGRAM_BASE = 'https://api.telegram.org';

function telegramConfigured(env = process.env) {
  return Boolean(
    String(env.TELEGRAM_BOT_TOKEN || '').trim() &&
    String(env.TELEGRAM_CHAT_ID || '').trim()
  );
}

function numberText(value, digits = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return number.toFixed(digits).replace('.', ',');
}

function formatGoalAlert(alert) {
  const score = Array.isArray(alert.score) ? `${alert.score[0]} × ${alert.score[1]}` : '—';
  const stats = alert.stats || {};
  const lines = [
    `🚨 RADAR JWC PRO · ${alert.label || 'SINAL DE GOL'}`,
    '',
    `${alert.home} ${score} ${alert.away} · ${alert.minute}'`,
    `Sinal ao vivo: ${numberText(alert.signalScore)}/100`,
    `Pressão JWC: ${numberText(alert.pressure)}/100`,
    `Finalizações: ${numberText(stats.shots)} · no alvo: ${numberText(stats.sot)}`
  ];
  if (Number.isFinite(Number(stats.xg))) lines.push(`xG total: ${numberText(stats.xg, 2)}`);
  if (Array.isArray(alert.reasons) && alert.reasons.length) {
    lines.push('', ...alert.reasons.slice(0, 3).map(reason => `• ${reason}`));
  }
  lines.push('', 'Sinal estatístico quase em tempo real. Não é garantia de gol.');
  return lines.join('\n');
}

async function sendTelegramMessage(text, env = process.env, fetchImpl = global.fetch) {
  const token = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = String(env.TELEGRAM_CHAT_ID || '').trim();
  if (!token || !chatId) {
    return { ok: false, status: 'not_configured', error: 'Telegram não configurado.' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetchImpl(`${TELEGRAM_BASE}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text || ''),
        disable_web_page_preview: true
      }),
      signal: controller.signal
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.ok === false) {
      return {
        ok: false,
        status: 'failed',
        error: `Telegram HTTP ${response.status || 502}`
      };
    }
    return {
      ok: true,
      status: 'sent',
      messageId: body.result?.message_id || null
    };
  } catch (error) {
    return {
      ok: false,
      status: 'failed',
      error: error?.name === 'AbortError' ? 'Telegram excedeu o tempo de resposta.' : 'Falha ao enviar Telegram.'
    };
  } finally {
    clearTimeout(timer);
  }
}

async function sendGoalAlert(alert, env = process.env, fetchImpl = global.fetch) {
  return sendTelegramMessage(formatGoalAlert(alert), env, fetchImpl);
}

module.exports = {
  telegramConfigured,
  formatGoalAlert,
  sendTelegramMessage,
  sendGoalAlert
};
