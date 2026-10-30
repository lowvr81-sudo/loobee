
/*
 * Loobee Video Storage
 * File: video-storage.js
 *
 * Requires:
 *   npm install @supabase/supabase-js tus-js-client
 */

import { createClient } from "@supabase/supabase-js";
import * as tus from "tus-js-client";

const SUPABASE_URL = "https://npnxfvqnjdvqgyecoxdu.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_jH73fmYtkQ1Vkz2BsrK4Wg_SSZFvcjB";

const BUCKET = "video-storage";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const MAX_FILE_SIZE = 200 * 1024 * 1024 * 1024; // 200 GB target

export async function uploadVideo(file, onProgress = () => {}) {
  if (!file) throw new Error("Choose a video first.");

  if (file.size > MAX_FILE_SIZE) {
    throw new Error("Video exceeds the configured 200 GB target.");
  }

  const {
    data: { session },
    error: sessionError
  } = await supabase.auth.getSession();

  if (sessionError || !session) {
    throw new Error("Please sign in before uploading.");
  }

  const fileId = crypto.randomUUID();
  const extension = file.name.split(".").pop()?.replace(/[^a-zA-Z0-9]/g, "") || "mp4";
  const path = `${session.user.id}/${fileId}.${extension}`;

  return new Promise((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint: `${SUPABASE_URL}/storage/v1/upload/resumable`,
      retryDelays: [0, 1000, 3000, 5000, 10000],
      chunkSize: 6 * 1024 * 1024,
      headers: {
        authorization: `Bearer ${session.access_token}`,
        apikey: SUPABASE_ANON_KEY
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      metadata: {
        bucketName: BUCKET,
        objectName: path,
        contentType: file.type || "video/mp4",
        cacheControl: "3600"
      },
      onError(error) {
        reject(new Error(`Upload failed: ${error.message}`));
      },
      onProgress(bytesUploaded, bytesTotal) {
        const percent = Math.round(bytesUploaded / bytesTotal * 100);
        onProgress({
          percent,
          uploaded: bytesUploaded,
          total: bytesTotal
        });
      },
      onSuccess() {
        const { data } = supabase.storage
          .from(BUCKET)
          .getPublicUrl(path);

        resolve({
          id: fileId,
          path,
          url: data.publicUrl,
          name: file.name,
          size: file.size
        });
      }
    });

    upload.findPreviousUploads().then(previous => {
      if (previous.length) upload.resumeFromPreviousUpload(previous[0]);
      upload.start();
    }).catch(reject);
  });
}

export async function deleteVideo(path) {
  const { error } = await supabase.storage
    .from(BUCKET)
    .remove([path]);

  if (error) throw error;
  return true;
}

export async function getVideoLink(path) {
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(path, 60 * 60 * 24 * 7);

  if (error) throw error;
  return data.signedUrl;
}

export { supabase };
