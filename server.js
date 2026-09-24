import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import JSZip from "jszip";
import mammoth from "mammoth";
import { getData } from "pdf-parse/worker";
import { PDFParse } from "pdf-parse";
import { GoogleGenAI } from "@google/genai";

// ===============================
// PDF worker
// ===============================

PDFParse.setWorker(getData());

const app = express();
const PORT = process.env.PORT || 3000;

// ===============================
// Upload settings
// ===============================

const upload = multer({
  dest: "uploads/",
  limits: {
    fileSize: 100 * 1024 * 1024,
  },
});

app.use(express.static("."));
app.use(express.json());

// ===============================
// Extract images from DOCX/PPTX
// ===============================

async function extractImagesFromZip(filePath) {
  const images = [];

  try {
    const fileBuffer = await fs.promises.readFile(filePath);
    const zip = await JSZip.loadAsync(fileBuffer);

    const mediaFiles = Object.keys(zip.files).filter(
      (fileName) =>
        fileName.startsWith("ppt/media/") ||
        fileName.startsWith("word/media/")
    );

    for (const fileName of mediaFiles.slice(0, 5)) {
      const file = zip.files[fileName];

      const imageBuffer = await file.async("nodebuffer");

      const ext = path
        .extname(fileName)
        .toLowerCase()
        .replace(".", "");

      let mimeType = "image/jpeg";

      if (ext === "png") {
        mimeType = "image/png";
      } else if (ext === "webp") {
        mimeType = "image/webp";
      } else if (ext === "gif") {
        mimeType = "image/gif";
      }

      images.push({
        inlineData: {
          data: imageBuffer.toString("base64"),
          mimeType,
        },
      });
    }
  } catch (error) {
    console.warn(
      "[ImageExtraction] Could not extract images:",
      error.message
    );
  }

  return images;
}

// ===============================
// Extract text from PPTX
// ===============================

async function pptxText(filePath) {
  const zip = await JSZip.loadAsync(
    await fs.promises.readFile(filePath)
  );

  const names = Object.keys(zip.files)
    .filter((name) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(name)
    )
    .sort((a, b) =>
      a.localeCompare(b, undefined, {
        numeric: true,
      })
    );

  const output = [];

  for (const name of names) {
    const xml = await zip.files[name].async("text");

    const textParts = [
      ...xml.matchAll(
        /<a:t>([\s\S]*?)<\/a:t>/g
      ),
    ].map((match) => match[1]);

    if (textParts.length) {
      output.push(
        `[${name}]\n${textParts.join("")}`
      );
    }
  }

  return output.join("\n");
}

// ===============================
// Extract content from file
// ===============================

async function extractContentFromFile(file) {
  const ext = path
    .extname(file.originalname)
    .toLowerCase();

  let text = "";
  let images = [];

  // =============================
  // PDF
  // =============================

  if (ext === ".pdf") {
    const dataBuffer =
      await fs.promises.readFile(file.path);

    let parser = null;

    try {
      parser = new PDFParse({
        data: dataBuffer,
      });

      const result = await parser.getText();

      text = result?.text || "";
    } finally {
      if (parser) {
        await parser.destroy();
      }
    }
  }

  // =============================
  // DOCX
  // =============================

  else if (ext === ".docx") {
    const result =
      await mammoth.extractRawText({
        path: file.path,
      });

    text = result.value || "";

    images =
      await extractImagesFromZip(file.path);
  }

  // =============================
  // PPTX
  // =============================

  else if (ext === ".pptx") {
    text = await pptxText(file.path);

    images =
      await extractImagesFromZip(file.path);
  }

  // =============================
  // Unsupported
  // =============================

  else {
    throw new Error(
      "نوع الملف غير مدعوم. يرجى رفع PDF أو DOCX أو PPTX."
    );
  }

  return {
    text,
    images,
  };
}

// ===============================
// Quiz JSON Schema
// ===============================

