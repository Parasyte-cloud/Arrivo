// Object storage for in-trip audio, on Cloudflare R2 (S3 compatible).
//
// The bucket must be PRIVATE. The API never proxies audio: phones upload
// straight to R2 with a short-lived presigned PUT URL, and staff listen through
// a short-lived presigned GET URL. Neither URL is stored.
//
// Env:
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
//   RIDE_AUDIO_RECORDING_ENABLED   "true" turns the feature on. Anything else is off.
//   RIDE_AUDIO_RETENTION_DAYS      default 30
//
// Tests replace the whole backend with setStorageForTests().

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectsCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

let override = null;
let client = null;

function setStorageForTests(fake) {
  override = fake;
}

function isConfigured() {
  if (override) return true;
  return !!(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET
  );
}

// Recording needs both the switch and working storage. Never one without the
// other: a switch that is on with no bucket would let people believe they are
// being recorded.
function isEnabled() {
  return process.env.RIDE_AUDIO_RECORDING_ENABLED === "true" && isConfigured();
}

function retentionDays() {
  const n = Number(process.env.RIDE_AUDIO_RETENTION_DAYS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 30;
}

function s3() {
  if (!client) {
    client = new S3Client({
      region: "auto",
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
}

async function presignUpload(key, contentType, expiresSeconds = 600) {
  if (override) return override.presignUpload(key, contentType, expiresSeconds);
  const cmd = new PutObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key, ContentType: contentType });
  return getSignedUrl(s3(), cmd, { expiresIn: expiresSeconds });
}

async function presignDownload(key, expiresSeconds = 600) {
  if (override) return override.presignDownload(key, expiresSeconds);
  const cmd = new GetObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key });
  return getSignedUrl(s3(), cmd, { expiresIn: expiresSeconds });
}

// Returns { size } or null when the object does not exist.
async function headObject(key) {
  if (override) return override.headObject(key);
  try {
    const out = await s3().send(new HeadObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }));
    return { size: Number(out.ContentLength) };
  } catch (err) {
    if (err.name === "NotFound" || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

async function deleteObjects(keys) {
  if (!keys.length) return;
  if (override) return override.deleteObjects(keys);
  // S3 allows 1000 keys per request.
  for (let i = 0; i < keys.length; i += 1000) {
    const batch = keys.slice(i, i + 1000).map((Key) => ({ Key }));
    await s3().send(new DeleteObjectsCommand({ Bucket: process.env.R2_BUCKET, Delete: { Objects: batch, Quiet: true } }));
  }
}

module.exports = { setStorageForTests, isConfigured, isEnabled, retentionDays, presignUpload, presignDownload, headObject, deleteObjects };
