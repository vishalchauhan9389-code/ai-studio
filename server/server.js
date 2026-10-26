require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();
app.use(express.json({ limit: "10mb" })); // video ke liye image base64 mein aati hai
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || "*" }));

// =========================================
// IMAGE (AI Horde - free)
// =========================================
const HORDE = "https://aihorde.net/api/v2";
const HEADERS = {
    "Content-Type": "application/json",
    apikey: process.env.HORDE_API_KEY || "0000000000",
    "Client-Agent": "ai-studio:1.0:student-project"
};

// Normal models (SD 1.5 type) ke liye sizes (multiples of 64)
const SIZES = {
    "1:1": { width: 768, height: 768 },
    "16:9": { width: 896, height: 512 },
    "9:16": { width: 512, height: 896 },
    "4:5": { width: 640, height: 768 }
};

// SDXL models ke liye bade sizes (ye unka asli size hai)
const XL_SIZES = {
    "1:1": { width: 1024, height: 1024 },
    "16:9": { width: 1152, height: 640 },
    "9:16": { width: 640, height: 1152 },
    "4:5": { width: 896, height: 1088 }
};

const STYLES = {
    realistic: ", photorealistic, highly detailed, sharp focus, natural lighting, best quality",
    cinematic: ", cinematic lighting, dramatic, film still, depth of field, sharp focus, best quality",
    anime: ", anime style, vibrant colors, clean line art, best quality, masterpiece",
    "3d": ", 3D render, octane render, smooth shading, sharp focus, best quality",
    illustration: ", digital illustration, detailed, clean lines, best quality, masterpiece"
};

// Ye cheezein image mein nahi chahiye (### ke baad likhne se negative prompt ban jata hai)
const NEGATIVE = "blurry, low quality, worst quality, deformed, bad anatomy, extra limbs, extra fingers, watermark, text, jpeg artifacts, cropped, out of frame";

// Achhe models ke naam ke hisse. Jo pehle mile aur abhi online ho, wahi use hoga.
const MODEL_PREFERENCE = ["juggernaut", "albedobase", "dreamshaper", "sdxl", "deliberate"];

let modelCache = { name: null, at: 0 };

async function pickModel() {
    if (Date.now() - modelCache.at < 5 * 60 * 1000) return modelCache.name;

    let chosen = null;
    try {
        const r = await fetch(`${HORDE}/status/models?type=image`, { headers: HEADERS });
        const list = await r.json();

        if (r.ok && Array.isArray(list)) {
            for (const key of MODEL_PREFERENCE) {
                const matches = list.filter(
                    (m) => m.count > 0 && String(m.name).toLowerCase().includes(key)
                );
                if (matches.length) {
                    matches.sort((a, b) => b.count - a.count); // jis par zyada workers hain
                    chosen = matches[0].name;
                    break;
                }
            }
        }
    } catch (err) {
        console.error("Model list fetch failed:", err.message);
    }

    modelCache = { name: chosen, at: Date.now() };
    console.log("Using image model:", chosen || "(any available)");
    return chosen;
}

app.get("/", (_req, res) => res.json({ ok: true, service: "AI Studio backend" }));

// 1) Image job start karo
app.post("/api/image", async (req, res) => {
    try {
        const prompt = String(req.body.prompt || "").trim().slice(0, 500);
        if (!prompt) return res.status(400).json({ error: "Prompt is required" });

        const model = await pickModel();
        const isXL = !!model && /xl/i.test(model);

        const sizeTable = isXL ? XL_SIZES : SIZES;
        const size = sizeTable[req.body.aspectRatio] || sizeTable["1:1"];
        const styleText = STYLES[req.body.style] || "";

        const r = await fetch(`${HORDE}/generate/async`, {
            method: "POST",
            headers: HEADERS,
            body: JSON.stringify({
                prompt: `${prompt}${styleText} ### ${NEGATIVE}`,
                params: { ...size, steps: 25, n: 1, hires_fix: !isXL },
                models: model ? [model] : undefined,
                nsfw: false,
                censor_nsfw: true,
                allow_downgrade: true
            })
        });

        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data.id) {
            return res.status(502).json({ error: data.message || "Image service rejected the request" });
        }
        res.json({ id: data.id });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});