const quizResponseSchema = {
  type: "object",

  properties: {
    questions: {
      type: "array",

      items: {
        type: "object",

        properties: {
          question: {
            type: "string",
          },

          options: {
            type: "array",
            items: {
              type: "string",
            },
          },

          correct_answer: {
            type: "integer",
          },

          explanation: {
            type: "string",
          },

          difficulty: {
            type: "string",
            enum: [
              "Easy",
              "Medium",
              "Hard",
            ],
          },

          cognitive_level: {
            type: "string",
            enum: [
              "Recall",
              "Understanding",
              "Application",
              "Integration",
            ],
          },

          topic: {
            type: "string",
          },

          source: {
            type: "string",
          },
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

// ===============================
// Sleep helper
// ===============================

function sleep(ms) {
  return new Promise((resolve) =>
    setTimeout(resolve, ms)
  );
}

// ===============================
// Check if error is temporary
// ===============================

function isTemporaryGeminiError(error) {
  const message =
    error?.message?.toLowerCase() || "";

  return (
    message.includes("503") ||
    message.includes("unavailable") ||
    message.includes("highdemand") ||
    message.includes("overloaded") ||
    message.includes("temporarily")
  );
}

// ===============================
// Gemini with retry + fallback
// ===============================

async function executeGemini(contents) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error(
      "مفتاح GEMINI_API_KEY غير موجود في إعدادات البيئة."
    );
  }

  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
  });

  const models = [
    "gemini-3.6-flash",
    "gemini-3.5-flash-lite",
  ];

  let lastError = null;

  for (const modelName of models) {
    console.log(
      `[AIEngine] Trying model: ${modelName}`
    );

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(
          `[AIEngine] Attempt ${attempt}/3 - ${modelName}`
        );

        const response =
          await ai.models.generateContent({
            model: modelName,

            contents,

            config: {
              responseMimeType:
                "application/json",

              responseSchema:
                quizResponseSchema,
            },
          });

        console.log(
          `[AIEngine] Success with ${modelName}`
        );

        return response;
      } catch (error) {
        lastError = error;

        console.error(
          `[AIError-${modelName}-Attempt${attempt}]:`,
          error.message
        );

        if (isTemporaryGeminiError(error)) {
          if (attempt < 3) {
            const waitTime =
              attempt === 1
                ? 2000
                : attempt === 2
                ? 5000
                : 8000;

            console.log(
              `[AIEngine] Temporary error. Waiting ${waitTime}ms...`
            );

            await sleep(waitTime);

            continue;
          }

          console.warn(
            `[AIEngine] ${modelName} is still unavailable. Trying fallback model...`
          );

          break;
        }

        throw error;
      }
    }
  }

  console.error(
    "[AIEngine] Last error:",
    lastError
  );

  throw new Error(
    "تعذر إنشاء الاختبار حاليًا بسبب ضغط مؤقت على خدمة الذكاء الاصطناعي. يرجى المحاولة مرة أخرى بعد قليل."
  );
}

// ===============================
// Safe JSON parser
// ===============================

function safeParseJSON(rawText) {
  if (!rawText) {
    throw new Error(
      "استجابة الذكاء الاصطناعي فارغة."
    );
  }

  let cleaned = rawText.trim();

  cleaned = cleaned
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const firstOpen =
    cleaned.indexOf("{");

  const lastClose =
    cleaned.lastIndexOf("}");

  if (
    firstOpen !== -1 &&
    lastClose !== -1 &&
    lastClose > firstOpen
  ) {
    cleaned = cleaned.substring(
      firstOpen,
      lastClose + 1
    );
  }

  try {
    return JSON.parse(cleaned);
  } catch (error) {
    console.error(
      "[JSONParseError]",
      cleaned
    );

    throw new Error(
      "تعذر قراءة استجابة الذكاء الاصطناعي كـ JSON."
    );
  }
}

// ===============================
// Generate Quiz
// ===============================

