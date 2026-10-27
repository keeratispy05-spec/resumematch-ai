
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 8787);
const dataDir = path.resolve(
  process.env.DATA_DIR || path.join(__dirname, '..', 'data')
);

fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'resumematch.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    jobs TEXT NOT NULL,
    candidates TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`);

app.use(cors({
  origin: (origin, callback) => {
    const allowed = (
      process.env.CORS_ORIGINS ||
      'http://localhost:5173,http://127.0.0.1:5173,http://localhost:5174,http://127.0.0.1:5174'
    )
      .split(',')
      .map((s) => s.trim());

    if (!origin || allowed.includes(origin)) {
      return callback(null, true);
    }

    return callback(new Error('Origin not allowed by CORS'));
  }
}));

app.use(express.json({ limit: '32mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    aiConfigured: Boolean(process.env.OPENAI_API_KEY),
    database: 'sqlite',
    model: process.env.OPENAI_MODEL || 'gpt-4.1-mini'
  });
});

app.get('/api/data', (_req, res) => {
  try {
    const row = db
      .prepare('SELECT jobs, candidates, updated_at FROM app_state WHERE id = 1')
      .get();

    if (!row) {
      return res.json({
        exists: false,
        jobs: [],
        candidates: [],
        updatedAt: null
      });
    }

    return res.json({
      exists: true,
      jobs: JSON.parse(row.jobs),
      candidates: JSON.parse(row.candidates),
      updatedAt: row.updated_at
    });
  } catch (error) {
    console.error('Database read error:', error?.message || error);
    return res.status(500).json({ error: 'อ่านฐานข้อมูลไม่สำเร็จ' });
  }
});

app.put('/api/data', (req, res) => {
  const { jobs, candidates } = req.body ?? {};

  if (!Array.isArray(jobs) || !Array.isArray(candidates)) {
    return res.status(400).json({ error: 'รูปแบบข้อมูลไม่ถูกต้อง' });
  }

  if (JSON.stringify({ jobs, candidates }).length > 20_000_000) {
    return res.status(413).json({ error: 'ข้อมูลมีขนาดใหญ่เกินไป' });
  }

  try {
    const updatedAt = new Date().toISOString();

    db.prepare(`
      INSERT INTO app_state (id, jobs, candidates, updated_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        jobs = excluded.jobs,
        candidates = excluded.candidates,
        updated_at = excluded.updated_at
    `).run(JSON.stringify(jobs), JSON.stringify(candidates), updatedAt);

    return res.json({ ok: true, updatedAt });
  } catch (error) {
    console.error('Database write error:', error?.message || error);
    return res.status(500).json({ error: 'บันทึกฐานข้อมูลไม่สำเร็จ' });
  }
});

// อ่าน PDF ด้วย Python + Tesseract OCR ในเครื่อง ไม่ใช้ OpenAI API
app.post('/api/read-pdf-ocr', async (req, res) => {
  const { pdfBase64 } = req.body ?? {};

  if (
    typeof pdfBase64 !== 'string' ||
    !pdfBase64 ||
    pdfBase64.length > 28_000_000
  ) {
    return res.status(400).json({
      error: 'ข้อมูล PDF ไม่ถูกต้องหรือมีขนาดใหญ่เกินไป (สูงสุด 20 MB)'
    });
  }

  const pythonScript = path.join(__dirname, 'ocr.py');
  const pythonCommand = process.env.PYTHON_EXECUTABLE || 'py';

  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
  pythonCommand,
  [pythonScript],
  {
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1'
    }
  }
);

      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        if (error) reject(error);
        else resolve(value);
      };

      const timer = setTimeout(() => {
        child.kill();
        finish(new Error('OCR ใช้เวลานานเกินไป'));
      }, 120000);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      child.stdout.on('data', (chunk) => {
        stdout += chunk;

        if (stdout.length > 10_000_000) {
          child.kill();
          finish(new Error('ผล OCR มีขนาดใหญ่เกินไป'));
        }
      });

      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });

      child.on('error', (error) => finish(error));

      child.on('close', (code) => {
        if (settled) return;

        let parsed;

        try {
          parsed = JSON.parse(stdout);
        } catch {
          console.error('Local OCR output error:', stderr);
          return finish(new Error('อ่านผลลัพธ์ OCR ไม่สำเร็จ'));
        }

        if (code !== 0 || parsed.error) {
          console.error('Local OCR error:', parsed.error, stderr);

          return finish(
            new Error(parsed.error || 'OCR ทำงานไม่สำเร็จ')
          );
        }

        finish(null, parsed);
      });

      child.stdin.on('error', (error) => {
        if (error.code !== 'EPIPE') finish(error);
      });

      child.stdin.end(JSON.stringify({ pdfBase64 }));
    });

    if (!result.text || result.text.trim().length < 10) {
      return res.status(422).json({
        error: 'ไม่พบข้อความที่อ่านได้ กรุณาตรวจสอบ PDF'
      });
    }

    return res.json({
      text: result.text,
      method: 'local-tesseract-ocr'
    });
  } catch (error) {
    console.error('Local PDF OCR error:', error.message);

    return res.status(500).json({
      error: 'OCR ในเครื่องไม่สำเร็จ กรุณาตรวจสอบ Python, Tesseract และไฟล์ PDF'
    });
  }
});

/**
 * ดึงชื่อผู้สมัครจากข้อความ OCR
 * ไม่ใช้ชื่อไฟล์เป็นชื่อผู้สมัคร
 */
app.post('/api/extract-candidate-name', (req, res) => {
  const { resumeText } = req.body ?? {};

  if (typeof resumeText !== 'string' || !resumeText.trim()) {
    return res.status(400).json({
      error: 'ไม่พบข้อความเรซูเม่'
    });
  }

  const lines = resumeText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  // ค้นหาบรรทัดที่ระบุชื่ออย่างชัดเจน
  const patterns = [
    /^(?:ชื่อ\s*[-:：]?\s*)(.+)$/,
    /^(?:ชื่อ[- ]นามสกุล\s*[-:：]?\s*)(.+)$/,
    /^(?:full\s*name|candidate\s*name|name)\s*[-:：]?\s*(.+)$/i
  ];

  for (const line of lines) {
    for (const pattern of patterns) {
      const match = line.match(pattern);

      if (match?.[1]) {
        const name = match[1]
          .replace(/\s{2,}/g, ' ')
          .trim();

        if (name.length >= 2 && name.length <= 100) {
          return res.json({
            name,
            source: 'resume-text',
            needsReview: false
          });
        }
      }
    }
  }

  // ไม่เดาชื่อจากชื่อไฟล์หรือข้อความทั่วไป
  return res.json({
    name: '',
    source: 'not-found',
    needsReview: true,
    message: 'ไม่พบชื่อที่ระบุชัดเจน กรุณาตรวจสอบเรซูเม่'
  });
});


// วิเคราะห์เรซูเม่ด้วย AI (ยังใช้ OpenAI API ตามเดิม)
app.post('/api/ai-insights', async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({
      error: 'ยังไม่ได้ตั้งค่า OPENAI_API_KEY ในไฟล์ .env ของ backend'
    });
  }

  const { resumeText, job } = req.body ?? {};

  if (
    typeof resumeText !== 'string' ||
    resumeText.trim().length < 30 ||
    !job ||
    !Array.isArray(job.criteria)
  ) {
    return res.status(400).json({
      error: 'ข้อมูลเรซูเม่หรือตำแหน่งงานไม่ครบถ้วน'
    });
  }

  try {
    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    const response = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: `คุณเป็นผู้ช่วยวิเคราะห์เรซูเม่สำหรับ HR ภาษาไทย ตอบโดยยึดข้อความเรซูเม่และเกณฑ์ตำแหน่งที่ได้รับเท่านั้น ห้ามแต่งข้อมูลหรือสร้างหลักฐาน ห้ามใช้ชื่อ อายุ เพศ รูปถ่าย เชื้อชาติ ศาสนา ความพิการ หรือคุณลักษณะส่วนบุคคลที่ไม่เกี่ยวข้อง ห้ามสร้างคะแนนหรือเปลี่ยนคะแนนคำนวณที่ได้รับมา แยกข้อเท็จจริงที่มีหลักฐานออกจากข้อมูลที่ไม่พบ/ยืนยันไม่ได้ ระบุข้อความอ้างอิงสั้น ๆ จากเรซูเม่เมื่อทำได้ ห้ามตัดสินใจรับหรือปฏิเสธแทน HR หากข้อมูลไม่เพียงพอให้ระบุชัดเจน จัดคำตอบเป็นหัวข้อภาษาไทย: สรุปความสอดคล้อง, จุดแข็งที่มีหลักฐาน, ช่องว่าง/ข้อมูลที่ไม่พบ, ข้อความหลักฐานจากเรซูเม่, คำถามที่ HR ควรตรวจสอบ, ข้อจำกัดและความไม่แน่นอน`
        },
        {
          role: 'user',
          content: JSON.stringify({
            job: {
              title: job.title,
              description: job.description,
              minQualification: job.minQualification,
              criteria: job.criteria
            },
            resumeText: resumeText.slice(0, 24000)
          })
        }
      ]
    });

    const insight = response.choices[0]?.message?.content?.trim();

    if (!insight) {
      return res.status(502).json({
        error: 'AI ไม่ได้ส่งข้อความกลับมา กรุณาลองใหม่'
      });
    }

    return res.json({
      insight,
      model: process.env.OPENAI_MODEL || 'gpt-4.1-mini'
    });
  } catch (error) {
    console.error('AI insights error:', error?.message || error);

    return res.status(502).json({
      error: 'เชื่อมต่อ AI ไม่สำเร็จ ตรวจสอบ API Key, ชื่อโมเดล และโควตาการใช้งาน'
    });
  }
});

const server = app.listen(port, () => {
  console.log(
    `ResumeMatch AI backend running at http://localhost:${port}; SQLite: ${path.join(dataDir, 'resumematch.sqlite')}`
  );
});

function shutdown() {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