// 2) Image status poll karo; ready hone par image (base64) wapas do
app.get("/api/image/:id", async (req, res) => {
    try {
        const { id } = req.params;
        if (!/^[a-f0-9-]{36}$/i.test(id)) {
            return res.status(400).json({ error: "Invalid id" });
        }

        const checkRes = await fetch(`${HORDE}/generate/check/${id}`, { headers: HEADERS });
        const check = await checkRes.json().catch(() => ({}));

        if (!checkRes.ok || check.faulted) {
            return res.json({ status: "failed" });
        }
        if (!check.done) {
            return res.json({
                status: "pending",
                queuePosition: check.queue_position,
                waitTime: check.wait_time
            });
        }

        const statusRes = await fetch(`${HORDE}/generate/status/${id}`, { headers: HEADERS });
        const status = await statusRes.json().catch(() => ({}));
        const img = status.generations && status.generations[0] && status.generations[0].img;
        if (!img) return res.json({ status: "failed" });

        // Image server par download karke bhejte hain, taaki browser mein CORS ka jhanjhat na ho
        let dataUrl;
        if (img.startsWith("http")) {
            const imgRes = await fetch(img);
            const buf = Buffer.from(await imgRes.arrayBuffer());
            const type = imgRes.headers.get("content-type") || "image/webp";
            dataUrl = `data:${type};base64,${buf.toString("base64")}`;
        } else {
            dataUrl = `data:image/webp;base64,${img}`;
        }

        res.json({ status: "done", dataUrl });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});


// =========================================
// VIDEO (Magic Hour API)
// =========================================
const MH = "https://api.magichour.ai";

function mhHeaders() {
    return {
        "Content-Type": "application/json",
        accept: "application/json",
        Authorization: `Bearer ${process.env.MAGIC_HOUR_API_KEY}`
    };
}

// 1) Video job start karo (image + prompt, ya sirf prompt/script)
app.post("/api/video", async (req, res) => {
    try {
        if (!process.env.MAGIC_HOUR_API_KEY) {
            return res.status(500).json({ error: "MAGIC_HOUR_API_KEY server ke .env mein nahi hai." });
        }

        const prompt = String(req.body.prompt || "").trim().slice(0, 1000);
        const seconds = Math.min(15, Math.max(3, parseInt(req.body.seconds, 10) || 5));
        const image = req.body.image;

        if (!prompt && !image) {
            return res.status(400).json({ error: "Prompt likho ya image upload karo." });
        }

        let url;
        let body;

        if (image) {
            // Image-to-video: pehle image Magic Hour par upload karo
            const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(image);
            if (!m) return res.status(400).json({ error: "Sirf PNG, JPG ya WEBP image chalegi." });

            const ext = m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase();
            const buffer = Buffer.from(m[2], "base64");

            const upRes = await fetch(`${MH}/v1/files/upload-urls`, {
                method: "POST",
                headers: mhHeaders(),
                body: JSON.stringify({ items: [{ type: "image", extension: ext }] })
            });
            const up = await upRes.json().catch(() => ({}));
            if (!upRes.ok || !up.items || !up.items[0]) {
                return res.status(upRes.status || 502).json({ error: up.message || "Image upload URL nahi mila." });
            }

            const { upload_url, file_path } = up.items[0];
            const putRes = await fetch(upload_url, { method: "PUT", body: buffer });
            if (!putRes.ok) return res.status(502).json({ error: "Image upload fail ho gaya." });

            url = `${MH}/v1/image-to-video`;
            body = {
                name: "AI Studio video",
                end_seconds: seconds,
                resolution: "480p", // free plan par 480p hi milta hai
                assets: { image_file_path: file_path }
            };
            if (prompt) body.style = { prompt };
        } else {
            // Text-to-video: sirf script/prompt se
            url = `${MH}/v1/text-to-video`;
            body = {
                name: "AI Studio video",
                end_seconds: seconds,
                aspect_ratio: "16:9",
                resolution: "480p",
                style: { prompt }
            };
        }

        const r = await fetch(url, { method: "POST", headers: mhHeaders(), body: JSON.stringify(body) });
        const data = await r.json().catch(() => ({}));

        if (!r.ok || !data.id) {
            const msg = r.status === 402
                ? `Magic Hour: ${data.code || "payment_required"} - ${data.message || "credits ya plan ki dikkat"}`
                : (data.message || "Video service ne request reject kar di.");
            return res.status(r.status === 402 ? 402 : 502).json({ error: msg });
        }

        res.json({ id: data.id, credits: data.credits_charged });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});

// 2) Video status poll karo
app.get("/api/video/:id", async (req, res) => {
    try {
        const { id } = req.params;
        if (!/^[A-Za-z0-9_-]{5,64}$/.test(id)) {
            return res.status(400).json({ error: "Invalid id" });
        }

        const r = await fetch(`${MH}/v1/video-projects/${id}`, { headers: mhHeaders() });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) return res.status(r.status).json({ error: d.message || "Status check fail ho gaya." });

        if (d.status === "complete") {
            const dl = d.downloads && d.downloads[0];
            if (!dl) return res.json({ status: "failed", error: "Video ready hai par download link nahi mila." });
            return res.json({ status: "done", videoUrl: dl.url });
        }
        if (d.status === "error" || d.status === "canceled") {
            return res.json({ status: "failed", error: (d.error && d.error.message) || "Video generation fail ho gayi." });
        }

        res.json({ status: "pending", state: d.status }); // queued / rendering
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Server error" });
    }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AI Studio backend running on port ${PORT}`));