app.post(
  "/api/generate-quiz",
  upload.single("file"),
  async (req, res) => {
    let uploadedFilePath = null;

    try {
      if (!req.file) {
        return res.status(400).json({
          error: "لم يتم رفع أي ملف.",
        });
      }

      uploadedFilePath =
        req.file.path;

      const count = Math.min(
        Math.max(
          parseInt(
            req.body.count || "10"
          ),
          1
        ),
        50
      );

      const difficulty = [
        "Easy",
        "Medium",
        "Hard",
      ].includes(req.body.difficulty)
        ? req.body.difficulty
        : "Medium";

      console.log(
        `[Quiz] Count: ${count}, Difficulty: ${difficulty}`
      );

      const {
        text,
        images,
      } = await extractContentFromFile(
        req.file
      );

      const material =
        text.slice(0, 45000);

      console.log(
        `[File] Extracted text: ${material.length} chars`
      );

      console.log(
        `[File] Extracted images: ${images.length}`
      );

      if (
        material.trim().length < 50 &&
        images.length === 0
      ) {
        return res.status(400).json({
          error:
            "الملف المرفوع لا يحتوي على نص أو صور كافية للتحليل.",
        });
      }

      if (
        !process.env.GEMINI_API_KEY
      ) {
        return res.status(500).json({
          error:
            "مفتاح GEMINI_API_KEY غير مضاف في إعدادات البيئة.",
        });
      }

      const promptText = `
You are the AskMe question generation engine.

SOURCE MATERIAL:
${material}

Generate exactly ${count} multiple-choice questions.

Difficulty:
${difficulty}

IMPORTANT RULES:

1. Use ONLY the provided source material.
2. Do not introduce outside facts.
3. Generate exactly ${count} questions.
4. Every question must have exactly 4 options.
5. There must be exactly ONE correct answer.
6. correct_answer must be a 0-based index:
   0 = first option
   1 = second option
   2 = third option
   3 = fourth option
7. Explanations must be based only on the source material.
8. Use the provided images when they contain useful information.
9. Identify the topic of every question.
10. Identify the source/section from which the question was generated.
11. Cognitive level must be one of:
   Recall
   Understanding
   Application
   Integration

Return ONLY valid JSON matching the provided schema.
`;

      const contents = [
        {
          role: "user",

          parts: [
            {
              text: promptText,
            },

            ...images.map(
              (image) => ({
                inlineData:
                  image.inlineData,
              })
            ),
          ],
        },
      ];

      const apiResponse =
        await executeGemini(
          contents
        );

      const rawText =
        apiResponse.text;

      console.log(
        "[AIEngine] Raw response length:",
        rawText?.length || 0
      );

      const jsonOutput =
        safeParseJSON(
          rawText
        );

      if (
        !jsonOutput ||
        !Array.isArray(
          jsonOutput.questions
        )
      ) {
        throw new Error(
          "الذكاء الاصطناعي لم يُرجع قائمة أسئلة صحيحة."
        );
      }

      if (
        jsonOutput.questions.length !==
        count
      ) {
        console.warn(
          `[AIWarning] Requested ${count} questions but received ${jsonOutput.questions.length}`
        );
      }

      return res.json(
        jsonOutput
      );
    } catch (error) {
      console.error(
        "[QuizRouteError]:",
        error
      );

      return res.status(500).json({
        error:
          error.message ||
          "حدث خطأ غير متوقع أثناء إنشاء الاختبار.",
      });
    } finally {
      if (uploadedFilePath) {
        fs.promises
          .unlink(
            uploadedFilePath
          )
          .catch((error) => {
            console.error(
              "فشل حذف الملف المؤقت:",
              error
            );
          });
      }
    }
  }
);

// ===============================
// Health Check
// ===============================

app.get(
  "/api/health",
  (req, res) => {
    res.json({
      status: "healthy",
      timestamp: new Date(),
    });
  }
);

// ===============================
// Start server
// ===============================

app.listen(
  PORT,
  () => {
    console.log(
      `Server is running on port ${PORT}`
    );
  }
);