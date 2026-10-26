// Backend ka address. Deploy ke baad yahan apna Render URL daalna.
const API_BASE = "http://localhost:3000";

// =========================================
// GALLERY DATABASE (IndexedDB)
// =========================================

const galleryDB = new Promise((resolve, reject) => {
    const req = indexedDB.open("AIStudioGallery", 1);

    req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains("images")) {
            db.createObjectStore("images", { keyPath: "id", autoIncrement: true });
        }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
});

async function dbAdd(record) {
    const db = await galleryDB;
    return new Promise((resolve, reject) => {
        const tx = db.transaction("images", "readwrite");
        const req = tx.objectStore("images").add(record);
        tx.oncomplete = () => resolve(req.result); // new id
        tx.onerror = () => reject(tx.error);
    });
}

async function dbDelete(id) {
    const db = await galleryDB;
    return new Promise((resolve, reject) => {
        const tx = db.transaction("images", "readwrite");
        tx.objectStore("images").delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function dbGetAll() {
    const db = await galleryDB;
    return new Promise((resolve, reject) => {
        const req = db.transaction("images", "readonly").objectStore("images").getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}


document.addEventListener("DOMContentLoaded", () => {

    const $ = (id) => document.getElementById(id);

    const generateBtn = $("generateBtn");
    const promptInput = $("prompt");
    const resultGrid = $("resultGrid");
    const galleryAddButton = $("galleryAddButton");
    const galleryImageInput = $("galleryImageInput");
    const imageTab = $("imageTab");
    const videoTab = $("videoTab");
    const imagePanel = $("imagePanel");
    const videoPanel = $("videoPanel");

    const EMPTY_HTML = resultGrid.innerHTML;

    function removeEmptyState() {
        const empty = resultGrid.querySelector(".empty-state");
        if (empty) empty.remove();
    }

    function showEmptyIfNeeded() {
        if (!resultGrid.querySelector(".result-card")) {
            resultGrid.innerHTML = EMPTY_HTML;
        }
    }

    // -----------------------------------------
    // Image card banane ka code
    // -----------------------------------------
    function createCard({ url, title, text, fileName, onSave, onDelete }) {
        const card = document.createElement("div");
        card.className = "result-card";

        card.innerHTML = `
            <img alt="">
            <div class="result-info">
                <h3></h3>
                <p></p>
                <div class="result-actions">
                    <a class="download-btn">📥 Download</a>
                    ${onSave ? '<button class="save-gallery-btn" type="button">💾 Save to Gallery</button>' : ""}
                    <button class="delete-btn" type="button">🗑️ Delete</button>
                </div>
            </div>
        `;

        card.querySelector("img").src = url;
        card.querySelector("h3").textContent = title;
        card.querySelector("p").textContent = text;

        const dl = card.querySelector(".download-btn");
        dl.href = url;
        dl.download = fileName;

        card.querySelector(".delete-btn").addEventListener("click", async () => {
            card.remove();
            URL.revokeObjectURL(url);
            if (onDelete) await onDelete();
            showEmptyIfNeeded();
        });

        const saveBtn = card.querySelector(".save-gallery-btn");
        if (saveBtn) {
            saveBtn.addEventListener("click", async () => {
                try {
                    await onSave();
                    saveBtn.textContent = "✅ Saved!";
                    saveBtn.disabled = true;
                } catch (err) {
                    console.error("Failed to save image:", err);
                    alert("Image could not be saved to Gallery.");
                }
            });
        }

        return card;
    }

    // -----------------------------------------
    // Saved images load karo
    // -----------------------------------------
    async function loadGalleryImages() {
        try {
            const images = await dbGetAll();
            if (images.length) removeEmptyState();

            images.forEach((image) => {
                const url = URL.createObjectURL(image.file);
                resultGrid.prepend(createCard({
                    url,
                    title: "My Upload",
                    text: image.name,
                    fileName: image.name,
                    onDelete: () => dbDelete(image.id)
                }));
            });
        } catch (err) {
            console.error("Gallery load failed:", err);
        }
    }

    loadGalleryImages();

    // -----------------------------------------
    // Image / Video tabs
    // -----------------------------------------
    imageTab.addEventListener("click", () => {
        imageTab.classList.add("active");
        videoTab.classList.remove("active");
        imagePanel.style.display = "block";
        videoPanel.style.display = "none";
    });

    videoTab.addEventListener("click", () => {
        videoTab.classList.add("active");
        imageTab.classList.remove("active");
        imagePanel.style.display = "none";
        videoPanel.style.display = "block";
    });

    // -----------------------------------------
    // Asli image generation (backend ke through)
    // -----------------------------------------
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    generateBtn.addEventListener("click", async () => {
        const userPrompt = promptInput.value.trim();

        if (!userPrompt) {
            alert("Please write a prompt first.");
            return;
        }

        generateBtn.disabled = true;
        generateBtn.textContent = "⏳ Creating...";

        try {
            const start = await fetch(`${API_BASE}/api/image`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    prompt: userPrompt,
                    style: $("style").value,
                    aspectRatio: $("aspectRatio").value
                })
            });

            const started = await start.json();
            if (!start.ok) throw new Error(started.error || "Request failed");

            // Free queue mein kabhi kabhi kuch minute lagte hain
            const deadline = Date.now() + 5 * 60 * 1000;
            let result = null;

            while (Date.now() < deadline) {
                await sleep(3000);

                const r = await fetch(`${API_BASE}/api/image/${started.id}`);
                const d = await r.json();

                if (!r.ok || d.status === "failed") {
                    throw new Error(d.error || "Image generation failed");
                }
                if (d.status === "done") {
                    result = d;
                    break;
                }

                generateBtn.textContent = d.queuePosition
                    ? `⏳ Queue position: ${d.queuePosition}`
                    : "⏳ Creating...";
            }

            if (!result) throw new Error("Timed out. Please try again.");

            const blob = await (await fetch(result.dataUrl)).blob();
            const url = URL.createObjectURL(blob);
            const ext = blob.type.includes("png") ? "png" : "webp";
            const fileName = `AI-Studio-${Date.now()}.${ext}`;

            removeEmptyState();
            resultGrid.prepend(createCard({
                url,
                title: "Generated Image",
                text: userPrompt,
                fileName,
                onSave: () => dbAdd({ name: fileName, type: blob.type, file: blob })
            }));
        } catch (err) {
            console.error(err);
            alert(err.message || "Something went wrong.");
        } finally {
            generateBtn.disabled = false;
            generateBtn.textContent = "✦ Generate Image";
        }
    });

    // -----------------------------------------
    // Gallery mein upload (+ button)
    // -----------------------------------------
    galleryAddButton.addEventListener("click", () => galleryImageInput.click());

    galleryImageInput.addEventListener("change", async (event) => {
        const file = event.target.files[0];
        if (!file) return;

        if (!file.type.startsWith("image/")) {
            alert("Please select an image file.");
            galleryImageInput.value = "";
            return;
        }

        try {
            const id = await dbAdd({ name: file.name, type: file.type, file });
            const url = URL.createObjectURL(file);

            removeEmptyState();
            resultGrid.prepend(createCard({
                url,
                title: "My Upload",
                text: file.name,
                fileName: file.name,
                onDelete: () => dbDelete(id)
            }));
        } catch (err) {
            console.error("Failed to save image:", err);
            alert("Image could not be saved to Gallery.");
        }

        galleryImageInput.value = ""; // same file dobara select ho sake
    });

    // -----------------------------------------
    // Asli video generation (image + prompt, ya sirf script)
    // -----------------------------------------
    const imageUpload = $("imageUpload");
    const uploadPreview = $("uploadPreview");
    const generateVideo = $("generateVideo");
    const videoPrompt = $("videoPrompt");
    let videoImage = null; // base64 data URL

    function createVideoCard(videoUrl, text) {
        const card = document.createElement("div");
        card.className = "result-card";
        card.innerHTML = `
            <video controls loop playsinline style="display:block;width:100%;background:#080b12"></video>
            <div class="result-info">
                <h3>Generated Video</h3>
                <p></p>
                <div class="result-actions">
                    <a class="open-btn" target="_blank" rel="noopener">⬇ Open / Download</a>
                    <button class="delete-btn" type="button">🗑️ Delete</button>
                </div>
            </div>
        `;
        card.querySelector("video").src = videoUrl;
        card.querySelector("p").textContent = text;
        card.querySelector(".open-btn").href = videoUrl;
        card.querySelector(".delete-btn").addEventListener("click", () => {
            card.remove();
            showEmptyIfNeeded();
        });
        return card;
    }

    if (imageUpload && uploadPreview && generateVideo && videoPrompt) {

        imageUpload.addEventListener("change", () => {
            const file = imageUpload.files[0];
            videoImage = null;

            if (!file) {
                uploadPreview.style.display = "none";
                return;
            }
            if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) {
                alert("Sirf PNG, JPG ya WEBP image chalegi.");
                imageUpload.value = "";
                uploadPreview.style.display = "none";
                return;
            }
            if (file.size > 5 * 1024 * 1024) {
                alert("Image 5 MB se chhoti honi chahiye.");
                imageUpload.value = "";
                uploadPreview.style.display = "none";
                return;
            }

            const reader = new FileReader();
            reader.onload = () => {
                videoImage = reader.result;
                uploadPreview.src = reader.result;
                uploadPreview.style.display = "block";
            };
            reader.readAsDataURL(file);
        });

        generateVideo.addEventListener("click", async () => {
            const prompt = videoPrompt.value.trim();

            if (!prompt && !videoImage) {
                alert("Video ke liye prompt likho ya image upload karo.");
                return;
            }

            generateVideo.disabled = true;
            generateVideo.textContent = "⏳ Starting...";

            try {
                const start = await fetch(`${API_BASE}/api/video`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ prompt, seconds: 5, image: videoImage })
                });

                const started = await start.json();
                if (!start.ok) throw new Error(started.error || "Request failed");

                const deadline = Date.now() + 10 * 60 * 1000;
                let result = null;

                while (Date.now() < deadline) {
                    await sleep(5000);

                    const r = await fetch(`${API_BASE}/api/video/${started.id}`);
                    const d = await r.json();

                    if (!r.ok || d.status === "failed") {
                        throw new Error(d.error || "Video generation failed");
                    }
                    if (d.status === "done") {
                        result = d;
                        break;
                    }

                    generateVideo.textContent = d.state === "rendering"
                        ? "⏳ Rendering video..."
                        : "⏳ In queue...";
                }

                if (!result) throw new Error("Timed out. Please try again.");

                removeEmptyState();
                resultGrid.prepend(createVideoCard(result.videoUrl, prompt || "Image to video"));
                $("gallery").scrollIntoView({ behavior: "smooth" });
            } catch (err) {
                console.error(err);
                alert(err.message || "Something went wrong.");
            } finally {
                generateVideo.disabled = false;
                generateVideo.textContent = "▶ Generate Video";
            }
        });
    }
});