import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import cors from "cors";
import {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
} from "@aws-sdk/client-transcribe-streaming";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import { Readable } from "stream";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 4000;

// === AWS Clients ===
const transcribeClient = new TranscribeStreamingClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const bedrockClient = new BedrockRuntimeClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const pollyClient = new PollyClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

// === Prompt híbrido MOZART ===
const MOZART_PROMPT = `
Eres MOZART, el Cuidador Digital de COMPENSAR EPS.

🔵 Identidad
- Rol: Agente de Presentación Institucional Conversacional.
- Inspiración: Baymax (funcional, protector, empático).
- Tono: Cercano, profesional, comercial y entusiasta. 
- Estilo conversacional: Explica breve → hace una pregunta → espera respuesta → continúa.
- Actitud: Proactiva, enfocada en beneficios y valor (ROI, eficiencia, satisfacción).

🔵 Propuesta de valor
- Aumentar la satisfacción del paciente.
- Liberar tiempo clínico a médicos.
- Reducir costos y aumentar ingresos institucionales.
- Digitalizar rutas de atención de forma simple y rentable.

🔵 Restricciones
- No das diagnósticos ni recomendaciones médicas directas.
- Si te preguntan fuera de tu rol, respondes con cortesía y rediriges:
  Ej. “No fui diseñado para responder eso; mi rol es acompañar actores del sistema de salud”.
`;

// === Few-shots (ejemplos de diálogo) ===
const FEWSHOT_MESSAGES = [
  {
    role: "user",
    content: [{ text: "Hola, ¿quién eres?" }],
  },
  {
    role: "assistant",
    content: [
      {
        text: "Hola, soy MOZART, tu Cuidador Digital. Te acompaño 24/7 en tu ruta de salud. ¿Quieres ver cómo te ayudo a pedir una cita o medicamento?",
      },
    ],
  },
  {
    role: "user",
    content: [{ text: "¿En qué me apoyas antes de mi consulta?" }],
  },
  {
    role: "assistant",
    content: [
      {
        text: "Te preparo un resumen ejecutivo del paciente con triage, alertas y datos clave, reduciendo tu tiempo administrativo en un 40%. ¿Quieres ver un demo?",
      },
    ],
  },
  {
    role: "user",
    content: [{ text: "¿Cómo ayuda MOZART a mi clínica?" }],
  },
  {
    role: "assistant",
    content: [
      {
        text: "Digitalizo tus rutas de atención, reduzco costos en un 25% y aumento la retención de pacientes con procesos automáticos. ¿Quieres conocer un caso real?",
      },
    ],
  },
];

// === Función para invocar Bedrock ===
async function askBedrock(prompt) {
  const command = new ConverseCommand({
    modelId: "us.amazon.nova-lite-v1:0", // puedes cambiar a nova-sonic para latencia baja
    messages: [
      { role: "user", content: [{ text: MOZART_PROMPT }] },
      ...FEWSHOT_MESSAGES,
      { role: "user", content: [{ text: prompt }] },
    ],
    inferenceConfig: {
      maxTokens: 512,
      temperature: 0.7,
      topP: 0.9,
    },
  });

  const response = await bedrockClient.send(command);
  return (
    response.output?.message?.content?.[0]?.text ||
    "⚠️ No hubo respuesta del modelo"
  );
}

// === Transcribe vía WebSocket ===
function createAudioStream(ws) {
  const audioStream = new Readable({ read() {} });

  ws.on("message", (msg) => {
    if (Buffer.isBuffer(msg)) {
      audioStream.push(msg);
    }
  });

  ws.on("close", () => audioStream.push(null));
  return audioStream;
}

wss.on("connection", async (ws) => {
  console.log("✅ Cliente conectado");

  try {
    const audioStream = createAudioStream(ws);

    const command = new StartStreamTranscriptionCommand({
      LanguageCode: "es-US",
      MediaSampleRateHertz: 44100,
      MediaEncoding: "pcm",
      AudioStream: (async function* () {
        for await (const chunk of audioStream) {
          yield { AudioEvent: { AudioChunk: chunk } };
        }
      })(),
    });

    const response = await transcribeClient.send(command);

    for await (const event of response.TranscriptResultStream) {
      if (event.TranscriptEvent) {
        const results = event.TranscriptEvent.Transcript.Results;
        for (const result of results) {
          if (result.Alternatives.length > 0) {
            const transcript = result.Alternatives[0].Transcript;
            ws.send(
              JSON.stringify({ transcript, isPartial: result.IsPartial })
            );

            // 🔥 Solo si es final, mandar a Bedrock
            if (!result.IsPartial) {
              const reply = await askBedrock(transcript);
              ws.send(JSON.stringify({ bedrockReply: reply }));
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("❌ Error en Transcribe:", err);
    ws.close();
  }
});

// === Endpoint REST para texto manual ===
app.post("/chat", async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ reply: "❌ Falta el prompt" });

  try {
    const reply = await askBedrock(prompt);
    res.json({ reply });
  } catch (error) {
    console.error("Error con Bedrock:", error);
    res.json({ reply: "❌ Error al invocar Bedrock" });
  }
});

// === Endpoint TTS con Polly ===
app.post("/speak", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !text.trim()) {
      return res.status(400).json({ error: "Falta texto" });
    }

    const command = new SynthesizeSpeechCommand({
      OutputFormat: "mp3",
      Text: text,
      VoiceId: "Mia",   // voz en español (puedes cambiarla)
      Engine: "neural",   // usa motor Neural para voz más natural
      LanguageCode: "es-MX",
    });

    const response = await pollyClient.send(command);

    res.setHeader("Content-Type", "audio/mpeg");
    response.AudioStream.pipe(res);
  } catch (err) {
    console.error("❌ Error Polly:", err);
    res.status(500).json({ error: "Error en Polly" });
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
});
