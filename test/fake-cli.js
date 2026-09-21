#!/usr/bin/env node
/*
 * fake-cli.js —— 模仿 WorkBuddy CLI 的 stream-json 协议，用来在没有真实 CLI
 * （或沙箱拦死真实 CLI）的环境里端到端验证 wb-relay 的 HTTP/SSE 全链路。
 *
 * 行为：启动时推 system/init，然后等 stdin 的 user 消息；
 * 收到一条就按协议推一轮：思考（thinking_delta + signature_delta）→ 正文（text_delta）→ result。
 *
 * 提示词里带关键词可以触发特殊模式：
 *   bigthink —— 思考不按字推，一次性给整段（模拟某些上游的 reasoning 推送方式）
 *   snapshot —— 不发任何 stream_event，只发 assistant 快照（模拟没开 --include-partial-messages）
 *   error    —— 返回 is_error 的 result
 */
'use strict';

const sessionId = 'fake-' + Math.random().toString(36).slice(2, 10);
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

send({ type: 'system', subtype: 'init', session_id: sessionId });

let buf = '';
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'user') handleTurn(ev);
  }
});

async function handleTurn(ev) {
  const content = ev.message && ev.message.content;
  const prompt = Array.isArray(content) ? content.map((c) => c.text || '').join('') : String(content || '');

  if (/error/.test(prompt)) {
    await sleep(10);
    send({ type: 'result', is_error: true, result: 'fake 错误：提示词里带了 error', usage: { input_tokens: 3, output_tokens: 0 }, duration_ms: 10, permission_denials: [] });
    return;
  }

  const bigThinking = /bigthink/.test(prompt);
  const snapshotOnly = /snapshot/.test(prompt);
  const partial = process.argv.includes('--include-partial-messages') && !snapshotOnly;

  const thinking = `想一下「${prompt.slice(0, 30)}」：先拆成几步，逐步推理，最后给结论。`;
  // bigthink 模式的思考要足够长（超过匀速器的 burstThreshold=40），才能触发「整段切吐」
  const thinkingBig = thinking + '再补充一大段推理：'.repeat(8) + '完。';
  const signature = 'sig-' + Date.now().toString(36) + '-abcdefgh';
  const answer = `这是对「${prompt.slice(0, 40)}」的回答。`;

  if (partial) {
    send({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } });
    if (bigThinking) {
      // 整段给：一次推完所有思考。真实上游整段推完 reasoning 后，正文生成还要时间，
      // 这里也停一下 —— 否则匀速器刚切第一片，正文就到了，finish() 会把剩下的整段倒出去
      send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: thinkingBig } } });
      await sleep(250);
    } else {
      for (const ch of thinking) {
        send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: ch } } });
        await sleep(2);
      }
    }
    // 签名拆两段推，验证「实时转发 + 累计值算增量」
    const half = Math.ceil(signature.length / 2);
    send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: signature.slice(0, half) } } });
    await sleep(5);
    send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: signature.slice(half) } } });
    send({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });

    send({ type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } });
    for (const ch of answer) {
      send({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: ch } } });
      await sleep(3);
    }
    send({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } });
    // 整条快照：内容与已发的增量一致，relay 应该识别出来不重复发
    send({ type: 'assistant', message: { content: [{ type: 'thinking', thinking, signature }, { type: 'text', text: answer }] } });
  } else {
    // 快照模式：一条 assistant 事件里思考 + 正文一起到
    await sleep(30);
    send({ type: 'assistant', message: { content: [{ type: 'thinking', thinking, signature }, { type: 'text', text: answer }] } });
  }

  await sleep(5);
  send({ type: 'result', is_error: false, result: answer, usage: { input_tokens: 10, output_tokens: 20 }, duration_ms: 50, permission_denials: [] });
}
