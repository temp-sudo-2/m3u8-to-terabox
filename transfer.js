require("dotenv").config();

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const axios = require("axios");
const TeraboxUploader = require("terabox-upload-tool");

axios.interceptors.request.use((config) => {
  const requestUrl = new URL(config.url, config.baseURL);

  if (requestUrl.hostname === "www.1024terabox.com") {
    requestUrl.hostname = "dm.1024terabox.com";
  }

  if (requestUrl.pathname === "/rest/2.0/pcs/superfile2") {
    requestUrl.hostname =
      process.env.TERABOX_UPLOAD_HOST || "kul-cdata.1024terabox.com";
    requestUrl.searchParams.delete("dp-logid");
    requestUrl.searchParams.set(
      "logid",
      Buffer.from(`${Date.now() * 10}.${Math.random()}`).toString("base64"),
    );
  }

  config.url = requestUrl.toString();

  return config;
});

axios.interceptors.response.use(undefined, (error) => {
  const response = error.response;

  if (response && error.config?.url) {
    const requestUrl = new URL(error.config.url, error.config.baseURL);
    const code = response.data?.error_code ?? response.data?.errno;
    const codeLabel = Number.isInteger(code) ? code : "unknown";
    const headers = response.config?.headers;
    const cookieHeader =
      headers?.get?.("Cookie") ?? headers?.Cookie ?? headers?.cookie ?? "";
    const cookieNames = String(cookieHeader)
      .split(";")
      .map((cookie) => cookie.split("=", 1)[0].trim())
      .filter(Boolean)
      .join(",") || "none";
    const uploadId = requestUrl.searchParams.get("uploadid");
    const uploadIdPresent = Boolean(uploadId && uploadId !== "undefined");

    console.error(
      `TeraBox request failed: ${requestUrl.hostname}${requestUrl.pathname} ` +
        `(HTTP ${response.status}, code ${codeLabel}, cookies ${cookieNames}, ` +
        `uploadId ${uploadIdPresent ? "present" : "missing"})`,
    );
  }

  return Promise.reject(error);
});

const INPUT_FILE = path.resolve("video-prime.json");
const OUTPUT_FILE = path.resolve("output.json");
const PROGRESS_FILE = path.resolve("progress.json");
const TEMP_DIR = path.resolve("temp");

const REMOTE_ROOT = "/CourseArchive";
const MAX_RETRIES = 3;

fs.mkdirSync(TEMP_DIR, { recursive: true });

for (const key of ["TERABOX_NDUS", "TERABOX_JSTOKEN", "TERABOX_APP_ID"]) {
  if (!process.env[key]) {
    throw new Error(`Missing ${key} in .env`);
  }
}

const uploader = new TeraboxUploader({
  ndus: process.env.TERABOX_NDUS,
  jsToken: process.env.TERABOX_JSTOKEN,
  appId: process.env.TERABOX_APP_ID,
  bdstoken: process.env.TERABOX_BDSTOKEN || undefined,
  browserId: process.env.TERABOX_BROWSER_ID || undefined,
});

const browserCookie = process.env.TERABOX_COOKIE?.trim();

if (browserCookie) {
  uploader.credentials.cookies = browserCookie;
} else if (process.env.TERABOX_BROWSER_ID) {
  uploader.credentials.cookies =
    `browserid=${process.env.TERABOX_BROWSER_ID}; ` +
    `ndus=${process.env.TERABOX_NDUS};`;
}

function atomicWrite(file, data) {
  const temporary = `${file}.tmp`;

  fs.writeFileSync(temporary, JSON.stringify(data, null, 2));

  fs.renameSync(temporary, file);
}

function readJson(file, fallback) {
  if (!fs.existsSync(file)) {
    return fallback;
  }

  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function safeName(value) {
  return String(value || "video")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 90);
}

function collectVideos(categories) {
  const videos = [];

  for (const category of categories) {
    for (const item of category.learningPath || []) {
      if (
        item.type !== "ivideo" ||
        typeof item.m3u8_url !== "string" ||
        !item.m3u8_url.startsWith("https://")
      ) {
        continue;
      }

      videos.push({
        category: category.category || "Uncategorized",
        item,
        key: `${category.category || "Uncategorized"}:${item.sourceId || item.name}`,
      });
    }
  }

  return videos;
}

