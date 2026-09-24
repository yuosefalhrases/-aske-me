import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import JSZip from "jszip";
import mammoth from "mammoth";
import { createRequire } from "module";
import { GoogleGenerativeAI } from "@google/generative-ai";

const require = createRequire(import.meta.url);

// إصلاح استدعاء pdf-parse ليتوافق مع ES Modules وقراءة ملفات الـ PDF بدون أخطاء
const pdfModule = require("pdf-parse");
const pdf = typeof pdfModule === "function" ? pdfModule : pdfModule.default;

const app = express();
const PORT = process.env.PORT || 3000;

// إعداد رفع الملفات (حد أقصى 100 ميجابايت)
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: 100 * 1024 * 1024 },
});

app.use(express.static("."));
app.use(express.json());

// دالة استخراج الصور المدمجة من ملفات Zip (DOCX / PPTX)
async function extractImagesFromZip(filePath) {
  const images = [];
  try {
    const fileBuffer = await fs.promises.readFile(filePath);
    const zip = await JSZip.loadAsync(fileBuffer);
    const mediaFiles = Object.keys(zip.files).filter((fileName) =>
      fileName.startsWith("ppt/media/") || fileName.startsWith("word/media/")
    );

    for (const fileName of mediaFiles.slice(0, 5)) { // قراءة أحدث 5 صور لتفادي التأخير
      const file = zip.files[fileName];
      const imageBuffer = await file.async("nodebuffer");
      const ext = path.extname(fileName).toLowerCase().replace(".", "");
      const mimeType = ext === "png" ? "image/png" : "image/jpeg";

      images.push({
        inlineData: {
          data: imageBuffer.toString("base64"),
          mimeType: mimeType,
        },
      });
    }
  } catch (e) {
    console.warn("[Image Extraction] No images extracted or invalid archive:", e.message);
  }
  return images;
}

// استخراج النص من PPTX
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

// دالة موحدة لاستخراج النصوص والصور من مختلف أنواع الملفات
async function extractContentFromFile(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  let text = "";
  let images = [];

  if (ext === ".pdf") {
    const dataBuffer = await fs.promises.readFile(file.path);
    if (typeof pdf !== "function") {
      throw new Error("مكتبة pdf-parse غير معرفة كـ Function بشكل صحيح.");
    }
    const r = await pdf(dataBuffer);
    text = r.text;
  } else if (ext === ".docx") {
    const r = await mammoth.extractRawText({ path: file.path });
    text = r.value;
    images = await extractImagesFromZip(file.path);
  } else if (ext === ".pptx") {
    text = await pptxText(file.path);
    images = await extractImagesFromZip(file.path);
  } else {
    throw new Error("نوع الملف غير مدعوم. يرجى رفع ملف PDF, DOCX, أو PPTX.");
  }

  return { text, images };
}

// Schema المخرجات المضمونة للذكاء الاصطناعي
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

// محرك التنفيذ المحمي والمعالج بالنماذج الرسمية المعتمدة
async function executeGeminiWithFallback(ai, contents) {
  // قائمة النماذج المستقرة بالترتيب
  const activeModels = [
    "gemini-1.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-pro-latest"
  ];

  let lastError = null;

  for (const modelName of activeModels) {
    console.log(`[AI Engine] Executing with active model: ${modelName}`);

    try {
      const model = ai.getGenerativeModel({
        model: modelName,
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: quizResponseSchema,
          temperature: 0.2,
        },
      });

      const result = await model.generateContent(contents);
      console.log(`[AI Engine] Success response received from: ${modelName}`);
      return result;

    } catch (error) {
      lastError = error;
      const errMsg = error.message || "";

      console.error(`[AI Error - ${modelName}]:`, errMsg);

      // إذا تعذر الوصول للنموذج أو كان غير مدعوم (404)، ينتقل تلقائياً للنموذج التالي
      if (errMsg.includes("404") || errMsg.includes("not found")) {
        console.warn(`[AI Engine] Model ${modelName} not found. Skipping...`);
        continue;
      }
    }
  }

  throw new Error(`فشل إنشاء الاختبار: ${lastError?.message || "يرجى المحاولة لاحقاً"}`);
}

function safeParseJSON(rawText) {
  if (!rawText) throw new Error("استجابة الذكاء الاصطناعي فارغة.");

  let cleaned = rawText.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");

  const firstOpen = cleaned.indexOf("{");
  const lastClose = cleaned.lastIndexOf("}");

  if (firstOpen !== -1 && lastClose !== -1 && lastClose > firstOpen) {
    cleaned = cleaned.substring(firstOpen, lastClose + 1);
  }

  return JSON.parse(cleaned);
}

// API Endpoint الرئيسي
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

    const { text, images } = await extractContentFromFile(req.file);
    const material = text.slice(0, 45000);

    if (material.trim().length < 50 && images.length === 0) {
      return res.status(400).json({ error: "الملف المرفوع لا يحتوي على نص أو صور كافية للتحليل." });
    }

    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: "مفتاح GEMINI_API_KEY غير مضاف في إعدادات البيئة." });
    }

    const ai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

    const promptText = `You are the AskMe question generation engine.

SOURCE MATERIAL:
${material}

Generate exactly ${count} MCQs at ${difficulty} difficulty level.

RULES:
- Analyze text and any provided image or table data.
- Use ONLY the provided material.
- Do not introduce outside facts.
- Provide 4 options per question with exactly 1 correct answer (0-indexed).
- Return valid JSON matching the schema.`;

    const contents = [promptText, ...images];

    const apiResponse = await executeGeminiWithFallback(ai, contents);
    const jsonOutput = safeParseJSON(apiResponse.response.text());

    return res.json(jsonOutput);

  } catch (error) {
    console.error("[Quiz Route Error]:", error);
    return res.status(500).json({
      error: error.message || "حدث خطأ غير متوقع أثناء إنشاء الاختبار.",
    });
  } finally {
    if (uploadedFilePath) {
      fs.promises.unlink(uploadedFilePath).catch((err) => {
        console.error("فشل حذف الملف المؤقت:", err);
      });
    }
  }
});

app.get("/api/health", (req, res) => res.json({ status: "healthy", timestamp: new Date() }));

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
