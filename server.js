import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import JSZip from "jszip";
import mammoth from "mammoth";
import { createRequire } from "module";
import { GoogleGenerativeAI } from "@google/generative-ai";

const require = createRequire(import.meta.url);
const pdf = require("pdf-parse");

const app = express();
const upload = multer({ dest: "uploads/", limits: { fileSize: 100 * 1024 * 1024 } });
const port = process.env.PORT || 3000;
app.use(express.static("."));

async function pptxText(filePath) {
  const zip = await JSZip.loadAsync(await fs.promises.readFile(filePath));
  const names = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  let out = [];
  for (const n of names) {
    const xml = await zip.files[n].async("text");
    const t = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]);
    if (t.length) out.push(`[${n}]\n${t.join(" ")}`);
  }
  return out.join("\n");
}

async function extract(file) {
  const ext = path.extname(file.originalname).toLowerCase();

  if (ext === ".pdf") {
    const dataBuffer = await fs.promises.readFile(file.path);
    const r = await pdf(dataBuffer);
    return r.text;
  }

  if (ext === ".docx") {
    const r = await mammoth.extractRawText({ path: file.path });
    return r.value;
  }

  if (ext === ".pptx") return pptxText(file.path);

  throw new Error("This first online build supports PDF, DOCX and PPTX.");
}

const schema = {
  type: "object",
  properties: {
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
          correct_answer: { type: "integer" },
          explanation: { type: "string" },
          difficulty: { type: "string", enum: ["Easy", "Medium", "Hard"] },
          cognitive_level: {
            type: "string",
            enum: ["Recall", "Understanding", "Application", "Integration"],
          },
          topic: { type: "string" },
          source: { type: "string" },
        },
        required: [
          "question",
          "options",
          "correct_answer",
          "explanation",
          "difficulty",
          "cognitive_level",
          "topic",
          "source",
        ],
      },
    },
  },
  required: ["questions"],
};

// دالة المحاولة التلقائية عند وجود ضغط على السيرفر
async function generateWithRetry(model, prompt, retries = 3, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await model.generateContent(prompt);
    } catch (error) {
      const is503 = error.message && error.message.includes("503");
      if (is503 && i < retries - 1) {
        console.log(`Server busy (503). Retrying in ${delay / 1000}s... (Attempt ${i + 1}/${retries})`);
        await new Promise((res) => setTimeout(res, delay));
        delay *= 1.5;
      } else {
        throw error;
      }
    }
  }
}

app.post("/api/generate-quiz", upload.single("file"), async (req, res) => {
  let p;
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded." });
    p = req.file.path;

    const count = Math.min(Math.max(parseInt(req.body.count || "10"), 1), 50);
    const difficulty = ["Easy", "Medium", "Hard"].includes(req.body.difficulty)
      ? req.body.difficulty
      : "Medium";

    const material = (await extract(req.file)).slice(0, 180000);
    if (material.trim().length < 100)
      return res.status(400).json({ error: "Not enough readable text." });

    if (!process.env.GEMINI_API_KEY)
      return res.status(500).json({ error: "Server AI key is not configured." });

    const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    const prompt = `You are the ask me question engine.

SOURCE MATERIAL:
${material}

Generate exactly ${count} MCQs at ${difficulty} difficulty.

SOURCE RULES:
- Use ONLY the source material.
- Do not use outside knowledge.
- Every correct answer must be directly supported by the source.
- Do not invent facts, numbers, mechanisms, examples, or recommendations.

QUESTION QUALITY:
- Prioritize understanding, application, comparison, calculation, mechanism, interpretation, and integration when supported by the source.
- Prefer reasoning over simple keyword recognition when the source allows it.
- Difficulty must come from reasoning and content complexity, never from ambiguity or trick wording.
- Each question must test one clear concept.
- State all necessary numbers, units, time periods, conditions, and assumptions.

OPTIONS:
- Exactly 4 options for every question.
- Exactly ONE best answer.
- Distractors must be plausible and related to the tested concept.
- Avoid "All of the above" and "None of the above".

EXPLANATIONS:
- Give a concise explanation for the correct answer using only source info.

FINAL REQUIREMENTS:
- Return exactly ${count} valid MCQs.`;

    const model = ai.getGenerativeModel({
      model: "gemini-3.6-flash",
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: schema,
      },
    });

    let out;
    try {
      out = await generateWithRetry(model, prompt);
    } catch (err) {
      if (err.message && err.message.includes("503")) {
        console.warn("Flash model overloaded. Falling back to gemini-1.5-pro...");
        // ✅ تم تعديل نموذج البديل إلى gemini-1.5-pro المعتمد
        const fallbackModel = ai.getGenerativeModel({
          model: "gemini-1.5-pro",
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: schema,
          },
        });
        out = await generateWithRetry(fallbackModel, prompt);
      } else {
        throw err;
      }
    }

    const jsonResult = JSON.parse(out.response.text());
    res.json(jsonResult);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || "Generation failed." });
  } finally {
    if (p) fs.promises.unlink(p).catch(() => {});
  }
});

app.get("/api/health", (req, res) => res.json({ ok: true }));
app.listen(port, () => console.log(`aske me running on port ${port}`));
