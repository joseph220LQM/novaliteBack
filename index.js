// index.js — MOZART: Transcribe (WS) + Bedrock Agent + Polly (barge-in)

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
import { Readable } from "stream";
import { randomUUID } from "node:crypto";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

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

// Bedrock Agent (ya creado en us-east-1)
const agentClient = new BedrockAgentRuntimeClient({
  region: process.env.AGENT_REGION || AWS_REGION, // puedes dejar vacío si el agente está en us-east-1
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// =================== HELPERS ===================
async function askBedrockAgent(inputText, sessionId) {
  const cmd = new InvokeAgentCommand({
    agentId: process.env.AGENT_ID,           // e.g. BBI4ILFEQR
    agentAliasId: process.env.AGENT_ALIAS_ID, // e.g. alias de Test
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

// Transcribe: convierte mensajes binarios del WS en stream legible
function createAudioStream(ws) {
  const audioStream = new Readable({ read() {} });

  ws.on("message", (msg) => {
    if (Buffer.isBuffer(msg)) audioStream.push(msg);
  });

  ws.on("close", () => audioStream.push(null));
  return audioStream;
}

// =================== WEBSOCKET (STT -> AGENTE) ===================
wss.on("connection", async (ws) => {
  console.log("✅ Cliente conectado");
  ws.sessionId = randomUUID(); // sesión estable por conexión

  try {
    const audioStream = createAudioStream(ws);

    const cmd = new StartStreamTranscriptionCommand({
      LanguageCode: "es-US",
      MediaSampleRateHertz: 44100,
      MediaEncoding: "pcm",
      AudioStream: (async function* () {
        for await (const chunk of audioStream) {
          yield { AudioEvent: { AudioChunk: chunk } };
        }
      })(),
    });

    const response = await transcribeClient.send(cmd);

    for await (const event of response.TranscriptResultStream) {
      if (!event.TranscriptEvent) continue;
      const results = event.TranscriptEvent.Transcript.Results;
      for (const result of results) {
        if (result.Alternatives.length === 0) continue;

        const transcript = result.Alternatives[0].Transcript;
        ws.send(JSON.stringify({ transcript, isPartial: result.IsPartial }));

        // Solo mensajes finales al agente
        if (!result.IsPartial && transcript.trim()) {
          const reply = await askBedrockAgent(transcript, ws.sessionId);
          ws.send(JSON.stringify({ bedrockReply: reply }));
        }
      }
    }
  } catch (err) {
    console.error("❌ Error en Transcribe:", err);
    try { ws.close(); } catch {}
  }
});

// =================== REST: CHAT TEXTO -> AGENTE ===================
app.post("/chat", async (req, res) => {
  const { prompt, sessionId } = req.body || {};
  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ reply: "❌ Falta el prompt" });
  }

  try {
    const sid = sessionId || randomUUID();
    const reply = await askBedrockAgent(prompt, sid);
    return res.json({ reply, sessionId: sid });
  } catch (error) {
    console.error("❌ Error con Bedrock Agent:", error);
    return res.status(500).json({ reply: "❌ Error al invocar el Agente" });
  }
});

// =================== TTS con barge-in (Polly) ===================
// Mapa de sesiones por clientId para abortar el audio anterior
const ttsSessions = new Map(); // clientId -> { controller }

function beginTtsSession(clientId) {
  const prev = ttsSessions.get(clientId);
  if (prev?.controller) {
    try { prev.controller.abort(); } catch {}
  }
  const controller = new AbortController();
  ttsSessions.set(clientId, { controller });
  return controller;
}

function endTtsSession(clientId, controller) {
  const cur = ttsSessions.get(clientId)?.controller;
  if (cur === controller) ttsSessions.delete(clientId);
}

// Genera audio y corta el anterior si existe (barge-in)
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
      VoiceId: "Mia",       
      Engine: "neural",
      LanguageCode: "es-MX",
    });

    const pollyRes = await pollyClient.send(command, {
      abortSignal: controller.signal,
    });

    res.setHeader("Content-Type", "audio/mpeg");

    pollyRes.AudioStream.on("error", (err) => {
      if (controller.signal.aborted) {
        try { res.end(); } catch {}
        return;
      }
      console.error("❌ Polly stream error:", err);
      if (!res.headersSent) res.status(500);
      try { res.end(); } catch {}
    });

    pollyRes.AudioStream.on("end", () => endTtsSession(clientId, controller));
    pollyRes.AudioStream.on("close", () => endTtsSession(clientId, controller));

    pollyRes.AudioStream.pipe(res);
  } catch (err) {
    if (err?.name === "AbortError") {
      try { res.end(); } catch {}
      return;
    }
    console.error("❌ Error Polly:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "Error en Polly" });
    }
  }
});

// Cortar audio actual sin iniciar otro
app.post("/speak/stop", (req, res) => {
  const clientId = req.query.clientId || req.header("x-client-id");
  if (!clientId) return res.status(400).json({ error: "Falta clientId" });
  const prev = ttsSessions.get(clientId);
  if (prev?.controller) {
    try { prev.controller.abort(); } catch {}
  }
  return res.json({ ok: true });
});

// =================== START ===================
server.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});

