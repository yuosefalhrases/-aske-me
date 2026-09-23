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
const PORT = process.env.PORT || 3000;

// إعداد التخزين المؤقت وحجم الملفات (100 ميجابايت كحد أقصى)
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 100 * 1024 * 1024 },
});

app.use(express.static("."));
app.use(express.json());

// دالة استخراج النصوص من ملفات PPTX
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

// دالة موحدة لاستخراج النصوص بحسب نوع الملف
async function extractTextFromFile(file) {
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

  if (ext === ".pptx") {
    return await pptxText(file.path);
  }

  throw new Error("نوع الملف غير مدعوم. يرجى رفع ملف PDF, DOCX, أو PPTX.");
}

// هيكلية المخرجات المضمونة (JSON Schema)
const quizResponseSchema = {
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

// محرك التنفيذ المحمي المعتمد فقط على النماذج الرسمية النشطة
async function executeGeminiWithFallback(ai, prompt) {
  // استخدام النماذج الرسمية النشطة حالياً
  const activeModels = [
    "gemini-3.6-flash",
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite"
  ];

  let lastError = null;

  for (const modelName of activeModels) {
    console.log(`[AI Engine] Trying active model: ${modelName}`);

    const model = ai.getGenerativeModel({
      model: modelName,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: quizResponseSchema,
      },
    });

    const maxRetries = 3;
    let baseDelay = 2000;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await model.generateContent(prompt);
        console.log(`[AI Engine] Success with model: ${modelName}`);
        return result;
      } catch (error) {
        lastError = error;
        const errMsg = error.message || "";

        // إذا كان النموذج غير موجود (404)، انتقل فوراً للنموذج التالي
        if (errMsg.includes("404") || errMsg.includes("not found")) {
          console.warn(`[AI Engine] Model ${modelName} returned 404 (Not Found). Skipping...`);
          break;
        }

        const is503 = errMsg.includes("503") || errMsg.includes("Service Unavailable") || errMsg.includes("429");

        if (is503 && attempt < maxRetries) {
          const jitter = Math.random() * 500;
          const delay = baseDelay * Math.pow(2, attempt - 1) + jitter;
          console.warn(`[AI Engine] ${modelName} busy (503/429). Retrying in ${Math.round(delay)}ms (Attempt ${attempt}/${maxRetries})...`);
          await new Promise((res) => setTimeout(res, delay));
        } else {
          console.warn(`[AI Engine] Model ${modelName} failed on attempt ${attempt}. Transitioning to next model...`);
          break;
        }
      }
    }
  }

  throw new Error(`تعذر إنشاء الاختبار حالياً بسبب ضغط عالٍ على الخوادم. يرجى إعادة المحاولة بعد ثوانٍ.`);
}

// دالة تنظيف واستخراج JSON آمنة لمنع أخطاء الـ Parsing
function safeParseJSON(rawText) {
  if (!rawText) throw new Error("استجابة الذكاء الاصطناعي فارغة.");
  
  let cleaned = rawText.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  
  const firstOpen = cleaned.indexOf('{');
  const lastClose = cleaned.lastIndexOf('}');
  
  if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
    cleaned = cleaned.substring(firstOpen, lastClose + 1);
  }

  return JSON.parse(cleaned);
}

// الـ API Endpoint الرئيسي
app.post("/api/generate-quiz", upload.single("file"), async (req, res) => {
  let uploadedFilePath = null;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "لم يتم رفع أي ملف." });
    }
    uploadedFilePath = req.file.path;

    const count = Math.min(Math.max(parseInt(req.body.count || "10"), 1), 50);
    const difficulty = ["Easy", "Medium", "Hard"].includes(req.body.difficulty)
      ? req.body.difficulty
      : "Medium";

    const extractedContent = await extractTextFromFile(req.file);
    const material = extractedContent.slice(0, 180000);

    if (material.trim().length < 100) {
      return res.status(400).json({ error: "الملف المرفوع لا يحتوي على نص كافٍ للتحليل." });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "مفتاح GEMINI_API_KEY غير مضاف في إعدادات البيئة (Environment Variables)." });
    }

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
- Return valid JSON matching the requested schema.
- Return exactly ${count} valid MCQs.`;

    const apiResponse = await executeGeminiWithFallback(ai, prompt);
    const jsonOutput = safeParseJSON(apiResponse.response.text());

    return res.json(jsonOutput);

  } catch (error) {
    console.error("[Quiz Route Error]:", error);
    return res.status(500).json({
      error: error.message || "حدث خطأ غير متوقع أثناء إنشاء الاختبار.",
    });
  } finally {
    // حذف الملف المرفوع مؤقتاً لتفادي امتلاء القرص
    if (uploadedFilePath) {
      fs.promises.unlink(uploadedFilePath).catch((err) => {
        console.error("فشل حذف الملف المؤقت:", err);
      });
    }
  }
});

// فحص حالة السيرفر
app.get("/api/health", (req, res) => res.json({ status: "healthy", timestamp: new Date() }));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
