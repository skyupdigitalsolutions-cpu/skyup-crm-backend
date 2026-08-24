// controllers/whatsappScreenshotController.js
// ─────────────────────────────────────────────────────────────────────────────
// Accepts a WhatsApp chat screenshot (image upload), runs GPT-4o Vision on it,
// extracts structured message data, and optionally saves the extracted messages
// into the existing WhatsApp conversation for the lead.
//
// Flow:
//   POST /api/whatsapp/screenshot/extract
//     → multer (memory) → Cloudinary upload → GPT-4o Vision → return structured JSON
//
//   POST /api/whatsapp/screenshot/import
//     → same as above + saves extracted messages into WhatsAppMessage collection
//       under the lead's existing conversation (or creates one if none exists)
//
// Security:
//   - OPENAI_API_KEY stays backend only
//   - Company isolation: extracted messages saved under companyId from JWT
//   - Lead ownership verified before saving
//   - Extracted messages marked with source: "screenshot_import" so they're
//     distinguishable from real WA messages in analytics
// ─────────────────────────────────────────────────────────────────────────────

const axios                = require("axios");
const multer               = require("multer");
const Lead                 = require("../models/Leads");
const WhatsAppConversation = require("../models/WhatsAppConversation");
const WhatsAppMessage      = require("../models/WhatsAppMessage");
const { getCloudinaryForCompany } = require("../services/cloudinaryService");

// ── Multer memory storage (we upload to Cloudinary manually for vision) ────────
const memStorage = multer.memoryStorage();
const screenshotUpload = multer({
  storage: memStorage,
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10 MB max
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed"));
    }
    cb(null, true);
  },
}).single("screenshot");

// ── Company resolver (same pattern as other controllers) ───────────────────────
function getCompanyId(req) {
  return req.admin?.company || req.user?.company || null;
}

// ── Upload buffer to Cloudinary and get a public URL ──────────────────────────
async function uploadScreenshotToCloudinary(buffer, mimetype, companyId) {
  const { config: cloudConfig } = await getCloudinaryForCompany(companyId);
  const cloudinary = require("cloudinary").v2;

  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder:          "skyup-crm/wa-screenshots",
        resource_type:   "image",
        allowed_formats: ["jpg", "jpeg", "png", "webp"],
      },
      (error, result) => {
        if (error) return reject(error);
        resolve(result.secure_url);
      }
    );

    // Pass explicit config so it doesn't use global singleton
    cloudinary.config(cloudConfig);
    uploadStream.end(buffer);
  });
}

// ── GPT-4o Vision: extract WhatsApp chat messages from screenshot ─────────────
const VISION_SYSTEM_PROMPT = `You are a WhatsApp chat screenshot reader for a CRM system.
Extract ALL visible messages from the WhatsApp chat screenshot.

Return ONLY a valid JSON object in this exact format:
{
  "contactName": "the contact/lead name shown in the chat header (string or null)",
  "phoneNumber": "phone number if visible (string or null)",
  "messages": [
    {
      "direction": "inbound or outbound",
      "text": "exact message text",
      "time": "time shown e.g. 10:30 AM (string or null)",
      "date": "date if a date separator is visible e.g. Today, Yesterday, 12 Jan (string or null)",
      "messageType": "text or image or audio or video or document",
      "isRead": true or false (based on tick marks — grey=sent, double grey=delivered, blue=read)
    }
  ],
  "summary": "1-2 sentence summary of what this conversation is about",
  "customerSentiment": "POSITIVE, NEGATIVE, or NEUTRAL",
  "keyTopics": ["topic1", "topic2"],
  "hasUnreplied": true or false (whether the last message is inbound and unanswered)
}

Rules:
- "inbound" = message from the lead/customer (left side, white bubble)
- "outbound" = message sent by the agent/company (right side, green/colored bubble)
- Extract messages in chronological order (oldest first)
- If text is unclear or cut off, include what is visible
- Do not invent messages. Only extract what is visible in the screenshot.
- If no messages are visible, return messages as an empty array.`;