function downloadVideo(url, destination) {
  return new Promise((resolve, reject) => {
    const args = [
      "--no-playlist",
      "--retries",
      "3",
      "--fragment-retries",
      "3",
      "--concurrent-fragments",
      "1",
      "--format",
      "bestvideo[height<=1080][format_id!*=original]+bestaudio/" +
        "best[height<=1080][format_id!*=original]/best[height<=1080]",
      "--merge-output-format",
      "mp4",
      "--output",
      destination,
      url,
    ];

    const child = spawn("yt-dlp", args, {
      stdio: "inherit",
    });

    child.once("error", reject);

    child.once("close", (code) => {
      if (code !== 0) {
        return reject(new Error(`yt-dlp exited with code ${code}`));
      }

      if (!fs.existsSync(destination) || fs.statSync(destination).size === 0) {
        return reject(new Error("Download file is missing or empty"));
      }

      resolve();
    });
  });
}

async function retry(operation, label) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`${label}: attempt ${attempt}/${MAX_RETRIES}`);
      return await operation();
    } catch (error) {
      lastError = error;

      console.error(`${label} failed: ${error.message || error}`);

      if (attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
      }
    }
  }

  throw lastError;
}

async function uploadAndVerify(localPath, remotePath) {
  const remoteDirectory = path.posix.dirname(remotePath);
  const filename = path.posix.basename(remotePath);

  // Upload response must report success.
  const result = await uploader.uploadFile(
    localPath,
    (loaded, total) => {
      if (total > 0) {
        const percent = Math.floor((loaded / total) * 100);

        process.stdout.write(`\rUpload: ${percent}%`);
      }
    },
    remoteDirectory,
  );

  console.log();

  if (!result || result.success !== true) {
    throw new Error(
      `Upload was not confirmed: ${JSON.stringify(result?.message || result)}`,
    );
  }

  const details = result.fileDetails;

  if (!details || details.errno !== 0 || !details.fs_id) {
    throw new Error("Upload response did not contain a confirmed file ID");
  }

  const localSize = fs.statSync(localPath).size;
  let listing;
  let remoteFile;

  for (let attempt = 0; attempt < 6; attempt++) {
    listing = await uploader.fetchFileList(remoteDirectory);

    if (
      listing?.success === true &&
      Array.isArray(listing.data?.list)
    ) {
      remoteFile = listing.data.list.find(
        (file) =>
          file.server_filename === filename &&
          Number(file.size) === localSize,
      );

      if (remoteFile) {
        break;
      }
    }

    if (attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1000));
    }
  }

  if (!listing?.success || !Array.isArray(listing.data?.list)) {
    throw new Error("Could not verify the uploaded file in TeraBox");
  }

  if (!remoteFile) {
    const sameName = listing.data.list.filter(
      (file) => file.server_filename === filename,
    );
    const sizeMatches = sameName.some((file) => Number(file.size) === localSize);
    const idMatches = sameName.some(
      (file) => String(file.fs_id) === String(details.fs_id),
    );

    throw new Error(
      `Uploaded file verification failed after 6 checks ` +
        `(listed=${listing.data.list.length}, name=${sameName.length > 0}, ` +
        `size=${sizeMatches}, id=${idMatches})`,
    );
  }

  return {
    fs_id: String(remoteFile.fs_id),
    path: remoteFile.path || remotePath,
    size: Number(remoteFile.size),
    filename,
  };
}

async function generateShareLink(remoteFile) {
  const result = await uploader.generateShortUrl(
    remoteFile.path,
    remoteFile.fs_id,
  );

  if (!result || result.success !== true || !result.shortUrl) {
    throw new Error(result?.message || "Share-link generation failed");
  }

  return result.shortUrl;
}

