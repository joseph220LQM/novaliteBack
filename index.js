// index.js — MOZART: Transcribe (WS) + Bedrock Agent (voz/chat) + Polly (barge-in)

import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import cors from "cors";
import {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
} from "@aws-sdk/client-transcribe-streaming";
import {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
} from "@aws-sdk/client-bedrock-agent-runtime";
import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());
app.get("/health", (req, res) => res.status(200).json({ ok: true, time: new Date().toISOString() }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 4000;

// =================== AWS CLIENTS ===================
const AWS_REGION = process.env.AWS_REGION || "us-east-1";

const transcribeClient = new TranscribeStreamingClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const pollyClient = new PollyClient({
  region: AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// Bedrock Agent
const agentClient = new BedrockAgentRuntimeClient({
  region: process.env.AGENT_REGION || AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// =================== HELPERS ===================
async function askBedrockAgent(inputText, sessionId, mode = "text") {
  const agentId =
    mode === "voice"
      ? process.env.AGENT_ID_VOICE
      : process.env.AGENT_ID_TEXT;
  const agentAliasId =
    mode === "voice"
      ? process.env.AGENT_ALIAS_ID_VOICE
      : process.env.AGENT_ALIAS_ID_TEXT;

  const cmd = new InvokeAgentCommand({
    agentId,
    agentAliasId,
    sessionId,
    inputText,
  });

  const resp = await agentClient.send(cmd);
  const dec = new TextDecoder();
  let text = "";
  for await (const ev of resp.completion) {
    if (ev.chunk?.bytes) text += dec.decode(ev.chunk.bytes);
  }
  return text || "⚠️ El agente no devolvió contenido.";
}

// --- Audio: parámetros seguros para Transcribe
const TR_LANG = process.env.TR_LANG || "es-US";
const DST_RATE = 16000; // Transcribe estable a 16 kHz
const BYTES_PER_SAMPLE = 2;
const FRAME_MS = Number(process.env.TR_FRAME_MS || 20);
const FRAME_BYTES = (DST_RATE * BYTES_PER_SAMPLE * FRAME_MS) / 1000;

const FRONT_SR = Number(process.env.FRONT_SR || 44100);

// -------- util: resample Int16 srcRate -> 16k
function resampleInt16(int16Src, srcRate = 44100, dstRate = DST_RATE) {
  if (srcRate === dstRate) return int16Src;
  const ratio = srcRate / dstRate;
  const dstLen = Math.floor(int16Src.length / ratio);
  const out = new Int16Array(dstLen);
  for (let i = 0; i < dstLen; i++) {
    const idx = i * ratio;
    const i0 = Math.floor(idx);
    const i1 = Math.min(i0 + 1, int16Src.length - 1);
    const frac = idx - i0;
    const s = int16Src[i0] * (1 - frac) + int16Src[i1] * frac;
    out[i] = s | 0;
  }
  return out;
}

// -------- generador asincrónico: agrupa en frames
function makeAudioStreamGenerator() {
  let buffer = Buffer.alloc(0);
  let alive = true;

  let notify = null;
  const wait = () => new Promise((r) => (notify = r));

  return {
    push({ chunk, sampleRate = FRONT_SR }) {
      if (chunk.length % 2 === 1) chunk = chunk.subarray(0, chunk.length - 1);
      const int16 = new Int16Array(
        chunk.buffer,
        chunk.byteOffset,
        chunk.byteLength / 2
      );
      const resampled = resampleInt16(int16, sampleRate, DST_RATE);
      const b = Buffer.from(
        resampled.buffer,
        resampled.byteOffset,
        resampled.byteLength
      );
      buffer = Buffer.concat([buffer, b]);
      if (notify) {
        const n = notify;
        notify = null;
        n();
      }
    },
    stop() {
      alive = false;
      if (notify) {
        notify();
      }
    },

    async *iterator() {
      while (alive) {
        while (buffer.length >= FRAME_BYTES) {
          const frame = buffer.subarray(0, FRAME_BYTES);
          buffer = buffer.subarray(FRAME_BYTES);
          yield { AudioEvent: { AudioChunk: frame } };
        }
        if (alive && buffer.length < FRAME_BYTES) await wait();
      }
    },
  };
}

// =================== WEBSOCKET (STT -> AGENTE VOZ) ===================
wss.on("connection", async (ws) => {
  console.log("✅ Cliente conectado (voz)");
  ws.sessionId = randomUUID();

  const stream = makeAudioStreamGenerator();

  const cmd = new StartStreamTranscriptionCommand({
    LanguageCode: TR_LANG,
    MediaSampleRateHertz: DST_RATE,
    MediaEncoding: "pcm",
    AudioStream: stream.iterator(),
  });

  let transcribePromise = null;
  try {
    transcribePromise = transcribeClient.send(cmd);
  } catch (err) {
    console.error("❌ Error al iniciar Transcribe:", err);
    try {
      ws.close();
    } catch {}
    return;
  }

  ws.on("message", (data, isBinary) => {
    const buf = isBinary ? data : Buffer.from(data);
    stream.push({ chunk: buf, sampleRate: FRONT_SR });
  });

  ws.on("close", async () => {
    stream.stop();
    try {
      await transcribePromise;
    } catch {}
  });

  (async () => {
    try {
      const response = await transcribePromise;
      for await (const event of response.TranscriptResultStream) {
        if (!event.TranscriptEvent) continue;
        const results = event.TranscriptEvent.Transcript.Results || [];
        for (const result of results) {
          if (result.Alternatives.length === 0) continue;
          const transcript = (result.Alternatives[0].Transcript || "").trim();
          ws.send(JSON.stringify({ transcript, isPartial: !!result.IsPartial }));

          if (!result.IsPartial && transcript) {
            try {
              const reply = await askBedrockAgent(
                transcript,
                ws.sessionId,
                "voice"
              );
              ws.send(JSON.stringify({ bedrockReply: reply }));
            } catch (e) {
              console.error("❌ Error Bedrock Agent voz:", e);
            }
          }
        }
      }
    } catch (err) {
      console.error("❌ Error en Transcribe:", err);
      try {
        ws.send(JSON.stringify({ error: "transcribe_failed" }));
      } catch {}
      try {
        ws.close();
      } catch {}
    }
  })();
});

// =================== REST: CHAT TEXTO -> AGENTE TEXTO ===================
app.post("/chat", async (req, res) => {
  const { prompt, sessionId } = req.body || {};
  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ reply: "❌ Falta el prompt" });
  }
  try {
    const sid = sessionId || randomUUID();
    const reply = await askBedrockAgent(prompt, sid, "text");
    return res.json({ reply, sessionId: sid });
  } catch (error) {
    console.error("❌ Error con Bedrock Agent (texto):", error);
    return res.status(500).json({ reply: "❌ Error al invocar el Agente" });
  }
});

// =================== TTS con barge-in (Polly) ===================
const ttsSessions = new Map();

function beginTtsSession(clientId) {
  const prev = ttsSessions.get(clientId);
  if (prev?.controller) {
    try {
      prev.controller.abort();
    } catch {}
  }
  const controller = new AbortController();
  ttsSessions.set(clientId, { controller });
  return controller;
}

function endTtsSession(clientId, controller) {
  const cur = ttsSessions.get(clientId)?.controller;
  if (cur === controller) ttsSessions.delete(clientId);
}

app.post("/speak", async (req, res) => {
  try {
    const clientId = req.query.clientId || req.header("x-client-id");
    if (!clientId) {
      return res
        .status(400)
        .json({ error: "Falta clientId (?clientId= o header x-client-id)" });
    }

    const { text } = req.body || {};
    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Falta texto" });
    }

    const controller = beginTtsSession(clientId);

    const command = new SynthesizeSpeechCommand({
      OutputFormat: "mp3",
      Text: text,
      VoiceId: process.env.POLLY_VOICE_ID || "Mia",
      Engine: "neural",
      LanguageCode: process.env.POLLY_LANG || "es-MX",
    });

    const pollyRes = await pollyClient.send(command, {
      abortSignal: controller.signal,
    });

    res.setHeader("Content-Type", "audio/mpeg");

    pollyRes.AudioStream.on("error", (err) => {
      if (controller.signal.aborted) {
        try {
          res.end();
        } catch {}
        return;
      }
      console.error("❌ Polly stream error:", err);
      if (!res.headersSent) res.status(500);
      try {
        res.end();
      } catch {}
    });

    const end = () => endTtsSession(clientId, controller);
    pollyRes.AudioStream.on("end", end);
    pollyRes.AudioStream.on("close", end);

    pollyRes.AudioStream.pipe(res);
  } catch (err) {
    if (err?.name === "AbortError") {
      try {
        res.end();
      } catch {}
      return;
    }
    console.error("❌ Error Polly:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Error en Polly" });
    }
  }
});

app.post("/speak/stop", (req, res) => {
  const clientId = req.query.clientId || req.header("x-client-id");
  if (!clientId) return res.status(400).json({ error: "Falta clientId" });
  const prev = ttsSessions.get(clientId);
  if (prev?.controller) {
    try {
      prev.controller.abort();
    } catch {}
  }
  return res.json({ ok: true });
});

// =================== START ===================
server.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