async function extractFromVision(imageUrl) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model:      "gpt-4o",
      max_tokens: 2000,
      messages: [
        { role: "system", content: VISION_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: imageUrl, detail: "high" },
            },
            {
              type: "text",
              text:  "Extract all WhatsApp messages from this screenshot. Return only the JSON.",
            },
          ],
        },
      ],
      response_format: { type: "json_object" },
    },
    {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type":  "application/json",
      },
      timeout: 40000,
    }
  );

  const content = response.data?.choices?.[0]?.message?.content || "{}";
  try {
    return JSON.parse(content);
  } catch {
    const cleaned = content.replace(/```json?|```/g, "").trim();
    return JSON.parse(cleaned);
  }
}

// ── Parse extracted time string into approximate Date ─────────────────────────
function parseExtractedTime(timeStr, dateStr) {
  if (!timeStr) return new Date();
  try {
    const base = new Date();
    if (dateStr) {
      const lower = String(dateStr).toLowerCase().trim();
      if (lower === "yesterday") base.setDate(base.getDate() - 1);
      else if (lower !== "today") {
        const parsed = new Date(dateStr);
        if (!isNaN(parsed)) return parsed;
      }
    }
    // Parse "10:30 AM" style
    const match = String(timeStr).match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (match) {
      let hours   = parseInt(match[1], 10);
      const mins  = parseInt(match[2], 10);
      const ampm  = match[3]?.toUpperCase();
      if (ampm === "PM" && hours < 12) hours += 12;
      if (ampm === "AM" && hours === 12) hours = 0;
      base.setHours(hours, mins, 0, 0);
    }
    return base;
  } catch {
    return new Date();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE HANDLER 1: Extract only — no DB writes, returns structured data
// POST /api/whatsapp/screenshot/extract
// Body: multipart/form-data with field "screenshot" (image file)
// ─────────────────────────────────────────────────────────────────────────────
const extractScreenshot = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(401).json({ success: false, message: "Unauthorized" });

    if (!req.file) return res.status(400).json({ success: false, message: "No screenshot uploaded" });

    // 1. Upload to Cloudinary
    let imageUrl;
    try {
      imageUrl = await uploadScreenshotToCloudinary(req.file.buffer, req.file.mimetype, companyId);
    } catch (err) {
      console.error("[screenshotExtract] Cloudinary upload failed:", err.message);
      return res.status(500).json({ success: false, message: "Image upload failed: " + err.message });
    }

    // 2. Run GPT-4o Vision
    let extracted;
    try {
      extracted = await extractFromVision(imageUrl);
    } catch (err) {
      console.error("[screenshotExtract] Vision extraction failed:", err.message);
      return res.status(500).json({ success: false, message: "AI extraction failed: " + err.message });
    }

    // 3. Validate structure
    const messages = Array.isArray(extracted.messages) ? extracted.messages : [];

    return res.json({
      success:    true,
      imageUrl,
      contactName:       extracted.contactName    || null,
      phoneNumber:       extracted.phoneNumber     || null,
      summary:           extracted.summary         || "",
      customerSentiment: extracted.customerSentiment || "NEUTRAL",
      keyTopics:         Array.isArray(extracted.keyTopics) ? extracted.keyTopics : [],
      hasUnreplied:      !!extracted.hasUnreplied,
      messages,
      messageCount: messages.length,
    });
  } catch (err) {
    console.error("[screenshotExtract] Error:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// ROUTE HANDLER 2: Extract + import into conversation
// POST /api/whatsapp/screenshot/import
// Body: multipart/form-data: "screenshot" (image) + "leadId" (text)
// ─────────────────────────────────────────────────────────────────────────────
const importScreenshot = async (req, res) => {
  try {
    const companyId = getCompanyId(req);
    if (!companyId) return res.status(401).json({ success: false, message: "Unauthorized" });

    const { leadId } = req.body;
    if (!leadId) return res.status(400).json({ success: false, message: "leadId is required" });
    if (!req.file) return res.status(400).json({ success: false, message: "No screenshot uploaded" });

    // Verify lead belongs to this company
    const lead = await Lead.findOne({ _id: leadId, company: companyId })
      .select("_id name mobile company")
      .lean();
    if (!lead) return res.status(403).json({ success: false, message: "Lead not found or access denied" });

    // 1. Upload screenshot
    let imageUrl;
    try {
      imageUrl = await uploadScreenshotToCloudinary(req.file.buffer, req.file.mimetype, companyId);
    } catch (err) {
      return res.status(500).json({ success: false, message: "Image upload failed: " + err.message });
    }

    // 2. Extract via Vision
    let extracted;
    try {
      extracted = await extractFromVision(imageUrl);
    } catch (err) {
      return res.status(500).json({ success: false, message: "AI extraction failed: " + err.message });
    }

    const messages = Array.isArray(extracted.messages) ? extracted.messages : [];
    if (messages.length === 0) {
      return res.json({
        success: true,
        imported: 0,
        message: "No messages found in screenshot",
        imageUrl,
      });
    }

    // 3. Find or create conversation for this lead
    let conversation = await WhatsAppConversation.findOne({
      lead:    leadId,
      company: companyId,
    });

    if (!conversation) {
      conversation = await WhatsAppConversation.create({
        lead:        leadId,
        company:     companyId,
        waPhone:     lead.mobile || "",
        contactName: extracted.contactName || lead.name || "",
        source:      "screenshot_import",
      });
    }

    // 4. Save extracted messages
    const now = Date.now();
    const savedMessages = [];

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      const timestamp = parseExtractedTime(m.time, m.date);

      // Small offset to preserve order when times are identical
      timestamp.setMilliseconds(timestamp.getMilliseconds() + i);

      try {
        const doc = await WhatsAppMessage.create({
          conversation: conversation._id,
          direction:    m.direction === "outbound" ? "outbound" : "inbound",
          body:         String(m.text || "").trim(),
          messageType:  m.messageType || "text",
          waTimestamp:  timestamp,
          status:       m.isRead ? "read" : "delivered",
          // Mark as screenshot import so it's filterable in analytics
          metadata: {
            source:       "screenshot_import",
            screenshotUrl: imageUrl,
            extractedAt:  new Date(now),
          },
          // Generate a unique waMessageId to prevent dedup conflicts
          waMessageId:  `screenshot_${conversation._id}_${i}_${now}`,
        });
        savedMessages.push(doc._id);
      } catch (err) {
        // Skip duplicates (waMessageId unique index) — non-fatal
        console.warn("[screenshotImport] Skipped message:", err.message);
      }
    }

    // 5. Update conversation's lastMessage
    if (savedMessages.length > 0) {
      const lastMsg = messages[messages.length - 1];
      await WhatsAppConversation.updateOne(
        { _id: conversation._id },
        {
          $set: {
            lastMessage:   String(lastMsg.text || "").slice(0, 100),
            lastMessageAt: new Date(),
          },
        }
      );
    }

    return res.json({
      success:           true,
      imported:          savedMessages.length,
      conversationId:    String(conversation._id),
      imageUrl,
      contactName:       extracted.contactName    || null,
      summary:           extracted.summary         || "",
      customerSentiment: extracted.customerSentiment || "NEUTRAL",
      keyTopics:         extracted.keyTopics        || [],
      hasUnreplied:      !!extracted.hasUnreplied,
      messageCount:      messages.length,
    });
  } catch (err) {
    console.error("[screenshotImport] Error:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  screenshotUpload,  // multer middleware
  extractScreenshot,
  importScreenshot,
};