async function main() {
  if (!fs.existsSync(INPUT_FILE)) {
    throw new Error(`Missing ${INPUT_FILE}`);
  }

  const source = readJson(INPUT_FILE, []);
  const progress = readJson(PROGRESS_FILE, {
    completed: [],
    failed: [],
  });

  // output.json uses the same category structure as the source.
  const output = readJson(OUTPUT_FILE, []);

  const videos = collectVideos(source);

  const outputKeys = new Set(
    output.flatMap((category) =>
      (category.learningPath || []).map(
        (item) => `${category.category}:${item.sourceId || item.name}`,
      ),
    ),
  );

  console.log(`Videos found: ${videos.length}`);
  console.log(`Already in output.json: ${outputKeys.size}`);

  for (let index = 0; index < videos.length; index++) {
    const { category, item, key } = videos[index];

    if (outputKeys.has(key)) {
      console.log(`\nSkipping completed video: ${item.name}`);
      continue;
    }

    const filename =
      `${safeName(category)}_` +
      `${safeName(item.name || item.sourceId)}_` +
      `${safeName(item.sourceId || "video")}_1080p.mp4`;

    const localPath = path.join(TEMP_DIR, filename);

    const remoteDirectory = `${REMOTE_ROOT}/${safeName(category)}`;

    const remotePath = `${remoteDirectory}/${filename}`;

    console.log(`\n[${index + 1}/${videos.length}] ${item.name || filename}`);

    try {
      // Create the destination directory if necessary.
      // TeraBox may report an error if it already exists;
      // the upload and remote-list verification below determine
      // whether the destination is usable.
      try {
        await uploader.createDirectory(remoteDirectory);
      } catch {
        // Continue: the directory might already exist.
      }

      // Keep a completed download if the previous upload failed.
      if (!fs.existsSync(localPath)) {
        await retry(() => downloadVideo(item.m3u8_url, localPath), "Download");
      }

      const remoteFile = await retry(
        () => uploadAndVerify(localPath, remotePath),
        "Upload/verification",
      );

      // Link generation is separate from upload success.
      let shareUrl = null;
      let shareError = null;

      try {
        shareUrl = await retry(
          () => generateShareLink(remoteFile),
          "Share-link generation",
        );
      } catch (error) {
        shareError = error.message;
      }

      // Store only videos whose remote upload was verified.
      let outputCategory = output.find((entry) => entry.category === category);

      if (!outputCategory) {
        outputCategory = {
          category,
          learningPath: [],
        };

        output.push(outputCategory);
      }

      outputCategory.learningPath.push({
        ...item,
        storage: {
          provider: "terabox",
          uploaded: true,
          remotePath: remoteFile.path,
          fs_id: remoteFile.fs_id,
          size: remoteFile.size,
          shareUrl,
          // A TeraBox share URL is not necessarily embeddable.
          embedUrl: null,
          shareLinkError: shareError,
        },
      });

      // Persist output first, then completion status.
      atomicWrite(OUTPUT_FILE, output);

      if (!progress.completed.includes(key)) {
        progress.completed.push(key);
      }

      progress.failed = progress.failed.filter((entry) => entry.key !== key);

      atomicWrite(PROGRESS_FILE, progress);
      outputKeys.add(key);

      // Never delete until output and progress are saved.
      fs.unlinkSync(localPath);

      console.log("Verified upload saved to output.json.");

      if (shareUrl) {
        console.log(`Share link: ${shareUrl}`);
      } else {
        console.log(
          "Upload succeeded, but share-link generation needs retrying.",
        );
      }

      console.log("Local file deleted.");
    } catch (error) {
      console.error(`Failed: ${error.message}`);

      // Do not add the video to output.json or completed.
      const previous = progress.failed.find((entry) => entry.key === key);

      if (previous) {
        previous.error = error.message;
        previous.attempts = (previous.attempts || 0) + 1;
      } else {
        progress.failed.push({
          key,
          name: item.name,
          attempts: 1,
          error: error.message,
        });
      }

      atomicWrite(PROGRESS_FILE, progress);

      // Keep local file if the download completed.
      // Continue processing the remaining videos.
    }
  }

  console.log("\nTransfer run finished.");
  console.log(`Verified uploads: ${outputKeys.size}`);
  console.log(`Failed/incomplete items: ${progress.failed.length}`);
  console.log(`Output: ${OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error("Fatal error:", error.message);
  process.exitCode = 1;
});
