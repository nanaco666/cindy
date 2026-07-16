#!/usr/bin/env node

import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 3345;
const DEFAULT_TRANSCRIPT = 'mock realtime voice draft';
const DEFAULT_REFINED_TEXT = 'mock refined voice draft';

const options = parseArgs(process.argv.slice(2));
const host = options.host ?? process.env.XDT_MOBILE_E2E_VOICE_PROXY_HOST ?? DEFAULT_HOST;
const port = parsePort(options.port ?? process.env.XDT_MOBILE_E2E_VOICE_PROXY_PORT, DEFAULT_PORT);
const transcript = options.transcript ?? process.env.XDT_MOBILE_E2E_VOICE_TRANSCRIPT ?? DEFAULT_TRANSCRIPT;
const refinedText = options.refinedText ?? process.env.XDT_MOBILE_E2E_VOICE_REFINED_TEXT ?? DEFAULT_REFINED_TEXT;
const debug = process.env.XDT_MOBILE_E2E_DEBUG === '1';

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/health') {
    writeJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    void handleChatCompletion(req, res);
    return;
  }
  writeJson(res, 404, { error: 'not_found' });
});

const realtime = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (
    url.pathname !== '/openai/passthrough/v1/realtime'
    && url.pathname !== '/dashscope/api-ws/v1/realtime'
  ) {
    socket.destroy();
    return;
  }
  realtime.handleUpgrade(req, socket, head, (ws) => {
    realtime.emit('connection', ws, req);
  });
});

realtime.on('connection', (ws) => {
  let partialSent = false;
  let completed = false;
  const itemId = `mock-voice-${Date.now()}`;

  const send = (payload) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(payload));
  };

  const sendPartial = () => {
    if (partialSent || completed) return;
    partialSent = true;
    send({
      type: 'conversation.item.input_audio_transcription.delta',
      item_id: itemId,
      delta: transcript,
    });
  };

  const sendCompleted = () => {
    if (completed) return;
    completed = true;
    send({
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: itemId,
      transcript,
    });
  };

  ws.on('message', (raw) => {
    const event = parseJson(raw);
    if (!event || typeof event.type !== 'string') return;
    if (debug) console.error(`[mock-voice-proxy] realtime event type=${event.type}`);
    switch (event.type) {
      case 'session.update':
        send({ type: 'session.updated' });
        setTimeout(sendPartial, 80);
        break;
      case 'input_audio_buffer.commit':
        send({ type: 'input_audio_buffer.committed', item_id: itemId });
        setTimeout(sendCompleted, 40);
        break;
      case 'session.finish':
        sendCompleted();
        send({ type: 'session.finished' });
        break;
    }
  });
});

server.listen(port, host, () => {
  console.log(`mock-voice-proxy ready http://localhost:${port}`);
});

async function handleChatCompletion(req, res) {
  try {
    await readRequestBody(req);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    for (const chunk of splitRefinedJson(refinedText)) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`);
      await sleep(40);
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    writeJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
}

function splitRefinedJson(text) {
  const json = JSON.stringify({ text });
  const firstSplit = Math.max(1, Math.min(json.length - 1, Math.floor(json.length / 2)));
  return [json.slice(0, firstSplit), json.slice(firstSplit)];
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 1_000_000) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', resolve);
    req.on('error', reject);
  });
}

function writeJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function parseJson(raw) {
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parsePort(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return parsed;
}

function parseArgs(args) {
  const parsed = {
    host: undefined,
    port: undefined,
    refinedText: undefined,
    transcript: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--host') {
      parsed.host = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--port') {
      parsed.port = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--transcript') {
      parsed.transcript = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--refined-text') {
      parsed.refinedText = readValue(args, index, arg);
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return parsed;
}

function readValue(args, index, flag) {
  const value = args[index + 1];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}
