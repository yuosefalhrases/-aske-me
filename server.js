import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import JSZip from "jszip";
import mammoth from "mammoth";
import { createRequire } from "module";
import { GoogleGenerativeAI } from "@google/generative-ai";

// 1. معالجة توافقية مكتبة pdf-parse في نظام ES Modules
const require = createRequire(import.meta.url);
const pdf = require("pdf-parse");

const app = express();

// إعداد التخزين المؤقت وحجم الملفات
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB Max
});

const PORT = process.env.PORT || 3000;
app.use(express.static("."));
app.use(express.json());

// 2. استخراج النصوص من ملفات PPTX
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

// 3. محرك استخراج النصوص الموحد
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

// 4. Schema المحددة والمضمونة للإرجاع
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

// 5. محرك التنفيذ المحمي المتقدم (Robust API Engine with Resilience)
async function executeGeminiWithFallback(ai, prompt, initialModel = "gemini-3.6-flash") {
  // ترتيب نماذج البدائل الرسمية والنشطة بحسب الكفاءة والتوفر
  const fallbackModels = [
    initialModel,
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.0-flash"
  ];

  let lastError = null;

  for (const modelName of fallbackModels) {
    console.log(`[AI Engine] Attempting request with model: ${modelName}`);
    
    const model = ai.getGenerativeModel({
      model: modelName,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: quizResponseSchema,
      },
    });

    // تنفيذ إعادة المحاولة مع Exponential Backoff & Jitter لكل نموذج
    const maxRetries = 3;
    let baseDelay = 1500;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const result = await model.generateContent(prompt);
        console.log(`[AI Engine] Successfully generated content using: ${modelName}`);
        return result;
      } catch (error) {
        lastError = error;
        const status = error.status || (error.message && error.message.match(/\[(\d{3})\b/)?.[1]);
        const isTransientError = status === "503" || status === "429" || (error.message && error.message.includes("503"));

        if (isTransientError && attempt < maxRetries) {
          // إضافة عشوائية (Jitter) للوقت لتجنب حدوث الضغط الجماعي بنفس اللحظة
          const jitter = Math.random() * 500;
          const delay = baseDelay * Math.pow(2, attempt - 1) + jitter;
          console.warn(`[AI Engine] Model ${modelName} busy (${status || '503'}). Retrying in ${Math.round(delay)}ms (Attempt ${attempt}/${maxRetries})...`);
          await new Promise((res) => setTimeout(res, delay));
        } else {
          console.warn(`[AI Engine] Model ${modelName} failed on attempt ${attempt}. Switching model if available...`);
          break; // الانتقال للنموذج التالي في القائمة عند الفشل المتكرر أو الأخطاء غير المؤقتة
        }
      }
    }
  }

  throw new Error(`فشلت جميع المحاولات والنماذج البديلة. الخطأ الأخير: ${lastError?.message || "Service Unavailable"}`);
}

// 6. دالة تحليل واستخراج الـ JSON الآمن
function safeParseJSON(rawText) {
  try {
    let cleaned = rawText.trim();
    if (cleaned.startsWith("```json")) {
      cleaned = cleaned.replace(/^```json\s*/, "").replace(/\s*```$/, "");
    } else if (cleaned.startsWith("```")) {
      cleaned = cleaned.replace(/^```\s*/, "").replace(/\s*```$/, "");
    }
    return JSON.parse(cleaned);
  } catch (err) {
    console.error("[JSON Parser Error] Raw text was:", rawText);
    throw new Error("فشل تحويل استجابة الذكاء الاصطناعي إلى JSON. يرجى إعادة المحاولة.");
  }
}

// 7. الـ API Endpoint الرئيسي
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

    // استخراج النص وتحديد سقف الحجم
    const extractedContent = await extractTextFromFile(req.file);
    const material = extractedContent.slice(0, 180000);

    if (material.trim().length < 100) {
      return res.status(400).json({ error: "الملف المرفوع لا يحتوي على نص كافٍ للتحليل." });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "مفتاح GEMINI_API_KEY غير مضاف في إعدادات البيئة (Render Environment Variables)." });
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

    // استدعاء المحرك المحمي
    const apiResponse = await executeGeminiWithFallback(ai, prompt, "gemini-3.6-flash");
    const jsonOutput = safeParseJSON(apiResponse.response.text());

    return res.json(jsonOutput);

  } catch (error) {
    console.error("[Quiz Route Error]:", error);
    return res.status(500).json({
      error: error.message || "حدث خطأ غير متوقع أثناء إنشاء الاختبار.",
    });
  } finally {
    // التنظيف الفوري للملفات المرفوعة لمنع امتلاء القرص في Render
    if (uploadedFilePath) {
      fs.promises.unlink(uploadedFilePath).catch((err) => {
        console.error("فشل حذف الملف المؤقت:", err);
      });
    }
  }
});

// Health check endpoint لـ Render
app.get("/api/health", (req, res) => res.json({ status: "healthy", timestamp: new Date() }));

// تشغيل السيرفر
app.listen(PORT, () => {
  console.log(`=================================`);
  console.log(`Server is running on port ${PORT}`);
  console.log(`=================================`);
});
